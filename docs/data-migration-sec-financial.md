# SEC sources and financial serving slice

This is a staged implementation. Production readers remain controlled separately
by `EDGAR_DATASTORE_SEC` and `EDGAR_DATASTORE_FINANCIAL` (default `off`). No financial
formula, period selector, source-evidence calculation, page layout, or public JSON
contract changed.

## Measured initial coverage

The bounded cohort is AAPL (CIK 0000320193), MSFT (0000789019), JPM
(0000019617), and ACU (0000002098). The audit verified issuer identity directly in
eight primary SEC JSON documents on 2026-09-13. This covers September, June, and
December fiscal year ends, a bank, and large and smaller nonfinancial filers.
Selection is representative, not based on unavailable traffic measurements.
Deterministic fixtures additionally exercise missing inputs, disclosed zero,
comparative-year revisions, and exact reporting cutoffs.

Only primary `/submissions/CIK##########.json` and
`/api/xbrl/companyfacts/CIK##########.json` resources enter this slice. Archive
history, other issuers, and other SEC resources retain their bounded legacy paths.
The canonical key is `sec-documents-v1:CIK##########:{submissions|companyfacts}`
under dataset `sec`. Identical documents are not copied separately for Research,
the SEC proxy, and financial calculations.

The real consumers are `secResearchJson`, `/api/sec`, SEC submissions prewarm,
and `/api/analysis-research`. The last consumer serves the unchanged
`packAnalysisCompany(buildAnalysisCompany(...))` result from dataset `financial`,
key `financial-analysis-v1:<ANALYSIS_VERSION>:CIK##########:<basis>:latest`.
Prepared annual, quarter, YTD, and TTM bases retain all currently returned periods
and evidence. User-selected historical `asOf` variants use the existing
calculation path rather than allowing arbitrary prepared-key creation.

## Refresh, reads, and rollback

`refreshSecFinancialCohort` processes no more than two companies per invocation and
returns a resumable cursor. It stops at the failing company rather than silently
skipping it. Source refresh uses the existing `secFetch` provider-wide transport,
12-second individual timeouts, zero internal retries, and a 24 MiB decoded limit.
The durable job owns bounded retries and checkpoints; duplicate source/output
claims do not launch another fetch. Four financial bases reuse the same two
canonical source reads. Output claims are acquired before source capture so an
older worker cannot obtain a later generation and republish older inputs.

Conditional requests retain ETag/Last-Modified where actually supplied. HTTP 304
and identical bytes revalidate the existing source version without replacing its
original retrieval time or source object. Original bytes, content hash, source
URL, CIK/resource, parser version, retrieval time, and revalidation time remain
available. Whole-document publication time is `null` because it is not supplied
by SEC; individual filing dates and accessions stay in financial evidence.

Current policy marks the source fresh for 25 hours after successful validation
and permits explicitly labeled last-good reads for at most seven further days.
This is the staged policy requiring acceptance before production activation;
it is not a claim that SEC changes only once daily. Headers include
`X-Data-Fetched-At`, `X-Data-Revalidated-At` when available, `X-Data-Stale`, and a
stale warning. Cohort missing/corrupt/too-old data or durable outages yield 503;
ordinary prepared reads do not start provider refreshes.
The shared research helper requires fresh validation, because its downstream
callers consume raw JSON without metadata headers; it refuses stale inputs rather
than labeling an old source as a newly retrieved research result.

Financial ingestion writes one existing `analysis-research` gzip cache envelope
with the original metadata; the legacy API already understands its gzip field.
The prepared reader only accepts an envelope with valid metadata and the current
calculation version. It does not copy an unverified legacy cache value into
Supabase or fill Redis from ordinary page requests. Both SEC rollback mirrors and
financial rollback mirrors reserve their Redis generation before source work and
use atomic generation/owner/expiry checks before writing. A failed/expired worker
cannot regress these mirrors. Oversized SEC rollback values remain deliberately
rejected by the existing Redis limit. `rollbackStored` reports actual mirror
results; this is not proof that a production rollback has been exercised.

In `off`, consumers use their original paths. In `shadow`, legacy results serve
while bounded jobs write durable data. Sample comparisons run at most once per
five minutes per covered key/process. Financial comparisons require identical
canonical source inputs and calculation versions, ignore only the calculation
execution timestamp, and distinguish source changes from storage mismatches.
These bounded aggregated events use existing logs, not per-request database rows.

## Actual sample measurements and reconciliation

These are local prepared payload measurements over the eight audited raw JSON
files; they are not network-egress or Supabase latency measurements. HTTP API
response content is preserved, so this migration does not claim an additional
browser-response reduction compared with the existing packed Analysis endpoint.
It removes the need to download/parse both full source documents and repeat
financial calculations for ordinary prepared requests.

| Issuer | Annual JSON bytes | Annual gzip bytes | Largest prepared JSON bytes | Largest prepared gzip bytes | All-four-basis local preparation |
| --- | ---: | ---: | ---: | ---: | ---: |
| AAPL | 434,218 | 30,498 | 1,714,410 | 110,285 | 2.95 sec |
| MSFT | 436,157 | 29,799 | 1,724,100 | 107,247 | 2.37 sec |
| JPM | 306,351 | 20,577 | 1,265,671 | 78,395 | 1.82 sec |
| ACU | 511,229 | 31,539 | 1,658,595 | 95,467 | 1.71 sec |

All 18,828 evidence entries across the sixteen prepared snapshots reconciled to
raw SEC observations by taxonomy, concept, unit, accession, start/end, and exact
numeric value. The existing calculations and full source contexts are retained.
Representative reconciliations:

| Output | Reporting period | Value (USD) | Exact source / lineage |
| --- | --- | ---: | --- |
| AAPL annual revenue | 2024-09-29–2025-09-27 | 416,161,000,000 | `RevenueFromContractWithCustomerExcludingAssessedTax`, accession `0000320193-25-000079`, filed 2025-10-31 |
| MSFT Q4 revenue | 2026-04-01–2026-06-30 | 90,007,000,000 | Fiscal year revenue 331,839,000,000 (`0001193125-26-323660`) minus matching nine-month revenue 241,832,000,000 (`0001193125-26-191507`) |
| JPM annual bank revenue | 2025-01-01–2025-12-31 | 182,447,000,000 | Net interest income 95,443,000,000 plus noninterest income 87,004,000,000, accession `0001628280-26-008131` |
| ACU annual revenue | 2025-01-01–2025-12-31 | 196,541,816 | `Revenues`, accession `0001193125-26-102079`, filed 2026-03-11 |

Latest financial observation rows are a small version-linked serving/audit
projection with context references to the immutable snapshot's source and
calculation catalogs; large revision histories are not duplicated per row. The packed
snapshot remains authoritative for the current Analysis response; optional
protected metric inspection can query the normalized rows by immutable version.
No dimension, scale, publication timestamp, or missing financial amount is
invented during persistence.

The focused regression suite covers canonical identity, disabled modes,
source-size limits, lease ordering, 304/unchanged identity, SEC/database/Redis
failures, controlled unavailable responses, all four financial bases,
comparative restatements, missing/zero semantics, exact source evidence,
rollback mirroring, and resumable capped processing. Full-repository acceptance,
real infrastructure round trips, public endpoint/UI checks, and production
cutover/rollback evidence are reported separately in the overall migration report.
