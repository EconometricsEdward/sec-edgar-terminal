# Disclosure passage search

The Disclosures search starts with prepared passages and SEC filing discovery in parallel. The prepared index reuses public filing text across queries, while the original SEC filing remains the source of record. No model, embedding service, new account, browser database key, or additional paid infrastructure is required.

## What a prepared result means

Postgres full-text search proposes and ranks candidate paragraphs. Before returning a match, the application applies the same literal phrase / AND / OR / NOT parser used in full filing review to the entire retained original paragraph. Results use `status: indexed-match` and `preparedRank`, the one-based position in prepared search results. That ordinal is separate from the SEC discovery rank; the database's underlying full-text score is not an ordinal. Paragraphs retain their original qualification and negation; display snippets do not crop away leading sentences.

Prepared results do not claim a complete document review or complete SEC coverage. Section labels come from the existing heading extractor. Long or unrecognized sections may be missing. Document-wide matching, especially `NOT` across paragraphs, goes directly to full review. Zero prepared matches is not evidence of zero SEC matches.

## Bounds and freshness

| Limit | Value |
| --- | --- |
| Filing age | Most recent 730 days |
| Corpus | 600 documents and 100 MiB raw serialized payload, whichever binds first |
| One document | 180 original paragraphs, 180,000 retained characters, 280,000 serialized bytes |
| One paragraph | 6,000 characters, retained whole or omitted whole |
| Search window | Up to 120 candidate paragraphs; encoded response limited to 400,000 bytes plus coverage |
| Prepared text reuse | Only complete text with a matching SHA-256 fingerprint and current parser version |

Raw payload accounting includes metadata, passage text and any full prepared text. Postgres relations, GIN indexes, TOAST, dead tuples and WAL are additional. The budget is intentionally a bounded acceleration layer, not an archival replacement. SQL periodically evicts expired/oldest indexed documents during ingestion, atomically with replacement. Read queries exclude expired entries even before cleanup occurs.

Per-document replacement is atomic. An advisory transaction lock serializes the short quota/replacement critical section. Same source fingerprint and parser version deduplicate. A different fingerprint with an older or equal source retrieval timestamp cannot overwrite a newer extraction. Failed transactions preserve the previous complete generation and its paragraphs. Filing identity includes CIK, accession and primary document, keeping amendments and distinct documents separate.

The existing scheduled prewarm rotates a small popular-company cohort and indexes recent filings incrementally. On-demand full review adds other recent filings. Old cached text without a trustworthy source retrieval time is refreshed before indexing; the ingestion time is never substituted for its source retrieval time.

## Interfaces

- `prepareDisclosureIndexDocument(input)` prepares a bounded record without I/O.
- `indexDisclosureText({cik,ticker,companyName,filing,text,sourceRetrievedAt,signal})` returns `{stored,...}`. Optional index failures fail open; request cancellation propagates.
- `readPreparedDisclosureText({cik,filing,signal})` returns `{text,sourceRetrievedAt}` only for complete fingerprint-verified source text, otherwise `null`.
- `searchDisclosurePassageIndex(settings,{tickers,ciks,signal,offset,limit})` returns `{results,coverage,hasMore,nextOffset}`.
- `GET /api/disclosure-search/passages` accepts normal disclosure filters plus `tickers`, `offset`, and `limit`. The parser validates the query before database work. `nextOffset` is the number of candidate paragraphs consumed, not a filing count. Follow it when `hasMore` is true; verified results may be fewer than the candidate count.

The public endpoint has rate limiting and private/no-store response headers. Its browser response exposes source evidence and aggregate coverage, never credentials. Database access uses the existing production Vercel OIDC gateway and restricted service-only SECURITY INVOKER RPCs. Both tables have RLS enabled in the private schema; `anon` and `authenticated` have no access.

## Deployment and verification

Apply `20260915070149_edgar_disclosure_passage_index.sql` before the application rollout. Deploy `edgar-data-gateway/handler.js` together with its new `disclosurePolicy.js` dependency and existing gateway dependencies. The only added RPCs are `edgar_disclosure_replace`, `edgar_disclosure_document`, and `edgar_disclosure_search`. No secret or exposed-schema changes are needed. Deploy the site, invoke its authorized prewarm workflow, and verify a prepared search plus its original SEC document. A missing index or temporary database failure leaves SEC discovery/full review available.

Run `node --test tests/disclosure-passage-index.test.js tests/data-store-gateway.test.js`. The tests execute the exact tracked migration in local PGlite, check anonymous/authenticated denial, service-only invoker functions, stale-generation rejection, atomic replacement rollback, source hashes, Boolean exclusions, preserved negation, section/ticker filtering, pagination, Unicode response bounds, hard corpus accounting, and the actual 120-candidate gateway request.

For operational footprint inspection, compare `sum(payload_bytes)` from `edgar_private.disclosure_documents` with `pg_total_relation_size` for both disclosure tables. Keep raw-payload and physical-relation measurements distinct when evaluating future growth.
