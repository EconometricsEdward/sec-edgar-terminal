# x402 paid machine access

Dedicated paid endpoints cost **0.01 USDC on Solana mainnet per successfully settled GET**. A paginated response is one paid retrieval, so every successful page costs 0.01 USDC. Public research pages and existing public API summaries remain free. Existing crawlers do not pay automatically; clients must understand x402 and authorize spending.

## Discovery and resources

`/data-access` is the human-readable guide. `GET /api/x402` is a free catalog exposing payment configuration status, protocol version, public recipient when active, and resource metadata. `/openapi.json` and `/llms.txt` describe the same contracts.

| Endpoint | Selection | Response |
| --- | --- | --- |
| `/api/x402/v1/financials/{ticker}` | `basis=annual|quarter|ytd|ttm`; defaults to annual | Full available prepared packed company financial model with periods, definitions, metrics and source/calculation catalogs |
| `/api/x402/v1/refinancing` | `limit=1..100`, `offset=0..9999`, optional exact `snapshot` token | Snapshot metadata, one company page and pagination |
| `/api/x402/v1/factor-universe` | `basis=ttm|annual`, page selections above | Snapshot metadata, one issuer-row page and pagination |

Page size defaults to 100 and offset to 0. Pass the first page's returned `pagination.snapshot` token on every subsequent page. The token is a SHA-256 fingerprint of the complete prepared snapshot. A mismatch returns HTTP 409 without settlement; restart the pull to avoid mixing versions. `nextOffset` is null when finished. Source dates and stale/incomplete coverage remain part of the data.

The fee buys paid machine delivery, not exclusive ownership of public records. Some research is also available through public pages or APIs. These reads do not initiate SEC acquisition or PDF extraction. Factor-universe pagination accepts retained prepared snapshots only; a computed fallback is unavailable for paid pagination and returns 503 without settlement. Financial histories use the site's existing prepared calculation model; historical as-filed vintages are not guaranteed.

## Activation

Production is configured with the owner's public Solana payout address, `5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR`, through `src/utils/x402Deployment.js`. This committed configuration contains only the public recipient and network and is used in production when no environment override is supplied. The server never needs the payout wallet's private key. `X402_PAY_TO` and `X402_NETWORK` can optionally override the deployment defaults; `X402_ENABLED=false` still disables payment access. Missing or invalid configuration produces availability errors without offering a payment challenge. `/data-access` and the catalog report the effective configuration status.

The default network is Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) and the accepted asset is USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The charge is fixed at 10,000 USDC base units (six decimals), or 0.01 USDC. Production rejects testnet configuration. Development may use the separately configured test network; do not describe testnet transactions as earned revenue.

The configured owner must also have a canonical associated token account for native USDC. The server checks that receiving account before allowing paid requests. If it is absent, the public status is `recipient-setup-required` and paid routes return an uncharged availability error. The owner can create the USDC receiving account through their wallet or receive a native-USDC transfer that creates it. Once the required account exists and the readiness check succeeds, the service can accept payments without changing the public payout address. `recipient-check-unavailable` instead means the read-only account check failed temporarily; it does not establish a missing account. These readiness states block payments and preserve the public recipient in the catalog.

`X402_FACILITATOR_URL` selects the HTTPS facilitator. The default is PayAI. If authenticated PayAI access is configured, provide both `PAYAI_API_KEY_ID` and `PAYAI_API_KEY_SECRET`; partial credential pairs are rejected. Confirm the facilitator's current network and asset support before activation. `X402_ENABLED=false` is the server-side kill switch.

Anonymous facilitator capacity is finite. Plan merchant credentials and funded facilitator credits before scaling production traffic, or select another compatible facilitator. Facilitator fees reduce net revenue; the advertised resource price remains 0.01 USDC.

Apply `supabase/migrations/20261004152305_edgar_x402_payment_receipts.sql`, then `supabase/migrations/20261004160213_edgar_x402_solana_receipts.sql`, and deploy the gateway policy before offering production payments. The second migration preserves legacy receipts while admitting new Solana payments. Receipt operations must remain server-only. Do not expose service-role credentials, facilitator secrets or raw signed payment headers in public responses or logs.

The read-only recipient check uses Solana's public mainnet RPC by default. `X402_SOLANA_RPC_URL` can select a dedicated HTTPS RPC service when needed. A failed check blocks payments rather than treating an unreachable account as ready.

## Request and settlement boundaries

When payments are active, an unsigned request returns HTTP 402 with x402 v2 `PAYMENT-REQUIRED`; the challenge is not a guarantee of source availability. A compatible client validates the offer and retries with `PAYMENT-SIGNATURE`. Successfully settled responses include `PAYMENT-RESPONSE` and return prepared JSON. There is no user-agent exemption on a paid route.

The server checks payment configuration and selection validity before processing the offer. Signed-request verification precedes data readiness and delivery checks, and settlement occurs only after a successful billable resource response is prepared. Invalid queries, source failures and snapshot conflicts must not settle payments. Record uncertain settlement outcomes for reconciliation; do not treat them as ordinary failures that authorize another charge.

Signed attempts are limited to six concurrent purchases and 60 attempts per minute across paid routes within each server runtime. Saturation returns 429 with `Retry-After` before payment verification. These limits protect each runtime; a global traffic budget additionally requires distributed or provider quotas because hosting can scale to multiple runtimes.

Paid responses use private, no-store browser/CDN headers. Never reuse public response-cache headers from the underlying data handlers. Do not emit cache validators that can unlock a paid representation without payment. Internal prepared-source caches remain shared to avoid repeated data collection and computation.

Receipt accounting and atomic authorization claims prevent duplicate or concurrent settlement. Store hashes and necessary transaction metadata rather than complete signed authorization payloads. Records become eligible for routine cleanup 30 days after authorization expiry; bounded cleanup occurs during later service activity, so deletion timing varies. Application deletion does not delete immutable public blockchain history.

## Client controls and verification

The `/data-access` example uses the pinned V2 client packages `@x402/core@2.28.0`, `@x402/fetch@2.28.0`, `@x402/svm@2.28.0` and `@solana/kit@6.9.0`. Save it as a local `.mjs` file. A local development signer is constructed from a 64-byte Solana CLI keypair JSON file. No private key is entered into the website or sent to the resource server. Production agents should receive a constrained signing interface. The displayed example uses the effective public recipient and network, checks the exact scheme, case-sensitive network, native USDC mint, exact 10,000-unit amount, recipient and resource URL before signing, and configures a 0.01 per-payment cap with `setSpendControls`. The `x402Client` constructor accepts a requirements selector, not a configuration object. The example preserves the response receipt and error body for reconciliation. Buyers also need a total budget and request limit. A signature alone must never grant free access before successful verification and settlement.

Before activation, verify inactive responses, invalid selection rejection, 402 challenges, CORS and no-store headers. Test successful settlement, exact pricing, failed verification, concurrent/repeated signatures, expiry, unavailable sources and uncertain-settlement reconciliation with a mock facilitator or testnet. Run the site's normal lint, type and build checks. A live paid crawl needs a real funded buyer and the owner's real payout address; do not fabricate either or perform a real transfer without authorization.

## Official references

- [x402 buyer guide](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [x402 seller guide](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 V2 migration guide](https://docs.x402.org/guides/migration-v1-to-v2)
- [Official Solana x402 V2 guide](https://solana.com/docs/payments/agentic-payments/x402)
- [Circle's native USDC contract and mint addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Implementation uses current V2 packages rather than the archived Vercel starter's older payment integration.
