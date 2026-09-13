# Live Supabase activation record

This follow-through supersedes the initial blocked state in `data-migration-rollout.md`. The user explicitly authorized production Supabase use on 2026-09-13, while retaining the existing Supabase Pro, Vercel and Upstash budget. Production activation proceeds through shadow writes and verified source/object/database/endpoint checks; a successful build alone does not prove live data use.

## Connection and security

The application now supports a narrow `edgar-data-gateway` Supabase Edge Function. Vercel obtains its short-lived workload identity inside each server request using pinned `@vercel/oidc@3.8.7`; Supabase verifies it using pinned `jose@6.2.12`. Exact issuer, audience, subject, stable team/project identifiers, production environment, signature and token lifetime are checked. Preview and development identities are denied. Supabase's privileged credential remains in its existing Edge runtime and is never copied to Vercel or returned to callers.

The gateway accepts only the 14 migration RPCs and the approved private source/snapshot object paths. It forces the production namespace, validates nested object references and the four-issuer cohort, prohibits arbitrary destinations, deletion and overwrite, bounds request/response bytes, and sanitizes errors. The SQL RLS/grants and generation fences remain in force. Supabase's built-in JWT check is disabled for this function because the function validates Vercel's signed identity instead; it is not an unauthenticated gateway.

Workload identity authenticates the deployment, not a visitor. Administrative refresh/status routes retain their CRON_SECRET check. A temporary high-entropy operator credential, represented only by its SHA256 and an absolute expiration in deployment configuration, permits bounded bootstrap through that same protected migration endpoint. It will be disabled after verification. It does not authorize other cron endpoints or previews.

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

Connection implementation and controlled tests are complete. The gateway is installed; anonymous and forged-token requests returned 401 with private/no-store headers. Production shadow deployment, real cohort ingestion, reader activation and rollback verification are recorded below as they finish.

## Sources

- [Vercel OIDC custom API authentication](https://vercel.com/docs/oidc/api)
- [Vercel OIDC token source, claims and lifetime](https://vercel.com/docs/oidc/reference)
- [Supabase Edge runtime secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase Edge Function limits](https://supabase.com/docs/guides/functions/limits)
- [Supabase Edge invocation pricing](https://supabase.com/docs/guides/functions/pricing)
- [Supabase egress accounting](https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e)
