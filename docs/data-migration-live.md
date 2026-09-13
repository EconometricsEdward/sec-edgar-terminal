# Live Supabase activation record

This follow-through supersedes the initial blocked state in `data-migration-rollout.md`. The user explicitly authorized production Supabase use on 2026-09-13, while retaining the existing Supabase Pro, Vercel and Upstash budget. Production activation proceeds through shadow writes and verified source/object/database/endpoint checks; a successful build alone does not prove live data use.

## Connection and security

The application now supports a narrow `edgar-data-gateway` Supabase Edge Function. Vercel obtains its short-lived workload identity inside each server request using pinned `@vercel/oidc@3.8.7`; Supabase verifies it using pinned `jose@6.2.12`. Exact issuer, audience, subject, stable team/project identifiers, production environment, signature and token lifetime are checked. Preview and development identities are denied. Supabase's privileged credential remains in its existing Edge runtime and is never copied to Vercel or returned to callers.

The gateway accepts only the 14 migration RPCs and the approved private source/snapshot object paths. It forces the production namespace, validates nested object references and the four-issuer cohort, prohibits arbitrary destinations, deletion and overwrite, bounds request/response bytes, and sanitizes errors. The SQL RLS/grants and generation fences remain in force. Supabase's built-in JWT check is disabled for this function because the function validates Vercel's signed identity instead; it is not an unauthenticated gateway.

Workload identity authenticates the deployment, not a visitor. Administrative refresh/status routes retain their CRON_SECRET check. A temporary high-entropy operator credential, represented only by its SHA256 and an absolute expiration in deployment configuration, permitted bounded bootstrap and rollback verification. Final configuration removes that credential by setting `MIGRATION_BOOTSTRAP` to null. It never authorized other cron endpoints or previews. Credential rejection is checked again after the final deployment.

Production defaults are reviewed in `src/utils/dataStoreDeployment.js`; explicit independent environment flags override them. Direct server-key transport remains available for an already trusted runtime. Unconfigured local/preview runtimes remain off. No new user login or authentication product is introduced.

## Performance evidence

Full receipts are in `data-migration-evidence/performance-followthrough.json`. Immutable, hash-verified content can be reused within bounded process caches, while current head metadata and expiry remain checked. Upload verification and source export always read the actual object bytes. Prepared financial responses reuse their exact JSON text instead of repeatedly serializing identical payloads; calculations and response contracts are unchanged.

| Controlled workload, 50 clients | Warm p95 | Prepared miss p95 |
| --- | ---: | ---: |
| Original synthetic five-full-Analysis portfolio stress | 1,831 ms | 1,363 ms |
| Actual compact portfolio helper, shared load-driver process | 779 ms | 462 ms |
| Actual compact portfolio helper, separate load-driver worker | 470 ms | 290 ms |

The final representative run completed 1,800 requests with zero errors and zero public-upstream attempts; all eight proposed fixture gates passed. Cold Analysis/SEC reads were 105/123 ms. Five outage probes covered Redis, PostgreSQL, warm/cold Storage and missing data. The heavier stress warm target remains unmet. An earlier worker stress run hit the memory guard and stopped; that result is preserved. These fixtures use assumed network latency and are not a production capacity guarantee.

## Costs and operation

No compute resize, new project, database branch, replica or paid add-on is needed. The gateway uses the existing Pro Edge allowance: two million invocations, with documented overage at $2 per million. Each durable RPC and Storage operation adds a gateway invocation. Count both Storage/database-to-Edge and Edge-to-Vercel egress, and keep Vercel CDN/Redis hot caching. At the prior illustrative 32,400 monthly durable reads, a manifest plus object would imply roughly 64,800 gateway invocations before ingestion; this is an assumption, not measured traffic. Organization allowances are shared, and actual total billing/Spend Cap/other-project usage remain unverified.

The existing SEC prewarm and CFTC cron remain the only authoritative refresh schedules. The SEC job is capped to AAPL, MSFT, JPM and ACU, with resumable checkpoints. Cleanup remains dry-run only. Database backups do not include Storage object contents; preserved public sample fixtures and the portable export/restore procedure remain relevant, but a hosted independent backup inventory is still unverified.

## Deployment and acceptance receipt

