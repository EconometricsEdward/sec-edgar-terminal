# Institutional manager research in Funds

The Funds workspace has two reporting sources. N-PORT identifies a registered fund portfolio and its series/class; Form 13F identifies an institutional investment manager by CIK. These identities and their denominators are kept separate.

Open `/fund?view=13f`, search a legal name or CIK, and select an explicit filer. A manager view can retain `managerCik`, `managerPeriod` (calendar quarter end), and `managerView` (`overview`, `holdings`, `changes`, or `filings`) in its URL. Global search links verified 13F holdings filers to this workspace, and the Filings page links directly from its latest 13F report.

## Evidence and interpretation

- The SEC submissions feed and verified archive manifest establish which accessions belong to a manager. Each filing's document index establishes the cover and information-table sources.
- A snapshot is a quarter-end disclosure, not a current portfolio. Its filing and retrieval dates are shown separately.
- Reported value is the sum of the included 13F security values, not assets under management or NAV. Portfolio shares and concentration use that disclosed denominator.
- Older filings use values in thousands of dollars. The amended form used from January 3, 2023 reports values in dollars. The filing date controls this interpretation, including late amendments to older periods.
- Restatements and amendments adding holdings have different meanings. The selected period retains its filing chain and source coverage; uncertain or incomplete snapshots cannot establish position entries and exits.
- Economic positions retain CUSIP, share class, put/call designation, and share/principal units. Options remain distinct, and their reported values describe underlying securities rather than option premiums.
- Changes describe reported quantities, values, and portfolio shares. They do not establish executed purchases or sales, cash flows, investment performance, or split-adjusted trading activity.
- Cash, short positions, and many other assets are absent from 13F. Confidentially omitted holdings and combination reports can further limit the visible portfolio.

## Retrieval and failure handling

`GET /api/fund-13f?cik=0001747057&period=2026-06-30` resolves a manager and selected period; omitting `period` selects the latest available reporting quarter. The endpoint uses the shared SEC transport and its production dispatch coordinator. Preview isolation is preserved.

Requests and responses are bounded, repeated requests coalesce, and a bounded instance cache plus CDN caching reduces repeated source downloads. Partial or failed responses stay retryable. No new database schema, credential, shared-cache namespace, or paid service is introduced.

## Official references

- [SEC Form 13F frequently asked questions](https://www.sec.gov/divisions/investment/13ffaq)
- [SEC Form 13F and instructions](https://www.sec.gov/files/form13f.pdf)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

These rules apply to the disclosed information tables. They do not imply that SEC staff have verified the filer's assertions.
