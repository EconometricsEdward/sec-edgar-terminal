# Research Hub

The Hub at `/workspace` has two sections. Saved portfolios, position notes and research views stay in the browser.

1. **Overview:** Resume saved portfolios, assess research coverage, search portfolios by name or company, compare portfolios, and start a new company list.
2. **Portfolio research:** Explore the portfolio briefing, financial metrics and rankings, concentration, company financials, screening, scenarios, and evidence coverage. Inspect company details, browse filings, search portfolio disclosures, research fund ownership, compare captures in What changed, and export portfolio reports.

## Navigation and persistence

Hub areas use `view=overview|portfolios`. Portfolio, row, saved-view, tab and analytics-area identifiers support deep links; private content never appears in those links. Old bookmarks to retired Hub screens resolve to a supported view. Portfolio import accepts uploaded files or pasted tickers.

The Hub review inbox, research briefs editor, combined watchlist, and evidence/backup screens have been removed. Their existing browser data is not deleted or migrated. Shared storage compatibility utilities remain for other tools. Market watchlists, Funds shelves, and company evidence notebooks remain in their own tools.

Portfolio reports and exports remain available inside Portfolio research. These are distinct from the retired Hub briefs editor and complete-workspace backups. Export a portfolio before clearing site data or moving browsers; saved work does not automatically synchronize.

## Verification

Tests cover supported navigation and legacy bookmarks, portfolio-only search, summary coverage, baseline comparisons, saved-view validation, and storage compatibility. Release verification exercises Overview, portfolio imports, research destinations and report exports.

## Financial measure availability

The metric explorer, company detail cards, company table choices and selected-company comparison use `portfolioAvailableMetrics`. It shares the ranking eligibility contract: a usable company capture, an applicable business lens, a finite value in the expected unit, and a complete annual or TTM period. Zero and negative values remain observations. Metrics with no eligible observations in the current scope are not offered, and empty metric families disappear. Rankings and their CSV include only measured issuers; coverage counts retain the full selected issuer denominator. Comparisons offer only measures observed for every selected company, with each observation's reporting dates shown.

A selection that becomes unsupported resolves to an available choice during rendering. If no choices remain, the explorer offers filter reset and refresh instead of an empty ranking. Screening never transfers numeric bounds to a different metric or silently removes an AND rule; an unsupported saved screen requires new bounds.

The September 8, 2026 demo captured 30 measures, before the expanded Analysis capture. Existing browser-saved copies do not change when the bundled demo is updated. Captures without `analysisVersion` receive a financial-refresh action using the existing bounded research workflow. The September 11 demo already contains short-term debt for 84 of 100 issuers. Remaining gaps can reflect missing compatible facts, required calculation inputs, business applicability or absent reporting periods. Do not infer zeros, substitute another CIK, change reporting basis, or broaden financial concept definitions to fill them.

User-facing tables and reports omit all-empty metric columns and unmeasured company metric cards. Raw saved evidence and dedicated coverage diagnostics retain the original missing-value reasons and classifications for audit and refresh.

The financial corrections from the earlier coverage draft are retained: reported combined SG&A takes precedence; otherwise both selling/marketing and general/administrative components must have compatible actual periods and units. Administrative expense alone is withheld from combined SG&A, including older saved captures. Analysis and risk calculation versions invalidate affected caches, and portfolio cache keys include the Analysis version. Older calculation versions receive the same refresh path as pre-expansion captures.

## Hypothetical weighted demo

The public 100-company demo applies explicit illustrative weights: five companies at 5%, fifteen at 2%, thirty at 1%, and fifty at 0.3%, totaling 100%. These fixed educational inputs are independent of market prices and financial evidence. The default view opens concentration; users can compare equal weights and company counts without changing the captured facts. Saved copies and reports preserve the chosen analysis basis and identify the allocations as hypothetical. Company results show model weights in descending order.

`node scripts/generate-portfolio-demo.mjs` rebuilds matching CSV, XLSX, JSON and capture allocation inputs while preserving the original SEC snapshot, source dates and request history. Only `--refresh` / `--resume` retrieve evidence. CSV/XLSX retain literal `weight_pct` values but require choosing the weighting basis after import; JSON includes the allocation settings. Legacy ticker-only captures remain supported.

