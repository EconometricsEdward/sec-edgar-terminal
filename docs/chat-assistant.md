# EDGAR Terminal assistant

The browser pilot adds **Data answers** (the default, no model), **Browser AI** (explicit Qwen3-1.7B download), and **Hosted AI** (the existing service described below). See [Browser AI pilot](browser-ai-pilot.md) for device requirements, storage, evidence limits, and verification results. Browser/data research uses its own short-lived request limits and never consumes the hosted inference budget.

The global **Chat** button sits below Reading. It lazy-loads a native modal panel without navigation. Opening does not call a model or fetch research. The panel uses validated current public selections at each submit, including an in-memory bridge for the open Filings reader. It does not scrape page HTML or automatically read uploaded portfolios. The explicit **Use this portfolio/scenario in chat** buttons attach a bounded snapshot and open the same modal without navigation. Portfolio snapshots contain at most 25 public ticker identifiers and modeled weights, with total-count/coverage metadata; no account names, position amounts or uploaded files are included. Analysis scenario snapshots contain the company, exact period/basis/filing cutoff and applied, allowlisted assumptions. Attachments remain only in React memory, are visibly removable, and clear on New chat or URL changes. An attachment is a fixed snapshot until the user shares again. History and drafts live only in root-mounted React memory, bounded to 20 displayed messages and nine complete-pair messages/12,000 characters sent per request. Reloading or New chat clears the conversation. Closing aborts generation and preserves the incomplete answer.

## Model and transport

`POST /api/chat` accepts same-origin JSON text conversations. Five-second/64 KiB body limits, strict roles and shape validation, no client system messages, no CORS, and private/no-store responses apply. The NDJSON protocol carries validated page metadata, statuses, text, server-verified sources, completion or a safe error. SDK errors, reasoning, internal URLs and raw tool payloads never reach the browser.

The Apache-2.0 AI SDK 7 `ToolLoopAgent` calls `mistral/mistral-small` through Vercel AI Gateway. At release this is Apache-2.0 Mistral Small 4, eligible for Gateway's free monthly credit tier. Inference is hosted separately from the site's database. Production/preview Vercel OIDC supplies authentication; no model key is sent to the client. Local development needs a Gateway key plus the existing Redis REST configuration. Do not copy production credentials into client code or introduce a local bypass of spending controls.

Requests allow only the `mistral` provider, require zero data retention/no training, disable SDK retries, and cap the loop at three model calls with a forced final answer on the third. **Fast** is the default, using `reasoningEffort: 'none'` and 1,800 output tokens per call. The optional **Reasoning** mode uses the same model with `reasoningEffort: 'high'` and 4,000 combined reasoning/answer tokens per call, within the Gateway endpoint's advertised output ceiling. Both modes retain the 64 KiB serialized prompt limit, including instructions and tool schemas, and the 85-second request deadline. The browser may select only this mode enum, never a model, provider, or token budget; older open tabs that omit mode default to Fast.

The mode selector and answer badges live in the existing panel. Selection is held only in React memory, persists across opening/closing, and is disabled during an active answer. Reasoning uses extra effort to check period alignment, calculations, drivers and counter-evidence, then presents a concise conclusion, supporting evidence and limitations. Actual provider reasoning events produce a coarse progress status. Raw reasoning is retained only in the current server-side SDK tool loop as required by the provider, never returned to the browser, logged or stored in conversation history. A token-limited answer is marked incomplete and suggests narrowing the question or switching to Fast; there is no automatic retry or fallback model call.

No chat-specific tracing or prompt logging is enabled. The deployment must be on Vercel Pro/Enterprise for the per-request ZDR setting. Gateway remains an external processor; users are told not to enter sensitive information.

## Research tools

`chatResearch.js` exposes bounded read-only tools through the shared turn-level identity, byte, time and lookup limits. Every tool can be used from any page:

| Tool | Data and selection |
| --- | --- |
| `search_entities` | Verified SEC company, fund series or manager identity |
| `company_financials` | Up to five financial periods, exact fiscal end and filing cutoff |
| `company_comparison` | Two issuers, calendar alignment, deterministic differences and comparable YoY changes |
| `company_risk` | Current annual/TTM Risk profile, supported strengths, watch items and source-linked ratios |
| `company_exposures` | Dated SEC exposure evidence and associated benchmark contracts; not a company's futures position |
| `market_summary` | Prepared SEC business breadth and sector medians |
| `sector_companies` | Full-sector ranking before pagination, metric/filter/basis and company report dates |
| `cftc_positioning` | Prepared broad futures positioning |
| `cftc_history` | Exact prepared contract/group/report date/window; no new CFTC download on a missing chart |
| `fund_portfolio` | Verified portfolio summary, selected quarter/accession and top holdings |
| `fund_holdings` | Targeted holdings search within the selected public report |
| `fund_changes` | Existing deterministic N-PORT/13F before/after comparisons |
| `fund_overlap` | Two managers' aligned-quarter overlap, including explicit incomplete-report coverage |
| `filings_list` | Recent filings or one manifest-listed historical archive |
| `filing_document` | Selected filing sections, complete paragraphs and Risk Factors/MD&A changes |
| `disclosure_passages` | Retained indexed SEC disclosure passages |
| `shared_context` | User-provided portfolio concentration or recomputed Analysis scenario |

Native production readers reuse existing data caches, SEC pacing, prepared market/CFTC snapshots and report normalization. Preview uses a small fixed set of the live site's public research endpoints; no private-data gateway identities are broadened.

