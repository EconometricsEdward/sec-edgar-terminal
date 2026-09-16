# Prepared CFTC context for What changed

The public Research Hub demo uses the exact source-dated 100-company universe in
`public/portfolio/portfolio-demo-100-universe.json`. Preparation does not change
the universe, allocations, saved portfolio format, or SEC comparison checkpoints.

## Storage and retention

The namespace `edgar.portfolio-cftc-prepared.v1:production` admits exactly 103 keys:
100 `CIK##########` context records, `DEMO-CURRENT`, `DEMO-PREVIOUS`, and `DEMO-STATE`.
The gateway allowlist is copied into its deployable function directory and a test
requires an exact match with the demo universe. Unknown companies, arbitrary
snapshot keys, and preview namespaces are rejected.

All records use the existing bounded `checkpoint` cache family and expire after
14 days without a successful write. Its existing byte budget and cleanup apply.
Each company record is at most 48 KiB raw; each of the two aggregate snapshots is
at most 2 MiB raw; the state record is at most 16 KiB raw. The total payload bound
is 8.704 MiB before gzip, plus database row/index overhead. Entries replace fixed
keys; daily refreshes do not append permanent versions. This deliberately small
prepared cache uses compressed Postgres storage. Existing large filing-document
and CFTC source-storage paths are reused without copying their full source files
into the prepared cache.

## Preparation and updates

The existing authenticated SEC coverage scheduler gives this worker an additional
45-second budget after the existing research work, with a route ceiling of 275
seconds. Existing SEC work retains its 225-second budget. A SEC work failure does
not skip preparation. The production feature and data-store gates still apply.

Each invocation processes at most six companies and persists a resumable cursor.
A content-hash CAS checkpoint lease excludes concurrent workers. Individual
context and snapshot writes also use CAS against their previously observed
records; losing ownership cannot overwrite newer acknowledged results. Failed
checks use bounded exponential backoff, remain incomplete, and never replace a
completed public snapshot.

Company submissions are checked at least once per completed daily refresh cycle.
If the latest annual accession and source URL are unchanged, the extracted
connection evidence is reused. Valid, fresh existing warm contexts can bootstrap
preparation. `checkedAt` records the source check; the original extraction
`generatedAt` and filing dates are preserved. Shared market histories are loaded
once per contract/family/trader-group combination, and only observations needed
for the 90-day display plus exact-week comparisons are retained.

Once every company context is checked and all related market reads are available,
the worker publishes the next aggregate. A completed refresh is due again after
six hours. The last successful aggregate remains available while the next cycle
runs. A preserved prior snapshot provides a fallback; copying it cannot extend its
original expiry. Partial or stale source history retains its explicit coverage
flags. Checking 100 companies does not imply 100 supported market connections.

## Reader contract

- `runPortfolioCftcPreparation({ signal, deadline, maxCompanies })` performs one
  bounded scheduler continuation.
- `readPreparedPortfolioCftcChanges({ companies, days }, { signal })` returns null
  for an unprepared or mismatched universe, or the existing changes response with
  exact requested-company coverage and events. Requested row IDs are retained.
- `readPreparedDemoCftcChanges({ days, signal })` returns the full demo response.
- `readPreparationProgress({ signal })` returns source-check progress without
  treating missing/failed companies as having no connection.

Readers never start source ingestion or refresh cache retention. Calculations run
against the prepared context/history maps using the same event builder as live
research. Events are filtered using the current requested window; the response
`generatedAt` remains the original preparation time. The `preparation` object
contains `status`, `checkedAt`, `nextCheckAt`, `totalCompanies`,
`completedCompanies`, and `universeAsOf`. Stale source history remains marked
stale even when the prepared snapshot itself was recently assembled.

## Deployment

Deploy the updated `edgar-data-gateway` with `portfolioDemoPolicy.js` before the
application. No SQL migration, additional RPC, paid service, credential, or new
privilege is required. Until the first successful full preparation, readers return
null and the public UI must show truthful preparation status rather than inventing
complete coverage.