## Recent SEC and CFTC updates

What Changed is available in saved portfolios and the public demo. Windows use today's UTC calendar date (7 days includes today and the six preceding dates). Source-dated SEC filings appear on the first capture. Undated, future and unverified document references are excluded; later value/period comparisons use the actual capture observation date and do not imply issuer restatements. Coverage changes are diagnostics, not company developments. Portfolio evidence retains up to 30 relevant filings per issuer; potential within-window clipping is disclosed separately from truncated older history.

`POST /api/v1/cftc/portfolio-changes` accepts only public company identifiers and a 1–90 day window, rejects invalid requests with HTTP 400, and scans up to 24 of 100 supplied issuers. The UI prioritizes a selected company, including those outside the initial scan. CFTC context does not require a prior SEC comparison baseline. The client retrieves a 60-day result once per identifier set/capture and filters windows locally; full research refresh and explicit CFTC retry recheck the context.

Events group related issuers by contract, report family, trader category and actual observation date. Shared source requests use bounded concurrency of four. Candidate links retain exact SEC annual-filing passages and must agree with the issuer identity, accession, official CFTC contract and futures-only report basis. These links are research context, not measured corporate exposure or evidence that the annual disclosure existed on a historical COT observation date.

A weekly event qualifies if net positioning/open interest changes by at least 1 percentage point or total open interest changes by at least 5%. Net equals longs minus shorts; net share uses each date's own open interest. Both observations must be exactly seven calendar days apart. Display thresholds are not statistical significance tests. Missing, unavailable, stale, unlinked and mismatched data have separate coverage counts. Observation dates are never presented as verified publication times. CSV exports retain date basis, report scope, sources and SEC connection excerpts.

The demo's Refresh all research checks every issuer. Retry alone targets incomplete issuers; failures retain earlier evidence with its status and source dates. Per-basis comparison checkpoints last for the browser session.

## Company impact scenarios

Scenarios opens a company-first lab in both saved research and the demo. Six editable starting cases cover demand slowdown, cost pressure, combined pressure, demand recovery, operating-cash-flow deterioration and a new noncash asset loss. Company results use no investment weights. Complete reviewed allocations can annotate model coverage; the separate price and allocation sandbox retains explicit price shocks, case comparison and allocation tools.

Operating scenarios require compatible corporate revenue and operating income. Implied costs equal revenue less operating income; the assumed variable share adjusts with revenue, then the cost assumption adjusts the resulting cost base. Cash scenarios change the magnitude of reported operating cash flow and hold PP&E purchases fixed. A negative assumption worsens negative operating cash flow. Balance scenarios reduce assets and shareholder equity equally before taxes; the noncash ceiling is checked against compatible cash when available. Undefined ratios remain unavailable. These are company sensitivities, not stock returns, portfolio profit, regulatory capital or scenario probabilities.

The company comparison reports operating and equity impacts relative to labeled financial baselines, prioritizing newly negative outcomes. The cash case instead ranks scenario operating-cash-flow coverage of PP&E purchases, since the assumed cash-flow percentage alone does not distinguish companies. A waterfall reconciles reported to modeled dollars; a sensitivity curve varies one assumption while retaining the others. Company selection exposes exact periods, original source values and SEC filing links. Issuer identity, accession, USD units and complete matching observation periods are checked. Supported calculated quarterly and TTM inputs reconcile to their retained SEC values. Source index links remain explicitly labeled. Excluded companies and reasons remain visible. CSV exports preserve assumptions, results, coverage and evidence.

Selected-company CFTC context reuses the existing prepared company-context/history endpoints. Only verified annual-filing connections enter its bounded market selector. The chart shows aggregate trader positioning divided by each observation's own total open interest, with exact-week comparisons and gaps for missing observations. It does not set company scenario assumptions. Observation dates, source limitations, coverage failures, report family and futures-only scope remain explicit. No weights or private portfolio data are sent to these endpoints; no new database or provider is introduced.
