# CFTC durable pilot

This slice changes storage and refresh execution. It does not change positioning formulas, add report families, change the company/disclosed-position distinction, or activate production readers. `CFTC_ENABLED` remains the existing feature switch. `EDGAR_DATASTORE_CFTC` independently selects `off` (default), `shadow`, or `supabase`.

## Actual consumers and bounds

`cftcServer.js` connects the existing markets, history, and status endpoints to `cftcPersistence.js`. Market, Analysis, and Risk continue using those endpoints and their existing schemas. The separate monthly FCM service remains unmigrated.

| Data | Producer / real reader | Existing Redis TTL | Durable representation |
|---|---|---|---|
| Positioning markets | `computeMarkets` / `loadCftcMarkets`, `/api/v1/cftc/markets` | Primary 9 days; last-good 16 days | Versioned prepared envelope; atomic current and last-good pointers |
| Contract/group/window history | `loadCftcHistory` / `/api/v1/cftc/history` | Primary 9 days; last-good 16 days | Versioned prepared envelope, retaining exact selected observation, compatible periods and formulas |
| Full raw contract history | Launch fetch and bounded contract fetch / `fetchCftcContractHistory` | 16 days | Private compressed source bundle; separate from normal market response |
| Family refresh checkpoint | Existing `/api/cron/cftc` | 3 days; incomplete resume window 48 hours | Durable job checkpoints at initial write, after each family, and final status; existing Redis checkpoint preserved |
| Transport coordination | Existing outbound gate and leases | Existing bounded leases/cooldown | Remains in Redis; database outage cannot bypass the gate |

The existing application freshness boundary is 26 hours, stale-use limit 15 days, source-currency limit 14 days, and public date range six calendar years. These are unchanged. Successful revalidation is stored separately from original retrieval time. Serving uses the latest verified revalidation for cache age while preserving the original `retrieved_at`/`retrievedAt` and the report date. Copying an old response alone does not revalidate it.

The source path remains bounded: latest-date discovery at most 25 rows; latest pages 500 rows with existing maximum 10,000 rows; launch history at most five 1,000-row pages; individual contract history at most three 200-row pages. Each contract envelope preserves its actual global or contract-specific page provenance. CFTC is weekly data; the existing daily revision/release checks do not create daily observations.

## Measured sample evidence

The bounded public application audit on 2026-09-13 returned the following ready responses for report date 2026-09-08. Gzip is a local level-6 measurement, not measured billed egress.

| Sample | JSON bytes | Local gzip bytes | Coverage |
|---|---:|---:|---|
| TFF markets | 137,842 | 15,174 | 99 catalog contracts; 13 expected launch raw histories |
| Disaggregated markets | 190,455 | 18,112 | 277 catalog contracts; 12 expected launch raw histories |
| TFF `13874A`, leveraged funds, 1y | 55,095 | 6,925 | 53 compatible observations |
| Public status | 544 | 249 | Two report families |

All measured positioning response samples fit the 900,000-byte application Redis cap. Full production raw-history bytes and Redis command/egress totals were not measured. No production Redis scan or wholesale legacy-payload import is used. The SEC audit identifies substantially larger raw documents, so CFTC is a bounded correctness pilot rather than a demonstrated largest cost source.

## Publication and failure behavior

1. Acquire the existing Redis load lease, then reserve a durable generation and a matching persistent Redis generation marker **before** discovery or upstream retrieval.
2. Fetch only through the existing CFTC transport. Capture exact raw envelopes and actual selected latest source fields, including quarantined rows; preserve source URLs, family, futures-only basis, contract/venue/units, pagination, timestamps and formula versions.
3. Write raw Redis values and perform the existing primary-stage → complete last-good → final-primary sequence. Each write atomically checks the reserved generation, owner and unexpired lease. Off mode continues using the original `warmSet`.
4. Upload/verify the immutable source bundle and prepared snapshot through the shared adapter. Publish current/last-good transactionally with the same durable generation. A ready last-good publication requires all expected unique raw contract envelopes.

The current and last-good pointers cannot be overwritten by an older generation. Different history-group and market resources can share a legacy raw-history key, so their independent counters do not impose a total order on that shared raw key. Existing exact selected-observation comparisons reject conflicting revisions; they remain mandatory. The durable source bundle belongs to its exact prepared version and avoids this shared-key ambiguity.

