import { X402_PRODUCT_RESPONSE_SCHEMAS } from './x402ProductSchemas.js';

export const X402_SERVICE_METADATA = Object.freeze({
  serviceName: 'SEC EDGAR Terminal',
  iconUrl: 'https://secedgarterminal.com/favicon.svg',
});

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true });
const basis = (values, fallback) => ({ type: 'string', enum: values, default: fallback, description: 'Financial reporting basis; availability varies by company.' });
const pageProperties = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'Company rows per paid page. Each successfully settled page costs 0.01 USDC.' },
  offset: { type: 'integer', minimum: 0, maximum: 9999, default: 0, description: 'Zero-based row offset into the prepared snapshot.' },
  snapshot: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Pin pagination.snapshot from the first page on later requests. A changed snapshot returns 409 without settlement.' },
};
const pagination = object({
  ...pageProperties,
  total: { type: 'integer', minimum: 1 },
  nextOffset: { type: ['integer', 'null'], description: 'Next page offset, or null after the last page.' },
}, ['offset', 'limit', 'total', 'nextOffset', 'snapshot']);
const exportFormat = { type: 'string', enum: ['json', 'csv'], default: 'json', description: 'JSON result or flat CSV with source and pagination context.' };
const sector = { type: 'string', default: 'all', description: 'all, or an existing sector slug returned in the source snapshot.' };
const numericBound = { type: 'number', minimum: -1e15, maximum: 1e15 };
const screenOutput = version => object({
  schemaVersion: { type: 'string', const: version },
  status: { type: 'string' }, stale: { type: 'boolean' },
  selection: { type: 'object', additionalProperties: true },
  snapshot: { type: 'object', additionalProperties: true },
  population: { type: 'object', additionalProperties: true },
  rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: true } },
  pagination,
  limitations: { type: 'array', items: { type: 'string' } },
}, ['schemaVersion', 'status', 'stale', 'selection', 'snapshot', 'population', 'rows', 'pagination', 'limitations']);
const pageOutput = (version, field, factor = false) => object({
  schemaVersion: { type: 'string', const: version },
  snapshot: { type: 'object', additionalProperties: true, description: 'Prepared snapshot metadata with dates, methodology, coverage and stale flags when available.' },
  [field]: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: true }, description: 'Requested company page. Missing facts remain unavailable, not zero.' },
  pagination: factor ? { ...pagination, properties: { ...pagination.properties, basis: basis(['ttm', 'annual'], 'ttm') } } : pagination,
}, ['schemaVersion', 'snapshot', field, 'pagination']);

// Schemas describe real response contracts; no invented financial values are
// published as examples or implied to be live source data.
export const X402_OUTPUT_SCHEMAS = Object.freeze({
  financials: object({
    schemaVersion: { type: 'string', const: 'edgar.paid-financials.v1' },
    status: { type: 'string', const: 'ready' },
    stale: { type: 'boolean' },
    fetchedAt: { type: 'string', description: 'ISO 8601 source preparation timestamp.' },
    checkedAt: { type: 'string', description: 'ISO 8601 preparation or revalidation timestamp.' },
    freshUntil: { type: 'string', description: 'ISO 8601 prepared-cache freshness deadline.' },
    model: object({
      packed: { type: 'boolean', const: true },
      ticker: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,14}$' },
      cik: { type: 'string', pattern: '^(?!0+$)[0-9]{10}$' },
      name: { type: 'string' },
      basis: basis(['annual', 'quarter', 'ytd', 'ttm'], 'annual'),
      asOf: { type: 'string', const: '', description: 'No as-filed historical cutoff is provided.' },
      periods: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: true } },
      definitions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      metrics: { type: 'object', additionalProperties: true },
      sourceCatalog: { type: 'array' },
      calculationCatalog: { type: 'array' },
    }, ['packed', 'ticker', 'cik', 'basis', 'periods', 'definitions', 'metrics', 'sourceCatalog', 'calculationCatalog']),
    limitations: { type: 'array', items: { type: 'string' } },
  }, ['schemaVersion', 'status', 'stale', 'fetchedAt', 'checkedAt', 'freshUntil', 'model', 'limitations']),
  refinancing: pageOutput('edgar.paid-refinancing-page.v1', 'companies'),
  'factor-universe': pageOutput('edgar.paid-factor-page.v1', 'rows', true),
  'financial-batch': object({
    schemaVersion: { type: 'string', const: 'edgar.paid-financial-batch.v1' }, status: { type: 'string', const: 'ready' },
    selection: object({ tickers: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string' } }, basis: basis(['annual', 'quarter', 'ytd', 'ttm'], 'annual') }, ['tickers', 'basis']),
    stale: { type: 'boolean' }, companyCount: { type: 'integer', minimum: 1, maximum: 10 },
    companies: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', additionalProperties: true }, description: 'Validated prepared financial envelopes with metric definitions and SEC evidence.' },
    limitations: { type: 'array', items: { type: 'string' } },
  }, ['schemaVersion', 'status', 'selection', 'stale', 'companyCount', 'companies', 'limitations']),
  'fundamental-screen': screenOutput('edgar.paid-fundamental-screen.v1'),
  'credit-screen': screenOutput('edgar.paid-credit-screen.v1'),
  ...X402_PRODUCT_RESPONSE_SCHEMAS,
});