PR #60 deployed commit `a0a5046db5f5f77137691dccd91a001a2e9f6f98` to production (`dpl_FMHrFehPt3DKXfiwY1tgyTvYGsRU`) in shadow mode. The first hosted check exposed Supabase's relay path normalization: the function receives `/edgar-data-gateway/...`, without `/functions/v1`. Gateway version 3 accepts those two exact hosted/local prefixes and preserves the same authentication and inner operation allowlist. Seventeen gateway tests, including prefix lookalikes, and the Deno check pass. The production status endpoint then returned HTTP 200 through real Vercel workload identity; anonymous and forged gateway requests remain denied.

At 05:39 UTC on 2026-09-13, the live application had published 26 current versions: eight canonical SEC documents, sixteen financial views (annual, quarter, YTD, TTM for AAPL, MSFT, JPM and ACU), and two CFTC market snapshots. Ten immutable source assets include the eight SEC documents and both exact CFTC source bundles, with all 13 TFF and 12 disaggregated launch-market raw histories. CFTC report date is 2026-09-08. All sixteen financial rollback mirrors were acknowledged. Both durable ingestion jobs are done; SEC resumed from cursor 2 to 4 on its second claimed batch. One intervening call safely returned busy during its stored cooldown.

The protected financial endpoint read the AAPL annual snapshot and nine normalized observations through the live gateway, including revenue `416161000000` for 2025-09-27, with accession, filing date, source document hashes and calculation lineage. The status check reported 2,537,014 source bytes and 1,194,405 derived snapshot bytes, zero orphan candidates, and deletion disabled. These are logical referenced compressed bytes; shared source/snapshot objects are not double-counted as physical storage. Full bootstrap receipts are in `data-migration-evidence/hosted-activation.json`.

PR #61 enabled all three Supabase reader defaults and the bounded four-company SEC work within the existing prewarm cron. Production `dpl_n4KxZzuQSDG8MBWmZgmWHhvHUgpx` served eleven verified public requests. AAPL submissions and the 7.94 MB JPM companyfacts response returned `X-Cache-Source: supabase` and matched canonical source documents. AAPL annual, MSFT quarter, JPM YTD and ACU TTM returned `warm-prepared` and matched the exact published snapshot hashes. Both CFTC market families and sampled histories returned ready data. Previously unprepared TFF dealer/3y and disaggregated corn/non-reportable/1y histories returned `computed-from-prepared-raw` and created two durable history versions while preserving original source retrieval times. The other sampled history used an existing validated prepared cache entry.

An independent database review verified all 136 normalized financial observations, 32 input document links and 306 source references, with zero discrepancies. Browser reloads verified the homepage, AAPL Annual, and both CFTC families: all displayed financial highlights matched, 99 TFF and 277 disaggregated contracts appeared, launch coverage was 13/13 and 12/12, and no site console errors were observed. See `hosted-financial-review.json`, `hosted-ui-review.json`, and `hosted-public-read-review.json` in the evidence directory.

PR #62 performed a real production rollback drill using `off` defaults and a paused SEC cohort schedule. Protected status confirmed all three switches were off on `dpl_GLne9mvLqpKiR64jtu6mUECNzVcx`. Five public requests returned HTTP 200 with new-deployment cache misses and Age 0: AAPL annual and MSFT quarter used the original warm responses and matched published hashes; AAPL submissions used the warm cache; its 3.79 MB companyfacts document used the original gated SEC upstream route and matched canonical data; disaggregated CFTC retained identical report data. The 28 versions, twelve source assets and both completed jobs remained intact. No cache purge, source deletion or database cleanup was performed.

Final configuration restores Supabase readers and the SEC cohort schedule, and removes the temporary credential. Post-deployment restoration and credential-denial checks are recorded in the finalization pull request. At the end of the activation checks the private bucket held 31 objects totaling 3,800,590 compressed bytes, plus about 0.50 MB in migration relations. Retention and orphan scans remain dry-run only. The four-company boundary remains intentional; other issuers and historical filing cutoffs retain their existing paths. Hosted alert delivery, independent backup inventory, organization-wide usage and Spend Cap remain unconfigured or unverified as previously noted.

## Sources

- [Vercel OIDC custom API authentication](https://vercel.com/docs/oidc/api)
- [Vercel OIDC token source, claims and lifetime](https://vercel.com/docs/oidc/reference)
- [Supabase Edge runtime secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase hosted function routing](https://supabase.com/docs/guides/functions/routing)
- [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase Edge invocation pricing](https://supabase.com/docs/guides/functions/pricing)
- [Supabase egress accounting](https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e)
