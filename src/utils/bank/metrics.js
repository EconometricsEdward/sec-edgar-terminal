import { pickFact } from './parser.js';
export const MAPPING_VERSION = 'ffiec031-pilot-v2';
export const FORM_SOURCE = 'https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_202606_f.pdf';
import { BANK_METRICS } from './definitions.js';
export { BANK_METRICS } from './definitions.js';
function sourceFact(parsed, code, period) {
  const direct = pickFact(parsed, code, period);
  if (code !== 'RCFDJJ34' || direct.value !== null) return direct;
  // Observed in the official pilot XBRL: this RC balance-sheet item uses the
  // calendar-YTD duration context. Accept this ONE stock item only if it ties to
  // RC-B amortized cost less RI-B II ending HTM allowance. Preserve the anomaly.
  const duration = pickFact(parsed, code, 'ytd');
  const gross = pickFact(parsed, 'RCFD1754');
  const allowance = pickFact(parsed, 'RIADJH93', 'ytd');
  if ([duration, gross, allowance].every(f => f.value !== null && /(^|:)USD$/i.test(f.unit))
    && Math.abs(gross.value - allowance.value - duration.value) <= 1000) {
    return { ...duration, contextNote: 'RC 2.a quarter-end stock is encoded with a YTD context by FFIEC; verified against RC-B I 8.A less RI-B II 7.B',
      corroboration: [gross, allowance] };
  }
  return direct;
}
export function normalizeMetrics(parsed, ingestedAt = new Date().toISOString()) {
  return BANK_METRICS.map(def => {
    let facts = def.codes.map(code => sourceFact(parsed, code, def.period));
    let reason = null;
    if (def.operation === 'exclusive') { facts = facts.filter(f => f.value !== null); if (facts.length !== 1) reason = facts.length ? 'ambiguous_capital_column' : 'item_not_reported_on_required_basis'; }
    if (!reason && facts.some(f => f.value === null)) reason = facts.find(f => f.value === null).reason;
    if (!reason && facts.some(f => !(def.unit === 'USD' ? /(^|:)USD$/i.test(f.unit) : /(^|:)pure$/i.test(f.unit)))) reason = 'unsupported_source_unit';
    const value = reason ? null : facts.reduce((n, f) => n + f.value, 0) * (def.unit === 'percent' ? 100 : 1);
    return { ...def, value, status: reason ? 'unavailable' : def.operation === 'sum' ? 'calculated' : 'reported', reason,
      reportDate: parsed.reportDate, startDate: def.period === 'ytd' ? `${parsed.reportDate.slice(0, 4)}-01-01` : null,
      rssd: parsed.rssd, ingestedAt, mappingVersion: MAPPING_VERSION, formSource: FORM_SOURCE,
      sourceHash: parsed.sha256, lineage: facts, formula: def.operation === 'sum' ? def.codes.join(' + ') : null };
  });
}
export function validateMetrics(metrics) {
  const values = Object.fromEntries(metrics.map(m => [m.key, m.value])); const checks = [];
  const check = (name, keys, predicate) => checks.push({ name, passed: keys.every(k => values[k] != null) ? predicate(...keys.map(k => values[k])) : false, inputs: Object.fromEntries(keys.map(k => [k, values[k]])) });
  for (const key of ['assets', 'loans', 'deposits', 'equity', 'net_income', 'tier1', 'nonaccrual']) check(`${key}_reported`, [key], () => true);
  check('balance_sheet_reconciles', ['assets', 'liabilities', 'equity'], (a, l, e) => Math.abs(a - l - e) <= 2000);
  check('loans_reconcile', ['loans', 'loans_hfs', 'loans_hfi'], (a, b, c) => Math.abs(a - b - c) <= 2000);
  check('net_interest_income_reconciles', ['interest_income', 'interest_expense', 'net_interest_income'], (a, b, c) => Math.abs(a - b - c) <= 2000);
  for (const [capital, ratio] of [['cet1', 'cet1_ratio'], ['tier1', 'tier1_ratio'], ['total_capital', 'total_capital_ratio']]) check(`${ratio}_reconciles`, [capital, 'rwa', ratio], (c, r, pct) => r > 0 && Math.abs(c / r * 100 - pct) <= 0.001);
  return { passed: checks.every(c => c.passed), checks };
}
