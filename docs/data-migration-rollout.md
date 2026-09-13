# Staged Supabase migration: implementation and acceptance record

Historical initial-stage record. See [live activation follow-through](data-migration-live.md) for the current status.

Initial status: **reviewable implementation; production cutover is blocked**. No production reader, environment variable, scheduler, compute size, or subscription was changed. This document distinguishes installed schema, working local integrations, and unverified hosted behavior.

## Baseline and installed infrastructure

The branch was created from current main `71dd98d673da0cb2c1967843cf4a07cb4bfa5016`. Vercel production deployment `dpl_G18shh6ct3mrrbgcNU78FTFVxumr` was READY at that same commit and served `secedgarterminal.com`. Open Factor Lab PR #28 was detected and left intact. Work uses `codex/supabase-staged-migration` and a separate worktree; no force-push or merge was performed.

The exact existing Supabase project `vvkihuduqqnxqahhbphs` in organization `vwqaamrbdfaeisycoymv`, us-east-1, was verified healthy on Pro. Before changes: no public application tables, buckets, migrations, Edge Functions, branches, or pg_cron schedule. Initial database size was 10,431,635 bytes. DERIV was not modified.

On 2026-09-13 UTC, the verified additive migration was applied to that project. Its repository filename matches the version assigned by the management API:

`supabase/migrations/20260913031639_edgar_staged_data_store.sql`

SHA256: `cb8afd007a7f5a5108e9a2d8717a87d745c4c5824236fc05c1a5da65ce464c90`.

It creates five tables (`edgar_dataset_heads`, `edgar_source_assets`, `edgar_dataset_versions`, `edgar_financial_metrics`, `edgar_ingestion_jobs`), 14 restricted invoker RPCs, and the private `edgar-durable-private` bucket. Source objects are limited to 6 MiB compressed and 24 MiB decoded; compact SQL payloads are limited to 64 KiB. The adapter conservatively accounts for JSONB spacing before selecting compact SQL storage.

Live PostgreSQL 17.6 transaction tests passed compact record roundtrip, null-claim rejection, stale-worker rejection, actual anonymous RPC denial, and bucket privacy. All test rows were rolled back. Afterwards production/rehearsal contained zero heads, versions, source assets, and jobs; application relations including indexes occupied 188,416 bytes. No source objects have been uploaded through the hosted Storage API. **Schema installation is not data migration completion.**

## Implemented paths and flags

| Component | Actual integration | Default |
| --- | --- | --- |
| `dataStore.js`, `dataStoreRegistry.js` | HTTP Data API/Storage, checksums, semantic deduplication, immutable versions, fenced publication, jobs, exact-decimal metric audit, bounded exports/dry runs | No runtime access without configuration |
| `EDGAR_DATASTORE_CFTC` | `cftcServer.js` + `cftcPersistence.js`: validated Redis hot reads; durable markets/history/raw bundles/last-good; existing staged/final semantics; durable cron checkpoints | `off` |
| `EDGAR_DATASTORE_SEC` | `secDocumentStore.js`: shared primary submissions/companyfacts in SEC research, `/api/sec`, and prewarm; strict four-issuer cohort | `off` |
| `EDGAR_DATASTORE_FINANCIAL` | `preparedFinancialData.js` + `/api/analysis-research`: actual annual/quarter/YTD/TTM prepared responses; existing formulas and public shape | `off` |
| `EDGAR_DATASTORE_SEC_SCHEDULE` | Optional bounded four-issuer work inside the existing `/api/cron/prewarm`; removes that cohort from duplicate submissions prewarm | `0` |
| `/api/internal/data-migration` | Protected status, real normalized metric evidence query, dry-run retention/orphans; manual bounded SEC preparation | CRON_SECRET authorization required |

All dataset flags accept `off`, `shadow`, or `supabase`. A misspelled flag fails to off. Unmigrated namespaces are unchanged. CFTC uses the existing CFTC cron only; no second scheduler was introduced. The SEC scheduler switch remains disabled and requires separate approval. Jobs persist checkpoints, reject expired ownership, resume prior-day eligible work, and stop at bounded retry limits. No background promise is used as a queue.

The four-issuer cohort is AAPL, MSFT, JPM, and ACU: differing fiscal year ends, bank/nonfinancial companies, and differing sizes. Missingness/restatement tests supplement the measured cohort; the sample does not establish coverage of every filer. Other companies and historical/as-of variants retain the existing bounded path. New source-document reads do not serve stale raw research data that would be relabeled as newly calculated; explicit prepared responses retain bounded freshness headers and labeled last-good behavior.

Financial preparation reuses the existing compressed `analysis-research` Redis entries with provenance metadata. Ordinary prepared reads do not write Redis or fetch SEC sources. Ingestion maintains gzip rollback responses for 25 hours. CFTC preparation retains existing TTLs and validation requirements. Generation-fenced Redis writes prevent expired workers from regressing the rollback cache. This does not globally redirect warmCache.

## Evidence and practical limits

