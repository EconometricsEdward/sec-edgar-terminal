import { pickFact } from './parser.js';
export const MAPPING_VERSION = 'ffiec031-pilot-v2';
export const FORM_SOURCE = 'https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_202606_f.pdf';
const metric = (key, label, group, schedule, item, codes, extras = {}) => ({ key, label, group, schedule, item, codes: codes.split(' '), period: 'instant', unit: 'USD', basis: 'Consolidated bank; domestic and foreign offices', ...extras });
export const BANK_METRICS = Object.freeze([
  metric('assets', 'Total assets', 'Overview', 'RC', '12', 'RCFD2170'),
  metric('cash', 'Cash and balances due', 'Overview', 'RC', '1.a + 1.b', 'RCFD0081 RCFD0071', { operation: 'sum' }),
  metric('securities', 'Securities, excluding trading assets', 'Overview', 'RC', '2.a + 2.b + 2.c', 'RCFDJJ34 RCFD1773 RCFDJA22', { operation: 'sum', basis: 'HTM net of allowance + AFS debt at fair value + equity securities with readily determinable fair values; excludes trading assets' }),
  metric('loans', 'Loans and leases, before allowance', 'Overview', 'RC-C I', '12, column A', 'RCFD2122', { basis: 'Consolidated; held for investment and held for sale, net of unearned income, before allowance' }),
  metric('loans_hfi', 'Loans and leases held for investment', 'Overview', 'RC', '4.b', 'RCFDB528'),
  metric('loans_hfs', 'Loans and leases held for sale', 'Overview', 'RC', '4.a', 'RCFD5369'),
  metric('deposits', 'Total deposits', 'Overview', 'RC', '13.a + 13.b', 'RCON2200 RCFN2200', { operation: 'sum' }),
  metric('liabilities', 'Total liabilities', 'Overview', 'RC', '21', 'RCFD2948'),
  metric('equity', 'Total equity capital', 'Overview', 'RC', '28', 'RCFDG105', { basis: 'Consolidated; includes noncontrolling interests' }),
  metric('bank_equity', 'Bank equity capital', 'Overview', 'RC', '27.a', 'RCFD3210', { basis: 'Equity attributable to the bank; excludes noncontrolling interests' }),
  ...[
    ['interest_income', 'Interest income', '1.h', 'RIAD4107'], ['interest_expense', 'Interest expense', '2.e', 'RIAD4073'],
    ['net_interest_income', 'Net interest income', '3', 'RIAD4074'], ['provision', 'Provision for credit losses', '4', 'RIADJJ33'],
    ['noninterest_income', 'Noninterest income', '5.m', 'RIAD4079'], ['noninterest_expense', 'Noninterest expense', '7.e', 'RIAD4093'],
    ['net_income', 'Net income attributable to bank', '14', 'RIAD4340'],
  ].map(([key, label, item, code]) => metric(key, label, 'Earnings', 'RI', item, code, { period: 'ytd', basis: 'Calendar year to date; consolidated bank' })),
  metric('past_due_30_89', '30–89 days past due, still accruing', 'Credit quality', 'RC-N', '9, column A', 'RCFD1406'),
  metric('past_due_90', '90+ days past due, still accruing', 'Credit quality', 'RC-N', '9, column B', 'RCFD1407'),
  metric('nonaccrual', 'Nonaccrual loans and leases', 'Credit quality', 'RC-N', '9, column C', 'RCFD1403'),
  metric('allowance', 'Allowance on loans and leases', 'Credit quality', 'RC', '4.c', 'RCFD3123', { basis: 'Allowance for credit losses on loans and leases held for investment' }),
  metric('charge_offs', 'Gross loan and lease charge-offs', 'Credit quality', 'RI-B I', '9, column A', 'RIAD4635', { period: 'ytd', basis: 'Calendar year to date; gross charge-offs, including allocated transfer risk reserve' }),
  metric('recoveries', 'Loan and lease recoveries', 'Credit quality', 'RI-B I', '9, column B', 'RIAD4605', { period: 'ytd' }),
  metric('domestic_deposits', 'Domestic deposits', 'Funding', 'RC', '13.a', 'RCON2200', { basis: 'Domestic offices only' }),
  metric('foreign_deposits', 'Foreign deposits', 'Funding', 'RC', '13.b', 'RCFN2200', { basis: 'Foreign offices, Edge and Agreement subsidiaries, and IBFs' }),
  metric('brokered_deposits', 'Brokered deposits', 'Funding', 'RC-E I', 'Memorandum 1.b', 'RCON2365', { basis: 'Domestic offices only' }),
  metric('fhlb_advances', 'FHLB advances', 'Funding', 'RC-M', '5.a.(1)(a)–(d)', 'RCFDF055 RCFDF056 RCFDF057 RCFDF058', { operation: 'sum', basis: 'Sum of four maturity / repricing buckets; excludes overlapping memorandum subtotals' }),
  metric('cet1', 'CET1 capital', 'Capital', 'RC-R I', '19, applicable column', 'RCFAP859 RCFWP859', { operation: 'exclusive', basis: 'Applicable non-advanced / advanced institution column; no mixing of capital bases' }),
  metric('tier1', 'Tier 1 capital', 'Capital', 'RC-R I', '26', 'RCFA8274'),
  metric('total_capital', 'Total capital, standardized', 'Capital', 'RC-R I', '47.a', 'RCFA3792', { basis: 'Standardized approach' }),
  metric('rwa', 'Risk-weighted assets, standardized', 'Capital', 'RC-R I', '48.a', 'RCFAA223', { basis: 'Standardized approach' }),
  ...[['cet1_ratio', 'CET1 ratio', '49, column A', 'RCFAP793'], ['tier1_ratio', 'Tier 1 ratio', '50, column A', 'RCFA7206'],
    ['total_capital_ratio', 'Total capital ratio', '51, column A', 'RCFA7205'], ['leverage_ratio', 'Tier 1 leverage ratio', '31', 'RCFA7204']]
    .map(([key, label, item, code]) => metric(key, label, 'Capital', 'RC-R I', item, code, { unit: 'percent', basis: key === 'leverage_ratio' ? 'Tier 1 capital / adjusted average consolidated assets' : 'Standardized approach' })),
]);
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
