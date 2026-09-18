# Apple Risk reconciliation — 18 September 2026

Primary source: [Apple 10-Q, period ended 27 June 2026, filed 31 July 2026](https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm), accession 0000320193-26-000020. Annual bridge: [2025 10-K](https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm). All dollar inputs below are USD millions. The regression fixture contains the corresponding SEC company-facts observations and accession metadata.

## Balance-sheet and flow reconciliation

| Displayed measure | Reconciled calculation | Result |
| --- | --- | --- |
| Total debt | 1,997 commercial paper + 11,007 current term debt + 71,340 noncurrent term debt | 84,344 |
| Net debt, cash only | 84,344 − 39,544 cash and equivalents | 44,800 |
| Cash and marketable securities | 39,544 + 22,855 current + 84,118 noncurrent | 146,517 |
| Liabilities / equity | 275,746 / 107,520 | 2.564602× |
| Liabilities / assets | 275,746 / 383,266 | 71.946377% |
| Current ratio | 149,818 / 149,326 | 1.003295× |
| Current ratio, ex inventory | (149,818 − 11,092) / 149,326 | 0.929014× |
| Cash / assets | 39,544 / 383,266 | 10.317638% |
| TTM net income | 112,010 + 101,464 − 84,544 | 128,930 |
| TTM operating cash flow | 111,482 + 116,996 − 81,754 | 146,724 |
| TTM revenue | 416,161 + 364,357 − 313,695 | 466,823 |
| Operating cash flow / debt | 146,724 / 84,344 | 173.959025% |
| Net margin | 128,930 / 466,823 | 27.618605% |
| Accruals / ending assets | (128,930 − 146,724) / 383,266 | −4.642729% |
| Receivables growth − sales growth | (31,398 / 27,557 − 466,823 / 408,625) × 100 | −0.304016 percentage points |

TTM bridges use FY2025 plus nine months FY2026 less nine months FY2025. They do not add cumulative quarterly cash-flow statements. The latest six TTM windows contain no reported net loss; this is a historical count, not a forecast.

The former debt mapping required `DebtCurrent`; Apple instead reports current term debt and commercial paper separately. The revised mapping prefers the reported current-debt aggregate, then disjoint current-term and short-term borrowing components. Missing components remain unavailable. The former “Quick ratio” label was too broad for a formula retaining other current assets; it is now “Current ratio, ex inventory” and has no quick-ratio screening thresholds.

Separate interest expense is unavailable for the current compatible window. Net other income/expense and cash interest paid are not substituted. Interest coverage remains unavailable with this reason visible. Positive cash generation and securities exceeding borrowings do not establish an absence of credit, liquidity, counterparty or market risk.

## Note 4: credit and currency evidence

| Reported measure | 27 June 2026 | 27 September 2025 |
| --- | ---: | ---: |
| FX derivative notional, designated accounting hedges | 61,313 | 62,647 |
| FX derivative notional, not designated accounting hedges | 64,053 | 109,079 |
| Interest-rate derivative notional, designated accounting hedges | 10,625 | 12,875 |
| One customer / trade receivables | 18% | 12% |
| Cellular network carriers / trade receivables | 27% | 34% |
| Vendor one / vendor non-trade receivables | 47% | 46% |
| Vendor two / vendor non-trade receivables | 22% | 23% |

These figures come from exact inline-XBRL contexts and units in the primary filing. Concentration groups can overlap. Notionals are contract reference amounts, not losses, fair values or unhedged currency exposure. Accounting designation is distinct from economic hedging. The filing describes hedges covering portions of forecast revenue, purchases, debt and securities; it does not establish a supported currency pair for the CFTC mapping. Independently selected CFTC markets remain explicitly user-selected market context.

## Validation

Regression checks cover every existing Apple ratio on annual and TTM bases, debt double counting, unavailable versus zero inputs, securities context, inline units and dimensions, current/prior filing identity, CFTC report denominators, signed comparisons and missing-week gaps. Production verification additionally checks displayed source values, collapsible evidence, chart controls and the sticky company navigation.


## Funding and obligations profile revision

