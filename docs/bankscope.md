# BankScope

BankScope is the approved expansion of the original FFIEC pilot. It lives under Analysis at `/analysis/banks`, with legal-bank profiles at `/analysis/banks/{RSSD}`. Overview keeps the original template. Compare accepts up to four banks from the FFIEC directory and one reporting date; Trends displays quarter-end balances and either reported YTD or derived quarterly flows.

## Coverage and identity

The directory is built from FFIEC 031, 041 and 051 reporter panels for the four latest available quarters. Discovery is not limited to exchange-listed companies or the original three banks. Search matches legal name, RSSD, FDIC certificate, city and state. Identical names remain separate entities. RSSDs never become SEC tickers. Actual panel membership determines which periods a bank can prepare.

First complete discovery on September 25, 2026 found 4,445 distinct legal banks across four panels: 4,297 reporters for June 2026 (80 form 031, 934 form 041, 3,283 form 051), 4,336 for March 2026, 4,394 for December 2025 and 4,435 for September 2025. Counts change as FFIEC updates its panels.

## Calculation rules

- 35 metrics use form-aware schedules and item codes. Domestic forms use RCON balance-sheet and RCOA regulatory-capital items; form 031 retains its consolidated/foreign-office basis.
- Monetary XBRL values remain USD in storage and are displayed in millions. Ratios are pure fractions multiplied by 100. Source decimals describe precision and are not a scale multiplier.
- The CBLR election, RCOALE74, uses FFIEC's nonMonetary unit in real source files. Value 1 indicates CBLR. Missing risk-weighted assets, total capital and risk-based ratios then remain explicitly not required; the reported leverage ratio is retained. An unverified election cannot excuse missing capital data.
- Q1 flows equal YTD. Other quarters equal current YTD minus the immediately preceding same-year YTD amount. No cross-year subtraction or substitution is allowed. A missing prior quarter yields unavailable.
- Ratio changes use percentage points. Percentage growth needs a positive prior denominator. No growth is calculated between YTD periods.
- Comparisons use the chosen quarter for every bank; missing dates never fall back to a different quarter. N/A is distinguished from missing or unprepared data.
- Source records retain the original XBRL, SHA-256, reported submission timestamp, metric item codes, contexts, units, mapping version and validation checks. Selected metric lineage loads on demand; downloads are pinned to the displayed source hash.

## Preparation and operation

Public GET requests read stored data only. A bounded same-origin POST admits a verified RSSD to the queue and schedules a post-response worker. Every new bank shares prepared results with later visitors. `/api/cron/banks` runs every five minutes in production to recover interrupted work and perform daily panel/submission checks for recently requested banks. The existing CRON_SECRET authenticates the schedule; FFIEC credentials remain in existing Vercel server environment variables.

One database lease serializes workers. FFIEC requests are paced at least five seconds apart with conservative internal caps of 600/hour and 2,400/day, distinct from upstream limits. Admission allows 12 new banks/client/hour and at most 200 banks pending globally. Client identifiers are HMACs; raw IP addresses are not stored in the bank tables. Source versions are retained, and unchanged versions are reprocessed without an upstream download.

Directory publication uses 500-bank transactions to stay below the database's existing eight-second statement timeout. A quarter is marked fresh only after the last batch commits. Interrupted batches are safe to replay. Worker leases, retries, cooldowns and quotas are persisted. Review-required filings withhold unvalidated figures.

Bank tables are private, RLS enabled, and inaccessible to anon/authenticated roles. A narrow Supabase function validates signed Vercel OIDC tokens pinned to this project/team and forwards allowlisted operations to one service-only RPC. The old pilot write RPC is retired. `/bank-pilot` contains operations controls only on the protected feature preview and returns 404 in production.

## Verification fixtures

Fixtures contain selected facts from original FFIEC XBRL, including contexts, units and schema references. Full sources remain stored by hash.

| RSSD | Legal bank | Form | Q2 2026 framework | Full source SHA-256 |
| --- | --- | --- | --- | --- |
| 2758613 | First Internet Bank of Indiana | 041 | Risk based | e0fc591aa0812f63a6e9c1e6cd51f16f98054c6229e4b1de5831403bcc3e270b |
| 493741 | Alliance Bank, Francesville, IN | 051 | CBLR | 50d7154f08f7b7e7a6ccc3acbfd520add1c7c2c01b22be6a629df658d3b216e9 |
| 946274 | Bedford Federal Savings Bank | 051 | CBLR | 6466143358081bfcd07cc5d23b93d4dca793ef3f169d9ddd59bc7a3913491c3e |

The original three form-031 fixtures continue to reconcile. Tests cover actual source conventions, exact-quarter arithmetic, identity separation, API validation, durable admission and fencing, source reuse, partial directory batches and role restrictions. Live verification covers search → request → queue → original FFIEC data → validated UI, comparison, trends and source downloads.

## Official references

- FFIEC REST retrieval specification v1.10: https://cdr.ffiec.gov/public/Files/SIS611_-_Retrieve_Public_Data_via_Web_Service.pdf
- Reporting forms and instructions: https://www.ffiec.gov/resources/reporting-forms/ffiec031, https://www.ffiec.gov/resources/reporting-forms/ffiec041, https://www.ffiec.gov/resources/reporting-forms/ffiec051
- Vercel cron operation: https://vercel.com/docs/cron-jobs/manage-cron-jobs

## Current boundaries

This release provides four recent Call Report quarters, not unlimited historical backfill. Credit unions and institutions outside the FFIEC Call Report panels are outside this dataset. A bank legal entity differs from a listed holding company. The preparation queue is intentionally bounded; upstream outages or report validation failures remain visible instead of producing invented values.