See [inventory](data-migration-inventory.md), [SEC/financial traceability](data-migration-sec-financial.md), [CFTC semantics](data-migration-cftc.md), and the committed JSON files in `data-migration-evidence/`.

The 1.92 MB `tests/fixtures/data-migration-public-samples.zip` preserves the exact public samples and source audit for reproducible offline checks; its ZIP CRC validation passed. Extract it and pass the samples directory to the audit/load scripts. Eight real SEC documents and four existing CFTC endpoint responses were sampled with strict request/byte caps. All four companyfacts payloads exceed the 900,000-byte application write limit (2.51–7.94 MB); JPM submissions are also 4.61 MB. CFTC market responses measured approximately 138–190 KB. This supports CFTC as the smaller pilot and shared SEC documents as the next priority.

Sixteen prepared financial snapshots reconcile 18,828 evidence entries to raw SEC taxonomy, concept, unit, accession, start/end dates, and numeric values. Annual payloads are 306–511 KB raw / 21–32 KB gzip; the largest quarterly/YTD/TTM prepared payloads are 1.27–1.72 MB raw / 78–110 KB gzip. Ordinary pages can avoid source downloads and repeated calculations, but the unchanged Analysis response contract means **no additional browser-payload reduction is claimed**. Single-run local four-basis preparation took 1.7–2.95 seconds per company; this excludes hosted database, Redis, Vercel, and source-network latency.

The controlled local fixture/helper HTTP load rehearsal blocked all public upstreams and used actual saved response sizes. Across 1,800 requests: zero errors and zero attempted upstream calls. At 50 simulated clients, warm-mix p95 was 2,794 ms; forced prepared-miss p95 was 2,515 ms. **The proposed 750 ms / 2 second latency targets were not met.** The mixed warm case includes durable CFTC/SEC reads; the portfolio case deliberately fans out full Analysis snapshots and is heavier than the existing compact portfolio endpoint. The load driver and service share a process, fixture Data API/Storage latency is assumed at 20 ms, and local HTTP responses are uncompressed. These results identify serialization/fan-out risk, not production capacity or a 1,000-user guarantee. Redis outage, storage outage, and missing-data probes returned expected 200/503/503 with zero upstream attempts.

Final local gates: 1,442 tests passed, zero failed, and two opt-in live-source tests skipped (1,444 total). ESLint passed with seven existing warnings in untouched files and no errors; standalone TypeScript and the production build passed, including the provider-retirement build gate. Ten actual SQL test groups passed under PGlite PostgreSQL 18. The SQL groups cover access denial, claims, repeat/revised ingestion, exact decimals, comparative reporting periods, partial writes, retry/dead-letter behavior, bounded cleanup, and portable restore. A PostgreSQL 17 subset was also executed on the named hosted database, as described above. Hosted Storage authentication/upload/download, CDN behavior, and full deployed read-switch behavior remain unverified.

## Security, retention, and recovery

New tables have RLS and no anonymous/authenticated grants or policies; only the trusted server role may use the RPCs. Functions use invoker rights and explicit search paths. Source uploads are downloaded/hash-verified before a database pointer is published. Current, last-good, and rollback references are transactionally controlled; original source age and revalidation time are separate. A semantic identity excludes newly generated presentation/retrieval fields, while changed observations or formulas create distinct evidence versions.

The runtime uses a server secret (or legacy service JWT) because no narrower Data API credential was available. This is privileged access, **not** per-namespace isolation. Never configure it in Vercel Preview or NEXT_PUBLIC variables. A runtime guard also denies the production project in previews, but code guards cannot contain malicious code already given a secret. Untrusted previews therefore use fixtures without production Supabase credentials. No credential was retrieved, printed, or installed in this session.

