import { createHash } from 'node:crypto';
import { getBankPublicRead } from './bank/publicReadStore.js';
import { isBankReadResult } from './bank/readResult.js';
import { bankMetricDefinitions, validateBankReport } from './bank/normalization.js';
import { SCOPE_MAPPING_VERSION } from './bank/catalog.js';
import { X402_DATA_HEADERS, x402DataError } from './x402Research.js';
import { paidCsvCell } from './x402Products.js';
import { X402_BANK_RISK_BATCH_VERSION, X402_BANK_RISK_DEFINITIONS } from './x402BankRiskBatchSchema.js';
export { X402_BANK_RISK_BATCH_SCHEMA, X402_BANK_RISK_BATCH_DESCRIPTOR } from './x402BankRiskBatchSchema.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_AGE = 6 * 60 * 60 * 1000;
const CBLR_NOT_REQUIRED = new Set(['rwa', 'total_capital', 'cet1_ratio', 'tier1_ratio', 'total_capital_ratio']);
const NONNEGATIVE_BALANCES = new Set(['assets', 'loans', 'loans_hfi', 'loans_hfs', 'deposits', 'domestic_deposits', 'foreign_deposits',
  'brokered_deposits', 'cash', 'nonaccrual', 'past_due_30', 'past_due_90', 'allowance', 'fhlb_advances']);
const inputs = [...new Set(X402_BANK_RISK_DEFINITIONS.flatMap(definition => definition.inputs))];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value, now) => typeof value === 'string' && value.length <= 100 && /^\d{4}-\d{2}-\d{2}T/.test(value)
  && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now;
const quarter = (value, now) => date(value) && /-(03-31|06-30|09-30|12-31)$/.test(value) && value <= new Date(now).toISOString().slice(0, 10);
const string = (value, limit = 2000) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const optionalText = value => value == null || value === '' ? null : value;
const unavailable = () => x402DataError('DATA_NOT_PREPARED', 'Every selected bank needs a complete validated prepared Call Report for the exact current quarter. This request starts no source acquisition and is not charged.', 503);

export function paidBankRiskBatchSelection(request, now = Date.now()) {
  const query = new URL(request.url).searchParams;
  const allowed = ['rssds', 'period', 'comparison', 'snapshot', 'format'];
  if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1 || !query.get(key))) return null;
  const rssds = (query.get('rssds') || '').split(','), period = query.get('period');
  const comparison = query.get('comparison') ?? 'previous', snapshot = query.get('snapshot') ?? '', format = query.get('format') ?? 'json';
  if (rssds.length < 1 || rssds.length > 4 || rssds.some(rssd => !/^[1-9]\d{0,9}$/.test(rssd)) || new Set(rssds).size !== rssds.length
    || !quarter(period, now) || !['previous', 'none'].includes(comparison) || snapshot && !/^[a-f0-9]{64}$/.test(snapshot)
    || !['json', 'csv'].includes(format)) return null;
  return { rssds: rssds.map(Number).sort((a, b) => a - b), period, comparison, snapshot, format };
}

function validSelection(selection, now) {
  return record(selection) && Object.keys(selection).every(key => ['rssds', 'period', 'comparison', 'snapshot', 'format'].includes(key))
    && Array.isArray(selection.rssds) && selection.rssds.length >= 1 && selection.rssds.length <= 4
    && selection.rssds.every(rssd => Number.isSafeInteger(rssd) && rssd > 0 && rssd <= 9999999999)
    && new Set(selection.rssds).size === selection.rssds.length && quarter(selection.period, now)
    && ['previous', 'none'].includes(selection.comparison) && typeof selection.snapshot === 'string'
    && (selection.snapshot === '' || /^[a-f0-9]{64}$/.test(selection.snapshot)) && ['json', 'csv'].includes(selection.format);
}

function priorQuarter(period) {
  const year = Number(period.slice(0, 4)), month = Number(period.slice(5, 7));
  return month === 3 ? `${year - 1}-12-31` : `${year}-${{ 6: '03-31', 9: '06-30', 12: '09-30' }[month]}`;
}

