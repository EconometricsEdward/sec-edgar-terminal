# Reports preview

This feature is intentionally developed on `feat/reports-preview`. Do not merge or promote it to production until the owner tests the preview and requests publication.

## User flow

Open `/reports` between Disclosures and About. Choose Company, N-PORT fund, or 13F manager; search and confirm the SEC identity; build; download PDF and Excel. Company reports support annual, standalone quarter, and trailing-twelve-month bases.

Search uses the SEC company and fund directories and SEC filer discovery, rather than a curated entity allowlist. Untickered companies can be selected by CIK; an N-PORT portfolio can be selected by exact SEC series. A 13F selection identifies a filing manager, not necessarily an individual investment fund. Original source availability, supported SEC tags, and public disclosure coverage still determine the report contents.

## Data and performance

- Reuse the existing prepared financial data and bounded SEC acquisition pipelines. No new database tables or scheduled jobs are required.
- Verify returned CIK, fund series, reporting basis, and full-portfolio coverage before enabling downloads.
- Prepare one versioned report snapshot, then generate both file formats from that snapshot in a browser worker. PDF libraries and fonts are outside the initial page bundle.
- Search is debounced, abortable, capped at 20 choices, and cached for five minutes. Report preparation is explicitly requested, cancellable, rate limited, and time bounded.
- Complete holdings are included in Excel. PDF uses a concise portfolio summary and largest positions; neither file substitutes a page of holdings for the complete dataset.
- Missing values remain missing. Percent cells contain fractions and monetary cells contain whole USD. Reporting period, source filing date, source retrieval time, and report generation time are distinct.
- The preview page is marked noindex. There is no notebook, collection, saved-report account system, or automatic report publication.

## Acceptance checks

1. Search by company name, ticker, single-letter ticker, and CIK. Check annual/quarter/TTM labels and source identities.
2. Search funds by names, share-class tickers, and SEC series. Confirm different portfolios in one registrant do not resolve to each other.
3. Search a 13F manager by name and CIK. Retain options, principal-amount units, amendments, and public-scope limitations.
4. Generate both formats, then open the PDF and Excel files. Check reporting dates, exact financial values, numeric percentages, source URLs, and complete workbook holding counts.
5. Change entity/type/basis during a search or preparation. Old results must never be shown under the new selection.
6. Check loading cancellation, unavailable sources, retry, keyboard selection, and a narrow viewport.

Automated coverage lives in `tests/*report*.test.js`, alongside existing SEC filer, fund loader/cache, and navigation tests. Development also validated source payloads from KO, PNC, CAT, VIG, FXAIX, and D1 Capital; PDF pages and imported workbooks were visually inspected.
