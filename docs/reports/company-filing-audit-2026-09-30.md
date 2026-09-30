# Company Analysis: independent original-filing audit

Audit date: 2026-09-30. Baseline: downloaded live Analysis API responses on the audit date, before remediation. This report distinguishes verified numerical matches from semantic errors; an amount matching a standard XBRL tag is not by itself proof that its displayed financial label is correct. Implementation and post-fix results are tracked separately by the main audit.

## Coverage and method

- Read 20 original SEC 10-K/10-Q documents: annual and quarterly reports for AMZN, BRK-B, COST, DAL, GE, GS, JPM, MET and PLD; XOM's latest quarter; AAPL annual control
- Independently parsed original inline-XBRL values, decimal scaling/sign, start/end dates, entity contexts, dimensions and financial-statement row text
- **376 of 376** latest-period *reported* metric observations whose source accession matches the inspected filing match the original document's exact concept, amount and duration/instant context
- The committed independent replay also verifies unit, standard namespace, and entity. XOM's 20 checked values use the predecessor entity declared in the combined filing before its July 1 holding-company transition; both registrants and the original context are retained explicitly in the ledger
- Reproducible source ledger: [`../audits/company-original-filings-2026-09-30.json`](../audits/company-original-filings-2026-09-30.json.gz); parser: [`../../scripts/audit-company-analysis.py`](../../scripts/audit-company-analysis.py)
- This count does not claim exhaustive historical coverage, independent recalculation of every derived metric, or that a matching tag proves appropriate accounting scope
- All monetary figures below are USD; B = billion and M = million

## Confirmed errors and required treatment

### 1. AMZN: YTD selects a trailing-twelve-month start (high severity)

