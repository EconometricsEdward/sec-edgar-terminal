# Bank and durable-version read budget — 2026-09-30

## Why this follow-through exists

The first site-wide release reduced Vercel origin work, but a short matched deployment sample did not establish a net Supabase invocation reduction. Traffic shifted toward BankScope, and publication workload also changed. This follow-through therefore targets mechanisms with reproducible call-count tests rather than treating aggregate traffic variation as a per-request regression.

The matched windows contained identical counts of scheduled requests. This rules out a higher number of scheduler invocations as the explanation, but not different work within a job. No monthly run-rate or percentage-bill saving can be inferred from a short traffic-mix comparison.

## Existing safeguards and lower bounds

- Bounded live probes confirmed existing CDN hits for normal peer and organization-profile API responses. This release does not claim to introduce that already-working CDN behavior.
- Bank public reports and peer universes already have validated shared Data Cache entries. Prepared source clocks and publication identities remain authoritative.
- A caught-up refinancing cron reads its small checkpoint and exits when not due. Its 144 scheduled calls per day do not imply 144 full-universe scans.
- `vercel.json` configures 614 total scheduled invocations per day: 288 bank, 144 market-research, 144 refinancing, 33 Quant, two factor-universe, and three other daily jobs. Externally scheduled SEC jobs are additional.
- A successful idle bank-maintenance pass uses six gateway operations: begin, status, claim, peer status, UBPR claim and finish. At five-minute cadence this is about 1,728 gateway calls per day before real work. Altering that cadence cannot explain away the much larger observed cache-read workload, and it would change preparation latency.

## Changes

1. Durable version lookups share only overlapping identical RPCs, scoped by backend, namespace, credential scope, dataset, key and selector. The registry holds at most 64 keys and no completed result. Writer-lease acquisition clears pending entries before and after acquisition so subsequent source reads cannot join pre-lease reads. Publication and revalidation clear matching resource entries before and after the operation, including uncertain failures. Publication identity checks/read-backs retain direct reads. Independent callers receive cloned rows.
2. `publishDataset` accepts an explicit `returnEnvelope: false` for callers that discard the result. This still verifies uploaded objects and completes the fenced SQL publication, then requires a valid UUID commit receipt. It avoids exactly one post-commit version lookup and its unused payload decoding. The default returns the full persisted envelope.
3. Audited opt-outs cover Market overview and its four serving projections, refinancing wall/checkpoint publication, and broad-cohort financial/research views. The pilot financial and research Redis mirrors still request persisted envelopes. A changed nonpilot company can avoid up to four financial and seven research-view read-backs when all bases are published; unchanged/revalidation paths do not realize that saving.
4. Bank peer/history/reference and organization APIs gain bounded 30-second per-instance read sharing after existing rate checks. Only validated reusable public results are retained; errors, pending reference preparation, incomplete organization responses and stale results are not retained. Explicit refresh bypasses completed reuse and cannot be overwritten by an older pending result. Reused-response age is deducted from the existing CDN/browser freshness budget.
5. Organization profile/network/SEC views use the existing bounded browser-session request helper. Institution and view identities remain separate, navigation cancellation is isolated, and explicit Retry requests a refresh. No browser storage persistence is introduced.

## Verification and remaining measurement

This pass targets redundant public reads and unused publication return values. It preserves rate-limit checks, source timestamps, writer fencing, SEC dispatch coordination, preparation coverage and scheduler cadence. Mechanism tests must establish the exact saved calls; deployment observation must separately establish whether those mechanisms occur often enough to lower the subscription run rate. Already accumulated billing usage is unchanged.

Deterministic regressions cover a 12-reader version burst becoming one RPC; independent row ownership; missing/error retry; the 64-key registry bound; original transport timeout; resource and cross-dataset lease barriers; malformed publication receipts; preserved pilot mirror metadata; and verified object uploads in receipt mode. Bank tests cover 20 simultaneous organization browser reads becoming one fetch, and eight reads of each peer API variant becoming one service read while all 24 rate checks still run. These are mechanism demonstrations, not aggregate billing forecasts.

The complete local test run passed 3,968 tests with two explicit skips, followed by all 10 isolated SQL/recovery rehearsals. Release also requires lint, type checking, production build, hosted CI and a bounded production smoke test.