/** Validate complete prepared normalization, rather than trusting a passed flag alone. */
function validatedReport(report, rssd, period, now) {
  if (!record(report) || Number(report.id_rssd) !== rssd || report.report_date !== period
    || !['031', '041', '051'].includes(report.form_type) || !/^[a-f0-9]{64}$/.test(report.source_sha256 || '')
    || !timestamp(report.retrieved_at, now) || Date.parse(report.retrieved_at) < Date.parse(period)
    || report.submission_date_raw != null && !string(report.submission_date_raw, 100)
    || !record(report.validation) || report.validation.passed !== true || !['CBLR', 'risk_based'].includes(report.validation.capitalFramework)
    || !Array.isArray(report.validation.checks) || !report.validation.checks.length || report.validation.checks.length > 50
    || report.validation.checks.some(check => !record(check) || !string(check.name, 100) || check.passed !== true
      || !record(check.inputs) || Object.values(check.inputs).some(value => value !== null && !finite(value)))) return null;
  const definitions = bankMetricDefinitions(report.form_type), byKey = new Map();
  if (!Array.isArray(report.metrics) || report.metrics.length !== definitions.length) return null;
  for (const metric of report.metrics) {
    const definition = definitions.find(value => value.key === metric?.key);
    if (!definition || byKey.has(metric.key) || Number(metric.rssd) !== rssd || metric.reportDate !== period
      || metric.form !== report.form_type || metric.mappingVersion !== SCOPE_MAPPING_VERSION
      || metric.capitalFramework !== report.validation.capitalFramework || metric.unit !== definition.unit || metric.period !== definition.period
      || metric.startDate !== (metric.period === 'ytd' ? `${period.slice(0, 4)}-01-01` : null)
      || !['reported', 'calculated', 'unavailable', 'not_applicable'].includes(metric.status)
      || metric.value !== null && !finite(metric.value) || metric.value === null && !['unavailable', 'not_applicable'].includes(metric.status)
      || metric.value !== null && ['unavailable', 'not_applicable'].includes(metric.status)
      || metric.label !== definition.label || metric.basis !== definition.basis || metric.schedule !== definition.schedule || metric.item !== definition.item
      || metric.formula !== (definition.operation === 'sum' ? definition.codes.join(' + ') : null)
      || metric.value !== null && metric.status !== (definition.operation === 'sum' ? 'calculated' : 'reported')
      || metric.value !== null && (metric.reason !== null || NONNEGATIVE_BALANCES.has(metric.key) && metric.value < 0)
      || metric.reason != null && !string(metric.reason)
      || metric.value === null && !string(metric.reason) || !Array.isArray(metric.codes)
      || JSON.stringify(metric.codes) !== JSON.stringify(definition.codes)) return null;
    const requiredAbsence = definition.notApplicable
      || (report.validation.capitalFramework === 'CBLR' && CBLR_NOT_REQUIRED.has(metric.key) ? 'not_required_under_cblr' : null);
    if (requiredAbsence && (metric.value !== null || metric.status !== 'not_applicable' || metric.reason !== requiredAbsence)) return null;
    byKey.set(metric.key, metric);
  }
  const audited = validateBankReport(report.metrics, report.validation.capitalFramework === 'CBLR');
  if (!audited.passed || audited.checks.length !== report.validation.checks.length
    || new Set(report.validation.checks.map(check => check.name)).size !== report.validation.checks.length
    || audited.checks.some(expected => {
      const declared = report.validation.checks.find(check => check.name === expected.name);
      return !declared || JSON.stringify(Object.keys(declared.inputs).sort()) !== JSON.stringify(Object.keys(expected.inputs).sort())
        || Object.entries(expected.inputs).some(([key, value]) => declared.inputs[key] !== value);
    })) return null;
  return { report, byKey };
}

function sourceLinks(rssd, period, sourceHash, form, key) {
  const query = new URLSearchParams({ rssd: String(rssd), period, hash: sourceHash });
  const rawSourceUrl = `https://secedgarterminal.com/api/banks/source?${query}`;
  return { rawSourceUrl, sourceUrl: `${rawSourceUrl}&metric=${encodeURIComponent(key)}`,
    formSource: `https://www.ffiec.gov/resources/reporting-forms/ffiec${form}` };
}

