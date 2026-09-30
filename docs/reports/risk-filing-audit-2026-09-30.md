# Risk: multi-company, multi-filing audit

Audit date: 2026-09-30. Baseline: main and READY production commit `797b8d5b50f72c8bad386b3d364a62e9b7e5d00c`. The metric-card/chart redesign is preserved. This is a stratified sample audit, not certification of every company, filing, period, or risk.

## Coverage and method

- **48 issuers**, spanning all **15 business-model lenses**, with annual and TTM profiles and up to six observations per basis
- **138 original filing accessions / 141 original documents**: generally the latest two available 10-Ks and latest 10-Q; high-volume bank manifests supply one annual plus the latest quarter. The three additional documents are incorporated financial statements for Progressive and Wells Fargo
- Primary filing endpoints span September 1, 2024 through July 31, 2026, with earlier comparative observations inside those filings
- **4,272 independently recomputed ratio observations**, all matching their displayed inputs in the baseline. The corrected replay passes 4,360 arithmetic checks. This did not establish that the inputs were current, comprehensive, or economically comparable
- **3,527 / 3,527 baseline source observations** tied to original facts, including exact amount, sign, scale, currency/unit, start/end dates, namespace and legal entity
- **3,736 / 3,736 corrected replay source observations** tied to the same document set. The replay uses retained SEC inputs; it is separate from live deployment validation
- **3,742 / 3,742 supported derivative, fair-value and credit-concentration note observations** tied independently to original tags, values, dates, entity, units and dimensions. These are individual observations, not additive exposures or complete risk coverage
- Manual semantic review covered borrowing subtotals, restricted and narrow cash, capital-purchase scope, income/equity attribution, retained versus broader loan portfolios, insurer adjusted earnings, fiscal-week reporting, document sets and the verified ExxonMobil registrant transition

### Sample

| Lens | Issuers |
|---|---|
| Technology | AAPL, MSFT, NVDA |
| Retail and consumer | AMZN, COST, MCD, SBUX, WMT |
| Industrials | BA, CAT, F, GE, GM, RIVN |
| Company financial risk | DAL, UAL |
| Energy | CVX, XOM |
| Utilities | D, NEE, SO |
| REITs | AMT, HHH, O, PLD |
| Real estate | CBRE |
| Banks | BAC, C, JPM, WFC |
| Broker-dealers | GS, IBKR, MS, SCHW |
| Financial services | AXP, SOFI |
| Life and health insurers | AFL, MET, PRU, UNH |
| Property and casualty insurers | AIG, ALL, BRK-B, PGR, TRV |
| Other insurance | AIZ |
| Healthcare and life sciences | HCA, MRNA |

The sample includes non-calendar fiscal years, 52/53-week reporting, losses, negative equity, acquisitions/registrant transitions, lease-heavy and regulated businesses. SIC is a research starting point: for example Berkshire's diversified operations are not fully described by its insurance classification.

## Corrections

### 1. Ordinary filing typography was causing stale profiles

The identity parser accepted an ordinary space in a written reporting date but rejected a non-breaking space. It therefore rejected valid newer original reports. The correction normalizes presentation whitespace **before the existing exact issuer, fiscal period, form and report-date checks**; those checks are not relaxed.

| Issuer | Baseline latest period | Restored period | Newly verified facts |
|---|---|---|---:|
| Ford | 2026-03-31 | 2026-06-30 | 330 |
| Citigroup | 2025-12-31 | 2026-06-30 | 629 |
| Southern | 2026-03-31 | 2026-06-30 | 393 |

Same-source before/after replays reproduce the failures and restoration. Source documents:

