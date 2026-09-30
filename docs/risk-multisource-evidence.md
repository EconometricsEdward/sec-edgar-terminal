# Risk evidence expansion

The Risk Profile keeps the existing SEC financial, funding, filing-note and CFTC positioning analysis. It adds the existing concise evidence briefing, an adjacent-period change table, and three evidence lenses: debt maturities, FFIEC bank regulatory reports (for banks), and funding/derivatives market context. Business Exposures remains the second main tab.

## Source and calculation boundaries

- Maturities use the original registrant's company-facts response already loaded by `/api/risk`. The existing validated extractor supplies one annual filing's six standard USD buckets and same-filing cash/annual flows. Predecessor histories are not combined into a successor's schedule. Current-quarter balances are not substituted into the annual comparisons.
- Missing buckets stay missing. Schedule concentration requires all six buckets. Thereafter is excluded from the largest annual bucket comparison, and elapsed periods remain historical scheduled principal. Indicative fiscal dates remain labeled.
- The change table requires adjacent dated observations and compatible values. Percentage changes are displayed in percentage points. TTM windows overlap.
- Bank directory matches require explicit legal-entity selection; no parent/subsidiary relationship is inferred from names. Only validated reports for the chosen RSSD and quarter supply values. CET1 and leverage percentages retain their native units. Brokered deposits use domestic deposits; loan allowance uses HFI loans; nonaccruals use gross total loans. No supervisory rating is inferred.
- Funding rates and Treasury fails come from the prepared New York Fed dataset. SOFR/TGCR spreads require the same date and convert percentage-point differences to basis points. Fails and swaps retain the provider's USD-million units before formatting.
- CFTC swaps notional and cleared share describe market-wide activity, not company exposure, liquidity, or potential losses. Existing COT company connections remain in the profile and exposure view. The CFTC rollback switch suppresses new derivatives reads.
- DTCC remains external provider references. The Risk page does not ingest or redistribute DTCC charts.

## Storage and request budget

No new database tables, migrations, buckets, scheduled jobs, raw-source archives, or issuer-market snapshots.

- `/api/risk?...&evidence=1` adds a compact maturity projection to the existing approved `risk-workspace-v9` disposable entry. Old entries upgrade in place; unchanged financial calculations retain the same version. The evidence query makes the new response distinct at the CDN. Normal/partial retention remains 900/60 seconds.
- `/api/risk/market-context` accepts no query parameters. The existing `/api/risk/context?source=...` contracts remain available for older clients. All tickers share one compact projection of the existing Market datasets. It retains at most 67 daily funding rows, 14 weekly fail rows and 16 observations for each of three swaps classes. A production sample was 12,671 bytes before compression.
- The projection has one in-memory cache entry, 60-second reuse, single-flight, and a 10-second partial/failure cooldown. The HTTP response reuses the CDN for 15 minutes; partial responses have a 30-second cache. It performs no upstream ingestion and no additional durable write.
- Bank and market code load only when the corresponding lens is opened. Bank data use the existing compact prepared context API, with four-quarter source metadata added, with no automatic preparation requests. Client reuse is in memory, limited to 12 entries with a 60-second maximum; pending bank/partial reads get 3 seconds. There is no polling, focus refresh, permanent browser history, or automatic retry loop.
- Risk never downloads the full multi-company Refinancing Wall to inspect one issuer. Charts use SVG and the existing keyboard/touch period inspector; no new chart dependencies.

## Verification

`tests/risk-evidence.test.js` and `tests/risk-context.test.js` cover source units, missing observations, schedule completeness/elapsed dates, bank identity/validation and denominator scope, quarter-specific source provenance, dated financial changes, original-registrant extraction, payload size and concurrent/failing shared reads. Existing reconciliation, cache, section-identity, lint, typecheck, SQL rehearsal and production build gates also apply.

Browser review should cover a corporate issuer, a bank and a broker; annual/TTM switching; evidence tabs and keyboard charts; bank search/selection/quarter changes; exports; mobile layout; and unavailable source states. Production checks should confirm the new API returns compact dated data and the evidence response contains the maturity projection.

The integration preserves the concurrently published RiskSignalDesk and source context APIs, while consolidating supplemental evidence into one selected lens. The old standalone panels remain compatible for already-open clients. Bank quarter selection uses the compact server-validated history instead of transferring full Call Reports.
