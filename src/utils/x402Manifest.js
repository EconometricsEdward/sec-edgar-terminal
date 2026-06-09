const SITE = 'https://secedgarterminal.com';
const SCOUTGATE_PROXY_BASE = 'https://x402-scoutgate.onrender.com/api/2f9ca2f9';
const SCOUTGATE_PROXY_EXAMPLE = `${SCOUTGATE_PROXY_BASE}?ticker=AAPL`;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const REGISTERED_PAYOUT_ADDRESS = '0x91D59f9932557c8347AaAC800756E49A1cEDc794';

export const x402Manifest = {
  schema: 'https://secedgarterminal.com/.well-known/x402.json',
  manifestVersion: '2026-06-09',
  name: 'EDGAR Terminal SEC Snapshot',
  description:
    'Pay-per-call JSON snapshots of public SEC filing metadata by ticker for agents and research scripts.',
  homepage: `${SITE}/`,
  docs: `${SITE}/paid-api`,
  openapi: `${SITE}/openapi.json`,
  llms: `${SITE}/llms.txt`,
  wellKnown: {
    canonical: `${SITE}/.well-known/x402`,
    json: `${SITE}/.well-known/x402.json`,
    paidApi: `${SITE}/.well-known/edgar-paid-api.json`,
  },
  boundaries: [
    'Public SEC data only.',
    'No private data, account data, forecasts, or trading recommendations.',
    'For research and educational use only.',
    'Not investment, financial, legal, or tax advice.',
  ],
  resources: [
    {
      resource: SCOUTGATE_PROXY_BASE,
      example: SCOUTGATE_PROXY_EXAMPLE,
      type: 'http',
      method: 'GET',
      x402Version: 1,
      category: 'finance',
      pricing: {
        amountUsd: '0.01',
        currency: 'USDC',
        network: 'eip155:8453',
        networkName: 'Base mainnet',
        asset: BASE_USDC,
        maxAmountRequired: '10000',
        decimals: 6,
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: BASE_USDC,
          maxAmountRequired: '10000',
          payToSource: 'Call the resource to receive the authoritative ScoutGate paymentRequirements.payTo value.',
        },
      ],
      registeredPayoutAddress: REGISTERED_PAYOUT_ADDRESS,
      settlementNote:
        'ScoutGate returns a platform-mediated x402 challenge. Treat the challenge payTo as ScoutGate-controlled and count revenue only after USDC reaches the registered payout address.',
      metadata: {
        product: 'EDGAR Terminal SEC Snapshot',
        description:
          'Compact public SEC filing snapshot JSON with CIK, company identity, recent 10-K, 10-Q, 8-K, proxy and amendment filing rows, and source SEC URLs.',
        mimeType: 'application/json',
        input: {
          ticker: 'AAPL',
        },
        inputSchema: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              pattern: '^[A-Z0-9.-]{1,12}$',
              description: 'Public-company ticker symbol.',
            },
          },
          required: ['ticker'],
        },
        output: {
          status: 'ok',
          snapshot: {
            ticker: 'AAPL',
            found: true,
            cik: '0000320193',
            latestFilings: [],
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            product: { type: 'string' },
            snapshot: { type: 'object' },
            boundaries: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['status', 'snapshot', 'boundaries'],
        },
      },
    },
  ],
  alternatives: [
    {
      name: 'Native Solana memo HTTP 402 path',
      endpoint: `${SITE}/api/paid/snapshot?ticker=AAPL`,
      protocol: 'solana-direct-memo',
      price: '0.001 SOL',
      docs: `${SITE}/paid-api`,
      note: 'This is a native HTTP 402-style Solana memo flow, not the ScoutGate x402 USDC proxy.',
    },
  ],
  discovery: {
    x402ScoutCatalog: 'https://x402scout.com/catalog?q=EDGAR',
    x402ScoutProxy: SCOUTGATE_PROXY_BASE,
    suggestedDnsTxt:
      'v=x4021;descriptor=api;url=https://secedgarterminal.com/.well-known/x402',
  },
};
