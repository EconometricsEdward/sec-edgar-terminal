# Shared company research on Supabase

The broader research store uses the existing approved project `vvkihuduqqnxqahhbphs` and the existing Pro subscription. Vercel remains on Hobby; Upstash remains the hot cache. No compute upgrade, additional project, replica, or paid add-on is required by this change.

## Coverage and identity

The initial dated IVV holdings reference (2026-09-08) identifies 503 securities across 500 SEC issuers. This is an IVV reference for S&P 500 coverage, not an exact current SPY holdings list. `src/data/sec-coverage-2026-09-08.json` remains the reviewed bootstrap and rollback snapshot. The private membership registry maintains subsequent dated holdings, SEC CIK mappings, share-class aliases, source hashes, activation times, and departed issuers. The broader screener membership continues its independent update process.

The existing five-minute scheduler checks for a due membership refresh once every 24 hours. It downloads only the fixed official IVV CSV and a fresh SEC ticker directory through the shared SEC request gate. Admission rejects stale or incomplete sources, ambiguous identities, unexpected ticker reassignment, and turnover above 5%. Normal validation accepts 475–525 issuers rather than requiring exactly 500. An explicitly audited exception excludes tiny USD residuals marked `NO MARKET` with displayed zero weight; their individual and combined market value must not exceed $100,000. Listed securities with missing CIK mappings are never silently excluded.

Validated candidates are stored with compressed raw CSV evidence. The production gateway verifies both raw and compressed hashes. Activation occurs atomically only when every candidate issuer and ACU has two current canonical SEC documents and all eleven current prepared views, with valid source lineage and metric projection. A check prepares at most two missing issuers within a 125-second budget, rotating pending identities across invocations. Other daily refresh work retains the remaining request budget. Failures preserve the active membership and use bounded backoff. Candidates that become too old must be replaced from a newly validated source before activation.

Retired issuers keep their source evidence, prepared history, and membership records. Current prepared readership follows active membership; former members retain the site's existing on-demand research path. Application membership reads use a five-minute coalesced cache. Background workers require a successful current registry read. The gateway retains the reviewed baseline fast path and consults the private admission registry for newly admitted CIKs; key families, calculation versions, payload limits, and source-only permissions remain restricted.

The existing ACU pilot remains supported, producing 501 research issuers. Verified XOM predecessor CIK 0000034088 supplies two supporting documents, without adding another constituent or changing the current issuer's identity. Portfolio evidence retains the predecessor's SEC filing URLs.

## Serving and refresh design

Each issuer has two canonical SEC source documents, four Analysis bases, three Compare bases, and four Portfolio bases. Every prepared view uses the existing calculators, fiscal periods, missing-value behavior, and source evidence. Latest supported Analysis metrics are stored as queryable, version-linked observations with their actual units. Full historical response content is compressed in private Storage.

Compare's browser requests packed evidence and expands it locally. The default external API response remains compatible. Public page requests do not enqueue coverage jobs. Historical `asOf` requests retain their existing calculation path. Broad readers were independently gated during initial preparation and are enabled by the final activation release; the four original pilot readers remain active throughout. The broader scheduler replaces the old four-company schedule.

Only pilot issuers retain large legacy Redis mirrors. The broader prepared archive stays in Supabase, with Vercel CDN caching serving repeated requests. Unchanged financial and research views use small manifest reads and metadata revalidation instead of downloading and recalculating complete stored responses. Unchanged source bytes reuse existing immutable assets. Refreshes preserve original fetched times and track revalidation separately.

Coverage workers reuse a successful source check for only 15 minutes to avoid redundant downloads during nearby retries. The normal daily cycle therefore revalidates a daytime backfill at the next midnight cycle, even when it is only 16 hours old. This prevents a long reuse window from skipping an entire daily cycle and extending the gap beyond the 25-hour freshness lifetime. A 304 response preserves the original fetched time while renewing the revalidation time and expiration; the same retry interval applies to XOM's supporting documents.

Market and Screener keep their existing larger shared universe. Their prepared Market overview also receives a durable Supabase copy, which can recover service if its Redis snapshot is missing. Market detail and quant coverage reuse canonical prepared SEC documents where available. Existing CFTC preparation continues unchanged.

