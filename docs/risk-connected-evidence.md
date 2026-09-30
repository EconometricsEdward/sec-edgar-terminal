# Connected Risk evidence

The Risk page retains its two company views and futures-broker tool. The profile adds an evidence briefing, SEC annual debt maturities, a legal-bank Call Report selector, and separate market-wide funding/swaps charts.

## Source boundaries

- SEC briefing uses the existing industry-specific metrics and their adjacent observations. There is no new composite score, inferred rating, or default probability.
- Maturities are extracted from the original registrant facts already loaded by the Risk request. Predecessor schedules are not combined. All six principal buckets retain their original annual filing dates. Missing buckets stay null; partial subtotals are explicitly labeled. Financial capacity comparisons use that same annual filing, independently of the profile's annual/TTM switch. Companies without supported standard-tag schedules remain usable in the SEC profile.
- FFIEC requires selection of a named legal bank/RSSD. Name candidates are not parent/subsidiary mappings. Ratios use one validated Call Report, and a missing latest period cannot be filled with an older report. Brokered deposits use domestic deposits, allowance uses HFI loans, and regulatory ratios retain percentage units. User selection does not establish an organizational relationship.
- Funding and Treasury fails come from New York Fed prepared snapshots. Fails-to-deliver and fails-to-receive overlap and are not added. Swaps are CFTC aggregate market activity, with outstanding notional and cleared share kept distinct from company exposures, losses and CFTC COT positioning. DTCC/FICC data stays at the publisher through external links.

## Storage and performance

`GET /api/risk/context` exposes three strictly validated read-only projections. It does not fetch new SEC filings, enqueue FFIEC preparation, call raw market feeds, or write research datasets. No database migration, cache-budget increase, archival expansion, paid resource or new scheduled job is required.

The page requests `/api/risk?evidence=1` and receives a compact maturity projection alongside the financial profile. It reuses the existing bounded Risk disposable entry, original registrant facts and approved retention. It does not decode or transfer the multi-company Refinancing Wall. The older context endpoint remains compatible with already-open clients.

The selected market panel uses the ticker-independent `/api/risk/market-context` projection, bounded to 67 daily funding rows, 14 weekly fail rows and 16 swap observations for each of three asset classes. A sample was approximately 12.7 KB. All companies share one in-memory entry, 60-second reuse, single-flight and a 10-second failure cooldown. The legal-bank response holds eight selected measures and at most four quarters, approximately 5.4 KB in the JPMorgan example. These measurements are uncompressed and depend on source content.

CDN reuse is 15 minutes for complete market data and at most 30 seconds for partial market or validated bank results. Maturities share the Risk response retention. Failed, incomplete and unvalidated bank results are not cached as fresh. Panels defer requests until approaching the viewport; bank reports load only after the user selects a bank. The compact evidence client reuses at most 12 in-memory entries for up to 60 seconds; earlier-company results cannot overwrite the current selection. No polling, per-company persistent market copies, browser storage or third-party chart dependency is added.

## Validation

The current compact source implementation is also documented in `risk-multisource-evidence.md`.

Focused tests reconcile the new bank view against the existing original FFIEC fixture, exercise missing/zero inputs and wrong identities, enforce maturity expiry and shared-read behavior, verify non-overlapping swaps totals and adjacent-week comparisons, and assert strict API query validation/read-only operations. The existing Risk, market-plumbing and refinancing regression suites cover the reused calculations.

## Business-model research workbench

The Risk profile now organizes already-loaded SEC evidence into four business-specific drivers using `riskResearchModel.js`. Reported SIC selects among bank, broker, life/health insurer, P&C insurer, other insurer, REIT, real estate, utility, energy, retail, technology, healthcare, industrial, financial-services and general corporate lenses. The local launchpad offers example issuers without fetching each example.

Key measures include exact-source existing metrics and compatible reported balances/flows. New calculations are historical operating-cash/capex coverage, cash after PP&E purchases and, only for negative operating cash flow, 12 times ending cash divided by the absolute annual/TTM outflow. The last calculation is historical cash-use coverage, not forecast runway. Missing components are never zero. These are not peer bands, composite ratings or estimates of loss.

Recent changes require adjacent reporting dates and matching source concepts/scope. Percentages retain percentage units in before/after values and percentage-point units for their difference. Evidence gaps provide filing or regulatory review paths and are kept separate from numeric coverage counts. The profile export includes the questions, formulas, source URLs, gaps and market mechanisms.

The connected-evidence workspace opens one source at a time. Sources first mount when selected and retain their UI state while hidden. Annual maturities, selected legal-bank reports and shared market evidence survive financial reporting-basis changes; SEC notes and CFTC connections reset with their own ticker/basis/cutoff identities. No new ingestion, storage family, persistent table, cron, dependency or cache budget is introduced.

Insurance incurred claims/benefits and earned premiums must be compatible duration flows with identical start/end dates. Instant claims-reserve liabilities are excluded. Claims/premiums is descriptive across insurance products, without universal P&C thresholds or automated adverse-trend labels. `risk-workspace-v10` invalidates earlier prepared ratios using the existing bounded Risk cache.

SEC Business Exposures is independent of the CFTC flag. When CFTC is off, the SEC concentration, credit/derivative and ownership views remain available; market connections cannot mount. A bookmarked disabled market panel restores the concentration view while retaining the company and filing settings.