function reportEvidence(prepared, rssd) {
  const report = prepared.report;
  return { reportDate: report.report_date, form: report.form_type, sourceHash: report.source_sha256, retrievedAt: report.retrieved_at,
    submissionDateRaw: optionalText(report.submission_date_raw),
    rawSourceUrl: sourceLinks(rssd, report.report_date, report.source_sha256, report.form_type, '').rawSourceUrl,
    formSource: `https://www.ffiec.gov/resources/reporting-forms/ffiec${report.form_type}`,
    validation: { passed: true, capitalFramework: report.validation.capitalFramework,
      checks: report.validation.checks.map(check => ({ name: check.name, passed: true, inputs: { ...check.inputs } })) } };
}

function catalogSources(prepared, rssd, catalog) {
  if (!prepared) return null;
  return new Map(inputs.map(key => {
    const metric = prepared.byKey.get(key), sourceId = catalog.length;
    catalog.push({ key, label: metric.label, value: metric.value, unit: metric.unit, period: metric.period, status: metric.status,
      reason: optionalText(metric.reason), codes: [...metric.codes], basis: metric.basis, schedule: metric.schedule, item: metric.item,
      formula: optionalText(metric.formula), form: prepared.report.form_type, capitalFramework: metric.capitalFramework,
      reportDate: prepared.report.report_date, startDate: null, mappingVersion: metric.mappingVersion, sourceHash: prepared.report.source_sha256,
      ...sourceLinks(rssd, prepared.report.report_date, prepared.report.source_sha256, prepared.report.form_type, key) });
    return [key, sourceId];
  }));
}

function observation(definition, prepared, ids, catalog) {
  const sourceIds = definition.inputs.map(key => ids.get(key)), sources = sourceIds.map(id => catalog[id]);
  const missing = sources.find(source => source.value === null);
  let value = missing ? null : sources[0].value, reason = missing ? `input:${missing.key}:${missing.reason}` : null;
  let status = missing ? sources.length === 1 ? missing.status : 'unavailable' : sources[0].status;
  if (definition.denominator && !missing) {
    const denominator = sources.at(-1).value;
    if (denominator <= 0) { value = null; reason = 'nonpositive_denominator'; status = 'unavailable'; }
    else { value = sources.slice(0, -1).reduce((sum, source) => sum + source.value, 0) / denominator * 100; status = 'calculated'; }
  }
  if (value !== null && !finite(value)) { value = null; reason = 'arithmetic_outside_supported_range'; status = 'unavailable'; }
  return { value, unit: definition.unit, status, reason, period: 'instant', reportDate: prepared.report.report_date,
    sourceIds, formula: definition.formula || optionalText(sources[0].formula), scopes: [...new Set(sources.map(source => source.basis))] };
}

function sourceSignature(observation, catalog) {
  return observation.sourceIds.map(id => {
    const source = catalog[id];
    return { key: source.key, codes: source.codes, unit: source.unit, basis: source.basis, period: source.period, mappingVersion: source.mappingVersion,
      ...(['cet1_ratio', 'total_capital_ratio', 'leverage_ratio'].includes(source.key) ? { capitalFramework: source.capitalFramework } : {}) };
  });
}
function change(current, prior, catalog, priorReason) {
  const missing = reason => ({ comparable: false, absoluteDelta: null, growthPercent: null, percentagePointDelta: null, deltaUnit: null, reason });
  if (!prior) return missing(priorReason);
  if (current.value === null || prior.value === null) return missing(current.reason || prior.reason || 'required_observation_unavailable');
  if (current.unit !== prior.unit || JSON.stringify(sourceSignature(current, catalog)) !== JSON.stringify(sourceSignature(prior, catalog))) return missing('reporting_scope_or_capital_framework_changed');
  const delta = current.value - prior.value;
  if (!finite(delta)) return missing('arithmetic_outside_supported_range');
  const growth = current.unit === 'USD' && prior.value > 0 ? delta / prior.value * 100 : null;
  if (growth !== null && !finite(growth)) return missing('arithmetic_outside_supported_range');
  return { comparable: true, absoluteDelta: delta, growthPercent: growth, percentagePointDelta: current.unit === 'percent' ? delta : null,
    deltaUnit: current.unit === 'percent' ? 'percentage-points' : 'USD',
    reason: current.unit === 'USD' && prior.value <= 0 ? 'growth_unavailable_from_nonpositive_prior' : null };
}

