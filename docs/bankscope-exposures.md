# BankScope Exposures

The Exposures view enriches existing validated reports with Credit, Funding and Securities lenses. It works for any prepared FFIEC 031/041/051 bank and uses the existing bank directory and preparation flow. It does not require a schema migration, new ingestion jobs or an FFIEC download.

## Data and source fidelity

`GET /api/banks/exposures?rssd=451965&period=2026-06-30` reads the selected bank's metadata through the existing authenticated gateway. It reads original XBRL pinned to each validated report's SHA-256, verifies identity, date, form and byte hash, then normalizes quarter-end USD facts. The in-process cache is bounded to 48 immutable source versions for five minutes; failures are evicted. Selected-quarter failures are visible. Historical failures remain gaps and can be retried. Partial responses are not cached by the CDN. No source/provider credentials or raw XML are sent in this response.

Only the four currently available report dates are eligible. History stops at the chosen date. Source mappings, exact values, context references and original hash-pinned downloads are available in closed disclosure panels. Missing fields stay unavailable. Charts do not connect across missing quarters. Ratio/growth helpers require a positive denominator.

## Mappings

Reviewed against the June 2026 official forms:

- [FFIEC 031](https://www.ffiec.gov/resources/reporting-forms/ffiec031)
- [FFIEC 041](https://www.ffiec.gov/resources/reporting-forms/ffiec041)
- [FFIEC 051](https://www.ffiec.gov/resources/reporting-forms/ffiec051)

| Lens | Source | Treatment |
| --- | --- | --- |
| Loan composition | RC-C I, RCON | Construction F158+F159; CRE 1460+F160+F161; residential 1797+5367+5368; C&I 1763+1764 on 031, 1766 on domestic forms; consumer B538+B539+K137+K207. Other loans/leases is total 2122 less the five named groups. A negative residual is withheld. |
| Loan performance | RC-N | Matching real-estate categories are domestic on all forms. C&I/consumer performance is consolidated on 031, explicitly labeled separately from domestic portfolio balances. No cross-scope delinquency ratio is calculated. 30–89 and 90+ day values remain separate from nonaccrual. |
| Deposit composition | RC-E, RCON | 2215, 6810, 0352, 6648+J473, J474. Brokered 2365 and uninsured 5597 overlap these categories and are never included as additional slices. Foreign deposits RCFN2200 are shown separately on 031. |
| Time-deposit timing | RC-E M3.a and M4.a | HK07+HK12, HK08+HK13, HK09+HK14, HK10+HK15. Do not add the overlapping remaining-maturity memoranda HK11/K222. |
| FHLB timing | RC-M 5.a(1) | F055–F058, RCFD on 031 and RCON on 041/051. No addition of overlapping short-maturity/structured-advance memoranda. |
| Securities valuation | RC-B 8 | HTM cost 1754/fair 1771; AFS cost 1772/fair 1773. Use RCFD on 031, RCON on domestic forms. Gap = fair value − amortized cost, without implying realized losses or capital deductions. HTM cost is before allowance. |
| Securities timing | RC-B M2 | A549–A554 and A555–A560 have six maturity/repricing buckets. Other MBS A561/A562 use expected average life and remain separate. Timing uses HTM cost + AFS fair value and excludes nonaccrual securities. |

Uninsured deposits are the bank's RC-O estimate including accrued and unpaid interest. The June 2026 forms require it for the $1 billion prior-June asset test; missing disclosures are not estimated or assumed zero.

CDR consistently supplies RCONHK14 in a calendar-YTD context in the inspected reports. A narrow exception accepts that balance only when the candidate and HK12/HK13/HK15 are valid nonnegative USD facts for the same bank/date and their sum reconciles to independent total J474 within $3,000 (four rounded inputs plus total). Lineage discloses this context and corroboration. It never turns duration contexts into quarter-end balances generally.

The three selected-fact XML fixtures preserve original public XBRL values, units, and contexts for Wells Fargo (031), First Internet Bank (041), and Alliance Bank (051), Q2 2026. Original retained source hashes are respectively `66c6bb1b453ded7050001a79a89c472e2ff77780ee051d665160364ba5786433`, `e0fc591aa0812f63a6e9c1e6cd51f16f98054c6229e4b1de5831403bcc3e270b`, and `50d7154f08f7b7e7a6ccc3acbfd520add1c7c2c01b22be6a629df658d3b216e9`. The reduced fixtures intentionally have different hashes.

## UI and verification

Shareable state: `view=exposures&exposure=credit|funding|securities&segment=construction|cre|residential|commercial|consumer|other`. Invalid lens/segment values fall back to Credit/CRE. Other existing views retain their own parameters.

Charts use visible scope labels, consistent category colors, zero-inclusive dollar axes, keyboard-focusable quarter values, exact-value tables, and responsive layouts. Details and methodology start closed. SVGs require no additional charting dependency. Scope differences are visible even when explanatory text is collapsed.

`node --test tests/bankscope-exposures.test.js` verifies real form mappings and reconciliations, missing/zero behavior, source-basis and unit errors, scoped exceptions, signed valuation gaps, API validation, identity/hash pinning, coalescing/expiry, retryable failures and partial history. Existing bank view tests protect the original navigation and calculations.