const strictQuery = properties => ({ type: 'object', properties, additionalProperties: false });
export const X402_DISCOVERY_DESCRIPTORS = Object.freeze({
  financials: {
    routePattern: '/api/x402/v1/financials/:ticker',
    // Keep SDK path-parameter enrichment, but let facilitator probes target a
    // concrete supported ticker rather than the literal template placeholder.
    omitDiscoveryRouteTemplate: true,
    tags: ['finance', 'SEC', 'financial-statements', 'filing-evidence'],
    input: { basis: 'annual' },
    inputSchema: strictQuery({ basis: basis(['annual', 'quarter', 'ytd', 'ttm'], 'annual') }),
    pathParams: { ticker: 'AAPL' },
    pathParamsSchema: { type: 'object', properties: { ticker: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,14}$', description: 'Public company ticker; only prepared SEC coverage is accepted. Numeric CIKs are not supported.' } }, required: ['ticker'], additionalProperties: false },
  },
  refinancing: {
    routePattern: '/api/x402/v1/refinancing',
    tags: ['finance', 'SEC', 'refinancing', 'debt-maturities'],
    input: { limit: 100, offset: 0 },
    inputSchema: strictQuery(pageProperties),
  },
  'factor-universe': {
    routePattern: '/api/x402/v1/factor-universe',
    tags: ['finance', 'SEC', 'fundamentals', 'sector-analysis'],
    input: { basis: 'ttm', limit: 100, offset: 0 },
    inputSchema: strictQuery({ basis: basis(['ttm', 'annual'], 'ttm'), ...pageProperties }),
  },
  'financial-batch': {
    routePattern: '/api/x402/v1/financial-batch', tags: ['finance', 'SEC', 'batch-research', 'financial-statements', 'csv'],
    input: { tickers: 'AAPL,MSFT', basis: 'annual' },
    inputSchema: { ...strictQuery({ tickers: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,14}(,[A-Za-z][A-Za-z0-9.-]{0,14}){0,9}$', description: 'One to ten unique company tickers, comma separated.' }, basis: basis(['annual', 'quarter', 'ytd', 'ttm'], 'annual'), format: exportFormat }), required: ['tickers'] },
  },
  'fundamental-screen': {
    routePattern: '/api/x402/v1/fundamental-screen', tags: ['finance', 'SEC', 'screening', 'peer-comparison', 'csv'],
    input: { basis: 'ttm', limit: 100, offset: 0 },
    inputSchema: strictQuery({ basis: basis(['ttm', 'annual'], 'ttm'), sector,
      metric: { type: 'string', enum: ['revenueGrowth', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'netMargin', 'cashToAssets'], default: 'revenueGrowth' },
      field: { type: 'string', enum: ['change', 'current', 'prior'], default: 'change' }, min: numericBound, max: numericBound,
      sort: { type: 'string', enum: ['metric', 'ticker'], default: 'metric' }, order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
      missing: { type: 'string', enum: ['exclude', 'include'], default: 'exclude' }, ...pageProperties, format: exportFormat }),
  },
  'credit-screen': {
    routePattern: '/api/x402/v1/credit-screen', tags: ['finance', 'SEC', 'credit-research', 'debt-maturities', 'csv'],
    input: { limit: 100, offset: 0 },
    inputSchema: strictQuery({ sector, minDebt: { ...numericBound, minimum: 0, description: 'Minimum reported principal in the first maturity bucket (next fiscal year or rolling twelve months), in USD.' },
      maxCashCoverage: { ...numericBound, minimum: 0, description: 'Maximum cash divided by principal in the first maturity bucket (next fiscal year or rolling twelve months).' }, minInterestCoverage: numericBound,
      coverage: { type: 'string', enum: ['reported', 'complete'], default: 'reported' },
      sort: { type: 'string', enum: ['next12m', 'cashToNext12m', 'interestCoverage', 'ticker'], default: 'next12m' },
      order: { type: 'string', enum: ['desc', 'asc'], default: 'desc' }, ...pageProperties, format: exportFormat }),
  },
});

