import { bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { x402DiscoveryOptions, X402_SERVICE_METADATA } from './x402Discovery.js';

export const X402_DOCUMENTATION_URL = 'https://secedgarterminal.com/data-access';
export const X402_DISCOVERY_VERSION = 'edgar.x402-catalog.v1';
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAGE_PARAMETERS = [
  { name: 'limit', in: 'query', values: ['1–100'], default: '100' },
  { name: 'offset', in: 'query', values: ['0–9999'], default: '0' },
  { name: 'snapshot', in: 'query', values: ['Exact snapshot token returned by the first page'], default: 'current' },
];

/** This public catalog describes paid delivery, not payment authorization. */
export const X402_RESOURCES = [
  {
    id: 'financial-changes', name: 'Financial change evidence', path: '/api/x402/v1/financial-changes', method: 'GET',
    description: 'Compare latest financial observations with a compatible prior period, preserving units, calculation inputs and SEC evidence in a compact packet.',
    useCase: 'Answer what changed across a watchlist without parsing full financial histories.',
    includes: ['Latest and comparable baseline observations for selected metrics', 'Absolute changes, eligible growth rates and percentage-point margin changes', 'Compact SEC source and calculation references; explicit reasons for withheld comparisons'],
    formats: ['json', 'csv'], limits: '1–10 distinct issuers; 1–12 metric keys; up to 4 MiB.',
    parameters: [{ name: 'tickers', in: 'query', values: ['1–10 unique company tickers'], default: 'required' }, { name: 'basis', in: 'query', values: ['annual', 'quarter', 'ytd', 'ttm'], default: 'annual' }, { name: 'comparison', in: 'query', values: ['year', 'previous (annual or quarter only)'], default: 'year' }, { name: 'metrics', in: 'query', values: ['Up to 12 supported metric keys; see OpenAPI'], default: '11 core metrics' }, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/financial-changes?tickers=AAPL%2CMSFT&basis=annual&comparison=year',
    limitations: 'Latest-filed values, including revisions; this is not a filing-text diff or an as-filed archive. Incompatible comparisons are withheld. Percentage growth is withheld for zero or negative bases. All selected issuers need at least one compatible pair.',
  },
  {
    id: 'disclosure-evidence', name: 'Disclosure evidence search', path: '/api/x402/v1/disclosure-evidence', method: 'GET',
    description: 'Find exact Boolean-matched original paragraphs in the prepared filing corpus, with source links, filing context and extraction coverage.',
    useCase: 'Ground agent answers in disclosure passages with enough context to inspect qualifications and negations.',
    includes: ['Full retained matching paragraphs, never cropped around a keyword', 'Issuer, accession, section, passage identity and SEC document link', 'Prepared corpus coverage and raw-candidate pagination with exact query verification'],
    formats: ['json', 'csv'], limits: 'Up to 20 evidence paragraphs per request; up to 120 candidates checked.',
    parameters: [{ name: 'query', in: 'query', values: ['Literal terms, phrases, AND, OR, NOT and parentheses; up to 16 terms'], default: 'required' }, { name: 'ciks', in: 'query', values: ['Optional 1–10 zero-padded issuer CIKs'], default: 'all prepared issuers' }, { name: 'forms / section', in: 'query', values: ['Supported SEC forms / all, risk, mda, notes, other or 8k item'], default: 'documented defaults' }, { name: 'start / end', in: 'query', values: ['Inclusive filing dates within two-year retention'], default: 'retention window / today' }, { name: 'limit / offset', in: 'query', values: ['1–20 paragraphs / 0–9999 raw candidate offset'], default: '10 / 0' }, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/disclosure-evidence?query=liquidity&limit=10',
    limitations: 'A limited prepared corpus with partial document extraction, not all EDGAR or an exhaustive list of mentions. Matches verify the query within each retained paragraph, not document-wide absence. Candidate pagination can change as the corpus updates. No matches are not settled.',
  },
  {
    id: 'institutional-overlap', name: 'Institutional holdings overlap', path: '/api/x402/v1/institutional-overlap', method: 'GET',
    description: 'Reconcile shared reported positions across two to four same-quarter complete prepared 13F manager portfolios.',
    useCase: 'Find common institutional positions while preserving security classes, options and each manager’s reported exposure.',
    includes: ['Shared positions with per-manager shares, USD value and portfolio weights', 'Security identity, matching method and amendment-chain sources', 'Complete-input checks, reporting quarter, source-check dates and snapshot-pinned export pages'],
    formats: ['json', 'csv'], limits: '2–4 managers; up to 100 positions per page; up to 4 MiB.',
    parameters: [{ name: 'ciks', in: 'query', values: ['2–4 unique zero-padded manager CIKs'], default: 'required' }, { name: 'period', in: 'query', values: ['Optional retained quarter end'], default: 'aligned latest prepared quarters' }, { name: 'minimumManagers', in: 'query', values: ['2–4, no more than selected managers'], default: '2' }, { name: 'sort / order', in: 'query', values: ['reportedValue or cusip / asc or desc'], default: 'reportedValue / desc' }, ...PAGE_PARAMETERS, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/institutional-overlap?ciks=0001067983%2C0001350694&limit=100&offset=0',
    limitations: 'Historical disclosed 13F positions, not current holdings, trades, flows, performance or a complete manager balance sheet. All managers must have complete, uninvalidated prepared evidence for the same quarter; missing prior quarters are unavailable. Stale source checks remain visible.',
  },
  {
    id: 'financial-batch',
    name: 'Financial research bundles',
    path: '/api/x402/v1/financial-batch', method: 'GET',
    description: 'Normalize up to ten prepared company financial histories into one source-linked JSON bundle or flat CSV export.',
    useCase: 'Build company comparisons and research datasets with one request.',
    includes: ['Selected company histories on one reporting basis', 'Metric definitions, reporting dates and source references', 'Flat metric-period CSV for spreadsheets and data pipelines'],
    formats: ['json', 'csv'], limits: '1–10 unique tickers; response up to 4 MiB.',
    parameters: [{ name: 'tickers', in: 'query', values: ['1–10 comma-separated tickers'], default: 'required' }, { name: 'basis', in: 'query', values: ['annual', 'quarter', 'ytd', 'ttm'], default: 'annual' }, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/financial-batch?tickers=AAPL%2CMSFT&basis=annual',
    limitations: 'All selected companies must have usable prepared coverage. History varies by company; latest-filed values are not an as-filed archive. Unavailable or oversized bundles are not settled.',
  },
  {
    id: 'fundamental-screen', name: 'Fundamental screens & exports',
    path: '/api/x402/v1/fundamental-screen', method: 'GET',
    description: 'Filter and rank retained SEC fundamentals by sector, metric and range, then export consistent JSON or CSV pages.',
    useCase: 'Find comparable companies and build a reproducible fundamental screen.',
    includes: ['Sector selection, metric filters and peer percentiles', 'Current, prior or change values with missing-data controls', 'Deterministic sorting, reporting context and snapshot-pinned pagination'],
    formats: ['json', 'csv'], limits: 'Up to 100 companies per page; offset up to 9,999.',
    parameters: [{ name: 'basis', in: 'query', values: ['ttm', 'annual'], default: 'ttm' }, { name: 'sector', in: 'query', values: ['all or sector slug'], default: 'all' }, { name: 'metric', in: 'query', values: ['revenueGrowth', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'netMargin', 'cashToAssets'], default: 'revenueGrowth' }, { name: 'field', in: 'query', values: ['change', 'current', 'prior'], default: 'change' }, { name: 'min / max', in: 'query', values: ['Optional numeric bounds'], default: 'none' }, { name: 'sort / order', in: 'query', values: ['metric or ticker / desc or asc'], default: 'metric / desc' }, { name: 'missing', in: 'query', values: ['exclude', 'include'], default: 'exclude' }, ...PAGE_PARAMETERS, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/fundamental-screen?basis=ttm&limit=100&offset=0',
    limitations: 'Prepared retained snapshots only. Missing values remain unavailable. Accounting fundamentals are not security returns; empty results and snapshot conflicts are not settled.',
  },
  {
    id: 'credit-screen', name: 'Debt & liquidity screens',
    path: '/api/x402/v1/credit-screen', method: 'GET',
    description: 'Select and rank prepared debt maturity, cash coverage and interest coverage evidence with JSON or CSV export.',
    useCase: 'Prioritize companies for refinancing and liquidity research.',
    includes: ['First maturity bucket (next fiscal year or rolling twelve months), cash coverage and descriptive cash-shortfall calculations', 'Reported or complete source-coverage selection', 'Company-level maturity evidence and stable export pages'],
    formats: ['json', 'csv'], limits: 'Up to 100 companies per page; offset up to 9,999.',
    parameters: [{ name: 'sector', in: 'query', values: ['all or sector slug'], default: 'all' }, { name: 'minDebt', in: 'query', values: ['Optional first maturity bucket minimum in USD (next fiscal year or rolling twelve months)'], default: 'none' }, { name: 'maxCashCoverage', in: 'query', values: ['Optional maximum cash / first maturity bucket ratio'], default: 'none' }, { name: 'minInterestCoverage', in: 'query', values: ['Optional minimum interest coverage ratio'], default: 'none' }, { name: 'coverage', in: 'query', values: ['reported', 'complete'], default: 'reported' }, { name: 'sort / order', in: 'query', values: ['next12m, cashToNext12m, interestCoverage or ticker / desc or asc'], default: 'next12m / desc' }, ...PAGE_PARAMETERS, { name: 'format', in: 'query', values: ['json', 'csv'], default: 'json' }],
    example: '/api/x402/v1/credit-screen?limit=100&offset=0',
    limitations: 'Filing-based estimates and explicitly incomplete coverage, not credit ratings or a live financing feed. Empty results and snapshot conflicts are not settled.',
  },
  {
    id: 'financials',
    name: 'Company financials',
    path: '/api/x402/v1/financials/{ticker}',
    method: 'GET',
    description: 'Prepared company financial history with reporting periods, units and SEC source evidence.',
    parameters: [{ name: 'basis', in: 'query', values: ['annual', 'quarter', 'ytd', 'ttm'], default: 'annual' }],
    example: '/api/x402/v1/financials/AAPL?basis=annual',
    limitations: 'Available prepared coverage only. No historical filing-cutoff guarantee or new SEC acquisition.',
  },
  {
    id: 'refinancing',
    name: 'Refinancing snapshot',
    path: '/api/x402/v1/refinancing',
    method: 'GET',
    description: 'A page of the prepared corporate debt-maturity snapshot with company coverage, liquidity context and filing evidence.',
    parameters: PAGE_PARAMETERS,
    example: '/api/x402/v1/refinancing?limit=100&offset=0',
    limitations: 'Each successful page is a paid request. Pin the returned snapshot token on later pages; a changed snapshot returns 409 without settlement.',
  },
  {
    id: 'factor-universe',
    name: 'SEC fundamental universe',
    path: '/api/x402/v1/factor-universe',
    method: 'GET',
    description: 'A page of filing-based company and sector fundamentals with equal-issuer-weight breadth and explicit coverage.',
    parameters: [{ name: 'basis', in: 'query', values: ['ttm', 'annual'], default: 'ttm' }, ...PAGE_PARAMETERS],
    example: '/api/x402/v1/factor-universe?basis=ttm&limit=100&offset=0',
    limitations: 'Retained snapshots only; unavailable snapshots return 503 without settlement. Each successful page is paid. Pin the snapshot token on later pages. Accounting fundamentals are not security prices or returns.',
  },
];

export function buildX402Catalog(configuration) {
  const token = configuration.network === SOLANA_MAINNET ? { asset: SOLANA_USDC, amount: '10000', decimals: 6 } : {};
  return {
    schemaVersion: X402_DISCOVERY_VERSION,
    ...configuration,
    ...token,
    documentation: X402_DOCUMENTATION_URL,
    openapi: 'https://secedgarterminal.com/openapi.json',
    terms: 'https://secedgarterminal.com/terms',
    privacy: 'https://secedgarterminal.com/privacy',
    billingUnit: 'One successfully settled GET response from a listed paid endpoint.',
    publicResearch: 'Public research pages and existing public summaries remain freely accessible.',
    discovery: {
      extension: 'bazaar',
      metadata: 'enabled',
      indexing: 'concrete-path',
      catalogRegistration: 'facilitator-dependent',
      documentation: 'https://docs.x402.org/extensions/bazaar',
      ...X402_SERVICE_METADATA,
      note: 'Paid offers publish discovery metadata. External directory listing, indexing and demand depend on participating facilitators; this catalog does not assert listing status.',
    },
    resources: X402_RESOURCES.map(resource => {
      const { routePattern, omitDiscoveryRouteTemplate, extensions, ...metadata } = x402DiscoveryOptions(resource.id);
      const path = new URL(resource.example, 'https://secedgarterminal.com').pathname;
      let declaration = bazaarResourceServerExtension.enrichDeclaration(extensions.bazaar, {
        method: 'GET', routePattern, adapter: { getPath: () => path },
      });
      if (omitDiscoveryRouteTemplate) {
        const { routeTemplate: _routeTemplate, ...concrete } = declaration;
        declaration = concrete;
      }
      return { ...resource, price: configuration.price, currency: configuration.currency, network: configuration.network, ...token,
        discovery: { indexing: 'concrete-path', ...metadata, extensions: { ...extensions, bazaar: declaration } },
      };
    }),
  };
}