Tools validate entity identity and reporting basis, preserve dates/units/coverage/missing values and return citation IDs backed by allowlisted public sources. Ambiguous names require a selection. Financial metrics span up to five periods; fund summaries show the largest ten reported holdings with full-count coverage. Results are limited to 12 KB per lookup/30 KB total, four calls, two companies and 18 seconds of cumulative active research time. The research timer pauses between tool rounds while the model reasons; overlapping lookups share the same remaining allowance. The overall 85-second request deadline still applies. Existing readers own caching; no chatbot tables, vector store, embeddings, report copies or transcripts are created. Some pre-existing upstream readers have their own deadlines, so abort stops awaiting their results while their bounded shared cache work can finish.

Every turn requires new substantive research unless the complete question matches a narrow generic page-help, definition, or greeting exception. Entity search alone is insufficient. Prior assistant prose is removed from the model's evidence context. Research answers are held until a successful substantive tool result references a registered source. The narrow exception is a validated, explicitly attached portfolio: its computed weights/concentration can be explained as user-provided input, without invented public citations. Scenario numeric outputs require original SEC evidence for every baseline input; tool-call preambles are discarded. Missing evidence yields a fixed limitation or entity-selection response instead of unverified model prose. Generic help disables research and cannot repeat earlier entity figures. This prevents the observed no-lookup follow-up failure; users should still verify model interpretations against the supplied sources.

For calculated standalone quarters, the compact company tool can include the exact cumulative subtraction inputs with their dates and source IDs. It exposes this derivation only when concepts, units, fiscal-year starts, reporting dates and arithmetic match the existing verified report result. Other formulas are not inferred.

The assistant distinguishes sector business fundamentals from price returns, aggregate CFTC data from company positions, N-PORT from 13F, and an indexed passage search from a complete SEC corpus. Exact historical selections are passed to supporting readers and mismatches never silently fall back to current results. General company financial summaries support annual/quarter/TTM, while shared Analysis scenarios also support ytd when compatible baseline inputs exist. The current Risk profile does not support historical filing cutoffs and reports that limitation. Prepared CFTC history may be unavailable for a contract/date/window that has not been published; no chat-specific chart preparation starts. Filings text retrieval is bounded to the selected reader page and a maximum of one manifest-listed archive per accession; extracted passages do not represent an exhaustive review. A company with no supported periods or verified values for the requested basis returns a specific coverage limitation and an unverified alternative-basis suggestion, rather than an outage or invented annual figures. It cannot trade, mutate data, browse arbitrary URLs, or access unshared private browser data. N-PORT/13F changes use the site calculators; holding-value changes are not labeled purchases, sales, flows or performance. Portfolio impact scenarios use a different calculator and are not attached by the Analysis scenario action.

## Usage controls and costs

Hosted `POST /api/chat` requires a verified Supabase account and prepaid response credits. There is no anonymous or environment-flag fallback to the old beta allowance. Free data chat and the opt-in browser model remain separate and unchanged.

`billingServer.js` calls the durable `edgar_billing_operation` transaction through the production-only workload gateway. A $10 USD pack grants 100 account-bound responses without expiration or automatic refill. A completed nonempty model answer uses one credit in either Fast or Reasoning mode. Errors, cancellation, empty output, and source-unavailable deterministic limitations restore the held credit. An interrupted server lease expires after 120 seconds. Finalization is awaited before sending a completion frame.

Each accepted attempt conservatively reserves $0.04 of model cost; failed attempts still consume this cost reserve. Each account and the total reservation pool are limited to 60% of their verified, pre-tax paid receipts after proportional refunds and disputes, with additional durable $100/day and $2,000/month ceilings. There is one active request per account, eight globally, and per-account limits of five requests/minute and 100/day. Missing configuration, authentication, funds, or database access fails closed before inference. Customer credits and monetary cost reservations are separate ledgers. These limits do not cap unrelated Vercel, database, payment, tax, dispute, or network costs.

The model reservation bounds three calls at $0.15/M input and $0.60/M output, counting one input token per UTF-8 byte plus 4,096 formatting tokens per call. A bounded 32 KB model-endpoint metadata check verifies exact provider prices, zero additional charges and privacy properties before inference. Successful checks cache for one hour per warm server; a price increase or unknown pricing field pauses hosted AI.

`CHAT_ENABLED=false` pauses the hosted API. `BILLING_ENABLED` and merchant/auth/tax readiness settings gate paid activation; see [paid AI launch](paid-ai-launch.md). The old `chatLimits.js` beta limiter remains available for its historical tests but is no longer on the production hosted request path. Paid usage never resets or bypasses it. No provider automatic top-up is enabled by this feature.

Reasoning's larger completion allowance fits the unchanged reservation: `3 × (69,632 × $0.15/M + 4,000 × $0.60/M) = $0.0385344 < $0.04`. Reasoning may increase actual tokens and latency but adds no persistent storage or higher spending ceiling.

## Verification

Run `node --test tests/chat-*.test.js`, `npm run typecheck`, scoped ESLint and `npm run build`. Coverage includes request shape/origin/body bounds, actual Lua atomic limits, partial streams/cancellation, actual installed SDK tool execution, financial/source identity and unit checks, prepared Market calculations, CFTC feature rollback and price guards. Browser checks must cover open/close without navigation, Escape/focus restoration, drafts across routes, real model+source answers, partial cancellation and deployment configuration. Existing unrelated test failures should be recorded separately.

References: [AI Gateway REST metadata](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api), [Mistral Small 4](https://mistral.ai/news/mistral-small-4/), [Gateway OIDC](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc), [Gateway ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr).
