import { buildX402Catalog, X402_DOCUMENTATION_URL } from './x402Catalog.js';
import { buildX402BuyerExample } from './x402BuyerExample.js';

const ORIGIN = 'https://secedgarterminal.com';
const AVAILABILITY_PRODUCTS = ['disclosure-topic-packet', 'bank-risk-batch', 'financial-changes', 'disclosure-evidence', 'institutional-overlap'];

export const X402_DOCUMENTATION_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Link',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, follow',
  Allow: 'GET, HEAD, OPTIONS',
  Link: '</api/x402>; rel="service-desc"; type="application/json", </openapi.json>; rel="service-desc"; type="application/json", </llms.txt>; rel="describedby"; type="text/plain"',
});

/** Public machine instructions use the same effective offer and tested buyer source. */
export function buildX402Documentation(configuration) {
  const catalog = buildX402Catalog(configuration);
  const directoryQuery = new URLSearchParams({ limit: '100', ...(configuration.payTo ? { payTo: configuration.payTo } : {}) });
  const searchQuery = new URLSearchParams({ query: 'SEC EDGAR Terminal', ...(configuration.payTo ? { payTo: configuration.payTo } : {}) });
  return {
    schemaVersion: 'edgar.x402-documentation.v1',
    serviceName: 'SEC EDGAR Terminal',
    url: X402_DOCUMENTATION_URL,
    audience: 'Crawlers, agents and other x402-compatible machine clients',
    contentType: 'application/json',
    access: {
      discoveryFree: true,
      publicResearchFree: true,
      subscriptionRequired: false,
      apiKeyRequired: false,
      paymentRequired: 'Paid resource GETs require x402 payment regardless of user agent. Page visits and ordinary crawling are not automatically billed.',
      visibility: 'This machine document is public, omitted from human navigation and excluded from search indexing. It uses the same response for all clients.',
    },
    catalog,
    integration: {
      catalogUrl: `${ORIGIN}/api/x402`,
      openapiUrl: `${ORIGIN}/openapi.json`,
      agentGuideUrl: `${ORIGIN}/llms.txt`,
      workflow: [
        { step: 1, action: 'Read the free catalog and select the exact product URL, parameters and representation. Respect resource bounds and required selectors.' },
        { step: 2, action: 'Check free prepared coverage for supported evidence products. Readiness is a check, not a data reservation or a promise of later availability.' },
        { step: 3, action: 'Inspect an unsigned GET or bodyless HEAD payment challenge. HTTP 402 and PAYMENT-REQUIRED advertise the GET offer, not guaranteed prepared coverage.' },
        { step: 4, action: 'Check the exact resource URL, scheme, version, network, USDC mint, recipient and 10000 base-unit amount before authorizing one bounded GET.' },
        { step: 5, action: 'An x402-compatible client retries the exact GET with PAYMENT-SIGNATURE. Data and PAYMENT-RESPONSE are delivered only after verification and successful settlement.' },
        { step: 6, action: 'Preserve the receipt, coverage, periods, units, nulls, stale status, source evidence and snapshot context. Reconcile pending or unknown settlement before another authorization.' },
      ],
      clientStarter: {
        language: 'javascript',
        runtime: 'Node.js',
        fileExtension: '.mjs',
        installCommand: 'npm install @x402/core@2.28.0 @x402/fetch@2.28.0 @x402/svm@2.28.0 @solana/kit@6.9.0',
        environment: {
          PAYER_KEYPAIR_FILE: 'Absolute path to a private local Solana CLI 64-byte keypair JSON file for a funded development wallet. Never upload it.',
          RECOVERY_FILE: 'A new private file in an existing local directory. Use a unique filename for each purchase; exclusive creation refuses overwrite.',
        },
        purpose: 'Retrieves one prepared fundamental-universe page with the effective public recipient and network, exact offer validation and a 0.01 per-payment cap. Save source locally as a .mjs file.',
        productionControls: 'Use a constrained signer, total spending budget and request limit. The per-payment cap alone is not a total budget.',
        recoveryControls: 'Persists recovery details before the first request. Use the saved file to recover that same purchase; a new authorization is not a delivery retry.',
        source: buildX402BuyerExample(configuration),
      },
      officialBuyerGuide: 'https://docs.x402.org/getting-started/quickstart-for-buyers',
      solanaGuide: 'https://solana.com/docs/payments/agentic-payments/x402',
    },
    preflight: {
      free: true,
      method: 'GET',
      endpoint: `${ORIGIN}/api/x402/availability`,
      selection: 'Supply product={id} and the explicit documented selection for that product, including required selectors. Do not supply payment or recovery headers.',
      products: catalog.resources.filter(resource => AVAILABILITY_PRODUCTS.includes(resource.id)).map(resource => ({
        id: resource.id,
        example: `${ORIGIN}/api/x402/availability?product=${resource.id}&${new URL(resource.example, ORIGIN).searchParams}`,
      })),
      result: 'A readiness summary with counts, stale status and optional packet dataVersion; no purchased paragraphs or rows. Prepared coverage may change before purchase.',
    },
    billing: {
      price: catalog.price,
      currency: catalog.currency,
      network: catalog.network,
      amount: catalog.amount,
      asset: catalog.asset,
      unit: catalog.billingUnit,
      examples: 'One financial batch of up to ten companies is one retrieval. Each successfully settled page of a screen or paginated dataset is a separate retrieval.',
      uncharged: 'Invalid selections, unavailable data, no matches, changed snapshots, off-page requests and oversized output are not settled. Public pages, catalog, documentation and existing public API previews remain free.',
      status: configuration.status,
      readiness: {
        active: 'Payment configuration and the required public recipient readiness check permit paid offers. This does not guarantee prepared data availability.',
        'recipient-setup-required': 'The canonical native-USDC receiving account needs setup. Paid resources are unavailable and collect no payment.',
        'recipient-check-unavailable': 'The receiving account could not be checked temporarily. Retry the free catalog; this does not establish a missing account. Paid access remains blocked.',
        'configuration-required': 'Payment configuration is unavailable or disabled. Paid resources return unavailable status without a payable challenge.',
      },
    },
    pagination: {
      instruction: 'Use nextOffset and pin the returned snapshot on every later page. A snapshot conflict returns HTTP 409 without settlement; restart to avoid mixing versions.',
      screenTokens: 'Bind prepared source and screening criteria. Keep filters and sorting fixed; output format and page size may change.',
      csv: 'CSV screen columns preserve selection, pagination, snapshot and source context. Keep X-Schema-Version and units. Empty numeric cells represent unavailable inputs.',
      disclosureEvidence: 'Offsets count raw candidates, including rejected matches. Follow nextOffset; hasMore means more candidates, not guaranteed matches. This search does not promise snapshot-consistent pagination.',
    },
    deliveryRecovery: {
      optional: true,
      method: 'GET',
      endpoint: `${ORIGIN}/api/x402/v1/delivery`,
      tokenHeader: 'X-X402-Recovery-Token',
      tokenFormat: 'Generate and retain 32 random bytes as exactly 64 lowercase hexadecimal characters before each signed purchase.',
      purchase: 'Opt in by sending the retained token header on the paid request. Keep it private; possession grants access to that purchased delivery.',
      recovery: 'Send the same token header, no query parameters and no payment header or new authorization. A settled delivery returns the exact original JSON/CSV bytes and stored PAYMENT-RESPONSE within 24 hours.',
      statuses: { 200: 'Exact settled response', 202: 'Pending settlement; status only', 400: 'Missing or malformed token', 404: 'Unknown or expired token', 409: 'Failed settlement; status only', 503: 'Lookup unavailable; do not infer payment failure' },
      responseHeaders: ['PAYMENT-RESPONSE', 'X-X402-Recovered', 'X-X402-Recovery-Until', 'X-Content-SHA256'],
      limitation: 'Recovery is optional and does not guarantee automatic settlement reconciliation or a freshly updated dataset. Never automatically authorize a replacement payment after an interrupted or indeterminate purchase.',
    },
    security: {
      secrets: 'Keep private keys, signed payment headers and recovery tokens private. No private key is entered into this website or sent to the resource server.',
      offers: 'Solana wallet and mint addresses and network identifiers are case-sensitive. Validate exact offer terms before signing and maintain a total spending budget.',
      reconciliation: 'HTTP 409 may represent payment_already_used or SNAPSHOT_CHANGED. Preserve the error, receipt and transaction identifier and reconcile pending/unknown settlement before another authorization.',
      support: 'Share only the transaction identifier and requested resource with project support; never post a private key, signed authorization or recovery token.',
      publicChain: 'Wallet addresses and settled transfers can be visible on the public blockchain.',
    },
    limitations: [
      'Prepared coverage only; requests do not start bulk source collection. Source dates and preparation coverage vary.',
      'The fee pays for bounded delivery and processing, not exclusive ownership of SEC or other public records. Some underlying research is also available free.',
      'No real-time guarantee, fixed update schedule, availability SLA or guaranteed external demand.',
      'Preserve reporting periods, filing dates, retrieval times, units, nulls, stale/incomplete status, source links and calculation context.',
      'Latest-filed financial values may include revisions and do not guarantee the information known at an earlier filing cutoff.',
      'Fundamental percentage levels and percentage-point changes differ. Credit selectors named next12m refer to the first reported maturity bucket; preserve its actual basis and dates.',
      'Accounting screens are not security returns, credit ratings or default probabilities. Regulatory-bank identifiers are legal reporting entities and do not imply SEC parent-company relationships.',
    ],
    externalDiscovery: {
      extension: 'bazaar',
      resourcesUrl: `https://facilitator.payai.network/discovery/resources?${directoryQuery}`,
      searchUrl: `https://facilitator.payai.network/discovery/search?${searchQuery}`,
      guide: 'https://docs.x402.org/extensions/bazaar',
      limitation: 'Offers publish strict input and schema-only output contracts. Directory listing is facilitator-dependent; publishing or queued admission alone does not establish a visible listing or paying demand.',
    },
    terms: catalog.terms,
    privacy: catalog.privacy,
    support: 'https://github.com/EconometricsEdward/sec-edgar-terminal/issues',
  };
}

/** HEAD and OPTIONS advertise the document without a network readiness read. */
export function createX402DocumentationHandlers(readConfiguration) {
  return {
    async GET() {
      return Response.json(buildX402Documentation(await readConfiguration()), { headers: X402_DOCUMENTATION_HEADERS });
    },
    HEAD() { return new Response(null, { headers: X402_DOCUMENTATION_HEADERS }); },
    OPTIONS() { return new Response(null, { status: 204, headers: X402_DOCUMENTATION_HEADERS }); },
  };
}