## Bounded work and security

The daily issuer universe becomes 32 stable CIK-based shards (11–24 issuers each). A bounded worker attempts at most six issuers within a 225-second request budget, saving each checkpoint before advancing. A failing issuer moves to a limited retry queue so other issuers continue. Successful continuation does not consume the crash retry budget. Provider cooldowns, the existing shared SEC request gate, immutable input checks, and publication generation fences remain enforced.

Eligible coverage jobs run by oldest cycle and stable shard order, continuing a yielded shard before the next eligible shard. This avoids randomly moving issuers between the beginning and end of successive daily sweeps. A future retry cooldown still allows other eligible shards to proceed, and the original pilot job ordering is unchanged. At six issuers per request, the current shard sizes require at least 96 five-minute invocations, or about eight hours per sweep. Daily revalidation is a target, not a guarantee: provider delays, retries, and worker deadlines can extend a sweep. The 25-hour freshness lifetime and shared SEC request gate remain unchanged; stale data is explicitly labeled.

One batched enqueue RPC prepares all 32 shard jobs, reducing scheduler coordination from 32 gateway calls to one. Each UTC date freezes its membership and per-shard CIK list once. Midday activation cannot change a resumed job's issuer identity or start a second complete sweep; additions are prepared before activation and join the next daily cohort. Existing completed bootstrap jobs are preserved on the migration day.

Private hourly operational snapshots record maintained coverage freshness, current and historical job progress, database counters, connections, and storage footprint. Retired heads remain in inventory but do not cause active-coverage freshness alerts. Operational snapshots retain 90 days; this cleanup does not delete membership history, company data, or source evidence. The protected `/api/internal/data-migration` GET response includes membership and operational summaries using its existing authorization. Supabase SQL operators can inspect `select public.edgar_coverage_operations('production',24);` and `select public.edgar_coverage_registry('production');`. Never place the operator credential in a URL or browser client.

Health distinguishes delayed snapshots, stale or missing current publications, expired worker leases, incomplete daily work, and unresolved failures. Hourly database counters describe intervals and include unrelated activity; connection samples are not peak measurements. CPU, month-to-date billable usage, and simultaneous visitor capacity are explicitly unmeasured. See [the measured browsing baseline and bounded repeat procedure](coverage-capacity.md).

The gateway retains production Vercel OIDC verification, fixed project/team identity, private Storage paths, bounded payloads, and restricted SECURITY INVOKER RPCs. It allows only reviewed source and result keys. No privileged Supabase credential is copied to Vercel or exposed to browsers. The dedicated coverage signing credential stays in Supabase Vault. Scheduled requests carry an HMAC bound to the fixed endpoint, timestamp, and random nonce, with a five-minute validity window and atomic replay prevention. A narrow OIDC-protected invoker RPC verifies the signature using the service role's existing Vault permission; public roles cannot execute it. The public endpoint rejects malformed requests and bounds signature verification attempts. Supabase Cron is active every five minutes after successful production authentication and job verification. Anonymous scheduler requests return 401.

The platform-owned `pg_net` queue has grants this project's database role cannot revoke. The signed protocol therefore keeps the long-lived credential out of that queue. No platform role or access-control bypass was used. The `pg_net` extension was installed with its registry in the extensions schema before any requests were queued.

## Verification and rollout

The automatic membership and operations release passed 1,656 regression tests, with two intentional skips, typecheck, production build, and all ten existing database recovery gates. Exact new migration fixtures cover thirteen membership cases and six operations database cases; focused application tests cover cache failures, candidate activation, removed issuers, frozen jobs, provenance changes, and protected status access. Seven pre-existing ESLint warnings remain outside the changed functionality.

Hosted migration preflight on 2026-09-13 found all 6,515 maintained SEC/source and research heads fresh, with zero missing heads, zero lineage mismatches, zero pending jobs, and zero expired leases. Database checks found no browser-role grants on private tables or the new RPCs. The security advisor reports informational [RLS-without-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), which match the intended service-only, default-deny design. The performance advisor's unindexed active-membership foreign key is on a namespace singleton control row; no speculative index or compute upgrade was added.

