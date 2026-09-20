import { COMPANY_EXPOSURE_CATEGORIES, COMPANY_EXPOSURE_LIMITATIONS } from './companyExposure.js';
import { CFTC_LAUNCH_CATALOG } from './cftc.js';
import { isCftcEnabled } from './cftcFeature.js';

const ORIGIN = 'https://secedgarterminal.com';
const cikOf = value => /^\d{1,10}$/.test(String(value || '')) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const categories = ['all', ...COMPANY_EXPOSURE_CATEGORIES.map(row => row.id)];

/** Uses the existing issuer-scoped source/revision cache. A cold lookup can
 * inspect only the existing reader's bounded annual and newer-quarter sources;
 * the request's shared research signal cancels it when the chat budget ends. */
export function createExposureChatTools(api) {
  const { tool, stringSchema, enumeration, read, resolve, rememberCompany, addSource, fail, unavailable, txt,
    dependencies = {}, context = {}, publicJson, preview = false } = api;
  const enabled = dependencies.cftcEnabled || isCftcEnabled;
  const load = dependencies.companyExposures || (async ({ ticker, cik, asOf }, signal) => {
    if (preview) {
      if (!ticker) return null;
      return (await publicJson('/api/v1/cftc/company-exposures', { ticker, ...(asOf ? { asOf } : {}) }, signal, 2 * 1024 * 1024)).payload;
    }
    const { loadCompanyExposures, loadCompanyExposuresByCik } = await import('./companyExposureServer.js');
    return ticker ? loadCompanyExposures({ ticker, asOf: asOf || null }, { signal })
      : loadCompanyExposuresByCik(cik, { asOf: asOf || null, signal });
  });
  const validateDate = asOf => {
    if (asOf && (!day(asOf) || asOf < '1994-01-01' || asOf > new Date().toISOString().slice(0, 10)))
      throw fail('Use an SEC filing cutoff from 1994 through today, or leave it empty for the applicable page selection.');
  };
  const benchmark = value => {
    const found = CFTC_LAUNCH_CATALOG.find(item => item.family === value?.family && item.code === value?.contract);
    if (!found || !['named-reference', 'proxy'].includes(value.fit) || typeof value.basisLimit !== 'string' || value.basisLimit.length > 700) return null;
    return { family: found.family, contract: found.code, label: found.label,
      group: found.family === 'tff' ? 'leveraged-funds' : 'managed-money', fit: value.fit, basisLimit: value.basisLimit };
  };

  return {
    company_exposures: tool('Read company-specific SEC passages connecting revenue, input costs, borrowing, investments or currencies to market exposures. Reuses the Risk/Analysis exposure map and its source cache. Exact dated passages and qualifications are preserved. Suggested CFTC contracts are benchmark context only; use a separate CFTC tool for aggregate positioning, never infer the company’s hedge positions or cash-flow sensitivity.', {
      identifier: stringSchema('Company name, verified ticker, or SEC CIK.'),
      asOf: { type: 'string', maxLength: 10, description: 'SEC filing-date cutoff YYYY-MM-DD; empty inherits the matching company page cutoff, otherwise latest.' },
      category: enumeration(categories),
    }, 'Reading company exposure evidence', async ({ identifier, asOf, category }) => {
      if (!enabled()) return unavailable('CFTC company exposure research is currently disabled.', 'CFTC_DISABLED');
      validateDate(asOf);
      const resolved = await resolve(identifier, 'company');
      if (!resolved.identity) return resolved;
      const identity = rememberCompany(resolved.identity);
      const samePage = typeof context.company === 'string' && [identity.id, identity.ticker, identity.cik].filter(Boolean)
        .some(value => value.toUpperCase() === context.company.toUpperCase() || cikOf(context.company) === identity.cik);
      if (!asOf && samePage && context.asOf) asOf = context.asOf;
      validateDate(asOf);
      const ticker = identity.ticker || (/^[A-Z][A-Z0-9.-]{0,14}$/.test(identity.id) ? identity.id : null);
      const response = await read(`company:exposures:${identity.cik}:${asOf}`, signal => load({ ticker, cik: identity.cik, asOf }, signal));
      if (!response) return unavailable('Exposure evidence is unavailable for this SEC identity in the current environment. No different company or date was substituted.');
      const result = response.payload || response;
      if (cikOf(result.cik) !== identity.cik || (result.asOf || '') !== asOf
        || result.ticker && result.ticker !== ticker) throw fail('The exposure source did not match the selected company and SEC filing cutoff.', 'SOURCE_IDENTITY_MISMATCH');
      if (!Array.isArray(result.rows) || !Array.isArray(result.sources)) throw fail('The exposure source returned an invalid evidence map.');
      const cutoff = asOf || new Date().toISOString().slice(0, 10), sourceMetadata = {}, sourceMap = new Map();
      const continuity = result.coverage?.continuity;
      const validSource = source => {
        if (!['10-K', '10-Q', '20-F', '40-F'].includes(source.form) || !day(source.filed) || source.filed > cutoff
          || !day(source.reportDate) || source.reportDate > source.filed || !/^\d{10}-\d{2}-\d{6}$/.test(source.accession || '')) return false;
        if (source.sourceCik && !cikOf(source.sourceCik)) return false;
        const sourceCik = cikOf(source.sourceCik) || identity.cik;
        if (sourceCik !== identity.cik && !(cikOf(continuity?.currentCik) === identity.cik
          && continuity.predecessorCiks?.includes(sourceCik) && day(continuity.evidenceFiled) && continuity.evidenceFiled <= cutoff)) return false;
        try {
          const url = new URL(source.url);
          return url.protocol === 'https:' && ['www.sec.gov', 'sec.gov'].includes(url.hostname) && !url.username && !url.password && !url.port
            && new RegExp(`^/Archives/edgar/data/${Number(sourceCik)}/${source.accession.replaceAll('-', '')}/[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:htm|html|txt)$`, 'i').test(url.pathname);
        } catch { return false; }
      };
      for (const source of result.sources.slice(0, 2)) {
        if (!validSource(source)) continue;
        const id = addSource(`${identity.name} · ${source.form} · filed ${source.filed}`, source.url, source.reportDate);
        if (!id) continue;
        sourceMap.set(source.accession, { ...source, sourceId: id });
        sourceMetadata[id] = { form: source.form, filed: source.filed, reportDate: source.reportDate,
          role: txt(source.role, 20), status: source.status === 'ready' ? 'ready' : 'unavailable',
          ...(source.sourceCik ? { sourceCik: source.sourceCik } : {}) };
      }
      const chosen = result.rows.filter(row => category === 'all' || row.category === category);
      let skippedInvalid = 0;
      const rows = [];
      for (const item of chosen) {
        if (!COMPANY_EXPOSURE_CATEGORIES.some(value => value.id === item.category) || !Array.isArray(item.evidence) || !item.evidence.length) { skippedInvalid++; continue; }
        const evidence = item.evidence.map(passage => {
          const source = sourceMap.get(passage.accession);
          if (!source || source.status !== 'ready' || source.url !== passage.url || source.filed !== passage.filed
            || source.reportDate !== passage.reportDate || source.form !== passage.form || source.role !== passage.role
            || (source.sourceCik || null) !== (passage.sourceCik || null)
            || typeof passage.text !== 'string' || passage.text.length < 35 || passage.text.length > 1800
            || !['connection', 'qualifying-or-negative'].includes(passage.disclosureDirection)) return null;
          return { text: passage.text, form: source.form, filed: source.filed, reportDate: source.reportDate, role: source.role,
            disclosureDirection: passage.disclosureDirection, ...(source.sourceCik ? { sourceCik: source.sourceCik } : {}),
            suggestedBenchmark: passage.disclosureDirection === 'connection' ? benchmark(passage.benchmark) : null,
            amounts: (passage.amounts || []).filter(amount => ['notional', 'balance', 'historical-activity', 'sensitivity', 'volume'].includes(amount.kind)
              && typeof amount.text === 'string' && passage.text.includes(amount.text) && amount.context === passage.text)
              .map(amount => ({ text: amount.text, kind: amount.kind })), sourceIds: [source.sourceId] };
        });
        // Dropping only an unavailable newer qualifier could turn old exposure
        // evidence into an unsupported current claim. Keep or omit whole rows.
        if (evidence.some(passage => !passage)) { skippedInvalid++; continue; }
        rows.push({ category: item.category, categoryLabel: txt(item.categoryLabel, 80), market: txt(item.marketLabel, 100),
          channelExplanation: txt(item.channelExplanation, 450), benchmarkUnavailableReason: txt(item.benchmarkUnavailableReason, 450) || null, evidence });
      }
      const page = addSource(`${identity.name} · ${ticker ? 'Company market exposures' : 'SEC filings'}`,
        ticker ? `${ORIGIN}/risk?ticker=${encodeURIComponent(ticker)}&view=exposures${asOf ? `&asOf=${asOf}` : ''}` : `${ORIGIN}/filings/${identity.cik}`, asOf);
      const scannedSource = [...sourceMap.values()].some(source => source.status === 'ready');
      const output = { status: rows.length || result.status === 'no_matches' && scannedSource ? 'ready' : 'unavailable',
        entity: identity, filingCutoff: asOf || null, sourceStatus: result.status, category, checkedAt: txt(result.checkedAt, 40),
        message: txt(result.message, 650) || null,
        coverage: { filingsScanned: result.coverage?.filingsScanned ?? null, filingsFailed: result.coverage?.filingsFailed ?? null,
          annualAvailable: result.coverage?.annualAvailable === true, quarterlyAvailable: result.coverage?.quarterlyAvailable === true,
          historyLimited: result.coverage?.historyLimited === true, searchComplete: result.coverage?.searchComplete === true,
          extractionLimited: result.coverage?.extractionLimited === true, totalMatchedRows: result.rows.length, selectedRows: chosen.length,
          omittedInvalidRows: skippedInvalid, omittedBudgetRows: 0 },
        rows, sourceMetadata, sourceIds: [page, ...[...sourceMap.values()].map(source => source.sourceId)].filter(Boolean),
        limitations: [...COMPANY_EXPOSURE_LIMITATIONS,
          'Only the latest eligible complete annual and at most one newer complete 10-Q are searched; amendments, exhibits and unreadable table context are excluded.',
          'The SEC filing cutoff is not a CFTC publication cutoff. No aggregate positioning observations were fetched by this tool. Use the suggested contract and family in a separate CFTC lookup when relevant.'],
      };
      while (bytes(output) > 11500 && output.rows.length) { output.rows.pop(); output.coverage.omittedBudgetRows++; }
      if (!output.rows.length && result.status !== 'no_matches') output.status = 'unavailable';
      if (output.coverage.omittedBudgetRows || skippedInvalid) output.truncationNote = 'Complete exposure rows were omitted. Do not infer absence or a complete exposure inventory; narrow the category or inspect the linked page.';
      return output;
    }),
  };
}
