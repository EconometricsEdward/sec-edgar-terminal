# CFTC integration and security-price provider retirement

This is the dependency and operations checklist for PR [#56](https://github.com/EconometricsEdward/sec-edgar-terminal/pull/56). CFTC positioning is a separate futures-only research source. It is not a replacement security-price feed and is never used in company, portfolio, or SEC-fundamental calculations.

## Migration boundary

| Area | Release treatment |
| --- | --- |
| Stock charts and adjusted-price histories | Removed, including loaders, parsers, fallbacks, warming, exports, and UI shells. |
| Return models | Removed: returns, market/downside/sector beta, residual volatility, return co-movement, filing price response, price/fundamental associations, and combined evidence-gap grades. |
| Legacy APIs | `/api/prices`, `/api/v1/market-signals`, and `/api/v1/factor-universe` return structured, non-cacheable `410 Gone` responses. |
| Fundamental universe | SEC-only data is published at `/api/v2/factor-universe` under the v2 schema. Publication retention is based on SEC coverage, never retired price coverage. |
| Market and portfolio research | Preserved: Market briefing, sector heatmap, screener, filing-derived breadth/distributions and paired changes, cash confirmation, simultaneous weakening, company drilldowns, portfolio screener, Financial Profile, concentration, and hypothetical scenarios. |
| SEC values that happen to be called prices or returns | Preserved: Form 4 transaction prices, N-PORT reported values, company financial figures, accounting return ratios, user-entered position values, and hypothetical inputs. |
| CFTC positioning | Added independently from official futures-only TFF and Disaggregated datasets; never inserted into issuer statements, portfolio weights, or company exposure claims. |

## Code and data checklist

- [x] Trace and remove all live Yahoo Finance and Stooq acquisition modules, imports, provider aliases, price-specific build work, and scheduled warming.
- [x] Keep SEC submissions prewarming. The fixed launch list and bounded `popular_tickers` set are used only to resolve SEC identifiers and cache SEC submissions.
- [x] Move expanded SEC coverage to environment-scoped `quant-coverage-v2`, `quant-company-v2`, and `quant-atlas-v2` namespaces. Production may read preserved SEC-only v1 checkpoints during transition; previews neither read them nor run mutation crons.
- [x] Publish only strictly validated SEC-only Fundamental Lab v2 snapshots. Old v1 or recursively price-derived snapshots cannot become a v2 last-good response.
- [x] Migrate Market saved views to valid canonical views without inventing a replacement rule. Remove retired fields recursively from Market baselines while preserving SEC baselines, watchlists, and notes.
- [x] Apply the same migration to Research Vault backups/restores, recent searches, Research Trail links, and direct Market URLs. Show a one-time migration notice.
- [x] Gate source and production artifacts against provider hosts, finance-CDN aliases, known proxy/package signatures, retired loaders, retired caches, and live calls to retired endpoints. The deletion module, this migration document, and the gate itself are the only documented exceptions.
- [x] Add separate official CFTC endpoints, status, source provenance, calculations, fixtures, and bounded live-source smoke coverage.
- [x] Isolate CFTC state by deployment environment. Positioning and transport use `edgar.cftc-positioning.v1:<production|preview-SHA|local>` and `edgar.cftc-transport.v1:<production|preview-SHA|local>`; preview and local deployments cannot read or mutate production CFTC caches.
- [ ] After deployment, verify the exact production commit and let the scheduled retirement route reach `complete: true` as described below.
- [ ] Invalidate/revalidate public CDN and Next caches for retired API/doc surfaces, then prove all three retired endpoints return `410` without touching legacy cache data.
- [ ] Disable or protect older deployment URLs that still contain provider writers. Do not roll back to any provider-enabled commit.
- [ ] Run desktop/mobile production checks across the homepage, every Market tab, Analysis, Risk, Compare, Filings/Form 4, Disclosures, Funds, Research Hub, and portfolio workflows.

## Baseline and source verification

The recorded pre-migration baseline at commit `c9448c4` was: `npm test` 1,253 passed; typecheck passed; lint completed with 0 errors and 7 warnings. Compare preserved SEC reporting periods and figures against that baseline during browser verification.

The bounded official live-source verification found report date `2026-09-08` with 99 TFF rows from dataset `gpe5-46if` and 277 Disaggregated rows from dataset `72hh-3qpy`. Dataset/report dates must still be rediscovered from validated rows on each refresh; this record is not a promise of future availability or publication time.

## Production cache retirement

The authenticated route `/api/cron/provider-retirement` is intentionally checkpointed and idempotent. The Vercel Hobby-compatible schedule invokes it once daily as a safety net. For prompt post-deploy completion, an authorized operator performs the same route sequence manually:

1. The first successful production run proves that current TTM and annual Fundamental Lab v2 snapshots are ready, writes a durable checkpoint, and performs no deletion.
2. A six-minute writer-quiescence barrier expires before any key can be removed. The next scheduled run revalidates both v2 snapshots, then deletes at most 2,500 audited keys across bounded scans. Additional scheduled runs resume from the stored target and cursor if needed.
3. After all delete targets and exact keys are processed, the route waits at least 15 seconds and performs a clean second scan. Recreated keys restart verification; zero removals sets `complete: true`.
4. Completed runs take the done-marker fast path: one read-only checkpoint lookup, no lease, scan, deletion, upstream call, or provider processing. Keep the daily schedule installed so a partially completed manual sequence cannot strand the migration.

Expected minimum timing is three authenticated invocations: arm; delete at or after the returned `deletion_not_before` (six minutes); and verify at or after the returned `verification_not_before` (15 seconds). Use `Authorization: Bearer $CRON_SECRET` and optional `?max_keys=1..2500`; repeat while a delete or verify cursor remains. If operator access is unavailable, report that blocker and rely on the daily safety-net cron, which preserves every safety gate but can require multiple days. Do not claim cache migration completion until the checkpoint says `complete: true`.

Vercel's Cron Jobs **Run** control (or `vercel crons run /api/cron/provider-retirement`) invokes the route without revealing `CRON_SECRET`. Each successful invocation emits a `[provider-retirement]` runtime-log summary containing only the plan, phase, aggregate scanned/removed counts, deadlines, and completion timestamp—never cache-key names or credentials. Use that summary to prove `complete: true`.

The migration deletes only audited provider-derived warm prefixes, legacy price-model universe/signal values, obsolete `views:*` and related legacy rate-limit keys, and the raw `hot_tickers` key. It deliberately preserves `popular_tickers`, SEC facts/submissions, SEC-only quant company/atlas checkpoints used for transition, CFTC caches, portfolios, notes, evidence, identifiers, allocations, and user research. It never uses a global flush.

## Refresh and failure maintenance

- SEC: `/api/cron/prewarm` refreshes the compact Market atlas plus bounded SEC submissions; quant membership and 16 issuer batches checkpoint expanded coverage; `/api/cron/factor-universe` publishes both v2 bases. All mutation routes require `CRON_SECRET` and production deployment context.
- CFTC: `/api/cron/cftc` refreshes TFF and Disaggregated independently. Its daily `22:30 UTC` schedule is after the normal Friday-afternoon New York release window in both EST and EDT; the daily check and live date discovery tolerate holidays without claiming an actual publication timestamp. Hobby cron execution can occur later within its documented delivery window. Inspect `/api/v1/cftc/status` before investigating a UI report. A failed family must retain and label its own valid last-good data rather than erase the other family or imply a common date.
- CFTC retention: primary prepared responses have a 9-day TTL; validated last-good responses and raw contract histories have a 16-day TTL. Refresh checkpoints have a 3-day TTL and resume work completed within the prior 48 hours. Responses are considered fresh for 26 hours and may be served as explicitly stale for no more than 15 days. These limits apply inside the environment-scoped namespaces above; previews never fall back to production entries.
- Schema changes: add a new adapter/schema/calculation version, validate real-shaped fixtures and bounded official rows, publish the new contract, and only then migrate readers. Never reinterpret old cached fields under a new schema.
- Source failures: keep report date, retrieval time, cache age, source-report age, partial coverage, and stale state separate. Do not forward-fill missing CFTC reports or replace an unsuccessful refresh with an empty snapshot.
- Provider-free rollback: set Production `CFTC_ENABLED=0` (or `false`) and redeploy this provider-free commit. The Market tab, preview and homepage discovery disappear; positioning URLs return to SEC Market; CFTC APIs return non-cacheable `503 CFTC_DISABLED`; and the authenticated CFTC cron skips before cache or upstream access. Verify the three retired routes still return `410` and both SEC-only v2 bases still work. Re-enable with `CFTC_ENABLED=1` and another redeploy after the CFTC issue is repaired. Never use Vercel Instant Rollback to a provider-enabled deployment; roll back only to a commit that already has the three `410` routes and no provider acquisition.

## Release handoff record

Record the production commit, deployment ID/URL, retirement checkpoint totals and completion timestamp, CDN invalidation result, live CFTC report dates/counts, test/lint/typecheck/build results, and browser matrix in PR #56. A green build alone is not a verified deployment.