- [Ford Q2 2026](https://www.sec.gov/Archives/edgar/data/37996/000003799626000156/f-20260630.htm)
- [Citigroup Q2 2026](https://www.sec.gov/Archives/edgar/data/831001/000083100126000045/c-20260630.htm)
- [Southern Q2 2026](https://www.sec.gov/Archives/edgar/data/92122/000009212226000054/so-20260630.htm)

The same parser correction makes Bank of America's classification read verifiable, without inventing a current/noncurrent classification for its unclassified bank balance sheet. Missing historical inputs can still leave individual TTM measures unavailable after the latest balance date is recovered.

### 2. Supported capital spending was being omitted

Risk previously accepted only `PaymentsToAcquirePropertyPlantAndEquipment`. Several issuers use the standard `PaymentsToAcquireProductiveAssets` concept. The latter is now an explicitly scoped fallback; the original tag, source values and dates remain visible. The PP&E concept remains preferred, and neither tag is added to the other.

| Issuer / basis | Reported purchases | Operating cash less those purchases |
|---|---:|---:|
| Amazon FY2025 | $131.819B | $7.695B |
| Amazon TTM to 2026-06-30 | $173.028B | **−$11.625B** |
| Nvidia FY2026 | $6.042B | $96.676B |
| Nvidia TTM to 2026-07-26 | $7.354B | $127.006B |

Amazon's [2025 annual](https://www.sec.gov/Archives/edgar/data/1018724/000101872426000004/amzn-20251231.htm), [2024 annual](https://www.sec.gov/Archives/edgar/data/1018724/000101872425000004/amzn-20241231.htm) and [Q2 2026](https://www.sec.gov/Archives/edgar/data/1018724/000101872426000026/amzn-20260630.htm) statements identify PP&E purchases under the productive-assets tag. Nvidia's [FY2026 annual](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm) and [Q2 FY2027](https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm) explicitly include **PP&E and intangible assets**. Treating the fallback universally as PP&E-only would be wrong.

Supported capital-purchase history is restored for AIG, AMZN, CBRE, CVX, DAL, F, GE, NVDA, SO, SOFI and UAL in the replay. Financial-company cash flows are still not used as industrial free-cash-flow debt screens. All derived descriptions use reported capital purchases, disclose broader productive-asset scope, and avoid claiming complete investment spending or the issuer's own free-cash-flow definition. Caterpillar is a useful control: its PP&E purchase row explicitly excludes equipment leased to others, so even the narrower standard tag is not proof of comprehensive capital investment.

### 3. Scope changes were appearing as ordinary period deltas

The newer top-card model already guarded source signatures, but the lower metric, funding and evidence comparisons could still calculate changes through known ownership-scope switches. Examples in the baseline include Ford's parent-attributable versus consolidated earnings and Southern's parent versus consolidated equity.

Known income attribution, equity attribution, cash, units and debt/lease scope changes now suppress incompatible deltas and adverse streaks consistently. A change between PP&E-only and broader productive-asset purchases also cannot become a like-for-like investment change. Original observations remain available with their sources. Loss-window counts remain counts, not period deltas.

### 4. Labels and calculations must not imply complete scope

- **Selected reported debt:** MetLife's Q2 selected borrowing subtotal is $14.704B while the [same filing](https://www.sec.gov/Archives/edgar/data/1099219/000109921926000050/met-20260630.htm) separately presents $5.144B of subordinated debt. The selected amount is retained under an honest label and source note; potentially overlapping components are not added universally
- **Narrow cash:** cash-only and cash-and-due-from-banks concepts retain their own labels. They no longer acquire a cash-and-equivalents label merely by passing through the balance or business-driver presentation
- **Insurance operating income:** generic insurer operating-income tags are withheld from operating-income/stress inputs, consistent with Company Analysis. MetLife's standard `OperatingIncomeLoss` fact is adjusted earnings, not interchangeable GAAP operating profit. Reported net income and insurance measures remain available
- **Cash/income residual:** the accruals description now states that parent-attributable income and consolidated operating cash flow can differ in ownership scope. Their difference is not a causal reconciliation of noncash adjustments
- **Bank loan scope:** JPMorgan's Q2 net loans plus loan allowance equal $1.542462T, while its independently tagged retained-loan subtotal is $1.463808T. The latter is a different portfolio, not a replacement denominator. The reserve description explicitly distinguishes broader loans, fair-value/held-for-sale amounts and retained-loan scope

Positive control: JPMorgan's Q2 $23.7B restricted cash is explicitly contained within cash/due-from-banks and deposits-with-banks in the restriction note. Its $309.811B cash-flow endpoint less those restrictions is $286.111B; that reconstruction is retained rather than silently replacing it with the narrower $24.720B cash-and-due-from-banks component.

## Coverage that remains bounded

- Financial facts and supported note extractions do not establish covenant headroom, complete credit exposure, derivative net risk, hedging effectiveness, borrower/counterparty concentration, contractual liquidity, legal-entity regulatory compliance or future losses
- Missing current borrowing components are not reported zero. COST's narrative short-term borrowing, unclassified/partial debt, custom loan tags and unsupported capex categories are not fabricated to fill coverage
- SEC consolidated issuer data and separately selected FFIEC/CFTC legal entities remain distinct. The earlier [BankScope original-source audit](../bankscope-accuracy-audit-2026-09-30.md) is complementary evidence, not proof that holding-company ratios equal a bank subsidiary's measures
- PGR and WFC demonstrate why inspecting only a primary HTML file is insufficient for financial-statement verification: their incorporated financial documents are in the same accession. PGR is an inline-XBRL document set whose financial exhibit uses contexts/units defined in the primary 10-K. The independent audit resolves only explicitly listed same-accession companions; note extraction remains bounded to its selected primary document and reports missing coverage
- For the verified pre-transition XOM joint filing, predecessor contexts are allowed only under the reviewed registrant-continuity evidence. Other co-registrants are not accepted interchangeably
- Note observations remain separate measures. Fair-value components, collateral/netting offsets, notional amounts, and overlapping concentration groups are not summed. Duration-typed receivable concentrations are not automatically mistaken for flow measures merely because their XBRL contexts include a start date
- Historical paths outside the inspected accessions, unsupported/custom or dimensional mappings, foreign-currency filers and untagged narrative risks are not certified by this sample

## Evidence and regression artifacts

All ledgers are losslessly gzip-compressed JSON; `gunzip -c FILE.json.gz` exposes the full evidence. Each original document and captured profile has a SHA-256 fingerprint.

- [Filing/document manifest](../audits/risk-filing-manifest-2026-09-30.json.gz)
- [Baseline original-filing ledger](../audits/risk-original-baseline-2026-09-30.json.gz)
- [Corrected original-filing and note ledger](../audits/risk-original-fixed-2026-09-30.json.gz)
- [Baseline arithmetic ledger](../audits/risk-arithmetic-2026-09-30.json.gz) and [corrected arithmetic ledger](../audits/risk-arithmetic-fixed-2026-09-30.json.gz), replayed with `scripts/audit-risk-arithmetic.py --capture-dir DIR --output RESULT.json`
- [Same-input correction replay](../audits/risk-replay-2026-09-30.json.gz)
- Independent replay: [`scripts/audit-risk-filings.py`](../../scripts/audit-risk-filings.py), using captured Risk responses and the manifest's exact original files. It performs no network calls or production writes
- Regressions: `risk-financial-scope.test.js`, `risk-original-filings.test.js`, the updated profile-source tests, and the full existing Risk suite. Reduced original Ford/Citi/Southern identity fragments preserve exact typography; reduced original Amazon/Nvidia observations preserve their multi-filing capital-purchase facts

## Release and cost boundaries

The calculation contract advances to `risk-workspace-v11`, but the existing `risk-workspace-v9` disposable cache namespace remains unchanged. Entries replace the existing per-ticker slot. No new durable dataset, ingestion schedule, paid capacity, credentials or permissions is added. No full filing corpus or large companyfacts capture is committed.

The audit made 48 sequential profile reads between approximately 07:51 and 08:04 UTC, plus a small control/UI read set. Original SEC downloads and offline replays are separate from the site's storage. Deployment and verification timestamps belong in the PR release record; the existing Sep 30 06:00 to Oct 1 06:00 cost-observation window is not restarted.

Run `npm run check` before release. Exact-commit CI, deployment state and live API/browser verification are recorded in the pull request rather than inferred from local arithmetic or a successful build.

### Live-verification follow-up: incomplete loss histories

PR #187 passed exact-commit CI and deployed as `9dda2ed1`. Nine live issuer controls passed. Citi's first attempt encountered a transient shared SEC-dispatch timeout; the normal retry after its short degraded-cache expiry recovered the June filing. The page retained the old date and disclosed the temporary coverage gap while that read was unavailable.

Live browser review then exposed a separate presentation issue: Citi's restored June balance sheet coexists with an unavailable latest TTM earnings window. Its count of zero losses in the **available historical windows** was correct, but the lower earnings row labeled that incomplete history “Within screen.” Incomplete histories with zero observed losses now show **Context**. The count and missing-observation note remain intact; known losses retain their warnings.

The v12 presentation contract has a bounded, read-only v11 adapter. It changes neither financial numbers nor source evidence, acquisition/calculation timestamps, or the existing v9 cache slot, and does not force a new SEC source rebuild. A [48-profile compatibility replay](../audits/risk-loss-presentation-compatibility-2026-09-30.json) preserves all financial values, series, sources and clocks; Citi is the only sampled profile whose classification changes. Fresh and compatible cached responses receive the same correction. Unknown or malformed old contracts do not use the adapter.
