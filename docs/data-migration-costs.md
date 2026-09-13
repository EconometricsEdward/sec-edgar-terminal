# Supabase migration: baseline, budget, and operating assumptions

Audit date: **2026-09-13 UTC**. This is a planning model and a read-only infrastructure audit, not a capacity guarantee, invoice forecast, or claim of production cutover. Application changes and acceptance evidence are tracked separately.

## Confirmed live baseline

The connected Supabase tools returned the following before migration changes:

| Item | Observed value |
| --- | --- |
| Organization | `vwqaamrbdfaeisycoymv` — EconometricsEdward's |
| Organization subscription | `pro` |
| Project | `vvkihuduqqnxqahhbphs` — `sec-edgar-terminal` |
| Region / status | `us-east-1` / `ACTIVE_HEALTHY` |
| Project creation time | `2026-09-13T01:05:37.466412Z` |
| Database release | `17.6.1.166`, Postgres engine 17, GA channel |
| Database bytes | 10,431,635 bytes, approximately 9.95 MiB |
| `max_connections` | 60; this does **not** distinguish Nano from Micro |
| Application relations | None in the bounded `pg_stat_user_tables` inventory after excluding Supabase-owned schemas |
| Storage buckets | None |
| Recorded migrations / branches / Edge Functions | None |
| `cron.job` relation | Absent |

Evidence: `get_project`, `get_organization`, `list_migrations`, `list_branches`, `list_edge_functions`, and bounded read-only SQL against the named project. No unrelated project was queried or changed by this audit.

**Unverified:** current compute size, provisioned disk size, Spend Cap switch state, actual organization usage, upcoming invoice, other projects' consumption of organization credits/allowances, available backup dates and restore status, Vercel/Upstash account billing, and actual production traffic. The connected Supabase tool set does not expose the corresponding billing, compute-settings, or backup-list endpoints. No Supabase management token was present in the process environment. No browser sign-in or settings change was attempted. Plan entitlement is not evidence that a usable backup already exists, particularly for a project created today.

## Budget rules and current published prices

