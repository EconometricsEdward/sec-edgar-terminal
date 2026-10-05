# x402 paid machine data products

Dedicated paid products have starter pricing of **0.01 USDC on Solana mainnet per successfully settled bounded GET**. A batch of up to 10 company histories is one retrieval. A paginated response is one retrieval, so every successful page costs 0.01 USDC. Public research pages and existing public API summaries remain free. Existing crawlers do not pay automatically; clients must understand x402 and authorize spending.

The offer is workflow convenience: batch delivery, derived screening and sorting, JSON/CSV exports, source context, consistent pagination and optional 24-hour recovery of purchased output. It does not claim exclusive government data, real-time updates, a fixed refresh schedule or an availability SLA. The human product catalog at `/data-access` and the homepage explain the specific buyer workflows. The primary navigation links to the Data API catalog.

## Discovery and resources

`/data-access` is the human-readable guide. `GET /api/x402` is a free catalog exposing payment configuration status, protocol version, public recipient when active, and resource metadata. `/openapi.json` and `/llms.txt` describe the same contracts.

The eleven paid routes declare the x402 **Bazaar discovery extension** with the official `@x402/extensions@2.28.0` helper. Their offers include query/path input schemas, response schemas, `SEC EDGAR Terminal` service metadata, topical tags and the site's public favicon. Company financials retain SDK path-parameter enrichment internally, but omit the discovery route template so external catalog entries and verification probes use a concrete supported company path, such as `/api/x402/v1/financials/AAPL`. Each company URL can have its own discovery entry. The generic API still accepts `/api/x402/v1/financials/{ticker}`. Payment remains bound to the exact concrete requested URL, including tickers, filters, sorting, pagination and format; discovery metadata never substitutes a template for that binding.

`src/utils/x402Discovery.js` owns these declarations. Output schemas describe prepared-reader contracts without fabricated financial values or an implied live sample. The free catalog also publishes the discovery contracts. Participating facilitators may index this metadata; deployment alone does not prove an external listing, successful cataloging or buyer demand. Check the facilitator's discovery catalog and any actual `EXTENSION-RESPONSES` Bazaar result before asserting registration. Discovery does not add a payment or change the 0.01-USDC retrieval price.

All eleven paid resources provide a dedicated unpaid `HEAD` discovery challenge. The SDK extracts catalog resource URLs without query strings, so a bare `HEAD` advertises the GET contract and its required selectors without claiming that a selector-free GET can deliver data. Query-bearing HEAD probes use the same strict selectors and selected JSON/CSV metadata. Every response is bodyless. HEAD rejects payment, authorization and recovery credentials before dependency reads; it never reads prepared research, checks buyer proofs, reserves a ledger entry, settles or recovers a delivery. Configuration, recipient readiness and facilitator support fail closed. Use free availability checks for supported prepared selections; a discovery challenge does not establish data coverage. Strict GET validation and exact URL payment binding are unchanged.

Run `node scripts/check-x402-discovery.mjs` to validate the live offers and inspect PayAI's listing status and wallet-filtered catalog. This default mode is read-only and does not load wallet keys. `--register` alone uses a fresh unfunded signer for a verification-only probe; the production check on October 4, 2026 returned simulation failures, no Bazaar acknowledgment and no catalog entries. It did not establish listings.

