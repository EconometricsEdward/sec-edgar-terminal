import { randomUUID } from 'node:crypto';
import { createFfiecClient } from './client.js';
import { BankDataError, safeBankError } from './errors.js';
import { apiDate, latestPeriods, verifyPanel } from './identity.js';
import { decodeFacsimile, parseCallXbrl } from './parser.js';
import { MAPPING_VERSION, normalizeMetrics, validateMetrics } from './metrics.js';

/** Operator-triggered, at most three filings per invocation. No cron and no reader ingestion. */
export async function ingestBankPilot({ store, env = process.env, clientFactory = createFfiecClient, now = Date.now } = {}) {
  const owner = randomUUID(); const begin = await store('begin', { owner });
  if (!begin.allowed) throw new BankDataError(begin.code, { retryAt: begin.retryAt });
  const result = { stored: 0, skipped: 0, status: 'ready', issues: [] }; const deadline = now() + 200000;
  const owned = (op, payload = {}) => store(op, { ...payload, owner });
  try {
    const state = await store('read');
    const discovery = state.discovery || {};
    const client = clientFactory({ env, gate: { reserve: method => owned('reserve', { method }), cooldown: (retryAt, code) => owned('cooldown', { retryAt, code }) } });
    if (!discovery.periods) {
      discovery.periods = latestPeriods(await client.request('RetrieveReportingPeriods'));
      discovery.checkedAt = new Date().toISOString(); discovery.panels = {}; discovery.submissions = {};
      await owned('discovery', { value: discovery });
    }
    // A completed request reuses stored source documents and makes zero FFIEC calls.
    const reports = state.reports || [];
    for (const period of discovery.periods) {
      if (now() >= deadline || result.stored >= 3) { result.status = 'more_available'; break; }
      if (reports.filter(r => r.report_date === period && r.validation?.passed).length === 3) { result.skipped += 3; continue; }
      if (!discovery.panels[period]) {
        discovery.panels[period] = verifyPanel(await client.request('RetrievePanelOfReporters', { reportingPeriodEndDate: apiDate(period) }), period);
        await owned('discovery', { value: discovery });
      }
      const banks = discovery.panels[period];
      for (const bank of banks) {
        const prior = state.banks?.find(b => b.pilot_key === bank.key);
        if (prior && Number(prior.id_rssd) !== bank.rssd) throw new BankDataError('institution_identity_changed');
        await owned('institution', bank);
      }
      if (!discovery.submissions[period]) {
        const rows = await client.request('RetrieveFilersSubmissionDateTime', { reportingPeriodEndDate: apiDate(period), lastUpdateDateTime: apiDate(period) });
        if (!Array.isArray(rows)) throw new BankDataError('parsing_failure');
        discovery.submissions[period] = rows.filter(r => banks.some(b => b.rssd === r.ID_RSSD)).map(r => ({ rssd: r.ID_RSSD, dateTime: r.DateTime }));
        await owned('discovery', { value: discovery });
      }
      for (const bank of banks) {
        if (!bank.filed) { result.issues.push({ rssd: bank.rssd, period, code: 'call_report_not_filed' }); continue; }
        const existing = reports.find(r => Number(r.id_rssd) === bank.rssd && r.report_date === period);
        if (existing) {
          result.skipped++;
          if (!existing.validation?.passed) { result.status = 'needs_review'; return result; }
          continue;
        }
        if (now() >= deadline || result.stored >= 3) { result.status = 'more_available'; return result; }
        const response = await client.request('RetrieveFacsimile', { reportingPeriodEndDate: apiDate(period), fiIdType: 'ID_RSSD', fiId: String(bank.rssd), facsimileFormat: 'XBRL' });
        const retrievedAt = new Date().toISOString(), xml = decodeFacsimile(response);
        const parsed = parseCallXbrl(xml, { rssd: bank.rssd, reportDate: period });
        const metrics = normalizeMetrics(parsed, retrievedAt), validation = validateMetrics(metrics);
        await owned('publish', { rssd: bank.rssd, reportDate: period, retrievedAt, rawXbrl: xml, sha256: parsed.sha256, parserVersion: MAPPING_VERSION,
          submissionDate: discovery.submissions[period].find(s => s.rssd === bank.rssd)?.dateTime || null,
          metrics, validation, metadata: { format: 'XBRL', form: '031', schemaReferences: parsed.schemaReferences, factCount: parsed.factCount,
            versionBasis: 'Source SHA-256 and FFIEC submission timestamp; amendment sequence not supplied', submissionTimezone: 'Not specified by FFIEC; original text retained' } });
        result.stored++;
        if (!validation.passed) { result.status = 'needs_review'; return result; }
      }
      // The latest quarter is fully validated before any history is downloaded.
    }
    return result;
  } catch (error) { result.status = 'error'; result.error = safeBankError(error); throw error; }
  finally { await owned('finish', { code: result.error?.code || null, result }).catch(() => {}); }
}
