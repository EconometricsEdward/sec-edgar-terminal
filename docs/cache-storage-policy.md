# Public research cache and retention

The site uses the existing Supabase project `vvkihuduqqnxqahhbphs` for shared public research data. Redis retains small operational counters, leases, cooldowns and legacy generation markers. Selected CFTC and four-company mirror payloads use the bounded Supabase cache with publication fencing preserved. No additional project or paid resource is introduced.

## Coverage and freshness

The maintained company cohort receives scheduled preparation and retains its existing immutable source, calculation and membership evidence. A lookup outside that cohort remains available through the ordinary SEC research path. Successfully fetched on-demand data can enter the shared cache for any valid SEC issuer; this does not add the issuer to the daily cohort or create a permanent research archive.

Freshness is a reader decision. Retention determines how long a replaceable cache entry can exist. Reading an entry never renews its expiration. Migration preserves the original remaining Redis lifetime, including an absolute expiration cap, and never presents old inputs as newly fetched.

| Data | Retention and serving policy |
| --- | --- |
| On-demand SEC research inputs and Analysis/Compare results | Existing five-minute freshness; large SEC JSON now fits the compressed shared cache. A miss uses the existing coordinated upstream path. |
| On-demand Portfolio company research | Existing five-minute freshness and explicitly labeled last-good fallback within 24 hours. Portfolio allocations and private notes do not enter this shared cache. |
| Disclosure keyword scans | Twenty-four hours in the bounded research family. Query/depth identities remain separate. Invalidation uses a small marker retained for 25 hours in the protected reference family; both reads and writes check the actual scan start time so result eviction or an older in-flight scan cannot restore invalidated data. Legacy Redis scan values are neither read nor renewed. |
| SEC operating-company and fund directories | Fresh for 24 hours; validated last-good directory available for at most seven days during source failure. Company, fund, series and class identities remain distinct. |
| Market/Screener current and last-good snapshots | Up to seven days, with existing source-date and stale-state validation. Each named snapshot has one atomically replaced complete compressed entry. |
| Quant company checkpoints | Fourteen days; existing filing-change detection and revalidation cadence remain. Failed-attempt records last seven days. |
| CFTC prepared primary / last-good and raw history caches | Existing nine-day primary and sixteen-day last-good/raw retention, with current report-date, identity and source validation. Canonical CFTC evidence stays separate. |
| Filing text and other document caches | Existing caller lifetime, at most 30 days, subject to the document byte budget. |
| Parsed 13F filing inputs | Up to 30 days in the document family, keyed by manager CIK, accession and parser/source-metadata fingerprint. Reusing an unchanged filing does not establish that the manager has filed no later amendment. |
| 13F manager snapshots | Up to 25 hours in the research family. Snapshots require a source check within five minutes for fresh serving; an explicitly labeled last-good report can survive a failed refresh for at most 24 hours. |
| 13F comparisons | Reuse the shared manager snapshots and parsed filings. The compact result uses bounded process memory and CDN caching for at most five minutes, capped by the earliest constituent report expiry. Partial or stale comparisons are not cached as fresh. No separate Supabase comparison entries are written. |
| Small membership references and cumulative Market observations | Up to 90 days; kept in families that do not evict unexpired entries to admit another entry. |
| Canonical SEC evidence, prepared versions and membership history | Existing durable archive policy; excluded from disposable-cache cleanup. |

## Bounded Supabase cache

Private Postgres tables hold gzip-compressed, hash-verified JSON with one row per approved type and key. This avoids a second object-garbage lifecycle for disposable data. Large immutable research evidence continues to use the existing private Storage archive. Public browsers cannot access the cache tables or RPCs; the existing production Vercel identity gateway mediates server requests.

The initial compressed-payload budget is **512 MiB**, divided into independent families so arbitrary-company demand cannot evict the global Market snapshots or checkpoints:

| Family | Compressed payload budget | Admission at capacity |
| --- | ---: | --- |
| Global snapshots | 64 MiB | Expire old entries; preserve unexpired entries |
| Company and refresh checkpoints | 96 MiB | Expire old entries; preserve unexpired entries |
| On-demand research | 160 MiB | Expire old entries, then bounded eviction by approximate recent use |
| Document caches | 64 MiB | Expire old entries, then bounded eviction by approximate recent use |
| Reference directories and memberships | 16 MiB | Expire old entries; preserve unexpired entries |
| Cumulative history and CFTC market snapshots | 16 MiB | Expire old entries; preserve unexpired entries |
| CFTC raw and derived contract histories | 96 MiB | Expire old entries, then bounded eviction by approximate recent use |

These are application payload budgets, not physical database disk ceilings. Postgres tables, indexes, old row versions, WAL and backups have additional costs. Private operational monitoring continues to measure the actual database footprint. Quota accounting and replacement are atomic; an oversized or unadmittable value does not delete useful existing entries. Access popularity is updated at most hourly. A bounded daily SQL job removes expired cache entries.

CFTC contract histories use their own 10,000-row family with a maximum 16-day serving lifetime. A raw-history cache miss can read the corresponding immutable source document; derived trader-group and window results reuse that source. Cache eviction does not delete the historical evidence. Existing CFTC entries in the former shared history family keep their original expiry during rollout; they are not bulk-moved while older deployments could still read them. See [broader CFTC preparation](cftc-history-preparation.md).

