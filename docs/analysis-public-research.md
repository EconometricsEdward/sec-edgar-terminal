# Analysis public research and bounded storage

The Analysis directory and company routes expose financial research in initial HTML, with a read-only compact endpoint at `/api/v1/analysis/{ticker}`. This is a projection of the existing financial calculator output, not a separate calculation or database snapshot.

## Data and interpretation

The projection reads `readPreparedAnalysis` only. It does not acquire SEC documents, enroll companies, create financial versions or copy complete histories into a new Supabase table. Annual, standalone quarter, year-to-date and trailing-twelve-month bases remain separate. Six corporate, bank or insurer overview metrics retain current/prior values, units, reported/calculated classification, formulas, exact source contexts and SEC archive links. Missing values remain null. Summary limits are six metrics, 96 relevant sources and 64 KiB; excess evidence produces an unavailable response rather than silently truncating provenance.

`end` selects an exact period from the same prepared history in memory. Those are latest-filed comparative values, potentially revised later. `asOf` requests do not substitute today's vintage: the public endpoint returns 503 and directs research to the existing interactive historical-cutoff workflow. Source retrieval, source revalidation, calculation time, report period and filing date remain distinct.

The existing preparation scheduler continues to refresh the company's four bases from shared canonical source documents. No new scheduler or provider load is added. Prepared misses are explicit. A 503 is not evidence that no filings or financial information exist.

## Cache bounds

- Full prepared financial histories and source evidence remain in the existing compressed File Storage architecture. Database pointers/metrics and immutable version history are unchanged.
- Only the four original pilot issuers read legacy warm mirrors. Other prepared issuers avoid that guaranteed remote miss.
- HTML caches only successful concise latest summaries for 60 seconds by issuer and basis. Historical end/cutoff and personal workspace settings create no Next Data Cache summary entries. Compact JSON responses use a 60-second shared HTTP cache.
- Browser history caching stores packed JSON, limited to four entries and 12 MiB of serialized UTF-16 payload for five minutes. Only the selected model expands its source references. A valid oversized model is displayed without retention. Refresh replaces the same company/basis/cutoff key.
- Simultaneous request-driven interactive misses share calculation, serialization and optional cache write. Eight active selections are permitted; completed results keep the existing five-minute shared cache. Reader cancellation is isolated and cache failures do not discard valid calculations.

The public brief is rendered for the URL's financial selectors. If a user changes basis, end, cutoff or comparison baseline locally, the obsolete brief hides before paint; matching selectors restore it. The interactive workspace, evidence inspector, charts, saved notes, scenarios, CFTC context and exports retain their existing calculators and contracts.

## Discovery

The directory and sitemap use the coverage identity registry, without loading every company's financial payload. Directory links disable automatic prefetch. `robots.txt` admits only the compact Analysis API prefix alongside the existing public APIs; general internal API crawling remains disallowed. `llms.txt` and OpenAPI document selectors, provenance and limitations. Historical/custom workspace URLs use noindex to reduce query crawl expansion.

## Observed baseline, 2026-09-16

The storage audit found 2,004 current views (501 issuers × four bases). Existing compression reduced approximately 2.26 GB of decoded financial results to 127.1 MB, primarily in File Storage. These are existing storage figures, not savings newly produced by this change. No schema migration, evidence deletion, paid capacity increase or retention-policy change is required.

Fixture projection against live full responses produced roughly 9–10 KB annual summaries for Apple, JPMorgan and MetLife; Apple's quarter was 12 KB and TTM 28 KB. Full responses retained all periods and evidence. Token reduction depends on what a crawler chooses to read; accessibility does not guarantee provider crawling or citation.
