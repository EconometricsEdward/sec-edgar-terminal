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
