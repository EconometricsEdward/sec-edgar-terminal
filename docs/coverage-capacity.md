# Prepared research capacity measurements

The live measurement uses the public site at `https://secedgarterminal.com` with its normal CDN, Redis and Supabase behavior. It records a bounded set of real API requests, not simulated daily visitors. The existing `scripts/data-migration-load.mjs` remains a separate local fixture rehearsal; its injected dependency delays must not be presented as measured production latency.

## Fixed workload and limits

`scripts/coverage-capacity.mjs` measures these six requests in rotation. All issuers are in the prepared coverage cohort; portfolio requests contain only three issuers and public ticker symbols.

| Request | Basis | Issuers |
| --- | --- | --- |
| Analysis | Quarter | AMZN |
| Compare, packed response | Annual | AAPL |
| Portfolio research | Annual | AAPL, MSFT, JPM |
| Analysis | Annual | AAPL |
| Compare, packed response | Quarter | AMZN |
| Portfolio research | Quarter | AMZN, MSFT, JPM |

The three stages allow at most 1, 3 and 6 simultaneous requests and contain 18, 36 and 54 requests respectively: 108 requests overall. The harness enforces a sliding limit of five request starts per second and 40 per minute per API route, below the application's 45/minute Analysis and Compare limit and 60/minute Portfolio limit. It does not change the client identity or application rate controls. A rate-limit response stops the run.

The run lasts at most five minutes; individual requests have a 20-second deadline. Aggregate compressed and decoded response-body budgets are each 100 MiB. Individual response limits are 1 MiB compressed and 4 MiB decoded. Remaining budgets reserve the maximum response size for each in-flight request. An unexpected large response stops the run rather than expanding the bound.

There are no retries, preparatory warm-up requests, random query parameters, historical cutoffs, cache flushes, CDN bypass headers, direct SEC requests, private API calls, or credentials. The Portfolio POST only researches the fixed public holdings and does not save a user's portfolio. Redirects are rejected. Output is a fresh file created before any requests; an existing receipt cannot be overwritten by an accidental rerun.

## Running and interpreting a measurement

Coordinate one authorized run with the production deployment and the before/after database snapshots. The command without arguments only displays usage and makes no network requests.

```sh
node scripts/coverage-capacity.mjs --execute --out=/absolute/path/new-capacity-receipt.json
```

The output includes the exact UTC interval, the configured concurrency limit and **actual peak in-flight requests**, successful p50/p95/p99 wall-clock latency, status/error counts, compressed body bytes, decoded bytes, CDN cache headers and prepared-data sources. Every successful response must identify the expected CIK, ticker and reporting basis, contain prepared metrics and an available period, and have a fresh source check. Portfolio coverage must have no failed, unsupported, unresolved or stale issuers; partially available financial metrics remain valid and are not converted to zero.

A non-200 response, timeout, stale data, unprepared response or content mismatch aborts the remaining ramp and returns a failed process status. Requests already in flight are cancelled. Failed samples remain in the receipt, separate from successful latency percentiles. Inspect the stopped receipt and resolve the specific cause before deciding whether another bounded run is warranted.

These are external end-to-end API timings, including the test location's network, configured runtime proxy, TLS/connection reuse and response decoding. They exclude browser rendering. The script uses Node 24.5 or later and honors the runtime's existing HTTPS proxy settings without recording their values. CDN hits describe the user's delivery path and do not establish the database's maximum throughput. A concurrency cap of six does not imply six were active simultaneously; the receipt records whether that level was reached. Short samples, particularly p99 values, have substantial uncertainty.

Compressed wire bytes are HTTP response-body bytes; they exclude headers and TLS. They describe traffic from the site to this test client, **not Supabase's billable egress**, which depends on origin reads and cache behavior. Neither this receipt nor database size establishes remaining monthly plan allowances.

The site's goal of 1,000 daily users is a planning target. Capacity also depends on pages per session, API fan-out, portfolio size, geographic mix, burst concentration, freshness and cache misses. This short ramp supplies an initial measured baseline, not a guarantee or maximum-visitor claim.

## Database observations around the run

The operator should capture these read-only aggregates immediately before and after the same workload, using only the approved production Supabase project. Do not reset statistics, disable caches, change compute tiers or collect query text, authentication tokens or user data.

| Observation | Interpretation |
| --- | --- |
| UTC time, `pg_stat_database.stats_reset`, database block read/hit, commits/rollbacks, deadlocks, temporary bytes/files | Compare cumulative counter deltas only when the reset marker is unchanged. Concurrent site traffic and scheduled jobs also contribute. PostgreSQL block hit ratio is distinct from CDN/Redis hits. |
| Client connection count, active/idle count, wait-event aggregate | Two instantaneous observations can show a clear anomaly but cannot establish peak connection or CPU utilization. |
| Database bytes, private object count/bytes, latest prepared-head count | Track observed footprint and unexpected growth; these are not billed disk provisioning or monthly bandwidth usage. |
| Current coverage job counts and checkpoints, source check age and expired-view counts | Relate response freshness to background refresh progress. A scheduler invocation success is separate from a completed HTTP worker or complete daily sweep. |
| Recent scheduler HTTP status and timeout counts | Separate scheduling failure, worker failure, provider delay and preparation backlog. Do not include signed headers or scheduler secrets in receipts. |