Analysis publication identity now includes raw source hashes as well as the normalized financial inputs. The first normal refresh after this release will create new Analysis versions to establish that stronger provenance identity. Later identical inputs revalidate normally. This bounded rebuild preserves reported figures and historical evidence.

The activation regression run passed 1,565 tests with two intentionally skipped tests and zero failures. Typecheck and the staged production build passed. The existing PostgreSQL recovery rehearsal passed all ten gates; additional batch, security, signed scheduler, and job tests exercise the new SQL. Seven pre-existing ESLint warnings remain outside the changed functionality.

AAPL TTM Compare in the committed public fixture measured 67,945 gzip bytes for expanded evidence and 28,398 for packed evidence, approximately 58% lower transfer. This fixture measurement does not establish production latency or traffic capacity.

The database migrations and gateway are additive. Rollback disables `EDGAR_DATASTORE_BROAD_COVERAGE` and the coverage schedule, retaining published source evidence and existing pilot behavior. A full durable-read rollback can still use the existing independent dataset flags. Membership and company evidence are retained; only the new operational time series has automatic 90-day cleanup.

## Production evidence, 2026-09-13

The initial backfill completed at 08:28 UTC: all 32 shards done, 501 successful issuers, zero remaining retries or failed issuers. A temporary larger initial batch encountered the shared SEC gate and one storage timeout; those issuers recovered through the bounded retry queue. Later manual backfill batches were limited to eight requests. All 106 initial signed HTTP requests completed with HTTP 200 and no HTTP timeout. Cron's own 08:00, 08:05, and subsequent runs also executed successfully; a cron enqueue receipt is distinguished from its later HTTP/job completion.

| Verified current data | Count |
| --- | ---: |
| Research issuers | 501 |
| Canonical source documents, including XOM support | 1,004 |
| Analysis views | 2,004 |
| Compare views | 1,503 |
| Portfolio views | 2,004 |
| Latest normalized metric observations | 150,206 |
| Validated input-document references | 11,036 |

Every required output was current. Audits found no missing source assets or stored objects, invalid units or periods, duplicate metrics, invalid evidence-reference structure, or source lineage/hash mismatches. Of the latest metric observations, 52,957 are reported, 58,350 calculated, and 38,899 explicitly unavailable. Prepared coverage does not imply that every metric or reporting basis exists.

The current HONA and XOM SEC issuer records lack supported annual history for Analysis and Compare; their current-record TTM values are also unavailable. HONA's annual Portfolio period is unavailable. These limitations match the preactivation live calculators and are not migration data loss. Quarterly/YTD data remain available. XOM Portfolio retains its independently verified predecessor history, including the 2025-12-31 annual period. No parent-company history is silently substituted into Analysis or Compare.

The latest production build durably published the existing Market overview: 1,498 companies across 11 sectors, with source time 2026-09-13T07:54:24.450Z. CFTC's existing four prepared heads remain in service, with the verified baseline content hash unchanged.

At 08:45:30 UTC, PostgreSQL database size was 129,264,787 bytes and 6,207 private objects totaled 310,108,603 bytes. PostgreSQL database size excludes WAL and other system disk usage; these are observed data footprints, not month-to-date billing or visitor-capacity measurements. Three small indexes support the current, last-good, and rollback version references. The existing source index is retained; there is no destructive retention cleanup. The five-minute cron was active with no pending HTTP requests or HTTP failures at this check.

Live staged Compare checks preserved AAPL's annual metrics, periods, and source references while reducing its transferred response from 8,884 to 6,706 bytes (24.5%). A fresh browser rendered AAPL/JPM annual, quarterly, and TTM comparisons and expanded original filing and calculation evidence without site-origin console errors.

Final activation on main commit `63d6b0b` reached READY. All 12 public verification requests returned HTTP 200 on CDN misses and passed their semantic checks, including prepared AMZN data, equivalent canonical results for GOOG and BRK aliases, and XOM Portfolio predecessor evidence with 104 metric URLs and 27 filing URLs. The four raw current HONA/XOM source documents confirmed the annual-history limitations described above. Fresh browser checks for AMZN and HONA passed without errors. These checks verify representative production behavior; they are not a concurrency load test.