To submit the declarations through a successful buyer verification, run `node scripts/check-x402-discovery.mjs --register --keypair /local/path/buyer-keypair.json` **on your own computer**, using an explicitly selected standard Solana JSON keypair whose wallet has at least 0.01 native USDC on Solana mainnet. Never upload or share that keypair. The command validates the exact recipient, network, mint and 0.01-USDC offers and all extracted-resource HEAD probes before signing, and sends genuine SDK payloads directly to PayAI `/verify`. It never sends a signed retry to the seller, calls `/settle` or broadcasts a transaction. PayAI nevertheless receives signed payment authorizations, so use a dedicated buyer wallet. Verification reuses the same balance across resources; it does not require eleven settled payments. Check the actual Bazaar outcome, then rerun the read-only command after asynchronous admission. A `processing` response alone does not establish a visible listing. See [PayAI's admission and refresh rules](https://docs.payai.network/x402/facilitators/bazaar).

| Endpoint | Selection | Response |
| --- | --- | --- |
| `/api/x402/v1/disclosure-topic-packet` | One exact `cik`, 1–3 curated `topics`, optional retained filing dates, JSON/CSV | Full verified paragraphs organized by topic, filing and section with deduplicated evidence/source catalogs and explicit candidate/extraction coverage |
| `/api/x402/v1/bank-risk-batch` | 1–4 legal-bank `rssds`, required quarter-end `period`, `comparison=previous\|none`, optional exact `snapshot`, JSON/CSV | Fifteen selected FFIEC capital, credit-quality and funding observations per bank, prior-quarter changes and exact source/calculation inputs |
| `/api/x402/v1/financial-batch` | `tickers=AAPL,MSFT` (up to 10), `basis=annual|quarter|ytd|ttm`, `format=json|csv` | Prepared company histories together as a JSON bundle or tabular CSV |
| `/api/x402/v1/fundamental-screen` | `basis=ttm|annual`, supported sector/metric filters and sorting, page selections below, `format=json|csv` | Derived selected and sorted issuer page from one prepared fundamental snapshot |
| `/api/x402/v1/credit-screen` | Supported debt/liquidity/maturity/coverage filters and sorting, page selections below, `format=json|csv` | Derived selected and sorted company page from one prepared refinancing snapshot |
| `/api/x402/v1/financials/{ticker}` | `basis=annual|quarter|ytd|ttm`; defaults to annual | Full available prepared packed company financial model with periods, definitions, metrics and source/calculation catalogs |
| `/api/x402/v1/refinancing` | `limit=1..100`, `offset=0..9999`, optional exact `snapshot` token | Snapshot metadata, one company page and pagination |
| `/api/x402/v1/factor-universe` | `basis=ttm|annual`, page selections above | Snapshot metadata, one issuer-row page and pagination |

JSON is the default format. The three new batch and screening products also accept `format=csv`; original model/page routes remain JSON-only. Each new product response is capped at 4 MiB; an oversized request returns HTTP 413 without settlement, so choose fewer tickers or a smaller page. Use the exact supported parameter names and enums in `/openapi.json` rather than constructing undocumented filters. Empty, unknown, conflicting or out-of-bounds selections are rejected without settlement.

Page size defaults to 100 and offset to 0. Pass the first page's returned `pagination.snapshot` token on every subsequent JSON page, keeping the same filters and sorting. Original snapshot routes fingerprint their complete prepared source; screen tokens fingerprint both the source and the screening criteria. Format and page size may change while keeping the screen token. A mismatch returns HTTP 409 without settlement; restart the pull to avoid mixing versions. `nextOffset` is null when finished. Source dates and stale/incomplete coverage remain part of the data. CSV screen exports carry snapshot, selection and pagination metadata in their columns, and `X-Schema-Version` identifies the response contract.

### Evidence workflows

The company disclosure topic packet and bank risk batch extend the catalog to **eleven paid products**. Their placement follows interest in Disclosures, Risk and individual BankScope pages. Page views are product-interest signals, not proof of crawler identity or paid demand. These research pages now expose relevant product links without initiating payment or acquiring data.

The disclosure packet answers several literal research questions in one prepared request. It preserves full original paragraphs, negations and qualifications, organized by topic, observed filing and section. Supported topics are liquidity, covenants, collateral and customer concentration. It does not classify events, establish covenant compliance or compare complete filing versions. Every topic checks up to 120 raw candidates and delivers up to five matching paragraphs. A missing topic is explicitly bounded to that candidate page; an all-empty packet returns 404 without settlement. Inconsistent source generations or unavailable index reads fail the packet atomically. Source/evidence catalogs deduplicate paragraphs that match multiple topics. Its snapshot fingerprints the selected source packet without generatedAt or output format.

The bank batch reads one bounded prepared-store selection, never the upstream FFIEC service or raw XBRL. All selected current quarters must be validated for the exact RSSD. Prior-quarter absence, CBLR nonrequired fields and incompatible scopes remain unavailable. Money is USD; percentages remain percentage levels, and percentage changes are percentage points. Derived ratios retain their actual reported metric inputs and denominator definitions. Snapshot binding rejects changed evidence with 409 before settlement. Legal banks are not inferred SEC parents or supervisory ratings.

Individual BankScope pages default to that legal bank's newest validated prepared quarter within the displayed retention periods. An explicit quarter selection remains exact, including unavailable quarters. The page's free bank-product coverage link uses the same selected quarter.

Three additional workflows provide compact processed evidence in JSON or CSV:

| Product | Work saved | Bounds and evidence |
| --- | --- | --- |
| `/api/x402/v1/financial-changes` | Select compatible latest and baseline observations, calculate changes and retain their inputs | 1–10 distinct issuers; up to 12 supported metrics; annual, quarter, YTD or TTM; `comparison=year` or `previous` (annual/quarter only). Percentage-point margin changes; percentage growth withheld for nonpositive bases; incompatible scopes/durations withheld. |
| `/api/x402/v1/disclosure-evidence` | Verify literal/Boolean matches against full retained filing paragraphs | Limited prepared corpus, partial document extraction; up to 20 quotes and 120 checked candidates. Filing dates, sections, SEC links and text fingerprints travel with each quote. |
| `/api/x402/v1/institutional-overlap` | Reconcile shared same-quarter positions across complete manager portfolios | 2–4 manager CIKs, 100 positions per page, explicit classes/options/share units, per-manager values/weights, complete amendment-chain evidence and snapshot-pinned pagination. |

Check each evidence product without payment through `/api/x402/availability?product={id}&{same-selectors}`. This checks the bounded prepared reader and returns only a readiness summary, result count, stale status and optional stable packet dataVersion. Up to ninety-six successful summaries are reused for thirty seconds within a runtime; checkedAt remains the original reader check time. Identical in-flight selections share one reader call. It accepts no payment/recovery headers, limits actual reader starts to four concurrent and thirty per minute per runtime, and returns no purchased rows or quotes. A later purchase can encounter changed coverage; readiness is not a data reservation.

Disclosure offsets count raw candidates, including those rejected by exact Boolean verification. `hasMore` means more candidates, not guaranteed additional verified matches. Preserve returned `nextOffset`; a no-match 404 can include pagination and incurs no settlement. The corpus can update between pages, and this endpoint makes no snapshot-consistency guarantee. A matching paragraph is not a claim that a disclosed risk happened or that a term is absent elsewhere.

Institutional overlap requires every requested portfolio to be complete, uninvalidated and on the same reporting quarter. Missing or expired snapshots return 503, mismatched quarters or changed pagination snapshots return 409, and no shared positions return 404 without settlement. Reported holdings are historical; they do not establish transactions, investment performance or cash flows. Financial changes use latest filed observations including revisions, rather than reconstructing original as-filed histories. All products preserve missing values and source context.

### Fundamental screen

- `sector=all` (default) or a sector slug from the prepared source snapshot.
- `metric=revenueGrowth` (default), `operatingMargin`, `freeCashFlowMargin`, `equityToAssets`, `netMargin` or `cashToAssets`.
- `field=change` (default), `current` or `prior`; optional finite decimal `min` and `max` use the selected field's units. Current and prior growth/ratio values are percentage levels; changes are percentage-point differences.
- `sort=metric` (default) or `ticker`; `order=desc` (default) or `asc`.
- `missing=exclude` (default) or `include`. Missing numeric values stay null; JSON may include missing rows only when requested and no numeric bounds are supplied. Numeric bounds always exclude unavailable selected values. CSV numeric nulls are empty cells.

Each JSON row adds `selectedValue` and `peerPercentile`. Sector peer percentiles use average ranks for ties among valid observations in the selected sector before applying numeric bounds. They are descriptive ranks in this prepared accounting dataset, not stock-return forecasts or probabilities.

### Credit screen

- `sector=all` (default) or a sector ID from the prepared refinancing snapshot.
- Optional nonnegative `minDebt` sets a minimum first-maturity-bucket amount in USD; nonnegative `maxCashCoverage` sets a maximum cash/first-maturity-bucket ratio; finite signed `minInterestCoverage` sets a minimum available interest-coverage ratio. The first bucket covers the next fiscal year or a rolling twelve-month interval; preserve the profile basis and bucket start/end dates. Decimal magnitudes are bounded to 1e15 and exponential notation is rejected.
- `coverage=reported` (default) or `complete`.
- `sort=next12m` (default), `cashToNext12m`, `interestCoverage` or `ticker`; `order=desc` (default) or `asc`.

Each JSON row adds `cashShortfallToNext12m = max(first-maturity-bucket principal − cash, 0)` when the required observations are available. The existing code keys `next12m`, `cashToNext12m` and `cashShortfallToNext12m` refer to that first bucket; their names do not establish a rolling twelve-month interval. This is a comparison of reported inputs, not a financing forecast, solvency judgment or credit rating.

Both screens use `limit=1..100`, `offset=0..9999`, optional exact SHA-256 `snapshot` and `format=json|csv`. No matching rows return HTTP 404; a changed token returns 409; an out-of-range page returns 416; unavailable prepared coverage returns 503. These outcomes do not settle payments. The batch is all-or-fail: an unavailable company does not silently turn a requested batch into a partial paid response.

CSV financial batches provide one row per metric and period, including metric definitions and expanded source/calculation references. CSV screen rows include schema, source/snapshot dates, selection criteria, pagination and original source identifiers/URLs. Text cells are escaped and spreadsheet-formula prefixes are neutralized; numeric missing values remain empty.

For an unpaid inspection in Windows PowerShell, run these separately. They inspect payment offers and do not authorize payment:

```powershell
curl.exe -i "https://secedgarterminal.com/api/x402/v1/financial-batch?tickers=AAPL%2CMSFT&basis=annual"
curl.exe -i "https://secedgarterminal.com/api/x402/v1/fundamental-screen?basis=ttm&limit=100&offset=0&format=csv"
curl.exe -i "https://secedgarterminal.com/api/x402/v1/credit-screen?limit=100&offset=0"
```

When payments are active these return HTTP 402. Actual purchases need an x402-compatible client, an explicit spending budget and a funded wallet. Read the current offer; do not paste a wallet private key into a website, issue or chat.

The fee buys paid machine delivery, not exclusive ownership of public records. Some research is also available through public pages or APIs. These reads do not initiate SEC acquisition or PDF extraction. Factor-universe pagination accepts retained prepared snapshots only; a computed fallback is unavailable for paid pagination and returns 503 without settlement. Financial histories use the site's existing prepared calculation model; historical as-filed vintages are not guaranteed.

## Activation

Production is configured with the owner's public Solana payout address, `5qe4MpMXzT6TeaUNZz7ApAzoQzTGpVWbz1VBGbGhrdiR`, through `src/utils/x402Deployment.js`. This committed configuration contains only the public recipient and network and is used in production when no environment override is supplied. The server never needs the payout wallet's private key. `X402_PAY_TO` and `X402_NETWORK` can optionally override the deployment defaults; `X402_ENABLED=false` still disables payment access. Missing or invalid configuration produces availability errors without offering a payment challenge. `/data-access` and the catalog report the effective configuration status.

The default network is Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) and the accepted asset is USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The charge is fixed at 10,000 USDC base units (six decimals), or 0.01 USDC. Production rejects testnet configuration. Development may use the separately configured test network; do not describe testnet transactions as earned revenue.

