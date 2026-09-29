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
  Existing 16 bounded shards complete and refresh coverage; there is no new cron.
- A scheduled shard repairs a confirmed missing or expired archive through the
  existing per-document fenced refresh and SEC dispatch controls. Registry,
  database, identity, and corrupt-source failures never fall through to SEC;
  a busy refresh waits for the next scheduled pass rather than retrying.
- A deployment can seed at most 80 issuers in 40 seconds using archived sources,
  two workers, and existing shard leases. It does not advance source clocks.
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
The gateway admission is one exact resource key; existing production OIDC
authentication and private durable storage remain in force.
