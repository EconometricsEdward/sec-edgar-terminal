# Analysis accuracy audit and corrections

Date: 2026-09-30. Baseline production commit: `b359dacd1789a4cabc51cbf2a47e8ec163626ac1`. This is a source-grounded sample audit and correction record, not certification of every issuer, filing, historical period or nonstandard taxonomy concept.

## What was checked

- Company Analysis: annual, standalone quarter, YTD and TTM for AMZN, BRK-B, COST, DAL, GE, GS, JPM, MET, PLD and XOM, plus AAPL annual control (41 live payloads)
- 874 independently recomputed latest-period arithmetic checks, with no arithmetic differences from the displayed inputs. This does **not** prove correct mappings: Amazon's wrong YTD window still reconciled internally
- 376 reported observations tied independently to 20 original SEC 10-K/Q documents, including scale, sign, unit, actual source dates and registrant. XOM's verified pre-transition predecessor contexts are explicitly identified
- Original-filing semantic review of face statements and notes: income attribution, adjusted earnings, cash components, borrowing subtotals, 12-week/36-week fiscal periods, share classes, dual registrants and newer-filing supplementation
- BankScope: six banks × four periods; 840 core and 1,452 exposure values tied to hash-verified original Call Report XBRL. 45 of 48 official FDIC ratio comparisons agreed; three disclosed domestic funding ratios were wrong
- Source mappings and defensive regression coverage for missing versus zero, currency, quarter/YTD/TTM, filing cutoffs, average opening/closing balances, cumulative-quarter derivation, growth comparability and retained-source publication

## Corrections

### Amazon's YTD was actually TTM

The period engine chose the earliest start in a filing, admitting Amazon's twelve-month cash-flow column. Q2 2026 YTD consequently used July 1, 2025 rather than January 1, 2026.

| YTD measure | Before | Corrected six months |
|---|---:|---:|
| Revenue | Unavailable | $382.125 billion |
| Net income | $135.281 billion | $92.902 billion |
| Operating cash flow | $161.403 billion | $71.419 billion |

Fiscal-start candidates now require the observed duration appropriate to the reporting season. Non-calendar 52/53-week dates remain reported dates. Selection also rejects stale period descriptors trying to reinterpret TTM as YTD. Ratios now use the correct December 31 opening balances and 181-day annualization. Annual, standalone-quarter and TTM amounts remain separate. A missing nine-month column cannot turn a trailing six-month column into Q3 YTD.

### BankScope domestic funding used an all-office numerator

FDIC `DEPNI` contains all-office noninterest deposits; the denominator was domestic `DEPDOM`. Both the ratio and peer-matching profile now use domestic `DEPNIDOM`.

| Institution | Before | Correct domestic noninterest deposit share |
|---|---:|---:|
| JPMorgan Chase Bank, N.A. | 30.2029378612% | 28.2377323412% |
| Bank of America, N.A. | 30.6565114717% | 29.9109042473% |
| Wells Fargo Bank, N.A. | 26.8397814506% | 26.8316765448% |

The peer model is versioned so old and corrected observations cannot be mixed. The FFIEC 031 CBLR election code is also corrected to `RCOALE74`; this is an official-form mapping defect, not a claim that every sampled bank elected CBLR.

### Historical fiscal metadata conflicts

GE's [original March 31, 2020 quarterly report](https://www.sec.gov/Archives/edgar/data/40545/000004054520000021/ge1q202010-q.htm) contains erroneous FY2019/Q3 fiscal metadata. The quarter's January 1–March 31 contexts follow the preceding December 31, 2019 annual endpoint. The normalized fiscal label is corrected to FY2020/Q1 only when the old start is incompatible with its declared season, a prior annual filing was already available, and at least two anchor concepts establish the exact fiscal start. The contradictory original metadata is preserved and a source notice explains the correction. No dollar amounts are rewritten by this metadata correction.

### Accounting labels were broader than their inputs

