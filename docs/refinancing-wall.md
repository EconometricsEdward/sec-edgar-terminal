# Refinancing Wall

Public route: `/market/refinancing`. Public read: `/api/market-refinancing`.

## Financial scope

The extractor uses entity-wide USD US GAAP principal-maturity concepts in SEC
Company Facts. It selects one annual filing accession and balance-sheet date,
never fills a missing bucket from another filing, and keeps fiscal and rolling
families separate. The aggregate chart uses years relative to each disclosure;
it is not a common calendar-year forecast. Non-December fiscal dates are marked
as indicative anniversaries. Thereafter remains one separate amount.

Custom-taxonomy and instrument-dimensional debt schedules are not covered.
Leases and standalone short-term borrowing are excluded. Partial schedules stay
partial; an unreported amount is not zero. Supported annual schedules older than
550 days are withheld. Every supported profile retains its SEC accession, filing
date, report date, and concepts.

Cash, annual operating cash flow, operating income, and interest expense use the
same filing and report date. Interest coverage requires matching annual durations
and positive gross interest expense, and is suppressed for financial institutions.
Cash is not cash available exclusively for debt repayment. These are reported
principal obligations and financial context, not a default prediction.

Legal-bank funding research stays in BankScope, linked from this page. Holding
company SEC debt is not combined with a legal bank's Call Report balance sheet.

## Publication and cost controls

- `buildMarketCompany` extracts while the scheduled worker already has SEC facts.
- Versioned packed profiles remain in the existing Quant checkpoints and atlas.
  Existing 16 bounded shards continue to refresh the financials and maturities.
- A scheduled shard repairs a confirmed missing or expired archive through the
  existing per-document fenced refresh and SEC dispatch controls. Registry,
  database, identity, and corrupt-source failures never fall through to SEC;
  a busy refresh waits for the next scheduled pass rather than retrying.
- A dedicated authenticated production cron runs at minutes 3, 13, 23, 33, 43,
  and 53. It enriches only the companies already present in the validated Market
  projection, with two workers, at most 160 issuers and a 240-second budget.
  Source work stops with 60 seconds reserved for publication and progress.
  A deployment runs this same resumable worker once after full publication,
  capped at 500 issuers and 240 seconds; it replaces the old 40-second seed.
- Admitted archived companyfacts are prioritized and retain their actual source
  clocks. Other known Market CIKs need at most one companyfacts request through
  the existing shared SEC gate, with no retry, redirect, submissions request,
  company discovery, or full financial rebuild. Confirmed missing or expired
  archives use the existing fenced source refresher. Storage, registry and
  identity failures never authorize an HTTP fallback. Global cooldown, SEC
  403/429, dispatch or database failures stop remaining source work promptly.
- One private `financial/research-market-refinancing-backfill-v1:state` object
  stores a fair cursor, capped per-issuer backoff (30 minutes to one day), and
  at most 500 successful results awaiting publication. A separate 300-second
  worker lease prevents duplicate backfills. Buffered work is flushed before
  starting another source batch; expired evidence returns to the due queue.
  Unavailable schedules are completed negative results for this parser version.
- Useful backfill runs read compact state, one prepared projection for the
  queue, and one fenced reread for final publication, plus the selected source
  documents. They perform no atlas/checkpoint scan or per-issuer database write.
  Once caught up, a run reads only small state until its six-hour membership
  recheck. The response contains counts and a few bounded errors, never facts or
  private state. Archive hits, archive refreshes and direct downloads are counted
  separately; coverage counts describe persisted profiles, not extraction attempts.
- The publisher writes `financial/research-market-refinancing-v1:latest` as a
  separate validated projection. Failure preserves the prior snapshot and does
  not fail established Market publication.
- Each successful Quant shard can also merge its already computed issuer results
  into that projection, rather than waiting for the twice-daily full publisher.
  The source loop reserves 45 seconds; at most 256 in-memory results are considered.
  One existing projection is read after obtaining its dataset lease, then merged
  and published under that same lease. This adds no SEC or checkpoint-universe
  reads. Publication failure leaves successful issuer checkpoints intact.
- Partial publication preserves membership, untouched company dates, and the
  original whole-snapshot retention clock. Future or regressing source/filing
  dates are rejected. Full publication also retains newer issuer evidence from
  earlier partial publications; content hashes distinguish actual data changes.
  A pending company has no maturity source: its first valid archived maturity
  profile may carry older clocks than Market's inherited observation date. Those
  actual source dates are preserved, and subsequent profiles cannot regress.
- Public reads never ingest, parse SEC documents, scan the universe, or enqueue
  work. One shared Next cache key is reused for 15 minutes. A validated process
  fallback also lasts 15 minutes; concurrent cold reads share work and failures
  have a 10-second cooldown.
- A static page makes one canonical read with no automatic polling. Search,
  filters, charts, sorting, pagination, and CSV export run locally.
- The shared cache compresses below 1.8 MB; decoded projection is bounded to
  20 MiB. HTTP uses negotiated gzip and streaming rather than a buffered response.
  Source snapshots have a hard seven-day retention, including CDN stale windows.

## Validation

The refinancing tests cover financial mappings, real SEC summary round trips,
5,000-company storage and HTTP capacity, missing-data semantics, seed clocks,
publication isolation, cache concurrency, failure cooldown, and retention.
The gateway admissions are two exact resource keys; existing production OIDC
authentication and private durable storage remain in force.