The profile keeps the financial-shape and balance-sheet overview, puts the collapsible metric explorer immediately afterward, and replaces the supporting-observations/review-questions sections with historical liquidity, borrowing and cash-generation analysis. Current liabilities remain separate from current debt; cash, current securities and noncurrent securities are not interchangeable. Credit concentration is grouped by its reported receivable denominator. FX and rate contract comparisons retain their accounting designation and exact source dates.

### Apple cash-generation reconciliation

All dollar amounts below are USD millions. Same primary 10-Q and 2025 10-K sources as above.

| Measure | Calculation | Result |
| --- | --- | ---: |
| TTM cash PP&E expenditure | 12,715 + 6,799 − 9,473 | 10,041 |
| TTM operating cash after PP&E expenditure | 146,724 − 10,041 | 136,683 |
| TTM cash dividends | 15,421 + 11,778 − 11,559 | 15,640 |
| Cash after PP&E expenditure and dividends | 136,683 − 15,640 | 121,043 |
| Cash / current debt | 39,544 / 13,004 | 3.04091× |
| Cash + current securities / current debt | (39,544 + 22,855) / 13,004 | 4.79845× |
| Current debt / total debt | 13,004 / 84,344 | 15.4178% |
| Cash after capex / total debt | 136,683 / 84,344 | 162.0542% |
| Cash after capex / current debt | 136,683 / 13,004 | 10.5108× |

These are historical capacity comparisons, not contractual DSCR or a forecast of coverage. Cash after capex precedes acquisitions, distributions, buybacks and debt principal; the additional dividend step still precedes other financing uses. OCF already reflects operating cash payments; lease payments and interest are not subtracted again. Cash-interest tags remain separate from accrual interest expense.

### Company-specific financial institutions

Banks use the six CAMELS dimensions as a public-filing research framework. Management/control evidence is qualitative with no inferred score; no composite or supervisory rating is computed. The framework follows the [Federal Reserve interagency UFIRS description](https://www.federalreserve.gov/boarddocs/srletters/1996/sr9638.htm). Bank earnings/ending-assets is explicitly not average-assets ROA. Loan allowances use the total gross-loan denominator reconstructed from aligned net loans plus allowance; a narrower retained-loan denominator is not substituted.

[JPMorgan June 2026 10-Q](https://www.sec.gov/Archives/edgar/data/19617/000162828026054343/jpm-20260630.htm), accession 0001628280-26-054343, checks: total gross loans 1,542,462; allowance 26,152; allowance/total gross loans 1.69547%. TTM pre-provision earnings are 99,838 net interest income + 99,570 noninterest income − 102,430 noninterest expense = 96,978; divided by 13,080 credit provision gives 7.41422×. Net income 65,067 / ending assets 5,015,069 = 1.29743%. Each flow retains its own SEC evidence and full TTM interval.

Broker-dealers (SIC 6211/6221) use firm cash, customer and clearing balances, securities financing, financial-instrument concentration and book capital. Financial advisers retain the broader financial-services lens. [IBKR June 2026 10-Q](https://www.sec.gov/Archives/edgar/data/1381197/000138119726000147/ibkr-20260630.htm), accession 0001381197-26-000147, checks: consolidated book equity 22,250 / assets 247,309 = 8.99684%; parent equity 5,904 remains separately identified. Cash 7,711 / liabilities 225,059 = 3.42621%; clearing receivables 5,120 / assets = 2.07028%. Customer payables 176,779 and broker/clearing payables 819 use their reported SRT concepts. No client funds are added to firm cash; missing custom customer-receivable or segregated-asset tags remain gaps. These balances do not establish legal-entity regulatory net capital or reserve compliance.

### Embedded market context

The Profile tab now contains a deferred SEC-to-CFTC context chart with net/open-interest and open-interest views, report-date inspection, exact 1/4/13-week changes and collapsed evidence/history. Supported benchmarks must retain qualifying proof from the selected annual or quarterly evidence. Generic Apple FX/rate passages do not automatically select a currency pair or maturity. User-selected references are explicit independent market context. Bank and broker funding/repricing channels take priority over peripheral commodity-trading passages. CFTC positioning is never interpreted as company exposure size, hedge coverage, market liquidity, credit risk severity or a price forecast.
