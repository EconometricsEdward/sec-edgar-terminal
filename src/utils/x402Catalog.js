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
    resources: X402_RESOURCES.map(resource => ({ ...resource, price: configuration.price, currency: configuration.currency, network: configuration.network, ...token })),
  };
}