The configured owner must also have a canonical associated token account for native USDC. The server checks that receiving account before allowing paid requests. If it is absent, the public status is `recipient-setup-required` and paid routes return an uncharged availability error. The owner can create the USDC receiving account through their wallet or receive a native-USDC transfer that creates it. Once the required account exists and the readiness check succeeds, the service can accept payments without changing the public payout address. `recipient-check-unavailable` instead means the read-only account check failed temporarily; it does not establish a missing account. These readiness states block payments and preserve the public recipient in the catalog.

`X402_FACILITATOR_URL` selects the HTTPS facilitator. The default is PayAI. If authenticated PayAI access is configured, provide both `PAYAI_API_KEY_ID` and `PAYAI_API_KEY_SECRET`; partial credential pairs are rejected. Confirm the facilitator's current network and asset support before activation. `X402_ENABLED=false` is the server-side kill switch.

Anonymous facilitator capacity is finite. Plan merchant credentials and funded facilitator credits before scaling production traffic, or select another compatible facilitator. Facilitator fees reduce net revenue; the advertised resource price remains 0.01 USDC.

Apply `supabase/migrations/20261004152305_edgar_x402_payment_receipts.sql`, then `supabase/migrations/20261004160213_edgar_x402_solana_receipts.sql`, then `supabase/migrations/20261004225742_edgar_x402_delivery_recovery.sql`, and deploy the updated gateway policy before offering the corresponding production payment and recovery features. The second migration preserves legacy receipts while admitting new Solana payments; the third adds opted-in response staging and recovery. Receipt and recovery storage operations must remain server-only. Do not expose service-role credentials, facilitator secrets, recovery tokens or raw signed payment headers in public responses or logs.