Raw source identity excludes cache/retrieval timestamps. Snapshot identity includes report date, raw observations, compatible periods, formulas, versions, coverage and quarantine, while excluding runtime freshness/publication presentation. Repeat ingestion of identical source content reuses the source and snapshot identity and advances separate revalidation metadata. Changed source observations create a revision. Nothing is deleted during rollback.

Shadow mode serves legacy data and mirrors new validated results. It performs at most eight same-generation, same-content comparison reads per process per hour, only after writes. It does not double ordinary public requests. A newer intervening generation is recorded as a revision skip, not a mismatch. Counters are bounded in-memory aggregates (`cftcPersistence.status()`), not global traffic measurements or delivered alerts.

Supabase mode keeps fresh, fully validated prepared Redis responses on the hot path, reads the durable envelope on a Redis miss/stale entry, and falls back to bounded validated legacy last-good data if durable storage is unavailable. This avoids a database/object download on every popular public request. It preserves provisional-primary rejection and complete last-good recovery. A missing/failed durable and legacy market read returns an explicit not-prepared response with **zero upstream calls**. History can derive the unchanged calculation from the durable raw bundle and save the resulting prepared response. Missing raw history returns an explicit not-prepared response; public reads cannot crawl a new contract/date. Consequently the first enabled cohort is the existing 13 TFF and 12 disaggregated launch histories plus already prepared, validated legacy selections. Unsupported/unprepared selections retain explicit unavailable behavior rather than fabricated empty observations.

Both Redis coordination failure and durable-generation reservation failure prevent an unfenced source refresh when the migration is enabled. Existing prepared data remains readable. A failed object write, verification, conditional publication or final-primary acknowledgement preserves usable last-good data; no independent background task bypasses those gates.

## Single scheduler and resume

The existing authenticated `/api/cron/cftc`, daily at 22:30 UTC in `vercel.json`, remains the sole scheduled positioning refresh. No schedule or production flag is changed. With migration enabled it enqueues/claims `cftc-refresh:YYYY-MM-DD` using the original checkpoint start date for resumed work, at most four attempts, a 300-second job lease, checkpoint renewal, bounded backoff/jitter and a dead state supplied by the shared job store. The two existing family loads remain independently fenced.

Every successfully persisted family checkpoint is also written under the live durable job owner/generation. If Redis loses the checkpoint, a valid, incomplete durable checkpoint within the existing 48-hour resume horizon can restore it. Recovery checks only the current and two preceding daily job keys and never scans an unbounded queue. A crash between writing Redis and the durable checkpoint may repeat the last bounded family; immutable identities prevent duplicate evidence. The response reports whether resume came from Redis, durable state, or a new run. A completed, busy, delayed or exhausted daily job is skipped. No second scheduler or unbounded retry loop is added.

## Validation and activation gate

Focused tests cover unchanged off-mode behavior; exact response/raw round trips; stable source/snapshot identity across retrieval timestamps; wrong/retired payload rejection; legacy rollback after final-primary interruption; older-generation/publication failures; bounded shadow comparisons; durable raw-to-history serving without source requests; 1y/3y histories that correctly stop at a non-exhausted 200-row page; and durable job checkpoints. Existing CFTC transport, route, formula, company-evidence and UI regression tests remain mandatory. Redis fence tests separately exercise the atomic Lua generation/lease checks.

Full raw-source storage has to be rehearsed with captured, validated raw envelopes or clearly labeled local fixtures. The public market/history samples above do not by themselves prove a full raw-history production round trip. Production cutover still requires actual Supabase verification, response/UI regression, measured miss latency and rollback coverage. No capacity or billed savings claim follows from fixture tests.

After those gates and user confirmation, set only `EDGAR_DATASTORE_CFTC=supabase` for the intended deployment and verify markets/history/status. Roll back to `off`, verify the preserved legacy primary and last-good envelopes are within retention, and keep the same CFTC scheduler active. Do not delete evidence, raw bundles, retained versions, job records or generation markers during this rollback. Cleanup remains a separately approved dry-run workflow.
