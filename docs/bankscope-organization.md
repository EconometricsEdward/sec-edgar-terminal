# Bank & Parent

`/analysis/banks/{rssd}?view=organization` adds a separate organization workspace.
`org=network` selects the bank footprint. URL state supports direct links, native
Back/Forward and reloads without another Call Report read. This view also works
before Call Reports are prepared.

## Identity and reporting scope

The FDIC institutions endpoint republishes NIC regulatory top-holder names and
RSSD identifiers (`NAMEHCR`, `RSSDHCR`). Its official field dictionary names NIC
as the source and warns that top-holder information is quarterly and some thrift
holding-company coverage is absent. This is a regulatory high holder, not a claim
about direct ownership, intermediate entities or the ultimate global parent.

Lookups use `FED_RSSD` **and `ACTIVE:1`**, not `RSSDID` (a different FDIC endpoint's
field). Wells Fargo demonstrates why: an RSSD-only query returns both a retired
certificate and the current bank with different parent RSSDs. More than one
active match, a mismatched RSSD, or a missing certificate fails closed.

Current structure is dated separately from historical Call Reports. No historical
ownership is inferred from the selected financial quarter. Missing and self-parent
identifiers are unavailable, not proof of an independent bank. Related institutions
must share the exact top-holder RSSD and be active; amounts are never aggregated.

Blue identifies the selected legal bank; violet identifies parent research.
FFIEC Call Reports, consolidated FR Y-9C, parent-only FR Y-9LP/Y-9SP, and SEC
registrant statements are separate research paths. NIC reports and full hierarchy
and history open at the official source. This release **does not ingest FR Y-9C
financial values or the full NIC dated relationship graph**. NIC's download site
rejected the development browser, so the implementation uses the documented FDIC
redistribution instead of inventing relationships or substituting financials.

The SEC directory supplies name candidates, not an RSSD-to-CIK crosswalk. Common
corporate abbreviations are normalized conservatively, exact normalized names
are required, share classes are grouped by CIK, and stale directories produce no
candidate. The UI labels this evidence and provides a registrant verification link.
Unmatched/private/unlisted parents can still be searched through the existing SEC
filer search, including by exact CIK. A missing ticker is not proof of no filings.

## Sources and request boundaries

- FDIC institutions: `https://api.fdic.gov/banks/institutions`
- FDIC locations: `https://api.fdic.gov/banks/locations`
- Field definitions: `https://api.fdic.gov/banks/docs/institutions_definitions.csv`
- NIC profiles: `https://www.ffiec.gov/npw/Institution/Profile/{rssd}`
- NIC reports: `https://www.ffiec.gov/npw/FinancialReport/FinancialDataDownload`
- SEC directory: existing shared `company_tickers.json` cache and SEC transport.

`/api/banks/organization` accepts only one `rssd` and an optional
`part=profile|network|sec`. Historical dates and arbitrary upstream paths are
rejected. Public source reads have a 12-second deadline, 2 MiB response bound,
complete-result validation, identifier checks, duplicate rejection, an eight-read
concurrency cap and one-hour bounded per-instance cache (96 entries). Concurrent
identical reads coalesce. Provider 403/429/503 responses trigger a one-minute local
cooldown. Empty matches are retained only one minute. Valid complete API responses
receive a 15-minute CDN lifetime; incomplete or degraded responses are not cached
publicly. Source release, retrieval clock and SHA-256 remain attached to results.

The component is dynamically imported. SEC discovery and office/group requests
load independently when relevant, so neither blocks the core bank-parent view.
Client request identities and aborts prevent cross-bank result races. The footprint
chart counts source-listed offices by state/location code; it is not deposit market
share or the full parent's footprint. All counts remain available in a table.

## Verification

`tests/bankscope-organization.test.js` checks current-vs-historical identity,
top-holder dates, missing/self parents, SEC candidate ambiguity and staleness,
complete office/group identities, source coalescing/expiry, partial provider
failure, input rejection and cache behavior. `bankscope-seo.test.js` includes
organization/network links and preserves the stable bank canonical.

Release checks: Wells Fargo (multiple related banks), First Internet (small
footprint/listed parent), Alliance (no exact ticker candidate), a bank without a
reported top holder, related-bank navigation, disclosure controls, SEC links,
source links, reload/Back/Forward and the existing bank financial views.