Supabase advisors returned informational findings: five RLS-without-policy notices are intentional deny-by-default behavior; three unindexed head-pointer foreign keys concern future deletes/referenced updates, which this migration does not perform; two newly created indexes had no usage yet. Do not add indexes merely to silence an empty-database report. An existing Auth connection-allocation notice was outside this no-auth-change scope. [RLS notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [foreign-key notice](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).

Retention is implemented **only as bounded dry runs**. Derived old snapshots and terminal job candidates are separated from permanent SEC/source evidence. Current, last-good, rollback, and in-flight objects are excluded. Orphan reconciliation has a 24-hour grace period, namespace boundary checks, reference checks, and live-writer exclusion. No deletion command or schedule is enabled. Approve a separate race-safe deletion change before any cleanup; do not treat a prior dry-run result as permission to delete later.

Pro backup entitlement does not prove a usable backup exists for this newly created project. Actual backup inventory is unverified. Database backups exclude Storage object contents; a second bucket in the same project is not independent protection. [Supabase backup limitations](https://supabase.com/docs/guides/platform/backups).

Portable recovery procedure:

1. In an approved trusted environment, export the application schema/data using the Supabase CLI's documented `db dump` options. Verify the linked project first. Use `--schema public --file schema.sql` and separately `--schema public --data-only --use-copy --file data.sql`; preserve migration history too. Credentials belong in the secure CLI/session configuration, not a committed command or shared report. These commands were verified against CLI 2.117.0 help; a hosted production dump was not run.
2. In that **export process only**, set the relevant dataset modes to `shadow` and namespace to the namespace being backed up. Run `node scripts/data-store-export.mjs --directory /safe/export/page-001 --limit 10`; repeat with the returned `--after` in a new page directory until complete. The exporter reads immutable versions, verifies source bytes, preserves exact-decimal audit strings, caps each page at 25 versions/128 MiB, and publishes its manifest last. It never changes source/production flags or deletes objects.
3. Store those object exports and the database dump on an independently protected destination you already control; no backup service was purchased here. Keep a consistent cutoff or pause ingestion for an exact full snapshot. Page flags are observational and are not an atomic cross-page database backup.
4. Restore into a disposable local Supabase environment first. Apply the repository migrations, upload original/derived gzip objects through the Storage API at recorded paths, and restore application rows with their foreign-key relationships. Never insert Storage object metadata directly in a hosted project. A database restore alone cannot recover deleted object bytes.
5. Verify each decoded SHA256, version/source link, exact decimals, and current/last-good/rollback heads before using restored readers. The local SQL rehearsal restored seven manifests and six referenced gzip objects and verified pointers, evidence hashes, comparative periods, and exact `9007199254740993.25`. This small fixture restore is tested; a hosted disaster-recovery restore is not.

## Activation and rollback gates

Current state: installed additive schema/private bucket, production running the prior commit, all new repository defaults off, no scheduled replacement, no live objects, no reader switched in preview. The preview is a regression review of the off path; it must not be represented as a live Supabase data preview.

Before asking for production cutover approval:

1. Finish the code/preview review with the full gates green. Resolve the stated load-target gap using a deployment-representative page mix and safe load environment; do not infer success from cache-only fixtures.
2. Configure `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or existing legacy service key), `EDGAR_DATASTORE_NAMESPACE`, and existing SEC/Redis coordination/CRON credentials securely in an approved trusted runtime. Production values must not be inherited by previews. `EDGAR_DATASTORE_TRUSTED_INGEST=1` is only for explicitly trusted local ingestion. Obtain actual environment-name, compute, Spend Cap, usage, and backup visibility.
3. Use namespace `rehearsal` and local shadow flags to perform complete real CFTC raw+prepared and SEC source+financial Storage/Data API round trips. Verify rejected unprivileged HTTP access, dedup, revisions, interrupted publication, and source-to-endpoint periods. Public CFTC market samples alone lack the complete raw-history bundle needed to prove CFTC ready/last-good publication.
4. Populate trusted production shadow data with the bounded existing CFTC refresher and manual SEC job (POST `/api/internal/data-migration` with `{"action":"refresh-sec","maxCompanies":2}`). Respect Retry-After and status until complete; no unlimited retry loop. Compare identical source/calculation versions only. Record fresh legacy rollback responses and verify old-reader endpoints while those entries are still valid. No production secret is needed in a preview to do these trusted checks.
5. Present that evidence for approval. Then independently enable CFTC, SEC, and financial `supabase` read flags in the intended production configuration, redeploy, and verify affected endpoints and UI. Enable `EDGAR_DATASTORE_SEC_SCHEDULE=1` only with the separate schedule approval; it reuses the current prewarm cron and processes at most four issuers. No second scheduler should refresh that cohort. CFTC retains its existing sole cron.

Rollback readers by setting the affected dataset flags to `off` and the SEC schedule switch to `0`, redeploying the verified prior/default path, and checking source/period responses. Preserve new objects and evidence. First verify that the intended rollback gzip responses remain populated within their 25-hour overlap. Large legacy companyfacts/submissions never fit the old Redis limit, so their rollback still uses the existing gated source path; this limitation must be exercised in the hosted drill. If needed, run the authorized bounded legacy prewarm before cutover; never FLUSHDB or broadly purge namespaces. A local rollback test does not substitute for this still-pending hosted drill.

## Cost and next-source onboarding

The [cost model](data-migration-costs.md) separates reads from ingestion for 1,000/5,000/10,000 DAU. Under its explicit cache/page/byte assumptions, Supabase uncached read egress is 1.62/8.10/16.20 GB per month, before a separate 1 GB ingestion/recovery allowance. Real Redis commands/storage, Vercel transfer/compute, organization usage and cache hit rates remain unmeasured. Alerts are **unconfigured**. The existing $25 subscription is the budget starting point, not a guaranteed total invoice.

Nano and Micro have the same paid compute rate; the $10 credit is organization-wide. Current compute and credit allocation are unverified. Resizing was not performed; verify current settings and obtain approval for the expected restart, usually under two minutes according to current documentation.

To onboard a later source: approve its origin/rights/cadence and dataset registry entry; define bounded canonical identity, validation and version lineage; implement a provider adapter using the existing global transport gate; prepare the smallest actual consumer slice; acquire generation claims before work; upload/verify evidence before publication; add capped resumable jobs under one scheduler; test source revisions, absence, access denial, failures and rollback; run shadow with a representative cohort and measure storage/egress before enabling readers. No new source is ingested by this migration.
