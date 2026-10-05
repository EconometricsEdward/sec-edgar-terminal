export const X402_FINANCIAL_CHANGES_VERSION = 'edgar.paid-financial-changes.v1';
export const X402_FINANCIAL_CHANGE_METRICS = Object.freeze(['revenue', 'operatingIncome', 'netIncome',
  'operatingCashFlow', 'freeCashFlow', 'cash', 'totalAssets', 'totalLiabilities', 'equity', 'operatingMargin', 'netMargin', 'totalDebt']);

const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }, number = { type: ['number', 'null'] };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const nullableDate = { ...date, type: ['string', 'null'] };
const ticker = { type: 'string', pattern: '^[A-Z][A-Z0-9.-]{0,14}$' };
const basis = { enum: ['annual', 'quarter', 'ytd', 'ttm'] };
const metricKey = { enum: X402_FINANCIAL_CHANGE_METRICS };
const list = items => ({ type: 'array', items });
const references = { ...list({ type: 'integer', minimum: 0 }), uniqueItems: true, maxItems: 128 };
const periodProperties = { kind: basis, start: nullableDate, end: date,
  fiscalYear: { type: ['integer', 'null'] }, fiscalPeriod: nullableText, filed: nullableDate, form: nullableText, accession: nullableText };
const period = object(periodProperties);
const observationPeriod = object({ kind: { enum: ['instant', 'duration'] }, start: nullableDate, end: date,
  dateBasis: { enum: ['metric-observation', 'reported-source', 'reporting-period-calculation'] } });
const observation = object({ value: number, unit: nullableText,
  unitBasis: { enum: ['metric-observation', 'reported-source', 'metric-definition-format', 'not-specified'] },
  classification: { enum: ['reported', 'calculated', 'unavailable'] },
  observationPeriod: { anyOf: [observationPeriod, { type: 'null' }] }, formula: nullableText, reason: nullableText, note: nullableText,
  sourceIds: references, calculationIds: references });
const source = object({ taxonomy: text, tag: text, unit: text, start: nullableDate, end: date, value: { type: 'number' },
  accession: { type: 'string', pattern: '^\\d{10}-\\d{2}-\\d{6}$' }, filed: date, form: text, documentUrl: { type: 'string', format: 'uri' },
  sourceCik: { type: ['string', 'null'], pattern: '^(?!0+$)\\d{10}$' }, revised: { type: 'boolean' },
  scopeNote: nullableText, revisionNote: nullableText, label: nullableText });
const calculation = object({ formula: text, label: nullableText, value: number, start: nullableDate, end: nullableDate, unit: nullableText });
const metric = object({ key: metricKey, modelKey: text, label: text, format: { enum: ['currency', 'percent'] },
  definition: object({ category: nullableText, formula: nullableText }), current: observation, prior: observation,
  change: object({ absoluteDelta: number, growthPercent: number, percentagePointDelta: number, deltaUnit: nullableText,
    comparable: { type: 'boolean' }, reason: nullableText }) });
const company = object({ ticker, cik: { type: 'string', pattern: '^(?!0+$)\\d{10}$' }, name: text, basis,
  lens: nullableText, businessModel: nullableText, fetchedAt: text, checkedAt: text, freshUntil: text, stale: { type: 'boolean' },
  period, comparisonPeriod: { anyOf: [period, { type: 'null' }] },
  metrics: { ...list(metric), minItems: 1, maxItems: 12 }, sourceCatalog: { ...list(source), maxItems: 512 },
  calculationCatalog: { ...list(calculation), maxItems: 512 },
  coverage: object({ requestedMetrics: { type: 'integer', minimum: 1, maximum: 12 },
    comparableMetrics: { type: 'integer', minimum: 1, maximum: 12 }, preparedHistoryPeriods: { type: 'integer', minimum: 1 } }),
  notes: list(text) });

/** Pure discovery contract for actual JSON bytes; CSV embeds the same evidence. */
export const X402_FINANCIAL_CHANGES_SCHEMA = Object.freeze(object({
  schemaVersion: { const: X402_FINANCIAL_CHANGES_VERSION }, status: { const: 'ready' }, stale: { type: 'boolean' },
  selection: object({ tickers: { ...list(ticker), minItems: 1, maxItems: 10, uniqueItems: true }, basis,
    comparison: { enum: ['year', 'previous'] }, metrics: { ...list(metricKey), minItems: 1, maxItems: 12, uniqueItems: true } }),
  companyCount: { type: 'integer', minimum: 1, maximum: 10 }, companies: { ...list(company), minItems: 1, maxItems: 10 },
  limitations: list(text),
}));
