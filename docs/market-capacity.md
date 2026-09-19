# Market coverage and serving capacity

## September 2026 expansion

The starting production snapshot contained 1,427 usable issuers from 1,500
fund-defined candidates. The target is 5,000 distinct SEC issuers, with staged
admission. A candidate is not counted as a company with available financial data.
Share classes count once by CIK. Unsupported reporting data remain unavailable;
they never become zero-valued financial observations.

The original IVV/IJH/IJR coverage and dated fund classifications are retained.
Supplemental candidates come from the SEC operating-company directory and must
pass SEC identity, operating-report, and supported financial-taxonomy checks.
Their sectors are broad research groups derived from SEC SIC, not certified GICS
or index membership. Unknown sectors remain unclassified. Membership and source
dates are separate from financial reporting dates.

## Work performed once, shared by visitors

- `/market` is a static CDN-served shell, with normal metadata and navigation.
- `/api/market-briefing` serves prepared annual/TTM sector statistics. There are no
  per-company financial arrays, filing histories, or industry metric arrays in
  the initial response.
- `/api/market-companies` searches a prepared identity directory and returns at
  most 50 companies. The browser waits until search is opened, debounces typing,
  cancels obsolete requests, and keeps a bounded cache of recent pages.
- `/api/market-industries` loads the selected sector's industry metrics on demand.
  Separate response dates remain visible when cached projections differ.
- `/api/market-sector-companies` ranks all matching companies in the selected
  sector before returning a 25-company page. Growth, profitability, cash flow,
  debt, liquidity, interest coverage and equity measures retain their reporting
  basis and dates. Missing values sort last in either direction. The prepared
  scalar projection is separate from the initial briefing (about 1.65 MB raw
  for the original 1,427-company snapshot; about 16.6 KB per browser page).
  New risk mappings are upgraded from retained SEC documents and scheduled
  checkpoints; old snapshots expose missing new metrics as unavailable.
- CFTC positioning retains its independent loading path. Direct CFTC visits do
  not request the SEC briefing.
- Public responses use short browser caching and shared CDN caching with stale
  revalidation. Cold server instances read small durable Supabase projections;
  a prepared overview is a migration fallback. Visitors cannot start a universe
  crawl. Concurrent reads in one instance share an in-flight projection read.

## Background preparation

Sixteen stable CIK shards run in two daily sweeps. Each invocation has two workers,
a 300-second platform ceiling and at most 256 due checks. Fresh checkpoints are
skipped; interrupted work resumes from stored attempts. The existing global SEC
dispatch limit and provider cooldowns remain enforced. A bounded local queue
reduces coordination polling, and scheduled SEC fetches allow one transient retry.

Theoretical scheduled capacity is 8,192 checks per day, not a throughput promise:
source latency, SEC availability and deadlines determine actual progress. First
backfill is gradual. Unsupported candidates are replaced during membership
maintenance, while validated issuers remain stable.

Publication requires the existing baseline coverage threshold and preserves a
recent completed snapshot if more than 5% of previously covered issuers disappear.
Missing candidates do not block all usable supplemental companies. Observations
reset when membership changes so a larger sample is not presented as market growth.
Deployment does not perform an unbounded crawl; it can activate membership and run
one short bootstrap shard. Scheduled work performs the remaining ingestion.

## Measured starting sizes and bounded storage

On the same 1,427-issuer production snapshot:

| Payload | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Previous full Market overview | 2,607,055 | about 443,000 |
| Initial prepared briefing | 151,460 | 24,464 |
| Full Quant atlas (server only) | 6,248,457 | 1,030,311 |

The initial briefing reduction is about 94% before compression. Linear projection
of the full atlas to 5,000 companies is about 21.9 MB raw / 3.61 MB compressed,
below the existing 32 MiB / 6 MiB limits. This is a capacity estimate, not a claim
that 5,000 companies have already been ingested or that every issuer has equal size.
The larger overview remains below its separate 24 MiB durable decoding cap at this
projection, including retained observation history.

The existing Supabase project had about 770 MB of database storage and 725 MB of
private objects at inspection. Application cache quotas, not the paid plan's disk
capacity, were causing frequent evictions. The bounded cache migration changes:

| Family | Before | After |
| --- | --- | --- |
| Checkpoint | 10,000-row ceiling | 20,000-row ceiling; unchanged 96 MiB |
| Research | 160 MiB | 256 MiB |
| Document | 64 MiB | 192 MiB |

The configured compressed payload allowance grows by at most 224 MiB. PostgreSQL
table/index/WAL overhead is additional. Existing expiry, eviction, RLS, OIDC
gateway authorization, rate limits and private storage access remain in force.
No new subscription, paid addon, replica, or database project is required.

## Verification and monitoring

Tests cover 5,000-issuer aggregates and bounded paging, source identities,
unsupported-candidate handling, independent CFTC loading, cross-query response
validation, cancellation, SEC coordination, cache limits and authorization.
Inspect live `X-Market-Coverage`, `X-SEC-Snapshot-At` and `x-vercel-cache` headers;
also inspect scheduled batch checked/failed/skipped counts and coverage source dates.
The UI's loaded count is the authoritative available company count.

Warm CDN response timings are not a concurrent-user capacity guarantee. The design
makes upstream work independent of visitor count, but actual traffic, origin misses,
database latency and plan usage still need observation after rollout.