function bankPacket(state, rssd, selection, now) {
  const bank = state.banks.find(row => Number(row.id_rssd) === rssd);
  const current = validatedReport(state.reports.find(report => Number(report.id_rssd) === rssd && report.report_date === selection.period), rssd, selection.period, now);
  if (!bank || !string(bank.legal_name, 500) || bank.city != null && !string(bank.city, 100)
    || bank.state != null && !string(bank.state, 10) || !current) return null;
  const before = priorQuarter(selection.period);
  const prior = selection.comparison === 'previous'
    ? validatedReport(state.reports.find(report => Number(report.id_rssd) === rssd && report.report_date === before), rssd, before, now) : null;
  const priorUnavailableReason = prior ? null : selection.comparison === 'none' ? 'comparison_not_requested' : 'validated_consecutive_prior_report_unavailable';
  const sourceCatalog = [], currentIds = catalogSources(current, rssd, sourceCatalog), priorIds = catalogSources(prior, rssd, sourceCatalog);
  const metrics = X402_BANK_RISK_DEFINITIONS.map(definition => {
    const latest = observation(definition, current, currentIds, sourceCatalog), previous = prior ? observation(definition, prior, priorIds, sourceCatalog) : null;
    return { key: definition.key, label: definition.label, note: definition.note || null, current: latest, prior: previous,
      change: change(latest, previous, sourceCatalog, priorUnavailableReason) };
  });
  return { rssd, name: bank.legal_name, city: optionalText(bank.city), state: optionalText(bank.state),
    currentReport: reportEvidence(current, rssd), priorReport: prior ? reportEvidence(prior, rssd) : null, priorUnavailableReason, metrics, sourceCatalog };
}

const columns = ['schemaVersion', 'snapshot', 'checkedAt', 'stale', 'rssd', 'name', 'city', 'state', 'period', 'comparison', 'metric', 'label', 'note',
  'currentValue', 'unit', 'currentStatus', 'currentReason', 'currentScopes', 'currentFormula', 'currentSourceReferences', 'currentReport',
  'priorValue', 'priorStatus', 'priorReason', 'priorScopes', 'priorFormula', 'priorSourceReferences', 'priorReport', 'priorUnavailableReason',
  'comparable', 'absoluteDelta', 'growthPercent', 'percentagePointDelta', 'deltaUnit', 'changeReason', 'limitations'];
function csvRows(payload) {
  return payload.banks.flatMap(bank => bank.metrics.map(metric => ({ schemaVersion: payload.schemaVersion, snapshot: payload.snapshot,
    checkedAt: payload.checkedAt, stale: payload.stale, rssd: bank.rssd, name: bank.name, city: bank.city, state: bank.state,
    period: payload.selection.period, comparison: payload.selection.comparison, metric: metric.key, label: metric.label, note: metric.note,
    currentValue: metric.current.value, unit: metric.current.unit, currentStatus: metric.current.status, currentReason: metric.current.reason,
    currentScopes: metric.current.scopes, currentFormula: metric.current.formula,
    currentSourceReferences: metric.current.sourceIds.map(id => bank.sourceCatalog[id]), currentReport: bank.currentReport,
    priorValue: metric.prior?.value ?? null, priorStatus: metric.prior?.status ?? null, priorReason: metric.prior?.reason ?? null,
    priorScopes: metric.prior?.scopes ?? null, priorFormula: metric.prior?.formula ?? null,
    priorSourceReferences: metric.prior?.sourceIds.map(id => bank.sourceCatalog[id]) ?? [], priorReport: bank.priorReport,
    priorUnavailableReason: bank.priorUnavailableReason, ...metric.change, changeReason: metric.change.reason, limitations: payload.limitations })));
}

