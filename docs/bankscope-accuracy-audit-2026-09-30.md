# BankScope source-accuracy audit · 30 September 2026

## Findings and corrections

1. **Domestic noninterest deposit share used an all-office numerator.** The FDIC dictionary distinguishes `DEPNI` (all-office noninterest deposits) from `DEPNIDOM` (domestic noninterest deposits). BankScope divided `DEPNI` by `DEPDOM`, despite labeling the numerator domestic. This also affected the funding component of peer selection. The FDIC request, normalization, displayed formula and matching now use `DEPNIDOM`; missing domestic data stays unavailable. `bankscope-peers-3` is a new normalization contract, not a reinterpretation of persisted v2 data.
2. **Form 031 CBLR election used the wrong prefix.** RC-R I 31.a is `RCOALE74` on **all three forms**, including 031. BankScope used `RCFALE74` on 031. The result could classify a CBLR elector as risk-based and withhold its report because non-required capital ratios were missing. The election now uses the official code and still requires the correct instant context, value and nonmonetary/pure unit. Other 031 capital amounts retain their RCFA/RCFW codes. Call Report mapping version is `ffiec-bankscope-v3`.

Official references:
- [FDIC financial field dictionary](https://api.fdic.gov/banks/docs/risview_properties.yaml): `DEPNI`, `DEPNIDOM`, `DEPDOM`; published ratio numerator/denominator definitions
- [FFIEC 031 June 2026 form](https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_202606_f.pdf), PDF page 63, RC-R I 31.a: `RCOALE74`; RC-R I 30–31 distinguish adjusted average leverage assets from other asset/capital measures
- [FFIEC 041 June 2026 form](https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC041_202606_f.pdf)
- [FFIEC 051 June 2026 form](https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC051_202606_f.pdf), PDF page 20 RC-C I and page 36 RC-N: portfolio and performance mappings

### Exact live deposit-share errors, Q2 2026

FDIC source amounts below are **USD thousands**. The corrected values are independently calculated from the official source; they were not yet deployed when captured.

| Legal bank / RSSD | Old `DEPNI` | Correct `DEPNIDOM` | `DEPDOM` | Live v2 share | Correct share | Overstatement |
|---|---:|---:|---:|---:|---:|---:|
| JPMorgan Chase Bank N.A. / 852218 | 672,556,000 | 628,795,000 | 2,226,790,000 | 30.2029378612% | 28.2377323412% | 196.520552 bp |
| Bank of America N.A. / 480228 | 608,067,000 | 593,278,000 | 1,983,484,000 | 30.6565114717% | 29.9109042473% | 74.560722 bp |
| Wells Fargo Bank N.A. / 451965 | 417,255,000 | 417,129,000 | 1,554,614,000 | 26.8397814506% | 26.8316765448% | 0.810491 bp |

In each case the corrected FDIC `DEPNIDOM × 1,000` also equals the same bank's `RCON6631` in its original Call Report. Domestic-only sample banks are unchanged. No holding-company figures were substituted for legal-bank figures.

FDIC's Q2 2026 public financials list three actual form-031 CBLR electors: Bank of the Orient (RSSD 777366), Banesco USA (3402913), and Cross River Bank (3783313). Their reports were **not prepared** on the public site during this read-only audit. Therefore the 031 CBLR fix has an official-form mapping regression and a real affected-population check, not a claimed live before/after validation of these banks' original XML.

## Alliance Bank screenshot

The supplied screenshot is **arithmetically correct** for Alliance Bank, Francesville, Indiana, RSSD 493741, June 30, 2026. Exact Call Report USD values:

| Portfolio component | MDRM / calculation | Exact USD |
|---|---|---:|
| Total domestic loans and leases | RCON2122 | 325,761,000 |
| CRE portfolio grouping | RCON1460 + RCONF160 + RCONF161 | 139,874,000 |
| Construction and land | RCONF158 + RCONF159 | 23,532,000 |
| Residential mortgages | RCON1797 + RCON5367 + RCON5368 | 28,120,000 |
| C&I | RCON1766 | 31,311,000 |
| Consumer | RCONB538 + RCONB539 + RCONK137 + RCONK207 | 532,000 |
| Other loans and leases | Total minus five displayed categories | 102,392,000 |

CRE consists of $39.996m multifamily, $38.107m owner-occupied nonfarm nonresidential, and $61.771m other nonfarm nonresidential. Construction is separate. This is **not the supervisory CRE concentration definition** and no regulatory CRE/capital concentration ratio is presented.

Alliance's “other” is independently explained by $54.727m farmland (`RCON1420`) + $46.256m agricultural production (`RCON1590`) + $1.409m state/local obligations (`RCON2107`). The amounts exactly reconcile; they are not an unexplained $102m error.

There is a **$1,000 discrepancy within the filed source**: RC-C `RCON2122` is $325.761m, while RC `RCONB528` is $325.762m and `RCON5369` is zero. This is within the existing disclosed $2,000 reconciliation tolerance. FDIC `LNLSGR` follows $325.762m. The exposure view correctly preserves the filed RC-C total; no invented adjustment or unearned-income explanation is applied (`RCON2123` is zero).

[Original hash-pinned Alliance XBRL](https://secedgarterminal.com/api/banks/source?rssd=493741&period=2026-06-30&hash=50d7154f08f7b7e7a6ccc3acbfd520add1c7c2c01b22be6a629df658d3b216e9)

## Coverage and independent method

The sample spans two CBLR/community banks (Alliance and Bedford Federal Savings Bank), a domestic 041 risk-based bank (First Internet Bank of Indiana), and three consolidated 031 banks (Wells Fargo, JPMorgan Chase Bank, Bank of America). Each has four periods: 2025-09-30, 2025-12-31, 2026-03-31 and 2026-06-30.

- Downloaded **24 original retained XBRL documents**, independently verified their SHA-256 against the public metadata, and parsed them with Python's ElementTree rather than the application parser
- Compared an independent explicit official-form mapping to every live core metric: **840/840 outcomes match** (788 numeric values and 52 appropriate unavailable/not-applicable values)
- Independently rebuilt credit composition/performance, deposit composition/timing, FHLB timing, securities cost/fair-value gaps and securities timing: **1,452/1,452 outcomes match** (1,444 numeric values and 8 unavailable values)
- Retrieved a separate official FDIC sample for all six banks and reproduced ROA, NIM, net charge-offs, noncurrent loans, leverage, total risk-based capital and efficiency from the FDIC dictionary's explicit numerator and denominator fields
- Of **48** live peer comparisons, **45** match; the three mismatches are the domestic deposit-share bug above. All 48 corrected normalization results pass regression tests
- Cross-checked quarterly earnings from consecutive same-year YTD inputs; Q1 equals YTD, Q2 and Q4 subtract the immediately preceding YTD; Q3 2025 remains unavailable because Q2 2025 is outside retained history

The [machine-readable evidence ledger](audits/bankscope-2026-09-30.json.gz) includes every bank/date, exact source URL/hash, original submission text, MDRM codes, raw USD/pure facts, XBRL contexts and precision, independently expected values, observed live values and pass/fail outcomes. FDIC records include original fields, index timestamp and response hash. It records the **pre-deployment** live observations; it is not rewritten to pretend the fixes were already live.

### Definitions and boundaries verified

- Monetary XBRL is USD; source `decimals` is precision, not a scale factor. FDIC money is USD thousands; published FDIC and UBPR ratios are already percentages. Raw Call Report capital pure fractions are multiplied by 100
- RC-C loans include HFI and HFS before allowance, net of unearned income; allowance coverage uses HFI, not total loans
- Total equity `G105` and attributable bank equity `3210` remain distinct. Neither is substituted for regulatory CET1 or Tier 1
- Standardized capital amounts/ratios remain separate from advanced-approach risk-weighted assets; CET1 selects exactly one applicable column
- All **24** reported leverage ratios independently reconcile to Tier 1 divided by RC-R adjusted average leverage assets (`RCFAA224` or `RCOAA224`), within the official four-decimal-place ratio precision. This is not ending assets, book equity or the ROA denominator
- FDIC `ROA = NETINCA / ASSET5 × 100`; `NIMY = NIMA / ERNAST5 × 100`; `NTLNLSR = NTLNLSA / LNLSGR5 × 100`; `NCLNLSR = NCLNLS / LNLSGRJ × 100`; `EEFFR = EEFF / IEFF × 100`. Average-asset and earning-asset denominators are preserved, not replaced by endpoint averages or ending balances
- Alliance has $8k YTD gross charge-offs and $10k recoveries: net **−$2k**, annualized **−$4k**, divided by $320.619m average loans gives **−0.001247586699478197%**. The negative sign correctly means net recoveries
- On 031, domestic loan composition is not confused with consolidated C&I/consumer past-due balances. No cross-scope delinquency ratio is calculated
- Past-due accruing and nonaccrual buckets remain separate. Brokered/uninsured deposit overlays are not extra composition slices. FHLB and time-deposit overlapping memoranda are not double-counted
- Securities valuation gaps retain their signs and gross HTM cost. Maturity/repricing bases are distinct from other-MBS expected-life buckets
- The pre-existing narrow FFIEC YTD-context exceptions (`JJ34` and `HK14`) are accepted only with independent balance reconciliations; no general duration-to-instant substitution was introduced
- BankScope supports YTD and standalone-quarter flows, **not TTM**. Published annualized YTD FDIC/UBPR ratios are not de-accumulated into quarters

## Reproduction and tests

```sh
python scripts/audit-bankscope-accuracy.py --fetch \
  --capture-dir /tmp/bankscope-audit-repeat \
  --output /tmp/bankscope-audit-repeat/ledger.json
node --test tests/bankscope*.test.js tests/bank-pilot.test.js
```

The audit script makes only bounded public GET requests (three concurrent at most). It never admits banks to preparation, contacts the authenticated FFIEC API, changes a database or reads credentials. Omitting `--fetch` replays the saved responses. Future source amendments, quarter rollover and deployed fixes can legitimately change a rerun's results.

Regression coverage includes actual-source excerpts reconstructed from the independent ledger for all 24 bank/quarters, all six official FDIC rows, the 031 election prefix, missing-domestic-value behavior, provider request fields, quarterly flows, capital denominator identity, snapshot version isolation, and SQL migration-chain rehearsal. The PGlite test applies the original checked-in bank migrations and current prepared/chunked payload logic before exercising the version change. Existing auth/RLS, worker fencing, queues, immutable source downloads and cache/cost controls remain intact.

## Rollout and remaining verification

1. Apply the forward history-version migration before the application release. It preserves existing function identity/ACLs, changes two exact guarded history model-filter clauses, and adds a version-gated retained-source repair to the existing worker begin operation; prepared/chunked read paths and grants are unchanged
2. Release code with peer model v3. The existing manifest gate withholds all v2 payloads from v3 clients, showing preparing rather than relabeling old values. The bounded worker notices the version mismatch even for fresh snapshots and prepares one retained quarter per run
3. Wait for all four retained quarters to publish v3. History is restricted to the selected snapshot's model, so mixed-version historical comparisons remain gaps during refresh. Old clients may finish pinned v2 requests during rolling deployment; those snapshots are not mutated
4. Recheck the three corrected live ratios and model metadata, then quarter history, exact source disclosures and cache freshness. Current public API/browser/CDN responses have short bounded freshness windows; they must expire or refresh before claiming live correction
5. Each v3 worker begin requeues at most 16 existing old-version, retained-history form-031 reports with normalized metrics and terminal jobs whose submission identity still matches the retained source. It reparses all such 031 reports rather than guessing CBLR eligibility from XML text. Current v3 reports, domestic forms, raw-source parsing failures, active jobs, and jobs tracking another amendment are excluded. The existing bounded worker reuses retained XML, preserving its hash and retrieval time. Old workers cannot initiate this repair; during a rolling deployment they could still consume an already-queued item, so verify the final parser versions after old workers have drained. The three public FDIC 031 CBLR examples were not prepared during this audit

This is a six-bank, four-quarter source audit, not a census of every institution or every historical taxonomy. Original XBRL was read from the site's retained hash-pinned copies, not freshly downloaded from authenticated CDR; official FDIC financials and official blank forms provide independent cross-checks. Historical source submissions may have been amended. No production mutation, push or deployment was performed as part of this audit subtask.