Retain both observations and the request receipt with the same UTC run interval. Where query-level statistics are available, report bounded aggregate call/time deltas for the application's prepared read operations, with the same concurrent-traffic caveat. Do not infer CPU or RAM saturation from latency or database block counts.

For continuous CPU, IO, WAL, connection and query metrics, Supabase exposes a Prometheus-compatible Metrics API; it is currently beta, and metric names may evolve. The project dashboard reports show a subset of the same signals. No extra monitoring vendor is required for this bounded measurement, and credentials for the Metrics API must remain private. [Supabase Metrics API documentation](https://supabase.com/docs/guides/observability/metrics).

## Production baseline: September 13, 2026

The coordinated live run lasted **41.75 seconds**, from **15:31:03.256 to 15:31:45.008 UTC**. All **108 requests returned HTTP 200** and passed the prepared identity, coverage and freshness checks. No retries or protective stops occurred. The actual peak concurrency reached each configured cap.

| Concurrency cap / actual peak | Requests | Median | p95 | p99 | Errors |
| --- | --- | --- | --- | --- | --- |
| 1 / 1 | 18 | 248.8 ms | 9,450.2 ms | 9,450.2 ms | 0 |
| 3 / 3 | 36 | 230.4 ms | 5,462.7 ms | 5,757.3 ms | 0 |
| 6 / 6 | 54 | 176.2 ms | 2,938.2 ms | 5,066.9 ms | 0 |
| All stages | 108 | 220.5 ms | 2,938.2 ms | 5,757.3 ms | 0 |

The run received **3,539,172 compressed body bytes** and **55,011,654 decoded bytes**. Analysis and Compare had 68 CDN hits and four misses combined; all 36 Portfolio requests were uncached POST requests, as intended. Portfolio's three-issuer median was 656.5 ms across all stages. All underlying issuer entries reported either `supabase-prepared` or `warm-prepared`; no observed request fell back to a public upstream.

Latency tails remain a concrete limitation: the first Analysis request took 9.45 seconds, and several five-second samples also occurred on CDN **HIT** responses. Therefore this result does not attribute the tails to Supabase, nor prove a database saturation problem. The external runtime proxy and connection setup may contribute, but this run did not instrument enough connection phases to establish the cause. The combined CDN-hit median was 150.9 ms and p95 was 444.9 ms; the few long tails remain in the unfiltered receipt and all-stage percentiles.

The initial attempt stopped before receiving any HTTP response because the custom Node HTTPS agent had not inherited the runtime's required proxy configuration (`EAI_AGAIN`, one attempted request, zero response bytes). That failed transport receipt is preserved separately. The documented `proxyEnv` setting corrected the local transport, and the operator explicitly coordinated one new run; it was not an automatic retry and did not change site networking or caches.

Read-only SQL observations at **15:29:20 and 15:32:36 UTC** bracketed the run. The statistics reset marker was unchanged (`2026-08-25T20:33:23.891825Z`), making cumulative counter comparisons valid. This wider interval includes idle time and production background activity; the changes cannot all be attributed to the test.

| Observation | Before | After / change |
| --- | --- | --- |
| Database bytes | 129,723,539 | Unchanged |
| Private objects / bytes | 6,209 / 311,009,628 | Unchanged |
| Commits | 109,373 | 109,548 / +175 |
| Rollbacks | 6,225 | Unchanged |
| PostgreSQL blocks hit | 4,094,993 | 4,102,383 / +7,390 |
| PostgreSQL blocks read | 1,469 | Unchanged |
| Temporary bytes / deadlocks | 363,473,606 / 0 | Unchanged |
| Client connections | 7 | 9 |
| Expired prepared heads / running coverage jobs | 0 / 0 | 0 / 0 |

These observations found no increase in database/storage footprint, disk block reads, temporary bytes, rollbacks or deadlocks. The connection counts are point samples, not peak usage; they do not establish CPU/RAM headroom. PostgreSQL buffer hits are separate from CDN/Redis cache hits, and none of these counters represents billed monthly usage. Both snapshots and their attribution caveats are included in the live receipt.

- [Live request receipt](data-migration-evidence/coverage-capacity-production.json)
- [Initial local transport failure receipt](data-migration-evidence/coverage-capacity-baseline.json)

Eight focused offline tests verify issuer/freshness checks, sliding rate bounds, compressed-body limits, total-budget reservation, achieved concurrency reporting and stop-without-retry behavior. They make no live requests.
