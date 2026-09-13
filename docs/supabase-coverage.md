# Shared company research on Supabase

The broader research store uses the existing approved project `vvkihuduqqnxqahhbphs` and the existing Pro subscription. Vercel remains on Hobby; Upstash remains the hot cache. No compute upgrade, additional project, replica, or paid add-on is required by this change.

## Coverage and identity

The dated IVV holdings reference (2026-09-08) identifies 503 securities across 500 SEC issuers. This is explicitly an IVV reference for S&P 500 coverage. It is not described as an exact current SPY holdings list. `src/data/sec-coverage-2026-09-08.json` preserves the constituent mapping, aliases, sector, source dates, and source manifest SHA256. A shared static allowlist bounds both application ingestion and the Supabase gateway. Updating the admitted universe uses the validation script and a reviewed deployment; existing broader screener membership updates independently, and newly admitted securities retain existing behavior until prepared coverage is updated.

The existing ACU pilot remains supported, producing 501 research issuers. Verified XOM predecessor CIK 0000034088 supplies two supporting documents, without adding another constituent or changing the current issuer's identity. Portfolio evidence retains the predecessor's SEC filing URLs.

## Serving and refresh design

Each issuer has two canonical SEC source documents, four Analysis bases, three Compare bases, and four Portfolio bases. Every prepared view uses the existing calculators, fiscal periods, missing-value behavior, and source evidence. Latest supported Analysis metrics are stored as queryable, version-linked observations with their actual units. Full historical response content is compressed in private Storage.

Compare's browser requests packed evidence and expands it locally. The default external API response remains compatible. Public page requests do not enqueue coverage jobs. Historical `asOf` requests retain their existing calculation path. Broad readers are independently gated until initial preparation is verified; the four original pilot readers remain active throughout.

Only pilot issuers retain large legacy Redis mirrors. The broader prepared archive stays in Supabase, with Vercel CDN caching serving repeated requests. Unchanged financial and research views use small manifest reads and metadata revalidation instead of downloading and recalculating complete stored responses. Unchanged source bytes reuse existing immutable assets. Refreshes preserve original fetched times and track revalidation separately.

Market and Screener keep their existing larger shared universe. Their prepared Market overview also receives a durable Supabase copy, which can recover service if its Redis snapshot is missing. Market detail and quant coverage reuse canonical prepared SEC documents where available. Existing CFTC preparation continues unchanged.

## Bounded work and security

The daily issuer universe becomes 32 stable CIK-based shards (11–24 issuers each). A bounded worker attempts at most six issuers within a 225-second request budget, saving each checkpoint before advancing. A failing issuer moves to a limited retry queue so other issuers continue. Successful continuation does not consume the crash retry budget. Provider cooldowns, the existing shared SEC request gate, immutable input checks, and publication generation fences remain enforced.

One batched enqueue RPC prepares all 32 shard jobs, reducing scheduler coordination from 32 gateway calls to one. Private status exposes prepared/fresh/stale counts by view and basis, queued work, and stored byte totals. Status is operational evidence, not a promised visitor capacity.

The gateway retains production Vercel OIDC verification, fixed project/team identity, private Storage paths, bounded payloads, and restricted SECURITY INVOKER RPCs. It allows only reviewed source and result keys. No privileged Supabase credential is copied to Vercel or exposed to browsers. The dedicated coverage signing credential stays in Supabase Vault. Scheduled requests carry an HMAC bound to the fixed endpoint, timestamp, and random nonce, with a five-minute validity window and atomic replay prevention. A narrow OIDC-protected invoker RPC verifies the signature using the service role's existing Vault permission; public roles cannot execute it. The public endpoint rejects malformed requests and bounds signature verification attempts. The scheduler remains inactive until its deployed authentication and first job are verified.

The platform-owned `pg_net` queue has grants this project's database role cannot revoke. The signed protocol therefore keeps the long-lived credential out of that queue. No platform role or access-control bypass was used. The `pg_net` extension was installed with its registry in the extensions schema before any requests were queued.

## Verification and rollout

The release regression run passed 1,562 tests with two intentionally skipped tests and zero failures. Typecheck and production build passed. The existing PostgreSQL recovery rehearsal passed all ten gates; additional batch, security, signed scheduler, and job tests exercise the new SQL. Seven pre-existing ESLint warnings remain outside the changed functionality.

AAPL TTM Compare in the committed public fixture measured 67,945 gzip bytes for expanded evidence and 28,398 for packed evidence, approximately 58% lower transfer. This fixture measurement does not establish production latency or traffic capacity.

The database migrations and gateway are additive. Rollback disables `EDGAR_DATASTORE_BROAD_COVERAGE` and the coverage schedule, retaining published source evidence and existing pilot behavior. A full durable-read rollback can still use the existing independent dataset flags. No source deletion or retention cleanup is performed by this rollout.

Final production coverage, source checks, scheduler execution, UI results, and resource measurements will be recorded after backfill and activation.