The read-only recipient check uses Solana's public mainnet RPC by default. `X402_SOLANA_RPC_URL` can select a dedicated HTTPS RPC service when needed. A failed check blocks payments rather than treating an unreachable account as ready.

## Request and settlement boundaries

When payments are active, an unsigned request returns HTTP 402 with x402 v2 `PAYMENT-REQUIRED`; the challenge is not a guarantee of source availability. A compatible client validates the offer and retries with `PAYMENT-SIGNATURE`. Successfully settled responses include `PAYMENT-RESPONSE` and return prepared JSON. There is no user-agent exemption on a paid route.

The server checks payment configuration and selection validity before processing the offer. Signed-request verification precedes data readiness and delivery checks, and settlement occurs only after a successful billable resource response is prepared. Invalid queries, source failures and snapshot conflicts must not settle payments. Record uncertain settlement outcomes for reconciliation; do not treat them as ordinary failures that authorize another charge.

Signed attempts are limited to six concurrent purchases and 60 attempts per minute across paid routes within each server runtime. Saturation returns 429 with `Retry-After` before payment verification. These limits protect each runtime; a global traffic budget additionally requires distributed or provider quotas because hosting can scale to multiple runtimes.

Paid responses use private, no-store browser/CDN headers. Never reuse public response-cache headers from the underlying data handlers. Do not emit cache validators that can unlock a paid representation without payment. Internal prepared-source caches remain shared to avoid repeated data collection and computation.

