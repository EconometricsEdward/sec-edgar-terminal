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

Insurance incurred claims/benefits and earned premiums must be compatible duration flows with identical start/end dates. Instant claims-reserve liabilities are excluded. Claims/premiums is descriptive across insurance products, without universal P&C thresholds or automated adverse-trend labels. `risk-workspace-v10` identifies the corrected calculations. The API rejects earlier calculation versions and replaces the same approved `risk-workspace-v9` cache entry in place; disclosure scans keep their existing key.

SEC Business Exposures is independent of the CFTC flag. When CFTC is off, the SEC concentration, credit/derivative and ownership views remain available; market connections cannot mount. A bookmarked disabled market panel restores the concentration view while retaining the company and filing settings.

## Visual dashboard

The default profile displays the unique business-lens measures as compact value cards with native SVG sparklines. Driver chips filter the same already-loaded measures. Selecting a card opens an interactive, unit-labeled history beside the original annual SEC debt schedule. Every measure has its own scale; null observations and incompatible time gaps break lines. Debt buckets retain their filing date, incomplete subtotal labels and visibly muted elapsed periods. A missing schedule stays unavailable.

The Risk timeline replaces the Changes view and opens paired source evidence for screened changes across several reporting periods. Coverage bars count available inputs and do not grade risk. Formulas, source dates, research questions and market mechanisms are expandable. Balance graphics remain visible, while full financial histories default closed. The source workspace keeps its existing mount/selection boundaries; legal-bank cards plot only validated quarters through the selected quarter. This presentation adds no requests, chart dependency, storage, cache key or ingestion changes.


## Changing-risk timeline

The workbench's Risk timeline loads its visual bundle only after selection. Financial events compare up to six reporting dates from the already-loaded business-specific research history, with at most four events per date and twenty in total. Each marker opens native-unit before/after values, signed bars, formulas and the original SEC inputs. Percentage differences are percentage points, multiples remain multiples, and missing inputs never become zero. No composite score or default estimate is added.

Comparisons require adjacent compatible periods, matching concepts/units/accounting scope and verified issuer evidence. Dollar filters require at least 15% and a scale-aware minimum; percentage-point and multiple thresholds are stated on each event. Financial-institution lenses retain their own earnings, capital, funding and asset-quality measures. Generic corporate cash/debt conclusions do not replace bank, broker or insurance research. These descriptive filters identify review candidates and are not credit thresholds.

`/api/risk?evidence=1&timeline=1` adds at most three original annual maturity schedules from the same original-registrant facts and recent submissions already loaded by the request. Exact accession, form, filing date and report end bind each schedule. The annual next-principal buckets cover different forward windows and do not establish that the same debt cohort changed or that refinancing is unavailable. Missing schedules stay unavailable. Older profiles upgrade once inside the existing `risk-workspace-v9` entry; no calculation-version change, new persistent namespace or archive reads are needed for this compact history.

Compare filings explicitly requests `/api/risk/timeline?ticker=...&basis=ttm|annual&asOf=...`. It reviews at most four original primary reports and two verified archive manifests. Latest + TTM selects up to two quarters and two annuals; annual selects up to four annuals. Wording changes are paired only between the same form and identified section, and require changed topic-specific sentences. An unrelated edit inside a mixed-topic paragraph cannot produce a collateral or covenant marker. The response shows coverage for customer concentration, covenants and collateral on every selected report, including missing, unpaired and unreadable evidence. Language changes are review prompts; they do not automatically prove a breach, new security requirement, changed customer identity, introduction or resolution of risk. Before and after passages retain leading qualifications, source URLs and independent filing dates. The paired view highlights changed words without changing the quoted text, marks changes beyond a shortened preview, and gives original filings prominent links. Date-only boilerplate is suppressed.

The existing bounded filing reader supplies documents (24 MB maximum) through its approved compressed cache. The timeline writes no duplicate document or derived persistent dataset. It retains at most two 600-character excerpts per topic/report, twenty-four total and a 64 KB response. Each request reads at most two documents concurrently; the process caps total document reads at four and declines excess work. A bounded twelve-entry/1 MB local response cache lasts five minutes, with single-flight and short failure cooldowns. No new table, bucket, ingestion job, cache budget, browser storage, polling or chart dependency is introduced. Topic parsing retains bounded complete paragraphs for comparison before shortening display excerpts.

The optional cutoff excludes reports and financial source inputs filed after that date. Financial events use the current loaded history filtered by verified source availability; this is not reconstruction of an archived point-in-time financial dataset. Report-period dates anchor the rail, with filing dates shown separately in evidence. Basis, company or cutoff changes cancel client work and cannot apply earlier responses to a new selection.
