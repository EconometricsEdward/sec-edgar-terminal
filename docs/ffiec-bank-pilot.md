# FFIEC bank Call Report pilot

Private preview only, branch `feat/ffiec-bank-pilot`, path `/bank-pilot`. Production and other branches return 404. No public navigation, sitemap entry, automatic schedule, or production rollout is included. Vercel Deployment Protection must stay enabled on previews.

The current pilot identifies the three requested national banks by exact legal name in the FFIEC panel; no RSSD IDs are inferred from SEC parents or tickers. The first discovered four completed quarters are frozen in Supabase. Each batch retrieves at most three filings and checks the latest before progressing through history. Readers only query Supabase; only the explicit preparation form initiates ingestion. A stored report is never redownloaded during this pilot. Corrections can be re-parsed from the retained source rather than consuming API quota. A future amendment-refresh policy requires a separate reviewed change.

## Credentials and access

Only the Vercel server reads `FFIEC_CDR_BASE_URL`, `FFIEC_CDR_USER_ID`, and `FFIEC_CDR_TOKEN`. They are neither downloaded nor copied to another environment, and are absent from client code and logs. The URL must match `https://ffieccdr.azure-api.us/public/`. Upstream redirects are refused so credentials cannot be forwarded to another host. Error responses discard upstream message text. Existing Vercel workload identity authenticates a separate, narrow Supabase gateway; no Supabase service key is copied to Vercel. The production SEC gateway and its production-only rules are unchanged.

The new `bank-pilot-gateway` validates the Vercel issuer, audience, subject, signature, owner ID, project ID, preview environment, and token age. Supabase's legacy JWT wrapper is disabled because this function performs that custom OIDC verification. Anonymous requests fail with 401. It can call only `bank_pilot_operation`, whose operations are confined to the bank pilot tables. All four tables live in `edgar_private`, use RLS, and have no anonymous or authenticated-user grants. Its RPC is SECURITY INVOKER and executable only by service_role and the database owner.

## Official interface

Verified against FFIEC CDR-PDD-SIS-611 v1.10: https://cdr.ffiec.gov/public/Files/SIS611_-_Retrieve_Public_Data_via_Web_Service.pdf

GET operations use `UserID`, `Authentication: Bearer …`, `dataSeries: Call`, and method-specific headers, not URL query credentials:

- `RetrieveReportingPeriods`
- `RetrievePanelOfReporters` (`reportingPeriodEndDate`)
- `RetrieveFilersSubmissionDateTime` (`reportingPeriodEndDate`, `lastUpdateDateTime`)
- `RetrieveFacsimile` (`reportingPeriodEndDate`, `fiIdType: ID_RSSD`, `fiId`, `facsimileFormat: XBRL`)

FFIEC documents approximately 2,500 downloads per hour. This implementation is deliberately slower: one process-wide queue plus a shared Postgres lease, five-second request spacing, maximum 80 total pilot dispatches, three attempts for transient failures, exponential backoff, 25-second network deadlines, and persistent extend-only cooldowns. HTTP 429 and quota-related 403 halt the batch. Retry-After numeric/date values and quota-reset durations are respected. Unknown reset times receive a conservative one-hour cooldown. Authentication failures do not retry. No API quotas are consumed by the automated tests.

## Financial interpretation

Mapping source: https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC031_202606_f.pdf and the March 2025 FFIEC 031 form for historical continuity.

- XBRL monetary facts retain their USD unit; decimals describe accuracy, not scaling. The interface divides dollar values by one million for display.
- Income and charge-offs use calendar YTD contexts. They are not presented as discrete-quarter earnings.
- RC-C I item 12 (RCFD2122) covers loans held for sale and investment before allowance, net of unearned income.
- Deposits sum RCON2200 (domestic) and RCFN2200 (foreign).
- Total equity is RCFDG105, including noncontrolling interests. RCFD3210 is separately labeled bank equity.
- Securities sum net HTM, AFS debt, and readily valued non-trading equity. Trading assets are excluded.
- RC-N separates still-accruing past-due loans from nonaccrual loans.
- Capital uses the appropriate CET1 capital column and the standardized RWA/ratio basis. Advanced-approach RWA and ratios are not mixed in.
- FHLB advances sum the four RC-M maturity/repricing buckets; overlapping subtotals are excluded.
- Absent, nil, conflicting, wrong-context, or unsupported-unit facts remain unavailable.

The mapping registry is `src/utils/bank/metrics.js`. Each stored metric carries schedule, item, mnemonic codes, original values, XBRL contexts/units/decimals, reporting basis, formula if calculated, report date, RSSD, ingestion time, source hash, and mapping version. The unmodified XBRL is retained in the filing row. Submission dates retain FFIEC's original text because the API does not specify a timezone. Source hashes distinguish source versions; amendment sequence numbers are not invented.

## Reproducible checks

Run `node --test tests/bank-pilot.test.js` for identity, parsing, context, units, missing values, ratios, HTTP error handling, serial requests, repeat-read behavior, exact SQL duplicate/lease/RLS behavior, gateway claims, and preview guards. SQL tests run in the existing PGlite dependency and never connect to a live database. Run the existing project typecheck, build, and regression suite before preview publication.

A passing HTTP status is insufficient. Reports must contain the seven required validation metrics and reconcile balance sheet, loans, net interest income, and standardized capital ratios. Live source verification and the actual retrieved periods are recorded separately after ingestion; mock test identities are synthetic, never reported as verified bank IDs.
