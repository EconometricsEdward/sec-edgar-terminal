import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

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
});

const strictQuery = properties => ({ type: 'object', properties, additionalProperties: false });
export const X402_DISCOVERY_DESCRIPTORS = Object.freeze({
  financials: {
    routePattern: '/api/x402/v1/financials/:ticker',
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
});

export function x402DiscoveryOptions(resourceId) {
  const descriptor = X402_DISCOVERY_DESCRIPTORS[resourceId];
  if (!descriptor) throw new Error('Unknown x402 discovery resource');
  const { routePattern, tags, ...declaration } = structuredClone(descriptor);
  const extensions = declareDiscoveryExtension(declaration);
  // The helper only retains an output schema alongside a sample. Publish a
  // schema-only output declaration instead of fabricating a financial record.
  extensions.bazaar.info.output = { type: 'json' };
  extensions.bazaar.schema.properties.output = {
    type: 'object',
    properties: {
      type: { type: 'string', const: 'json' },
      example: structuredClone(X402_OUTPUT_SCHEMAS[resourceId]),
    },
    required: ['type'],
    additionalProperties: false,
  };
  return { ...X402_SERVICE_METADATA, tags, routePattern, extensions };
}