Supabase bills by organization. Pro includes a **single $10 monthly organization compute credit**, sufficient for one Nano/Micro instance; it does not give each project another independent credit. Every running paid project contributes compute charges. Paid Nano and Micro have the same published compute price. Moving an existing paid Nano to Micro therefore has no expected increase in steady-state compute rate, but current size and organization credit usage remain unverified. [Compute billing](https://supabase.com/docs/guides/platform/manage-your-usage/compute), [organization billing](https://supabase.com/docs/guides/platform/billing-on-supabase).

Micro is approximately $10/month at $0.01344/hour, with 1 GB memory. Supabase reports that a compute-size change usually causes **less than two minutes of downtime**, but may take longer. Resizing requires the user's approval and has not been performed. Do not treat the Pro subscription as a compute-size setting. [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk).

| Item | Pro inclusion | Published overage |
| --- | --- | --- |
| Subscription | $25/month | Plus usage, add-ons, and applicable tax |
| Compute credit | $10/month for the organization | Compute remains hourly billed |
| Database disk | 8 GB per project | $0.125/GB/month |
| Storage objects | 100 GB across the organization | $0.0213/GB/month on current pricing page |
| Uncached egress | 250 GB across the organization | $0.09/GB |
| Supabase cached egress | Separate 250 GB organization quota | $0.03/GB |
| Database API requests | Unlimited count advertised | Compute/egress/resource limits still apply |

Sources: [pricing](https://supabase.com/pricing), [egress billing](https://supabase.com/docs/guides/platform/manage-your-usage/egress), [Storage size billing](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size). The general billing guide rounds Storage overage to $0.021; this model uses the pricing page's $0.0213. Disk is the explicitly documented per-project exception; other listed usage quotas are organization-wide.

Supabase cached egress means a hit at **Supabase's CDN**, generally for Storage. A Vercel CDN hit does not reclassify Supabase Data API traffic as cached egress. Account for source-to-Vercel ingress, Supabase-to-Vercel transfer, Redis transfer, and Vercel-to-browser transfer separately. [Egress definitions](https://supabase.com/docs/guides/platform/manage-your-usage/egress).

Keep an enabled Spend Cap enabled. It covers selected usage items; it is **not a total invoice cap**. Compute, branches, replicas, PITR, custom domains, IPv4, log drains, and provisioned disk performance are among its exclusions. Quota exhaustion can restrict service; an enabled cap does not make excessive demand safe or free. No new paid component or setting change is authorized by this document. [Cost control](https://supabase.com/docs/guides/platform/cost-control).

## Read-demand scenarios

All values below are **assumptions**, not observed hit rates or measured savings. Use 30 days/month, 8 page views/user/day, 3 API reads/page, an 80,000-byte average public API response, 70% Vercel response-cache hits, and 85% Redis hits among requests reaching the application. Assume one batched 50,000-byte Supabase prepared response per remaining miss. These assumptions apply only to migrated public research reads; private requests and unmigrated endpoints need separate accounting.

Formulas:

```text
monthly_api_reads = DAU * 30 * 8 * 3
origin_requests = monthly_api_reads * (1 - 0.70)
supabase_reads = origin_requests * (1 - 0.85)
supabase_read_egress_GB = supabase_reads * 50_000 / 1_000_000_000
public_api_transfer_GB = monthly_api_reads * 80_000 / 1_000_000_000
```

| Monthly demand | 1,000 DAU | 5,000 DAU | 10,000 DAU |
| --- | ---: | ---: | ---: |
| Page views | 240,000 | 1,200,000 | 2,400,000 |
| Public API reads | 720,000 | 3,600,000 | 7,200,000 |
| Application origin requests / Redis GETs | 216,000 | 1,080,000 | 2,160,000 |
| Supabase prepared reads | 32,400 | 162,000 | 324,000 |
| Redis refill SETs, upper planning count | 32,400 | 162,000 | 324,000 |
| Supabase uncached read egress | 1.62 GB | 8.10 GB | 16.20 GB |
| Public API transfer through Vercel | 57.60 GB | 288.00 GB | 576.00 GB |
| Added ingestion/recovery download reserve | 1.00 GB | 1.00 GB | 1.00 GB |
| Total modeled Supabase uncached egress | 2.62 GB | 9.10 GB | 17.20 GB |
| Supabase cached egress assumed | 0 GB | 0 GB | 0 GB |
| Modeled Supabase egress overage, if quota available | $0 | $0 | $0 |

Redis counts exclude rate limits, locks, cooldowns, job coordination, multi-command helpers, and ingestion writes. Coalescing can reduce refill SETs. Public API transfer excludes HTML, JavaScript, images, downloads, security traffic, and all other application endpoints. The 1 GB reserve is a planning allowance for verification, reconciliation, export, and occasional object retrieval; it is not a measured ingestion requirement.

For a conditional Vercel compute sensitivity, assume each origin request consumes 15 ms active CPU and 100 ms of a 2 GB instance with no concurrency sharing. This produces 0.9/4.5/9.0 CPU-hours and 12/60/120 GB-hours at 1k/5k/10k DAU. At published `iad1` Pro rates ($0.128/CPU-hour, $0.0106/GB-hour, and $0.60/million invocations), those read-function components would be approximately **$0.37 / $1.86 / $3.72** before credits, subscription, data transfer, ingestion, and other functions. These are illustrative gross usage calculations, not verified account charges; actual instance sharing and durations determine billing. [Vercel Fluid pricing](https://vercel.com/docs/functions/usage-and-pricing).

Upstash charges cannot be responsibly estimated in dollars without the existing plan and usage. Apply its verified account terms to the command/byte counts above. Do not assume a new plan or claim that shorter TTLs reduce the bill.

If the project stays within its included disk, the organization remains within Storage/egress quotas, and its $10 compute credit covers the active Nano/Micro, the modeled Supabase subtotal remains about **$25/month** at all three traffic levels. This is conditional on capacity, remaining organization allowance, other projects, add-ons, and taxes; it is not a guaranteed total website bill. No compute upgrade is assumed.

Cache-failure sensitivity matters: with both public caches ineffective, 50 kB per Supabase read would produce 36/180/360 GB read egress, or 37/181/361 GB including the reserve. The 10k scenario exceeds an otherwise unused 250 GB quota by 111 GB, equivalent to $9.99 of egress overage **only if** overage is enabled; with Spend Cap on, service restrictions may apply. Admission limits and bounded unavailable/last-good responses must prevent an outage from becoming unlimited downloads.

## Ingestion is independent of user count

For a separate, fixed-scope example, assume 100 companies, two SEC source resources per company, one bounded check per resource/day, 10% content changes, 1.5 MB average upstream JSON, and 0.4 MB compressed changed object. This is 6,000 monthly SEC checks, at most about 9 GB upstream ingress without conditional-response savings, 600 new source versions, and 0.24 GB/month new Storage evidence. The initial 200-object cohort adds about 0.08 GB. Hash deduplication prevents unchanged checks from creating new objects.

Assume a further 20 configured CFTC market/history objects, five successful weekly publication cycles in a long month, and 0.2 MB per compressed changed object: at most 100 new objects and 0.02 GB/month. The count is a scenario input, not an assertion about the actual configured market universe. Revision and failed-release checks add requests, but unchanged responses should not add archives. At 25 kB per changed compact financial revision, 600 revisions add approximately 15 MB of raw serving payload before indexes and metadata. Measure these inputs from the representative cohort before expansion.

These source costs remain the same across the three DAU scenarios when dataset coverage stays fixed. Expanding company coverage or archival depth changes ingestion and retention cost; user growth alone should not launch proportionate SEC/CFTC retrievals. Schedule observed upstream changes according to registry policy rather than using these financial-model assumptions as new freshness promises.

CFTC COT normally publishes Friday at 3:30 p.m. US Eastern for the preceding Tuesday's positions. Holidays alter release dates. More daily checks do not create daily observations. Keep bounded release-failure/revision checks and preserve reporting date separately from retrieval/revalidation time. COT classifications are market aggregates, not disclosed company derivatives positions. [CFTC COT explanations](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm), [release schedule](https://www.cftc.gov/MarketReports/CommitmentsofTraders/ReleaseSchedule/index.htm).

## Runtime and access-control constraints

- Vercel cron invokes ordinary Vercel Functions, so duration and usage charges apply. Current documentation allows 100 cron jobs/project; Hobby jobs run at most once/day with up to an hour's scheduling imprecision, whereas Pro supports per-minute scheduling. Verify the actual application account before changing schedules. [Cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- With Fluid Compute, current Node/Python limits are 300 seconds on Hobby and a generally available 800-second maximum on Pro/Enterprise; longer 1,800-second execution is a restricted beta, not an assumed entitlement. Function request/response payload limits are 4.5 MB. Respect smaller repository `maxDuration` values and checkpoint before expiry. [Function limits](https://vercel.com/docs/functions/limitations).
- Supabase Edge Functions currently have 256 MB memory, a paid-plan 400-second worker wall limit, 2 seconds active CPU/request, and a 150-second request idle timeout. No Edge Functions exist in the audited baseline and this document does not recommend moving bulk parsing there. [Supabase function limits](https://supabase.com/docs/guides/functions/limits).
- Prefer HTTP Data API for this phase. If a direct PostgreSQL driver becomes necessary, use the supported transaction pooler for short serverless work, a module-scoped client with a small pool (current guide starts at one connection), disabled prepared statements, timeouts, and verified TLS. Copy the actual pooler hostname from connection settings; the region does not uniquely determine it. [Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres).
- New secret keys map to `service_role` and bypass RLS. They remain server-only and still need table/function grants. Preview namespace names do not confine a privileged production secret. Modern secret/publishable keys are preferred; the current documentation announces legacy `service_role`/`anon` deprecation by the end of 2026. [API keys](https://supabase.com/docs/guides/getting-started/api-keys).

The [Supabase changelog index](https://supabase.com/changelog) was fetched and checked on the audit date. Relevant changes:

- New projects since May 30, 2026 require explicit Data API grants on new public tables, including grants for `service_role`; bundle narrowly scoped grants and RLS in the migration. Do not rely on historical automatic grants. [Data API exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
- Extension version pins have been ignored in favor of platform defaults since August 5, 2026. Avoid misleading `CREATE EXTENSION ... VERSION` clauses. [Extension change](https://supabase.com/changelog/extension-version-pinning-ignored).
- The August 12, 2026 backup-scheduler fix addresses missed scheduling windows. It does not establish that this specific new project already has a valid backup. [Backup scheduling fix](https://supabase.com/changelog/bulk-prepare-retry-on-transient-failure).

## Backup, retention, and observability limits

Pro includes daily database backups retained for seven days. The current Postgres release is eligible for physical backups. **Database backups do not include Storage object contents**; they contain object metadata. Restoring the database cannot recover deleted source objects. A second bucket in the same project is not independent disaster recovery. Actual backup availability and managed restore remain unverified. [Database backups](https://supabase.com/docs/guides/platform/backups).

Preserve source evidence and revisions; deduplicate content by hash. Treat replaceable response snapshots and bounded operational records separately. Cleanup must remain dry-run until separately approved and must exclude active, last-good, in-flight, and rollback-referenced objects. The example 0.26 GB monthly source growth is additive evidence retention, not permission to impose an evidence TTL.

A portable recovery package needs schema/migrations, metadata and revision rows, referenced object bytes, hashes, and a manifest linking them. Downloadable database exports alone are insufficient. Validate object hashes and restore a small sample into local or explicitly safe staging storage; do not rehearse by restoring over the production project. Document credentials/roles separately without exporting live secrets. No external backup destination, PITR purchase, independent object protection, or tested alert delivery is claimed here.

The local SQL rehearsal in `scripts/test-data-store-db.mjs` now executes the unmodified tracked migration and passes ten assertion groups, including access denial for `anon`/`authenticated` across 14 RPCs, generation/lease fences, source deduplication, revalidation age, exact financial decimals and comparative periods, job retries/checkpoints/dead-letter limits, and protected dry-run cleanup. Its portable restore recreates seven version manifests and six referenced gzip objects in a second isolated database, checking content hashes and current/last-good/rollback pointers. A JSON export must encode PostgreSQL `numeric` as text before parsing in JavaScript; native `pg_dump` also preserves decimal precision.

Run `npm run test:data-store-db` after installing the pinned dev dependency. `PGLITE_MODULE` can point to an isolated installed PGlite module when the repository dependency tree is unavailable. This rehearsal uses PGlite 0.5.8/PostgreSQL 18.3 with local Storage metadata and byte fixtures. Live Supabase is PostgreSQL 17.6. These are real SQL assertions and a local restore, not hosted Storage/Data API round trips, multi-connection race/load tests, a verified managed backup, or a production disaster-recovery test.

Measure database/index bytes, object counts and compressed bytes, actual API payload sizes, Redis commands/bytes, per-service cached/uncached egress, ingestion lag, retries and failures, and source requests. Use aggregate status and existing logs rather than per-public-request database rows. Record alerting as **unconfigured** until a delivery path is tested. Supabase/Vercel dashboards and account usage must be reconciled before any forecast is presented as an expected invoice or any capacity target is presented as achieved.