Each cache value is limited to 6 MiB compressed and 32 MiB decoded. The larger gateway body limit applies only to the new cache operations; existing durable-source, publication and scheduling capabilities retain their own restrictions. Unknown key types, coordination records and credentials are excluded from the data-cache gateway. Source CIK checks and gzip length/hash checks prevent cross-company or partial results from entering the research path.

### 13F reuse and source changes

The application writes two narrowly defined 13F cache types through the production gateway: `edgar.13f-snapshot.v1:production` for a ten-digit manager CIK plus `LATEST` or a calendar quarter end, and `edgar.13f-filing.v1:production` for CIK, SEC accession and a 64-character metadata fingerprint. The deployed allowlist also reserves `edgar.13f-comparison.v1:production` for a 64-character comparison fingerprint; no application reader or writer currently uses that reserved type. Snapshot and filing payloads must carry the same manager CIK as their key. Application readers additionally validate the report period, parser version, source accession chain, coverage, totals and source times. These are reproducible public filing results; portfolios, notes and other private user content are excluded.

After a snapshot becomes stale, the loader checks SEC submissions for new reports and amendments. Unchanged accession inputs reuse their validated parsed rows; a changed source chain rebuilds the assembled quarter. A later amendment therefore changes the result without requiring every earlier information table to be downloaded and parsed again. Compare-and-set publication prevents a concurrent older snapshot from replacing a newer check. Failed or incomplete refreshes preserve an eligible last-good report and identify its stale state; cache reads never renew its source-check time.

New 13F keys use the direct bounded Supabase adapter, avoiding the legacy Redis migration lookup on a miss. Production uses the existing Vercel workload identity and private gateway; preview and development caches remain isolated. The existing cache tables, indexes, RPCs and family quotas are sufficient. No schema, privilege, compute, storage-plan or paid-resource change is required. A gateway code deployment is required when adding a reviewed cache key type.

Read-only observations at 2026-09-15 05:02 UTC found 28,342,400 compressed cache bytes across the existing 512 MiB application budget, including 3,215,654 bytes in the 160 MiB research family and 10,750,765 bytes in the 64 MiB document family, with zero capacity evictions. PostgreSQL database size was 285,035,667 bytes; a following 05:03 UTC observation counted 9,310 private source objects totaling 479,327,789 bytes. These are observed footprints, not provisioned disk, billable monthly usage or a capacity guarantee.

Generation-fenced payloads capture the existing canonical claim before fetching. Publication can clear the active lease without losing that cache claim, but the original deadline and any newer canonical generation still invalidate the old writer. The database locks the canonical head before the cache family and entry, rolls back writes that cross claim expiry, and rejects ordinary unfenced replacement of guarded entries. Off/shadow dataset modes retain their existing Redis fencing behavior.

Disclosure scans additionally cap each decoded result at 4 MiB. Development and preview scan caches use bounded local memory only: 16 entries, 8 MiB total serialized input and 1 MiB per entry. Production cache failures do not fall back to old Redis scan results; failed invalidations are reported instead of acknowledged.

## Redis migration and operation

The signed coverage scheduler performs cache maintenance only with time remaining after research refresh work. The maintenance worker has its own private lease, bounded commands and a 20-second invocation budget. A private operator summary exposes aggregate cache use and migration progress without raw keys, source documents or credentials.

Initial inventory is read-only. After the replacement production deployment is ready and prior deployment URLs are protected, a database owner enables migration and starts a ten-minute drain window. Application credentials cannot change or shorten this window. Selected values are copied with their original remaining lifetime, read back and hash-verified before an atomic comparison permits removal from Redis. Complete snapshots are verified before their old manifests and chunks can be retired. Unreferenced generations require a separate observation grace and another parent-manifest check.

Single-entry removal uses Upstash's native `DELEX key IFEQ value` with the exact original serialized value. This retains atomic comparison while allowing ordinary verified copies to free initial space when the provider rejects `EVAL` at its storage limit. Snapshot and orphan removal retain their multi-key Lua checks. An unsupported or failed conditional-delete command preserves the Redis value; there is no unconditional-delete fallback. See [Upstash conditional deletion](https://upstash.com/docs/redis/commands/string/delex) and [capacity-limit behavior](https://upstash.com/docs/redis/troubleshooting/db_capacity_quota_exceeded).

An already refreshed Supabase snapshot can support removal of older unreferenced chunks only after target, schema, basis, integrity and publication time checks. It must be at least as recent as the earlier verified snapshot, no more than seven days old and not future-dated. Removing the current Redis manifest and its referenced chunks still requires an exact verified copy.

Unknown keys, rate counters, leases, cooldowns and generation fences are preserved. Cumulative observations require a verified replacement. There is no global flush. Redis inventory reports observed string bytes separately from Redis memory because key overhead and concurrent changes prevent those measurements from being interchangeable.

After acknowledged migration has freed space, the same signed scheduler resumes the existing versioned price-provider retirement plan. It requires verified TTM and annual replacement snapshots, preserves its own six-minute writer grace and checkpoint, and fences each bounded deletion batch to its lease. Each invocation has a 200-key and 20-second cap, including checkpoint persistence; interrupted or oversized SCAN pages remain resumable. This plan removes only its previously reviewed retired prefixes and exact keys.

Once migration is verified, maintenance switches to infrequent inventory instead of repeatedly scanning every five minutes. Cache failures continue to preserve valid fallbacks; a cache miss never makes a company unsupported. Reverting to an old Redis-only application after cleanup would restore the retired write pattern, so rollback should retain the new data routing or explicitly suspend migration while using a compatible build.
