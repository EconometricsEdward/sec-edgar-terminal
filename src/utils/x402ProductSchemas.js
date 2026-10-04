import { UNIVERSE_METRICS } from './marketFundamentals.js';
const metricKeys = UNIVERSE_METRICS.map(metric => metric.key);
const nullableNumberSchema = { type: ['number', 'null'] };
const nullableStringSchema = { type: ['string', 'null'] };
const basisSchema = { type: 'string', enum: ['annual', 'quarter', 'ytd', 'ttm'] };
const stringListSchema = { type: 'array', items: { type: 'string' } };
const tickerSchema = { type: 'string', pattern: '^[A-Z][A-Z0-9.-]{0,14}$' };
const paginationSchema = { type: 'object', additionalProperties: false,
  required: ['limit', 'offset', 'total', 'nextOffset', 'snapshot'], properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 9999 },
    total: { type: 'integer', minimum: 1 }, nextOffset: { type: ['integer', 'null'], minimum: 0 },
    snapshot: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  } };
const modelSchema = { type: 'object', required: ['ticker', 'cik', 'basis', 'version', 'mappingVersion', 'packed', 'periods', 'definitions', 'metrics', 'sourceCatalog', 'calculationCatalog'], properties: {
  ticker: tickerSchema, cik: { type: 'string', pattern: '^(?!0+$)[0-9]{10}$' }, basis: basisSchema, version: { type: 'string' }, mappingVersion: { type: 'string' }, packed: { const: true },
  periods: { type: 'array', minItems: 1, items: { type: 'object', required: ['end'], properties: { end: { type: 'string' }, start: nullableStringSchema } } },
  definitions: { type: 'array', items: { type: 'object', required: ['key', 'label'], properties: { key: { type: 'string' }, label: { type: 'string' }, format: { type: 'string' } } } },
  metrics: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', required: ['sourceIds', 'calculationIds'], properties: {
    value: nullableNumberSchema, sourceIds: { type: 'array', items: { type: 'integer', minimum: 0 } }, calculationIds: { type: 'array', items: { type: 'integer', minimum: 0 } },
  } } } }, sourceCatalog: { type: 'array', items: { type: 'object' } }, calculationCatalog: { type: 'array', items: { type: 'object' } },
} };
const financialEnvelopeSchema = { type: 'object', required: ['schemaVersion', 'status', 'stale', 'fetchedAt', 'checkedAt', 'freshUntil', 'model', 'limitations'], properties: {
  schemaVersion: { const: 'edgar.paid-financials.v1' }, status: { const: 'ready' }, stale: { type: 'boolean' }, fetchedAt: { type: 'string' }, checkedAt: { type: 'string' }, freshUntil: { type: 'string' }, model: modelSchema, limitations: stringListSchema,
} };
const metricSchema = { type: 'object', additionalProperties: false, required: ['current', 'prior', 'change', 'unavailable_reason'], properties: {
  current: nullableNumberSchema, prior: nullableNumberSchema, change: nullableNumberSchema, unavailable_reason: nullableStringSchema,
} };
const fundamentalRowSchema = { type: 'object', required: ['ticker', 'cik', 'name', 'group', 'financial', 'metrics', 'source_accessions', 'filed', 'fiscal_end', 'prior_fiscal_end', 'accession', 'source', 'selectedValue', 'peerPercentile'], properties: {
  ticker: { type: 'string' }, cik: { type: 'string' }, name: { type: 'string' }, group: { type: 'string' }, financial: { type: 'boolean' },
  metrics: { type: 'object', additionalProperties: false, required: metricKeys, properties: Object.fromEntries(metricKeys.map(key => [key, metricSchema])) },
  source_accessions: stringListSchema, filed: nullableStringSchema, fiscal_end: nullableStringSchema, prior_fiscal_end: nullableStringSchema, accession: nullableStringSchema, source: nullableStringSchema,
  selectedValue: nullableNumberSchema, peerPercentile: { type: ['number', 'null'], minimum: 0, maximum: 100 },
} };
const screenProperties = { status: { const: 'ready' }, stale: { type: 'boolean' }, snapshot: { type: 'object' }, selection: { type: 'object' },
  population: { type: 'object' }, pagination: paginationSchema, limitations: stringListSchema };