/** One bounded prepared-store read; no upstream, refresh, job request, or raw-source parsing. */
export function createPaidBankRiskBatchReader({ bankRead = getBankPublicRead, now = Date.now } = {}) {
  return async function bankRiskBatch(selection) {
    if (!validSelection(selection, now())) return x402DataError('INVALID_SELECTION', 'Use one to four unique RSSDs and an explicit reporting quarter. This request is not charged.', 400);
    let state, banks;
    const rssds = [...selection.rssds].sort((a, b) => a - b);
    try {
      state = await bankRead({ rssds });
      const clock = now();
      if (!isBankReadResult(state, rssds) || !timestamp(state.publicReadCache?.checkedAt, clock)
        || clock - Date.parse(state.publicReadCache.checkedAt) > MAX_CACHE_AGE) return unavailable();
      banks = rssds.map(rssd => bankPacket(state, rssd, selection, clock));
      if (banks.some(bank => bank === null)) return unavailable();
    } catch { return unavailable(); }
    const criteria = { rssds, period: selection.period, comparison: selection.comparison };
    const snapshot = hash({ schemaVersion: X402_BANK_RISK_BATCH_VERSION, selection: criteria, banks });
    if (selection.snapshot && selection.snapshot !== snapshot) return x402DataError('SNAPSHOT_CHANGED', 'The prepared bank observations or selected comparison changed. Retry without a snapshot token to inspect current evidence. This request is not charged.', 409);
    const stale = state.publicReadCache.stale === true || now() - Date.parse(state.publicReadCache.checkedAt) >= 300000;
    const payload = { schemaVersion: X402_BANK_RISK_BATCH_VERSION, status: 'ready', selection: criteria, snapshot,
      checkedAt: state.publicReadCache.checkedAt, stale, bankCount: banks.length, banks,
      limitations: [
        'RSSDs identify legal reporting banks. These are not inferred holding-company, SEC-issuer or credit-rating datasets.',
        'Values use the latest validated retained version for each quarter, including later amendments; these are not as-filed historical vintages.',
        'Reported money amounts are USD, not USD thousands or millions. Percent values are percentage levels; changes in ratios are percentage points.',
        'Form031 can consolidate domestic and foreign offices. Forms041/051 cover domestic-only banks; domestic deposit ratios always retain their domestic numerator and denominator.',
        'CBLR nonrequired risk-based capital fields and missing inputs remain null. Zero or negative denominators withhold ratios; missing prior quarters are not zero observations.',
        'Consecutive-quarter changes require compatible input codes, units, reported scope and applicable capital framework. Ratio and amount changes do not establish deterioration, causes or supervisory conclusions.',
        'Source hashes pin retained original XBRL and metric-lineage links. Source retrieval dates differ from the displayed prepared-store check time; no freshness SLA is promised.',
      ] };
    let body;
    try { body = selection.format === 'csv' ? `${columns.map(paidCsvCell).join(',')}\r\n${csvRows(payload).map(row => columns.map(column => paidCsvCell(row[column])).join(',')).join('\r\n')}\r\n` : JSON.stringify(payload); }
    catch { return unavailable(); }
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return x402DataError('PRODUCT_TOO_LARGE', 'This bank evidence packet exceeds the bounded delivery size. Choose fewer banks. This request is not charged.', 413);
    return new Response(body, { headers: { ...X402_DATA_HEADERS, 'X-Data-Stale': stale ? '1' : '0', 'X-Schema-Version': payload.schemaVersion,
      'Access-Control-Expose-Headers': `${X402_DATA_HEADERS['Access-Control-Expose-Headers']}, X-Schema-Version, Content-Disposition`,
      'Content-Type': selection.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      ...(selection.format === 'csv' ? { 'Content-Disposition': 'attachment; filename="bank-risk-batch.csv"' } : {}),
    } });
  };
}
export const paidBankRiskBatchReader = createPaidBankRiskBatchReader();