Receipt accounting and atomic authorization claims prevent duplicate or concurrent settlement. Store hashes and necessary transaction metadata rather than complete signed authorization payloads. Records become eligible for routine cleanup 30 days after authorization expiry; bounded cleanup occurs during later service activity, so deletion timing varies. Application deletion does not delete immutable public blockchain history.

## Optional delivery recovery

Before each signed purchase, generate `randomBytes(32).toString('hex')` locally and retain the resulting 64-character lowercase hexadecimal token. Send it in the optional `X-X402-Recovery-Token` header on that purchase. The server stages the exact response before settlement; successful delivery includes `X-X402-Recovery-Until` and `X-Content-SHA256`. Keep the recovery token private because possession grants access to the purchased response.

If the response is lost, send `GET /api/x402/v1/delivery` with the same token header within 24 hours. Do not send query parameters, `PAYMENT-SIGNATURE`, `X-PAYMENT` or a new authorization. A settled purchase returns the exact originally purchased JSON or CSV bytes, its stored `PAYMENT-RESPONSE`, content hash and `X-X402-Recovered: 1` without another payment. Recovery does not retrieve a newly refreshed dataset.

A pending settlement returns 202 with status information and no data; it needs reconciliation before another authorization. A failed settlement returns 409 with status only. Unknown or expired tokens return 404; malformed or missing tokens return 400; a lookup outage returns 503. Do not infer failure from an unavailable lookup or automatically authorize a replacement payment. This feature is optional and does not guarantee automatic settlement reconciliation. Recovery access ends after 24 hours; expired response copies become eligible for bounded cleanup during later verified opt-in purchases, so physical deletion can occur later. Receipt records retain the separate anti-replay retention policy.

## Client controls and verification

The `/data-access` example uses the pinned V2 client packages `@x402/core@2.28.0`, `@x402/fetch@2.28.0`, `@x402/svm@2.28.0` and `@solana/kit@6.9.0`. Save it as a local `.mjs` file. Set `PAYER_KEYPAIR_FILE` to a local 64-byte Solana CLI keypair JSON file for the development signer. Set `RECOVERY_FILE` to a new private file in an existing local directory, choosing a unique filename for each purchase. The example persists recovery details before requesting payment, refuses to overwrite an existing file and uses the saved file to recover that same purchase without a new authorization. Keep both files private. No private key is entered into the website or sent to the resource server. Production agents should receive a constrained signing interface. The displayed example uses the effective public recipient and network, checks the exact scheme, case-sensitive network, native USDC mint, exact 10,000-unit amount, recipient and resource URL before signing, and configures a 0.01 per-payment cap with `setSpendControls`. The `x402Client` constructor accepts a requirements selector, not a configuration object. The example preserves the response receipt and error body for reconciliation. Buyers also need a total budget and request limit. A signature alone must never grant free access before successful verification and settlement.

Before activation, verify inactive responses, invalid selection rejection, 402 challenges, CORS and no-store headers. Test successful settlement, exact pricing, failed verification, concurrent/repeated signatures, expiry, unavailable sources and uncertain-settlement reconciliation with a mock facilitator or testnet. Run the site's normal lint, type and build checks. A live paid crawl needs a real funded buyer and the owner's real payout address; do not fabricate either or perform a real transfer without authorization.

## Official references

- [x402 buyer guide](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [x402 seller guide](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 V2 migration guide](https://docs.x402.org/guides/migration-v1-to-v2)
- [x402 Bazaar discovery guide](https://docs.x402.org/extensions/bazaar)
- [Official Solana x402 V2 guide](https://solana.com/docs/payments/agentic-payments/x402)
- [Circle's native USDC contract and mint addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

Implementation uses current V2 packages rather than the archived Vercel starter's older payment integration.
