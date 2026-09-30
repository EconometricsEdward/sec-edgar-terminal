# Connected Risk evidence

The Risk page retains its two company views and futures-broker tool. The profile adds an evidence briefing, SEC annual debt maturities, a legal-bank Call Report selector, and separate market-wide funding/swaps charts.

## Source boundaries

- SEC briefing uses the existing industry-specific metrics and their adjacent observations. There is no new composite score, inferred rating, or default probability.
- Maturities match the prepared Market universe by exact ten-digit CIK. All six principal buckets retain their original annual filing dates. Missing buckets stay null; partial subtotals are explicitly labeled. Financial capacity comparisons use that same annual filing, independently of the profile's annual/TTM switch. Companies without prepared schedules remain usable in the SEC profile.
- FFIEC requires selection of a named legal bank/RSSD. Name candidates are not parent/subsidiary mappings. Ratios use one validated Call Report, and a missing latest period cannot be filled with an older report. Brokered deposits use domestic deposits, allowance uses HFI loans, and regulatory ratios retain percentage units. User selection does not establish an organizational relationship.
- Funding and Treasury fails come from New York Fed prepared snapshots. Fails-to-deliver and fails-to-receive overlap and are not added. Swaps are CFTC aggregate weekly traded notional, kept distinct from company exposures and CFTC COT positioning. Week-over-week changes require exactly adjacent weeks. DTCC/FICC data stays at the publisher through external links.

## Storage and performance

`GET /api/risk/context` exposes three strictly validated read-only projections. It does not fetch new SEC filings, enqueue FFIEC preparation, call raw market feeds, or write research datasets. No database migration, cache-budget increase, archival expansion, paid resource or new scheduled job is required.

Maturity reads reuse the existing validated Market snapshot and retain one decoded universe for at most 15 minutes per warm instance (subject to the existing seven-day hard expiry). Concurrent misses share one promise; source failures have a 10-second cooldown. This prevents re-inflating and validating the entire universe for each company. The browser receives only one issuer. The observed Apple response was approximately 3.4 KB, compared with the 8 MB full universe.

The global market projection is independent of ticker and retains at most one year of funding observations plus 26 weekly aggregate swap points per asset class. Its observed response was approximately 43 KB. The legal-bank response holds eight selected measures and at most four quarters, approximately 5.4 KB in the JPMorgan example. These measurements are uncompressed and depend on source content.

CDN reuse is 15 minutes for markets/maturities and at most 30 seconds for validated bank results. Maturity TTL is capped by the underlying snapshot's hard expiry. Failed, incomplete and unvalidated bank results are not cached as fresh. Panels defer requests until approaching the viewport; bank reports load only after the user selects a bank. Requests abort on navigation and earlier-company results cannot overwrite the current selection. No polling, per-company persistent market copies, browser storage or third-party chart dependency is added.

## Validation

Focused tests reconcile the new bank view against the existing original FFIEC fixture, exercise missing/zero inputs and wrong identities, enforce maturity expiry and shared-read behavior, verify non-overlapping swaps totals and adjacent-week comparisons, and assert strict API query validation/read-only operations. The existing Risk, market-plumbing and refinancing regression suites cover the reused calculations.