- JPM cash remains the reported $24.720 billion cash-and-due-from-banks component, now labeled accordingly. Its separate $285.091 billion deposits-with-banks balance is not silently added or represented as zero
- Insurer `OperatingIncomeLoss` is not treated as comparable GAAP operating profit. MetLife uses that tag for $1.604 billion consolidated adjusted earnings in Q2, so the misleading row is excluded with an insurer-scope explanation
- Debt is explicitly labeled **Selected reported debt**, with scope notes carried through ratios and evidence. MetLife's $14.704 billion subtotal excludes $5.144 billion separately displayed subordinated debt; Goldman's $437.874 billion tag is an unsecured-borrowing subtotal. These are not presented as comprehensive debt totals, and potentially overlapping components are not blindly added
- The cash-flow/net-income residual now explains that consolidated operating cash flow and parent net income can differ in ownership scope; it is not a causal noncash-adjustment attribution

### Calculation evidence and comparisons

- Calculated flows must have source intervals supporting the selected duration before entering labs, scenarios or goal-seek
- An average-balance input needs the same concept at exactly the required opening and closing dates
- Known cross-period changes in currency, income/equity ownership, cash/restricted-cash scope, net-interest revenue and debt/lease scope cannot masquerade as growth or statement/public-summary changes
- Equivalent ordinary revenue-tag migrations remain allowed. Same-period profit/earnings bridges can still compare unlike rows intentionally
- Eight historical GS calculated inputs with a one-day source interval gap now fail closed consistently with the pre-existing comparison checks. This is not a claim their reported dollar amounts are wrong

## Coverage intentionally not invented

Custom concepts, unsupported currencies, ambiguous current/noncurrent debt, unproven net borrowing completeness, share-class EPS and unsupported filing contexts remain unavailable. AMZN's productive-asset capex concept, DAL's broader current-debt reconciliation, PLD's unclassified debt balance and COST's narrative-only short-term borrowings are documented coverage gaps, not silently filled values. Some connected scenario debt rows also remain conservatively unavailable.

## Evidence and reproducibility

The three detailed ledgers are losslessly gzip-compressed JSON. Decompress with `gunzip -c FILE.json.gz`; the replay scripts emit plain JSON for inspection. Compression is verified byte-for-byte and reduces repository transfer size without dropping evidence.

- [Original Company filing review](company-filing-audit-2026-09-30.md)
- [Original Company fact ledger](../audits/company-original-filings-2026-09-30.json.gz), replayed with `scripts/audit-company-analysis.py` against captured live JSON and exact primary reports
- [Independent arithmetic ledger](../audits/company-arithmetic-2026-09-30.json.gz), replayed with `scripts/audit-company-arithmetic.mjs CAPTURE_DIR OUTPUT_JSON`
- [BankScope source review](../bankscope-accuracy-audit-2026-09-30.md), [bank ledger](../audits/bankscope-2026-09-30.json.gz), and `scripts/audit-bankscope-accuracy.py`
- Source-focused tests include the unchanged reduced Amazon SEC observation fixture and explicit before/after expectations

## Release validation

The pre-compatibility aggregate gate passed 3,996 tests with two intentional skips, 10 SQL recovery rehearsals, lint, type checking and production build. The final gate is rerun after all compatibility and disclosure changes.

A narrow, explicit v2-to-v3 serving adapter avoids invalidating every prepared issuer while the existing scheduler catches up. It proves the full retained fiscal history unchanged before adjusting presentation/scope notes and removing insurer operating-income rows; numeric values, source values, acquisition/validation clocks and original calculation time stay unchanged. Unknown versions, malformed evidence and affected fiscal periods fail closed. Full and public responses expose `mappingCompatibility`, and stored snapshots remain v2 until genuinely rebuilt. The 41-view capture matrix admits 35 and rejects AMZN/GE's three interim bases each; no number is inferred to rescue a rejected view. Frozen-payload memoization uses weak references, existing storage namespaces stay unchanged, and adaptation performs no new source reads or writes. A [same-source replay](../audits/analysis-mapping-compatibility-2026-09-30.json) independently builds old and new code from identical facts for ten issuers × four bases: all 34 compatible views have exactly matching values, complete sources, point notes, definitions and periods; only the six unsafe interim views are refused.

Only the existing queued AMZN/GE shards need prioritization for affected public summaries after deployment; memberships, checkpoints, leases, cadence and per-run limits remain intact. Bank historical repair uses retained XML and existing fenced workers. The final release record will identify the reviewed migration, merged commit, deployment, aggregate gate and live refresh verification. No paid capacity or broader credentials are introduced.
