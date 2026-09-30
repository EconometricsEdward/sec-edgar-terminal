# Risk peer benchmarks

The Risk workbench adds an on-demand Peer benchmarks view. Company comparisons use the existing scalar Market serving snapshot; the legal-bank panel reuses BankScope's existing quarterly FDIC peer publication. No new tables, source archives, ingestion jobs or persistent projections are created.

## SEC company populations

`GET /api/risk/peers?ticker=AAPL&basis=ttm&group=industry` accepts one exact ticker, annual or TTM basis, and industry or model grouping. Industry peers share a three-digit SIC family and the Risk business-model lens. The broader business-model population is an explicit user choice. Diversified corporate and financial groups additionally require the same SIC division and primary sector. Banks, brokers, life insurers and property insurers remain separate.

Duplicate share classes and the subject issuer are excluded by CIK. Eligible peers have original 10-K/20-F/40-F reports (and 10-Q for TTM), verified report/filing dates, filing links, and report ends within 120 days for annual or 100 days for TTM of the benchmark subject. Current values belong to the prepared snapshot, which is visibly separate from the main Risk profile. Historical Risk cutoffs do not trigger this latest-snapshot comparison.

Each measure excludes its missing values separately and requires at least eight reporting peers. Statistics use all eligible observations, equal issuer weights, linearly interpolated quartiles, and midpoint ties for the numeric percentile. Zero and negative observations remain data. Zero-dispersion populations can still have a valid median and quartile band. Percentile does not indicate credit quality or a rating.

Corporate liquidity, cash flow and interest-coverage measures are withheld for financial intermediaries. The existing compact Market projection combines annual and TTM revenue labels; ambiguous rental and financial net-revenue denominators cannot prove per-basis comparability. Revenue-based distributions therefore require a provable total-revenue scope and exclude REIT/real-estate scopes pending finer provenance. Raw subject values remain visible, but unverified distributions and ranks stay unavailable.

Charts retain at most 60 deterministically value-spaced peer observations including the extremes. Median, quartiles and percentile use the complete reporting cohort; the UI discloses partial plotting. Latest-report links identify the report, while TTM calculations may involve more than one filing; Analysis provides the underlying financial inputs.

## Legal-bank populations

The Call Reports source panel adds an initially collapsed FDIC matched-bank comparison for the selected legal bank and quarter. It uses `loadBankView({kind:'peers',rssd,period})`; opening the Risk profile does not read this source. FDIC subject values are compared with same-publication FDIC peers, independently of the FFIEC cards and SEC parent.

Bank identity, quarter, normalization model, duplicates, regulatory framework and sample coverage are checked. CBLR and unverified frameworks cannot become CET1 dots. Each measure needs five reporting matched peers. Definitions such as noncurrent loans and allowance coverage are retained from FDIC and are not substituted for similarly named FFIEC measures.

The existing BankScope model matches size (40%), lending (35%) and funding (25%), taking up to 30 banks within one-quarter to four times assets, with the existing one-eighth to eight-times expansion when matching coverage is small. Source quarter, publication dates, matching details and retained-data notices remain visible.

## Serving and verification

The company endpoint uses the shared prepared Market reader, computes only scalar distributions, rate limits requests and emits a short CDN cache budget. It cannot fetch a company universe from SEC or write snapshots. The browser cancels obsolete requests and does not poll. Existing bank-view request caches retain their bounded reuse behavior.

Focused tests cover quartiles/ties, issuer exclusion, missing and negative values, source/report date windows, financial-company separation, ambiguous revenue scope, display limits, strict requests, response binding, bank identity and CBLR handling. Repository financial tests, SQL recovery rehearsal, lint, typecheck, production build and live company/bank interactions are the release checks.
