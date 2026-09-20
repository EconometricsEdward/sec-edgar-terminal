# EDGAR Terminal assistant

The global **Chat** button sits below Reading. It lazy-loads a native modal panel without navigation. Opening does not call a model or fetch research. The panel uses the current public URL at each submit; it does not scrape the page or read uploaded portfolios. History and drafts live only in root-mounted React memory, bounded to 20 displayed messages and nine complete-pair messages/12,000 characters sent per request. Reloading or New chat clears the conversation. Closing aborts generation and preserves the incomplete answer.

## Model and transport

`POST /api/chat` accepts same-origin JSON text conversations. Five-second/64 KiB body limits, strict roles and shape validation, no client system messages, no CORS, and private/no-store responses apply. The NDJSON protocol carries validated page metadata, statuses, text, server-verified sources, completion or a safe error. SDK errors, reasoning, internal URLs and raw tool payloads never reach the browser.

The Apache-2.0 AI SDK 7 `ToolLoopAgent` calls `mistral/mistral-small` through Vercel AI Gateway. At release this is Apache-2.0 Mistral Small 4, eligible for Gateway's free monthly credit tier. Inference is hosted separately from the site's database. Production/preview Vercel OIDC supplies authentication; no model key is sent to the client. Local development needs a Gateway key plus the existing Redis REST configuration. Do not copy production credentials into client code or introduce a local bypass of spending controls.

Requests allow only the `mistral` provider, require zero data retention/no training, disable reasoning and SDK retries, and cap the loop at three model calls with a forced final answer on the third. Each call is limited to 1,800 output tokens and a 64 KiB serialized prompt, including instructions and tool schemas. No chat-specific tracing or prompt logging is enabled. The deployment must be on Vercel Pro/Enterprise for the per-request ZDR setting. Gateway remains an external processor; users are told not to enter sensitive information.

## Research tools

`chatResearch.js` exposes six read-only tools: SEC entity search, company financials, market fundamentals, CFTC positioning, N-PORT/13F portfolios, and indexed disclosure passages. Native production readers reuse existing data caches, SEC pacing, prepared market/CFTC snapshots and report normalization. Preview uses a small fixed set of the live site's public research endpoints; no private-data gateway identities are broadened.

Tools validate entity identity and reporting basis, preserve dates/units/coverage/missing values and return citation IDs backed by allowlisted public sources. Ambiguous names require a selection. Financial metrics span up to five periods; fund summaries show the largest ten reported holdings with full-count coverage. Results are limited to 12 KB per lookup/30 KB total, four calls, two companies and 18 seconds from the first lookup. Existing readers own caching; no chatbot tables, vector store, embeddings, report copies or transcripts are created. Some pre-existing upstream readers have their own deadlines, so abort stops awaiting their results while their bounded shared cache work can finish.

Every turn requires new substantive research unless the complete question matches a narrow generic page-help, definition, or greeting exception. Entity search alone is insufficient. Prior assistant prose is removed from the model's evidence context. Research answers are held until a successful substantive tool result references a registered source; tool-call preambles are discarded. Missing evidence yields a fixed limitation or entity-selection response instead of unverified model prose. Generic help disables research and cannot repeat earlier entity figures. This prevents the observed no-lookup follow-up failure; users should still verify model interpretations against the supplied sources.

For calculated standalone quarters, the compact company tool can include the exact cumulative subtraction inputs with their dates and source IDs. It exposes this derivation only when concepts, units, fiscal-year starts, reporting dates and arithmetic match the existing verified report result. Other formulas are not inferred.

The assistant distinguishes sector business fundamentals from price returns, aggregate CFTC data from company positions, N-PORT from 13F, and an indexed passage search from a complete SEC corpus. Historical URL dates are context hints; unsupported historical vintages and ytd are explicitly distinguished from tool results. A company with no supported periods or verified values for the requested basis returns a specific coverage limitation and an unverified alternative-basis suggestion, rather than an outage or invented annual figures. It cannot trade, mutate data, browse arbitrary URLs or read private uploaded holdings.

## Usage controls and costs

`chatLimits.js` uses the existing Upstash Redis REST configuration (`KV_REST_API_URL`/`KV_REST_API_TOKEN`, or their `UPSTASH_REDIS_REST_*` equivalents). A single atomic Lua reservation checks all limits before the model runs. Missing Redis, corrupt counters or network failures disable chat rather than bypass limits. Only hashed client identifiers, counters and 120-second concurrency leases are stored; all expire. No raw IP or message content is stored by the app.

- Five requests/minute and 30/day per client IP; one active request per IP.
- Four active requests and 1,000 requests/day globally. Successful/error completion releases the shared concurrency lease before publishing its terminal frame. Next.js `after` also retains cancellation cleanup after a browser disconnect; all completion paths await the same idempotent release promise.
- Shared production/preview reservation caps: $1 per UTC day and $5 per UTC month.
- Each accepted turn conservatively reserves $0.04, with no refund. This allows at most 25 accepted turns/day and 125/month under the initial shared beta budget, even though actual model usage is usually much lower. Failed or cancelled requests also consume reservations. The daily allowance leaves room for initial user testing after deployment checks; the total monthly ceiling is unchanged.

The reservation bounds three calls at $0.15/M input and $0.60/M output, counting one input token per UTF-8 byte plus 4,096 formatting tokens per call. A bounded 32 KB model-endpoint metadata check verifies exact provider prices, zero additional charges and privacy properties before inference. Successful checks cache for one hour per warm server; a price increase or unknown pricing field pauses chat. This is a conservative application reservation, not a billing reconciliation or cap on unrelated Vercel/Redis usage. For a contractual billing limit use the provider's project budget as well. No credits are purchased or automatic top-up enabled by this feature.

Private environment settings `CHAT_DAILY_BUDGET_MICRODOLLARS` and `CHAT_MONTHLY_BUDGET_MICRODOLLARS` can only lower their fixed ceilings; zero pauses allowance. Raising the beta budget requires a reviewed code change. `CHAT_ENABLED=false` pauses the API without removing the panel. SDK/model failures show a retriable error; there is no fabricated answer fallback or automatic retry.

## Verification

Run `node --test tests/chat-*.test.js`, `npm run typecheck`, scoped ESLint and `npm run build`. Coverage includes request shape/origin/body bounds, actual Lua atomic limits, partial streams/cancellation, actual installed SDK tool execution, financial/source identity and unit checks, prepared Market calculations, CFTC feature rollback and price guards. Browser checks must cover open/close without navigation, Escape/focus restoration, drafts across routes, real model+source answers, partial cancellation and deployment configuration. Existing unrelated test failures should be recorded separately.

References: [AI Gateway REST metadata](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api), [Mistral Small 4](https://mistral.ai/news/mistral-small-4/), [Gateway OIDC](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc), [Gateway ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr).
