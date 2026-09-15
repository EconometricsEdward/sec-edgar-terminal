# SEC filer discovery

Global search and the Filings search support institutional managers, private entities, and other SEC filers that do not have trading symbols. Ticker directories remain the source for listed-company and registered-fund classification. An investment manager that files Form 13F is not automatically a registered N-PORT fund.

`GET /api/sec-filers?query=...` searches official SEC entity-name metadata. It uses the SEC search interface's `keysTyped` entity hints and a supplementary `entityName` search for root forms `13F-HR,13F-NT`. Root forms include amendments. The hints endpoint returns at most ten entities even when pagination is requested, so a bounded broader filer-name search fills gaps when the hint list is limited. This finds managers such as D1 Capital Partners L.P. without hardcoding their names or CIKs. These are filer-name queries, not matches to a name mentioned in a filing's text.

Results retain one explicit CIK per choice. Names shared by different legal entities remain separate. A 13F badge requires a matching, single-filer 13F record. Display names in multi-entity records must independently match a CIK present in that record. Only a complete, unique exact-name match can open automatically; partial and ambiguous matches require an explicit selection. New asynchronous suggestions reset keyboard selection so an arriving result cannot take the place of the highlighted choice.

The SEC name search covers entity suggestions and indexed electronic filings from 2001 onward. It is a bounded discovery service, not an exhaustive list of every historical name. Responses disclose limited or unavailable sources. Direct positive CIKs open the SEC submissions history without requiring the name or ticker directory; older archives remain loadable from that filer's verified SEC manifest.

`/filings/0001747057` and `/api/filings-research?ticker=0001747057` preserve D1 Capital's CIK identity. SEC submissions must return that same CIK and a valid name and filing manifest. Missing public records return 404; source failures and malformed identities remain retriable errors. Numeric identifiers are never propagated as stock tickers to Analysis, Risk, or Funds. The filing reader, filters, and notebook retain the same verified identity.

Client searches debounce for 400 ms, cancel obsolete requests, and never display an old query's results under a new name. Small complete results use bounded five-minute caches and CDN caching; partial results and errors are not cached. Requests are rate-limited, coalesced per query, and bounded by upstream response size, timeout, and concurrency. The complete SEC name directory is not downloaded to browsers, and no database schema or cache permissions are changed.

Official references:

- SEC search implementation: https://www.sec.gov/edgar/search/js/edgar_full_text_search.js (`getCompanyHints`).
- SEC submissions API: https://www.sec.gov/search-filings/edgar-application-programming-interfaces.
- SEC access and coverage guidance: https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data.
