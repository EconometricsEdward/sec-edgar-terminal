import { X402_FINANCIAL_CHANGES_SCHEMA } from './x402FinancialChangesSchema.js';
import { X402_DISCLOSURE_EVIDENCE_SCHEMA } from './x402DisclosureEvidenceSchema.js';
import { X402_INSTITUTIONAL_OVERLAP_SCHEMA } from './x402InstitutionalOverlapSchema.js';
import { X402_BANK_RISK_BATCH_SCHEMA, X402_BANK_RISK_BATCH_DESCRIPTOR } from './x402BankRiskBatchSchema.js';
import { X402_DISCLOSURE_TOPIC_PACKET_SCHEMA, X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR } from './x402DisclosureTopicPacketSchema.js';

const format = { type: 'string', enum: ['json', 'csv'], default: 'json' };
const ciks = { type: 'string', pattern: '^(?!0000000000)[0-9]{10}(,(?!0000000000)[0-9]{10}){0,9}$', description: 'Unique nonzero zero-padded SEC issuer identifiers.' };
const query = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const page = { limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 }, offset: { type: 'integer', minimum: 0, maximum: 9999, default: 0 }, snapshot: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Reuse pagination.snapshot with identical manager selection, quarter and sorting.' } };
export const X402_EVIDENCE_SCHEMAS = Object.freeze({
  'bank-risk-batch': X402_BANK_RISK_BATCH_SCHEMA,
  'disclosure-topic-packet': X402_DISCLOSURE_TOPIC_PACKET_SCHEMA,
  'financial-changes': X402_FINANCIAL_CHANGES_SCHEMA,
  'disclosure-evidence': X402_DISCLOSURE_EVIDENCE_SCHEMA,
  'institutional-overlap': X402_INSTITUTIONAL_OVERLAP_SCHEMA,
});
export const X402_EVIDENCE_DESCRIPTORS = Object.freeze({
  'bank-risk-batch': X402_BANK_RISK_BATCH_DESCRIPTOR,
  'disclosure-topic-packet': X402_DISCLOSURE_TOPIC_PACKET_DESCRIPTOR,
  'financial-changes': {
    routePattern: '/api/x402/v1/financial-changes', tags: ['finance', 'SEC', 'financial-changes', 'evidence', 'csv'],
    input: { tickers: 'AAPL,MSFT', basis: 'annual', comparison: 'year' },
    inputSchema: query({
      tickers: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9.-]{0,14}(,[A-Za-z][A-Za-z0-9.-]{0,14}){0,9}$', description: 'One to ten unique tickers. Multiple securities of the same issuer are rejected.' },
      basis: { type: 'string', enum: ['annual', 'quarter', 'ytd', 'ttm'], default: 'annual' },
      comparison: { type: 'string', enum: ['year', 'previous'], default: 'year', description: 'Same season a year earlier, or previous standalone quarter/annual period. previous is unavailable for YTD and TTM.' },
      metrics: { type: 'string', pattern: '^(revenue|operatingIncome|netIncome|operatingCashFlow|freeCashFlow|cash|totalAssets|totalLiabilities|equity|operatingMargin|netMargin|totalDebt)(,(revenue|operatingIncome|netIncome|operatingCashFlow|freeCashFlow|cash|totalAssets|totalLiabilities|equity|operatingMargin|netMargin|totalDebt)){0,11}$', description: 'One to twelve unique supported keys. Omit for eleven core metrics.' }, format,
    }, ['tickers']),
  },
  'disclosure-evidence': {
    routePattern: '/api/x402/v1/disclosure-evidence', tags: ['finance', 'SEC', 'disclosure-search', 'evidence', 'csv'],
    input: { query: 'liquidity', limit: 10 },
    inputSchema: query({
      query: { type: 'string', minLength: 2, maxLength: 1000, description: 'Literal words, quoted phrases, AND, OR, NOT and parentheses; at most sixteen terms with at least one positive term. Exact matching within each retained original paragraph.' },
      ciks, forms: { type: 'string', description: 'Comma-separated supported SEC forms, including optional /A forms. Omit to search all supported prepared forms; see the output schema for the whitelist.' },
      section: { type: 'string', pattern: '^(all|risk|mda|notes|other|8k:[0-9]\\.[0-9]{2})$', default: 'all' },
      start: { type: 'string', format: 'date', description: 'Inclusive filing date, within the prepared two-year retention window.' },
      end: { type: 'string', format: 'date', description: 'Inclusive filing date, no later than today.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }, offset: page.offset, format,
    }, ['query']),
  },
  'institutional-overlap': {
    routePattern: '/api/x402/v1/institutional-overlap', tags: ['finance', '13F', 'institutional-holdings', 'overlap', 'csv'],
    input: { ciks: '0001067983,0001350694', period: '2026-06-30', limit: 100, offset: 0 },
    inputSchema: query({
      ciks: { ...ciks, pattern: '^(?!0000000000)[0-9]{10}(,(?!0000000000)[0-9]{10}){1,3}$', description: 'Two to four unique manager CIKs with complete prepared portfolios.' },
      period: { type: 'string', pattern: '^[0-9]{4}-(03-31|06-30|09-30|12-31)$', description: 'Exact retained quarter, or omit to require aligned latest prepared quarters.' },
      minimumManagers: { type: 'integer', minimum: 2, maximum: 4, default: 2 },
      sort: { type: 'string', enum: ['reportedValue', 'cusip'], default: 'reportedValue' },
      order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' }, ...page, format,
    }, ['ciks']),
  },
});