/** Bazaar/OpenAPI can reuse these schemas; they describe JSON delivery, not CSV bytes. */
export const X402_PRODUCT_RESPONSE_SCHEMAS = Object.freeze({
  'financial-batch': { type: 'object', required: ['schemaVersion', 'status', 'selection', 'stale', 'companyCount', 'companies', 'limitations'], properties: {
    schemaVersion: { const: 'edgar.paid-financial-batch.v1' }, status: { const: 'ready' }, stale: { type: 'boolean' }, companyCount: { type: 'integer', minimum: 1, maximum: 10 },
    selection: { type: 'object', additionalProperties: false, required: ['tickers', 'basis'], properties: { tickers: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: tickerSchema }, basis: basisSchema } },
    companies: { type: 'array', minItems: 1, maxItems: 10, items: financialEnvelopeSchema }, limitations: stringListSchema,
  } },
  'fundamental-screen': { type: 'object', required: ['schemaVersion', 'status', 'stale', 'selection', 'snapshot', 'population', 'sectors', 'rows', 'pagination', 'limitations'], properties: {
    ...screenProperties, schemaVersion: { const: 'edgar.paid-fundamental-screen.v1' },
    rows: { type: 'array', minItems: 1, maxItems: 100, items: fundamentalRowSchema },
    sectors: { type: 'array', items: { type: 'object', required: ['id', 'label', 'companies'], properties: { id: { type: 'string' }, label: { type: 'string' }, companies: { type: 'integer', minimum: 0 } } } },
    population: { type: 'object', additionalProperties: false, required: ['companies', 'metricEligible', 'metricMissing'], properties: { companies: { type: 'integer', minimum: 0 }, metricEligible: { type: 'integer', minimum: 0 }, metricMissing: { type: 'integer', minimum: 0 } } },
  } },
  'credit-screen': { type: 'object', required: ['schemaVersion', 'status', 'stale', 'selection', 'snapshot', 'population', 'rows', 'pagination', 'limitations'], properties: {
    ...screenProperties, schemaVersion: { const: 'edgar.paid-credit-screen.v1' },
    population: { type: 'object', additionalProperties: false, required: ['companies', 'reportedSchedules', 'completeSchedules'], properties: { companies: { type: 'integer', minimum: 0 }, reportedSchedules: { type: 'integer', minimum: 0 }, completeSchedules: { type: 'integer', minimum: 0 } } },
    rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['ticker', 'cik', 'name', 'sectorId', 'profile', 'cashShortfallToNext12m'], properties: {
      ticker: { type: 'string' }, cik: { type: 'string' }, name: { type: 'string' }, sectorId: { type: 'string' }, cashShortfallToNext12m: { type: ['number', 'null'], minimum: 0 },
      profile: { type: 'object', required: ['schemaVersion', 'status', 'currency', 'sourceUrl', 'accession', 'basis', 'buckets', 'metrics', 'coverage', 'warnings'], properties: {
        schemaVersion: { const: 'refinancing-v1' }, status: { const: 'ready' }, currency: { const: 'USD' }, sourceUrl: { type: 'string' }, accession: { type: 'string' }, basis: { enum: ['fiscal', 'rolling'] },
        buckets: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'object', required: ['key', 'value', 'dateBasis', 'tag'], properties: { key: { type: 'string' }, value: { type: ['number', 'null'], minimum: 0 }, dateBasis: { enum: ['calendar-year', 'anniversary-estimate'] }, tag: { type: 'string' } } } },
        metrics: { type: 'object' }, coverage: { type: 'object', required: ['reportedBuckets', 'totalBuckets', 'complete'], properties: { reportedBuckets: { type: 'integer', minimum: 1, maximum: 6 }, totalBuckets: { const: 6 }, complete: { type: 'boolean' } } }, warnings: stringListSchema,
      } },
    } } },
  } },
});