[Original Q2 2026 report](https://www.sec.gov/Archives/edgar/data/1018724/000101872426000026/amzn-20260630.htm) presents three-, six- and twelve-month cash-flow columns. The live quarter's `fiscalStart` is incorrectly `2025-07-01`; the resulting YTD period also starts there. Fiscal YTD must be `2026-01-01` through `2026-06-30`.

| Metric | Baseline live YTD | Actual six months | TTM amount incorrectly selected |
|---|---:|---:|---:|
| Revenue | Unavailable | $382.125B | N/A |
| Net income | $135.281B | $92.902B | $135.281B |
| Operating cash flow | $161.403B | $71.419B | $161.403B |

Exact original facts:
- `NetIncomeLoss`: six-month context `c-1`, fact `f-63`, $92.902B; twelve-month context `c-22`, fact `f-65`, $135.281B
- `NetCashProvidedByUsedInOperatingActivities`: `c-1` / `f-129`, $71.419B; `c-22` / `f-131`, $161.403B
- `RevenueFromContractWithCustomerExcludingAssessedTax`: `c-1` / `f-239`, $382.125B

The quarter itself correctly selects $62.647B net income and $45.387B OCF. TTM correctly selects the twelve-month facts. The defect is the fiscal-start anchor, not numerical extraction. Filter fiscal-start candidates to the fiscal YTD duration appropriate to the filing's quarter; do not choose the earliest start among cash-flow facts. Regression should cover all three cash-flow durations in one filing and protect COST's non-calendar year.

### 2. MET: adjusted earnings presented as operating income

[Original Q2 2026 report](https://www.sec.gov/Archives/edgar/data/1099219/000109921926000050/met-20260630.htm#f-879), segment reconciliation table, labels the $1.604B fact **“Total consolidated adjusted earnings.”** It uses standard tag `OperatingIncomeLoss`, context `c-13`, fact `f-879`. Baseline live labels this $1.604B as operating income. The annual equivalent is $6.137B and has the same source meaning.

This is an issuer-specific adjusted earnings measure, after income-tax and other adjustments, not consolidated GAAP operating income. The company describes it as its GAAP segment-performance measure under segment-reporting guidance, and also discusses adjusted earnings as a non-GAAP performance measure at consolidated level. Standard-taxonomy membership does not resolve this semantic distinction. Suppress from operating-income calculations or present it separately under its exact adjusted-earnings label; do not use it as a pre-tax operating-profit starting point.

### 3. MET: debt calculation omits separate subordinated debt

[Original Q2 balance sheet](https://www.sec.gov/Archives/edgar/data/1099219/000109921926000050/met-20260630.htm#f-125), all entity-wide instant context `c-7`:

| Primary balance-sheet row | Concept | Amount |
|---|---|---:|
| Short-term debt | `ShortTermBorrowings`, fact `f-117` | $0.460B |
| Long-term debt | `LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities`, `f-121` | $14.244B |
| Subordinated debt securities | `SubordinatedDebt`, `f-125` | $5.144B |

Baseline live `totalDebt` is $14.704B, the first two rows only. Those three separately reported borrowing rows sum to $19.848B. Debt/assets, debt/equity and net-debt outputs inherit the incomplete scope. A generic engine must not silently assume subordinated debt is already included in another long-term-debt tag. A proven issuer-specific reconciliation or an unavailable/explicitly partial measure is safer than a universal addition rule.

### 4. JPM: cash row mislabels a narrower balance

[Original Q2 report](https://www.sec.gov/Archives/edgar/data/19617/000162828026054343/jpm-20260630.htm#f-217):

- `CashAndDueFromBanks`, context `c-12`, fact `f-217`: **$24.720B**, the live cash value
- `InterestBearingDepositsInBanks`, same context, fact `f-219`: **$285.091B**
- Cash-flow ending “Cash and due from banks and deposits with banks,” fact `f-517`: **$309.811B**, tagged `CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents`

The $24.720B value is numerically correct for cash and due from banks, but **not** an interchangeable cash-and-cash-equivalents total. Preserve the narrow value under an honest label and scope note, including its dependent cash/assets ratio, or use a proven bank-specific reconciliation. Do not universally substitute the restricted-cash-inclusive cash-flow concept for unrestricted cash.

### 5. GS: combined debt tag is an unsecured-borrowings subtotal

[Original Q2 report](https://www.sec.gov/Archives/edgar/data/886982/000088698226000297/gs-20260630.htm#f-4528), borrowing-note table:

- Unsecured short-term borrowings: $89.911B
- Unsecured long-term borrowings: $347.963B
- Total: **$437.874B**, `DebtLongtermAndShorttermCombinedAmount`, context `c-14`, fact `f-4528`

The live value matches this subtotal. The generic tag does not make it complete funding/debt: collateralized financing liabilities are disclosed separately. Avoid labels or notes implying the tag proves total borrowing completeness; distinguish unsecured borrowings from broader bank funding and collateralized obligations.

## Coverage gaps and conservative choices

### AMZN capex

In the same primary cash-flow table, **“Purchases of property and equipment”** uses `PaymentsToAcquireProductiveAssets`: quarter `c-19` / `f-133` **$54.208B**; YTD `c-1` / `f-135` **$98.411B**; TTM `c-22` / `f-137` **$173.028B**. Baseline capex and FCF are unavailable despite this standard fact. An issuer-verified or accurately labeled productive-assets fallback can fill the gap. Generic productive assets can have broader scope than PPE, so do not silently assume equivalence for every filer. Amazon's own FCF convention also considers equipment sale proceeds/incentives; generic OCF minus gross purchases must retain its own explicit definition.

### DAL current debt

[Original Q2 balance sheet](https://www.sec.gov/Archives/edgar/data/27904/000002790426000031/dal-20260630.htm) reports current maturities of debt and finance leases of **$3.442B**, `LongTermDebtAndCapitalLeaseObligationsCurrent`, context `c-2`, and noncurrent debt and finance leases of **$10.510B**, `LongTermDebtAndCapitalLeaseObligations`. Baseline noncurrent debt is correct but current and total debt are unavailable. These face-statement rows total $13.952B within the stated finance-lease-inclusive scope; do not add separately reported operating leases without disclosure.

### COST: no missing-value-to-zero inference

[Original Q3 FY2026 report](https://www.sec.gov/Archives/edgar/data/909832/000090983226000051/cost-20260510.htm):
- Long-term debt note explicitly tags current maturities as zero (`LongTermDebtCurrent`, context `c-14`, fact `f-426`); noncurrent debt is $5.670B
- MD&A “Bank Credit Facilities and Commercial Paper Programs” separately discloses **$96M short-term bank borrowings**, included in other current liabilities; this amount is narrative, not a usable `ShortTermBorrowings` fact in this report
- Therefore $5.670B alone is not complete total debt. Leaving current/total debt unavailable is defensible without extracting and validating that additional borrowing

### PLD dual registrant and supplementation

[Original Q2 report](https://www.sec.gov/Archives/edgar/data/1045609/000119312526323746/pld-20260630.htm) contains separate Prologis, Inc. and Prologis, L.P. statements. Baseline source coverage correctly says companyfacts through March 31 and inline supplementation through June 30, not that the underlying companyfacts API is current through June.

Verified Prologis, Inc. values:
- Revenue **$2.425452B** and operating income **$1.251336B**, correct
- Parent net income **$1.062191B**, `NetIncomeLoss`, versus **$1.084892B** for the L.P.; live correctly selects Inc.
- Parent equity **$53.725722B**, `StockholdersEquity`, versus L.P. partners' capital **$54.815248B**; live correctly selects Inc.
- Consolidated earnings before NCI are **$1.123954B**, `ProfitLoss`; the $61.763M difference is not a cash adjustment
- Face-statement Debt is **$36.442085B**, `LongTermDebt`, instant context `C_2a4e4060-b972-4dc0-b027-4f72e1d3d4ca`; live total debt unavailable. Its current/noncurrent split must not be inferred from that concept

The parent-earnings-to-consolidated-OCF residual is a mathematical bridge with mixed accounting scopes, not a statement-of-cash-flows noncash-adjustment total. Explain scope rather than claiming a causal reconciliation. Supplemental EPS/share-count gaps are disclosed by the current fallback and should not be filled with L.P. amounts.

### GE / BRK-B: unavailable safer than scope substitution

- [GE Q2](https://www.sec.gov/Archives/edgar/data/40545/000004054526000049/ge-20260630.htm): face balance sheet has cash, equivalents **and restricted cash** of **$9.345B**. Baseline unrestricted cash is unavailable; do not silently treat $9.345B as unrestricted. Reported short-/long-term borrowings $2.000B/$17.157B tie to the live $19.157B sum
- [BRK-B Q2](https://www.sec.gov/Archives/edgar/data/1067983/000119312526341032/brka-20260630.htm): cash $35.096B for Insurance and Other plus $5.513B for Railroad, Utilities and Energy is dimensionally disaggregated; Class A EPS $17,868 and Class B EPS $11.91 use different share-class contexts. Baseline consolidated cash and EPS are unavailable instead of guessing an entity or share class. Revenue $101.808B is reported but omitted by the insurance lens; this is a coverage limitation for the diversified group, not extraction failure

## Positive source-semantic controls

- COST's latest quarter is a **12-week** period, February 16–May 10, 2026, not a calendar 90-day quarter. Its 36-week fiscal YTD begins September 1, 2025. Revenue **$70.527B** includes net sales $69.154B plus membership fees $1.373B; live correctly uses the total
- [XOM Q2](https://www.sec.gov/Archives/edgar/data/2115436/000003408826000093/xom-20260630.htm): revenue **$116.017B** is explicitly “Total revenues and other income,” including operating sales $114.529B, equity-affiliate income $0.893B and other income $0.595B. Live selection matches the total, not a segment or narrower sales amount. Net income $14.525B is attributable to ExxonMobil, versus consolidated $14.881B including NCI
- JPM reported bank revenue **$57.347B** equals net interest income $25.511B plus noninterest income $31.836B. This is net of interest expense and must not be compared to gross interest income
- GS reported net revenue **$20.338B** and net earnings **$6.628B** match the income statement. Common-share earnings are lower ($6.399B), so dividing net earnings by diluted shares is not a reliable EPS check
- MET net income **$0.736B** is attributable to the parent, versus consolidated $0.779B and common-shareholder $0.705B. PLD, XOM, GE, MET and BRK confirm that these scopes cannot be collapsed into a single meaning merely because all are labeled net income in the interface
- DAL operating revenue **$19.757B**, operating income **$1.864B** and net income **$1.604B** match the face statements

## Audit limitations and acceptance checks

The baseline numerical match result is not a post-fix certification. After changes, rerun AMZN YTD and affected dependent ratios; suppress/relocate MET adjusted earnings; ensure incomplete debt cannot drive supposedly complete net-debt scenarios; verify bank cash labels and ratio descriptions stay in sync. Recheck all four period bases and preserve source cutoffs and fiscal-week dates. Do not broaden reported scope to increase apparent coverage.
