# Institutional manager research in Funds

The Funds workspace has two reporting sources. N-PORT identifies a registered fund portfolio and its series/class; Form 13F identifies an institutional investment manager by CIK. These identities and their denominators are kept separate.

Open `/fund?view=13f`, search a legal name or CIK, and select an explicit filer. A manager view can retain `managerCik`, `managerPeriod` (calendar quarter end), and `managerView` (`overview`, `holdings`, `changes`, `history`, `markets`, or `filings`) in its URL. Global search links verified 13F holdings filers to this workspace, and the Filings page links directly from its latest 13F report.

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

Requests and responses are bounded, repeated requests coalesce, and a bounded instance cache plus CDN caching reduces repeated source downloads. Partial or failed responses stay retryable. Prepared reports and evidence use the existing private Supabase cache; no new database schema, credential or paid service is required.

The four featured managers are examples and a small scheduled preparation cohort, not an access list. Any positive SEC CIK can retrieve its current public 13F reports on demand; a successful complete report enters the same shared cache and public-summary path. Name discovery searches SEC filer metadata, prefers holdings reporters over notice-only entities when name relevance ties, and labels notices separately. A notice's referenced managers can be opened directly without treating its absent holdings as a zero portfolio.

Each expired or explicitly refreshed snapshot checks current SEC submissions. It selects the latest reporting quarter, includes the relevant amendment chain, and reuses verified accession inputs. Current-quarter retrieval only requires archives capable of affecting that quarter; unrelated old archives remain available through the filing browser and cannot block a healthy current report. Missing recent 13F metadata triggers bounded discovery through the verified archive manifest.

Transient source failures receive one document/search retry within the existing job deadline. GET/HEAD coordination failures can retry within the transport's existing attempt budget, reacquiring the same shared SEC permission each time. Provider cooldowns, identity errors and unsupported evidence remain explicit failures. Invalid XML does not masquerade as an upstream outage eligible for a stale fallback.

Large information tables may contain repeated security rows for multiple included managers. The loader accepts up to 24 MiB per XML document, 40 MiB across documents, and 100,000 source rows while keeping the 20,000 distinct-position limit. Every source row remains included in reconciliation and aggregation. SEC presentation stylesheet instructions are ignored before the XML root and never fetched or executed. Existing shared storage limits remain unchanged. The September 2026 review verified BlackRock's 23 MB June table: 49,968 source rows aggregate to 5,696 positions; the parsed filing and snapshot fit the existing compressed cache.

## Prepared cache and public summaries

The production cache stores one complete 13F holdings body per manager and reporting quarter. A compact `LATEST` pointer binds that body to its source-chain hash, data hash and original check time. Latest and exact-quarter interactive readers receive the same complete holdings; no positions are truncated for storage. Parsed accession inputs remain reusable for amendment checks. Metadata freshness is one hour, while a complete snapshot can remain available for seven days with an explicit stale label after that hour. A refresh checks current SEC metadata and reuses already validated accession documents.

`edgar.13f-snapshot.v2:production` uses the existing bounded snapshot storage family, with seven-day retention. Its latest pointer is limited to 16 KiB and the single quarter body to 24 MiB; no public-summary cache family or second holdings body is introduced. Existing v1 records are a read-only fallback only when the corresponding v2 record is confirmed absent. They retain their original 24-hour observation window and storage expiry. Errors, corrupt v2 records and reads do not promote, renew or resurrect older results.

After the complete portfolio reconciles, source preparation adds a compact public summary to the latest pointer. The digest binds the projection to the manager, reporting period, original check time and complete body/source-chain hashes. Public latest reads usually download only this pointer instead of decompressing and validating every holding. Exact-quarter selections, older pointers and unusually large source chains retain the complete validated read path, preserving every SEC link and coverage limitation. A failed newer publication may leave the previous complete public summary available with its original dates; it never advances its freshness.

Discovering incomplete newer evidence invalidates the latest pointer before an affected quarter body, so public summaries cannot conceal a successful body invalidation. Incomplete new quarters invalidate latest independently of an older exact quarter. Invalidation preserves existing expiry, and reads never extend retention, initiate preparation or publish data.

Public research HTML is available at `/fund/{ticker}` and `/fund/manager/{cik}`. The corresponding read-only endpoints, `GET /api/v1/funds/{ticker}?accession=…` and `GET /api/v1/managers/{cik}?period=…`, project prepared portfolios into compact summaries with at most ten positions, reporting/filing/check dates, coverage, freshness and original SEC links. Omit the selector for prepared latest data; an N-PORT accession pins one filing, while a 13F quarter retains its assembled public amendment chain. The full net-assets or reported-13F-value denominator remains in every weight; top-ten display never rescales it. N-PORT missing, zero and negative figures and 13F options and confidential omissions remain distinct.

Public summary reads do not fetch SEC documents, initiate preparation or save another holdings copy. Missing prepared data returns HTTP 503 with a 60-second retry hint and does not mean that no filing exists; the interactive workspace can prepare the selected research. Valid prepared summaries return HTTP 200 with an explicit `stale` flag and a 60-second shared cache lifetime. Invalid or ambiguous selectors return HTTP 400. The response contract is documented in `/openapi.json`.

## Company research and portfolio history

Holding names open a company research drawer from the overview, holdings table, quarterly changes, and history view. The server reopens the actual manager/quarter/security row before resolving a company. For a position absent from the current quarter, the drawer uses the previous quarter that actually disclosed it.

Company identity uses exact CUSIP evidence in structured SEC Schedule 13D/G cover documents, then verifies the issuer CIK against SEC submissions. Search-result reporting-person CIKs and issuer-name guesses are not company identity. Tickers are issuer-level aliases, not a guaranteed symbol for the selected security class. Conflicting, stale, or missing evidence stays unresolved; fund and principal-amount securities are kept separate. Option and depositary-receipt views describe the underlying issuer.

