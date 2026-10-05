export const X402_BANK_RISK_BATCH_VERSION = 'edgar.paid-bank-risk-batch.v1';
export const X402_BANK_RISK_DEFINITIONS = Object.freeze([
  { key: 'assets', label: 'Total assets', inputs: ['assets'], unit: 'USD' },
  { key: 'loans', label: 'Loans and leases before allowance', inputs: ['loans'], unit: 'USD' },
  { key: 'deposits', label: 'Total deposits', inputs: ['deposits'], unit: 'USD' },
  { key: 'nonaccrual', label: 'Nonaccrual loans and leases', inputs: ['nonaccrual'], unit: 'USD' },
  { key: 'allowance', label: 'Allowance on held-for-investment loans and leases', inputs: ['allowance'], unit: 'USD' },
  { key: 'cet1Ratio', label: 'Reported CET1 ratio', inputs: ['cet1_ratio'], unit: 'percent' },
  { key: 'totalCapitalRatio', label: 'Reported total capital ratio', inputs: ['total_capital_ratio'], unit: 'percent' },
  { key: 'leverageRatio', label: 'Reported Tier 1 leverage ratio', inputs: ['leverage_ratio'], unit: 'percent' },
  { key: 'noncurrentLoansRatio', label: '90+ days past due and nonaccrual / loans', inputs: ['past_due_90', 'nonaccrual', 'loans'], denominator: 'loans', unit: 'percent', formula: '(past_due_90 + nonaccrual) / loans × 100', note: 'Still-accruing 90+ days past due plus nonaccrual loans and leases, divided by loans and leases before allowance; not a probability of default.' },
  { key: 'allowanceHFIRatio', label: 'Allowance / held-for-investment loans', inputs: ['allowance', 'loans_hfi'], denominator: 'loans_hfi', unit: 'percent', formula: 'allowance / loans_hfi × 100', note: 'Allowance and denominator both cover held-for-investment loans and leases; not an assessment of reserve adequacy.' },
  { key: 'loansDepositsRatio', label: 'Loans / total deposits', inputs: ['loans', 'deposits'], denominator: 'deposits', unit: 'percent', formula: 'loans / deposits × 100', note: 'Consolidated scope on Form031 and domestic scope on Forms041/051; not a regulatory liquidity ratio.' },
  { key: 'brokeredDomesticDepositRatio', label: 'Brokered / domestic deposits', inputs: ['brokered_deposits', 'domestic_deposits'], denominator: 'domestic_deposits', unit: 'percent', formula: 'brokered_deposits / domestic_deposits × 100', note: 'Domestic offices only, including for Form031 banks; does not establish deposit stability or insurance coverage.' },
  { key: 'cashAssetsRatio', label: 'Cash and balances due / assets', inputs: ['cash', 'assets'], denominator: 'assets', unit: 'percent', formula: 'cash / assets × 100', note: 'Reported on-balance-sheet cash and balances due; not all balances are freely available or eligible high-quality liquid assets.' },
  { key: 'equityAssetsRatio', label: 'Total equity capital / assets', inputs: ['equity', 'assets'], denominator: 'assets', unit: 'percent', formula: 'equity / assets × 100', note: 'Book equity including noncontrolling interests; not regulatory capital.' },
  { key: 'fhlbAssetsRatio', label: 'FHLB advances / assets', inputs: ['fhlb_advances', 'assets'], denominator: 'assets', unit: 'percent', formula: 'fhlb_advances / assets × 100', note: 'The four nonoverlapping reported FHLB maturity/repricing buckets are summed by the prepared mapping; no deposit outflow or funding stress is inferred.' },
]);

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }, number = { type: ['number', 'null'] };
const rssd = { type: 'integer', minimum: 1, maximum: 9999999999 };
const date = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' };
const quarter = { type: 'string', pattern: '^[0-9]{4}-(03-31|06-30|09-30|12-31)$' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const list = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const observation = object({ value: number, unit: { enum: ['USD', 'percent'] }, status: { enum: ['reported', 'calculated', 'unavailable', 'not_applicable'] },
  reason: nullableText, period: { enum: ['instant'] }, reportDate: quarter, sourceIds: { ...list({ type: 'integer', minimum: 0, maximum: 29 }), minItems: 0, maxItems: 3 },
  formula: nullableText, scopes: list(text) });
const source = object({ key: text, label: text, value: number, unit: { enum: ['USD', 'percent'] }, period: { const: 'instant' },
  status: { enum: ['reported', 'calculated', 'unavailable', 'not_applicable'] }, reason: nullableText, codes: { ...list(text), minItems: 1, maxItems: 8 },
  basis: text, schedule: text, item: text, formula: nullableText, form: { enum: ['031', '041', '051'] }, capitalFramework: { enum: ['CBLR', 'risk_based'] },
  reportDate: quarter, startDate: { type: 'null' }, mappingVersion: { const: 'ffiec-bankscope-v3' }, sourceHash: hash, sourceUrl: text, rawSourceUrl: text, formSource: text });
const check = object({ name: text, passed: { type: 'boolean' }, inputs: { type: 'object', additionalProperties: number } });
const report = object({ reportDate: quarter, form: { enum: ['031', '041', '051'] }, sourceHash: hash, retrievedAt: text,
  submissionDateRaw: nullableText, rawSourceUrl: text, formSource: text, validation: object({ passed: { const: true }, capitalFramework: { enum: ['CBLR', 'risk_based'] }, checks: { ...list(check), minItems: 1, maxItems: 50 } }) });
const metric = object({ key: { enum: X402_BANK_RISK_DEFINITIONS.map(definition => definition.key) }, label: text, note: nullableText,
  current: observation, prior: { anyOf: [observation, { type: 'null' }] },
  change: object({ comparable: { type: 'boolean' }, absoluteDelta: number, growthPercent: number, percentagePointDelta: number,
    deltaUnit: nullableText, reason: nullableText }) });
const bank = object({ rssd, name: text, city: nullableText, state: nullableText,
  currentReport: report, priorReport: { anyOf: [report, { type: 'null' }] }, priorUnavailableReason: nullableText,
  metrics: { ...list(metric), minItems: 15, maxItems: 15 }, sourceCatalog: { ...list(source), minItems: 15, maxItems: 30 } });
export const X402_BANK_RISK_BATCH_SCHEMA = Object.freeze(object({ schemaVersion: { const: X402_BANK_RISK_BATCH_VERSION }, status: { const: 'ready' },
  selection: object({ rssds: { ...list(rssd), minItems: 1, maxItems: 4, uniqueItems: true }, period: quarter, comparison: { enum: ['previous', 'none'] } }),
  snapshot: hash, checkedAt: text, stale: { type: 'boolean' }, bankCount: { type: 'integer', minimum: 1, maximum: 4 },
  banks: { ...list(bank), minItems: 1, maxItems: 4 }, limitations: list(text) }));

export const X402_BANK_RISK_BATCH_DESCRIPTOR = Object.freeze({ routePattern: '/api/x402/v1/bank-risk-batch',
  tags: ['finance', 'FFIEC', 'banks', 'risk-evidence', 'csv'], input: { rssds: '852218,480228', period: '2026-06-30', comparison: 'previous' },
  inputSchema: { type: 'object', additionalProperties: false, required: ['rssds', 'period'], properties: {
    rssds: { type: 'string', pattern: '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,3}$', description: 'One to four unique legal-bank RSSDs with complete prepared current Call Reports.' },
    period: { ...quarter, description: 'Required exact prepared reporting quarter; directory dates alone do not establish a prepared report.' },
    comparison: { type: 'string', enum: ['previous', 'none'], default: 'previous', description: 'Consecutive prior quarter only; missing or incompatible prior evidence remains unavailable.' },
    snapshot: { ...hash, description: 'Reuse the exact output snapshot with the same RSSDs, quarter and comparison; changed evidence returns409.' },
    format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
  } } });
