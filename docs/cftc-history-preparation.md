# Broader CFTC contract history

The preparation universe is the validated current contract catalog in each of the existing futures-only TFF and Disaggregated report families. It is not restricted to the 25 contracts used by the positioning heatmap. The heatmap retains its selected-market presentation; the contract picker can use broader prepared histories.

## Shared source, separate calculations

Each contract's raw history is prepared once per catalog/report generation and archived independently. Its canonical identity includes source version, futures-only basis, report family, contract code and report date:

`raw-history-v1:futures-only:{family}:{contract}:{reportDate}`

Contract identifiers consistently accept 3–12 uppercase alphanumeric characters or `+`; they remain strings so leading zeroes are preserved. The existing report adapters admit only their own futures-only datasets. Futures-and-options combined reports require a distinct adapter and identity before they can be introduced.

The source is a hash-verified compressed immutable document. Original retrieval timestamps are preserved as metadata and excluded from content identity. Identical repeat observations reuse content; revisions preserve earlier evidence. This archive is separate from disposable caches. It is not renewed or deleted by cache reads or cache expiry.

A bounded source fetch uses at most three pages of 200 rows. It requests sufficient prior observations for the internal 520-report horizon, while public charts retain their existing 1-, 3- and 5-year windows. All trader groups reuse the same raw source. Identity, source URL, selected-observation agreement, venue, units, reconciliation, pagination and quarantine checks remain in force. A source-exhausted shorter history is prepared with disclosed limitations; missing years and percentiles are never invented.

Public history requests read prepared data only in Supabase mode. A missing cache entry can be reconstructed from durable raw history without contacting CFTC. A contract/date that has not been prepared returns an explicit unavailable response. Current multi-year charts do not imply that every historical as-of-date snapshot has been prepared.

Repeated catalog lookups reuse only hash-verified immutable source observations in a small process cache: two entries, 1 MiB of serialized rows in total, a 512 KiB per-entry cap and a fixed 60-second lifetime. Each request still checks the current database head and source age. A changed source hash causes a new verified read even when the displayed market summary is unchanged.

## Resumable preparation

The existing signed SEC coverage schedule runs SEC work first and gives CFTC preparation only the remaining bounded time. No additional paid scheduler or infrastructure is introduced. The initial preparation gate is disabled by default and is enabled by a database owner only after the first automatic SEC daily cycle is verified complete and the production deployment is ready. Application credentials cannot enable it.

Each family/catalog revision is divided into 32 frozen ordered shards. Jobs pin report date, futures-only basis, catalog identity and contract observation identities. Successful partial work checkpoints and yields without consuming the failure-attempt budget. Actual contract failures use bounded retries; one unavailable contract cannot prevent later contracts from being prepared. Replaced catalog revisions are superseded safely. Job claims, raw source publication and cache mirrors retain generation and lease checks.

Each invocation is capped at 180 seconds and 12 contracts and must fit within the parent route's 225-second research deadline. All upstream requests use the existing CFTC concurrency/cooldown gate, independent of SEC pacing. A CFTC preparation failure cannot change an acknowledged SEC refresh into a failed response.

Public coverage summaries match the current family and report date and are exposed only for a complete registered catalog. They distinguish prepared, awaiting preparation and unavailable contracts. Limited histories are a subset of prepared contracts, not a claim that every contract has five years of observations. Raw job identifiers, claims and provider errors remain private.

## Storage and operation

The CFTC contract-history cache has a dedicated 96 MiB compressed-payload budget, 10,000-row limit and maximum 16-day lifetime. It uses bounded eviction of disposable entries when needed. General on-demand research receives 160 MiB; the total shared cache budget stays 512 MiB. CFTC market snapshots and cumulative market history remain in their protected allocation.

The first complete preparation run must be measured for contract coverage, compressed source bytes, cache usage, source limitations and failed jobs. A weekly full-source archive can accumulate multiple historical versions; estimate growth from these measured bytes and observed revisions. Database payload quotas do not measure physical database disk, object storage, bandwidth, CPU or visitor capacity.

Production verification covers the natural SEC cycle, prepared history outside the former launch list in both families, group/window reuse, unchanged raw selected values and formulas, cache misses falling back to durable sources, public coverage reporting and ongoing scheduled progress. Turning off the operator preparation gate stops new background work without deleting evidence or disabling already prepared reads.