Verified issuers show current annual SEC financial extracts, financial source links, and recent company filings. The company financial cutoff is separate from the historical 13F quarter. Missing or unsupported XBRL concepts remain unavailable. Financial values are not inferred from the manager's reported holding value.

`GET /api/fund-13f/company?cik=…&period=…&key=…` supplies this drawer. Identity evidence is discovered on demand with bounded SEC requests and a bounded cache; no manual CUSIP-to-ticker map is introduced.

The Portfolio history view loads 4, 8, or 12 calendar quarters ending at the selected report. Separate synchronized charts show concentration, disclosed position count, and total reported value. A selected holding adds report share, quantity, and value history, first observation within the loaded window, and repeated changes across comparable adjacent reports.

`GET /api/fund-13f/history?cik=…&period=…&keys=…` returns one compact quarter projection with at most 32 explicitly requested security keys. Two browser workers load these progressively. Full historical holdings tables are not retained in the browser. Failed quarters stay retryable; missing reports and incomplete evidence remain visible gaps. An unrequested position never becomes a zero. Amendments use the currently available public filing sequence for each quarter, not a reconstruction of what was known on quarter end.

History charts use zero-based axes, separate units, keyboard quarter inspection, and exact-value/source tables. Manager, reporting-quarter, and security identities are checked again before data reaches the chart or company panel.

## Market connections

The Market connections view links actual 13F securities to current issuer disclosures and related CFTC markets. It starts with the 20 largest disclosed positions, reports coverage as it progresses, and lets the user continue, scan all holdings, pause, or retry. A missing match, unverified issuer, missing filing, partial source retrieval, and an unscanned holding remain different states.

The progress counter and bar describe the selected review scope, initially 20 holdings. The full report count and the share of disclosed value covered by filing reviews remain visible separately. A large report does not automatically start thousands of SEC requests.

`GET /api/fund-13f/market-connections?cik=…&period=…&key=…` verifies the manager, reporting quarter, exact security, and SEC CUSIP-to-issuer proof. It then loads disclosures directly by verified issuer CIK. An inactive or missing trading symbol does not block a valid issuer; a ticker alias never substitutes for CIK identity. The source reader uses the latest eligible complete annual report and at most one newer complete 10-Q, with bounded history search and source-integrity caches shared with company exposure research.

Adding `prepared=1` and up to 20 repeated `key` parameters reads completed connections together. This path loads the selected manager report once and checks the shared cache; it performs no issuer or disclosure discovery. Each prepared result is bound to the current exact security, reported value and quantity, portfolio denominator, coverage and source chain. An amendment that changes those inputs prevents reuse. The browser validates the returned subset, displays it immediately, and queues only missing reviews. A failed or timed-out prepared lookup falls back to ordinary bounded requests.

Completed connections use `edgar.13f-market-connections.v1:production` in the existing research cache, with a 1 MiB record limit and at most six hours of freshness measured from the oldest underlying check. No-match, missing-filing and unresolved results have shorter lifetimes. Incomplete research is not retained as a completed review. Exact-CUSIP ownership-cover evidence is separately reusable across managers under `edgar.13f-issuer-evidence.v1:production`, limited to 128 KiB and six hours from its original observation. Every holding still passes its own issuer-name/security checks; failed or conflicting discovery does not become persisted issuer proof.

The source-text cache accepts verified CIK selections as well as ticker selections, so Funds disclosures use Supabase across server instances. Its derived in-process cache is bounded to 16 MiB and retains the original manifest-check expiry. Reads do not renew source freshness. These caches fill on demand and share existing storage quotas; they add no scheduler or paid cache service. Refresh reloads the selected reviews through the current source freshness policy and does not force-download every SEC document.

Each market connection belongs to the specific supporting SEC passage. Named benchmarks and related proxies are labeled separately. Generic interest rates, unspecified currency pairs, Brent, regional gas, and other unsupported drivers retain their SEC evidence without an unrelated futures contract. Later qualifying or negative passages remain visible beside earlier connections. Filing selection is current research, not a reconstruction of disclosures available at the historical 13F quarter end.

Associated holdings are deduplicated by security key within each market and across the headline linked total. Multiple business channels and repeated passages do not increase their value. Different share classes, stock, PUT and CALL positions stay separate; option values describe the underlying securities and are never signed as measured positive or negative exposure. Percentages use the full reconciled public information-table value, including unscanned and unresolved positions in the denominator. A partial scan never renormalizes the portfolio. Percentages are withheld when the selected public report is incomplete. Contracts overlap, so market percentages are not additive.

Only the selected CFTC chart is loaded. The contract, report family, trader category, futures-only basis, report date, history window and individual observations are validated by the existing prepared-data client and chart model. The 13F quarter, issuer filing dates and CFTC position observation dates are displayed separately. Aggregate CFTC trader positioning does not establish company futures positions, hedge coverage, economic sensitivity, trader intent or expected returns.

Requests use the existing SEC dispatcher and cached sources. Two browser workers load missing holding connections progressively; individual responses are bounded to 1 MiB and prepared batches to 2 MiB. Request cancellation stops the active scan, and retry preserves completed evidence. The gateway explicitly admits the two bounded evidence namespaces while retaining production workload authentication.

## Official references

- [SEC Form 13F frequently asked questions](https://www.sec.gov/divisions/investment/13ffaq)
- [SEC Form 13F and instructions](https://www.sec.gov/files/form13f.pdf)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [CFTC Commitments of Traders reports and methodology](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm)

These rules apply to the disclosed information tables. They do not imply that SEC staff have verified the filer's assertions.
