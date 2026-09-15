# Disclosure search

The Disclosures page starts with a single Smart search field. A deterministic interpreter resolves SEC company names, tickers and CIKs, explicit filing-date windows, filing forms, sections and disclosure topics. Its output is a valid expression for the existing literal Boolean matcher. Company and date interpretations are editable; related terms and warnings are visible. Exact search preserves the entered expression. Spelling suggestions require an explicit choice. Fiscal periods are not silently treated as filing dates.

## Request flow

1. Smart input passes through `/api/disclosure-search/interpret`. Exact input uses the existing parser directly.
2. `/api/edgar-index-search` and `/api/disclosure-search/passages` run independently. The first useful response replaces the previous search; prior results remain visible while a replacement loads.
3. SEC discovery returns one bounded page of 20 candidates. `nextFrom` advances by raw SEC hits, including any omitted invalid pointers. Pagination is bounded by the SEC 10,000-result window, which is disclosed in the response.
4. The first four candidates are checked against filing text with two concurrent workers. Results appear individually. Additional checks and pages are user initiated. Cancelling prevents queued work from starting and propagates to active source requests.
5. Prepared matches retain literal original paragraphs and partial-corpus coverage. Full document verification supersedes prepared evidence; a failed fetch cannot erase an existing prepared passage.

SEC candidate discovery uses the SEC-supported Boolean syntax. Where nested groups or paragraph-level exclusions cannot be represented safely, discovery uses necessary positive conditions and reports the relaxation; complete Boolean logic is checked against original passages. An index candidate is never labeled a verified passage.

## Reading and comparisons

The default search does not fetch earlier reports. `Compare wording` opens a filing with the existing comparable-annual-season logic. The Changes view can request comparisons for the result set. Reporting-period dates and filing dates remain separate.

Results merge SEC discovery and prepared passage rankings with reciprocal rank fusion. Original ordinal positions are retained as evidence is verified; raw SEC and PostgreSQL scores are not compared directly. Documents and exhibits in the same accession remain separate evidence. Source requests use the known CIK ahead of the display ticker.

The reader, comparisons, inbox and collections load on demand. Shared highlighting and download helpers do not import these heavier views into the initial search bundle. Existing collections, saved searches and exact source links remain supported. Shared searches explicitly retain Exact semantics.

## Prepared data and refresh

See [disclosure-passage-index.md](./disclosure-passage-index.md) for schema, authentication, storage caps, parser versions and source lineage. On-demand document reads index reusable text after the response. The existing authenticated daily prewarm route additionally rotates through eight of sixteen frequently researched companies, at most one recent filing per company and two workers, under a one-minute deadline. SEC discovery continues to cover new and unindexed filings independently.

Old undated cache entries remain usable for reading, but cannot supply invented provenance. Scheduled preparation and bounded background work after a document response refresh eligible entries from the SEC before indexing them. Background refresh allows at most two pending documents per server instance, deduplicates repeated requests, and backs off failed attempts. Source failures retain the prior usable text.

## Verification

Focused tests cover interpretation, company-name collisions, dates, negation, ranking, pagination, cancellation, source identities, comparison compatibility, prewarm provenance and the actual SQL/gateway boundaries. The page reports time to first result and first matching passage under search coverage. These are elapsed times for that browser request, not a global latency claim. Cold SEC source access is distinguished from prepared results.
