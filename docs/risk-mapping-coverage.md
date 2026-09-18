# Risk mappings and source coverage

The Risk workspace uses shared mappings across supported issuers. A missing
value remains unavailable when its reporting scope or period cannot be verified.

## Financial balances

- Current debt prefers a reported current total. Otherwise it requires current
  long-term maturities and separately reported short-term borrowings.
- Debt and debt-with-lease concepts retain their reported scope. Including-current
  totals are never treated as noncurrent balances or added to current maturities.
- Commercial paper and other short-term borrowings can be combined when both
  are reported separately; an unresolved broader notes-payable balance blocks a
  narrower commercial-paper substitute.
- Generic notes payable requires evidence of current classification and a
  separate current-maturities line before it can be used as a component.
- Derived balances use one common filing and one reporting date. A repeated
  amount can be rebound to a common filing only when every component is unchanged.
- Current and noncurrent investments retain source scope. Standard investment
  totals can include nonmarketable assets; investment balances are not cash.
- A generic marketable-securities concept requires explicit balance-sheet
  section evidence before current/noncurrent classification.
- Total liabilities may use explicit current and noncurrent subtotals. Parent
  equity is not subtracted from assets to infer missing liabilities or NCI.

## Filing coverage and company history

`riskProfileSources.js` compares the aggregated SEC feed with the latest eligible
10-K or 10-Q. When needed, it reads at most one primary document, checks the
registrant, fiscal focus, report date and consolidated standard USD contexts,
and retains exact fact anchors. Contradictory same-filing aggregate values are
not overwritten. Fetch failures retain existing verified data and report the gap.
Repeated facts at different declared precision may retain the most precise
reported amount only when their rounding intervals agree; values are not averaged.

Predecessor histories are joined only through the reviewed
`SEC_EVIDENCE_CONTINUITY` registry. Original registrant and filing provenance are
preserved for every observation. Ticker/name similarity is not a join rule.

## Revenue and ownership

Standard revenue concepts are shared across issuers. Reviewed extensions use
an explicit issuer/namespace/context mapping. BAC's FTE segment revenue keeps its
own denominator and signed All Other reconciliation; it is never presented as
GAAP revenue or an all-positive composition.

Ownership responses permit omitted or null predecessor metadata for ordinary
issuers. Populated predecessor records and reported SEC source links remain
validated. Client regression tests exercise JSON-serialized server projections.

## Limits and verification

Classification evidence from the latest filing does not imply classification
for every historical observation. Unsupported dimensional-only balances are not
summed without a verified complete reconciliation. An absent operating-income
fact is not silently replaced with a different definition of EBIT.

Tests cover source identity, reporting periods, classification boundaries,
conflicting facts, debt overlap, signed revenue reconciliation, source links,
cache versions, and ordinary/predecessor ownership responses. Live publication
checks must include both API data and the corresponding rendered controls.
