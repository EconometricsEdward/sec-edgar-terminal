# BankScope peer benchmarks

Compare → Peer benchmarks automatically matches a bank without needing its peers' individual Call Reports to have been prepared. Compare → Selected banks retains the four-bank chart/table workflow. The `panel` URL parameter preserves the selected mode; older links with selected peers continue opening Selected banks.

## Sources and refresh

- FDIC BankFind financials: https://api.fdic.gov/banks/docs/ and its `risview_properties.yaml`. Source amounts are USD thousands; published ratios are percentages. Fetch the complete requested quarter, validate the reported total and unique RSSDs, then join RSSD **and** certificate against that quarter's FFIEC reporting panel. Missing inputs stay null. Coverage is the identity-verified intersection, not every historical or uninsured institution.
- Complete snapshots publish atomically after fenced batches of at most 500 rows. The previous complete universe remains readable on failures. The five-minute bank cron prepares one due quarter per run and checks completed quarters daily. Retain two complete snapshots per quarter. Database reads coalesce per-quarter promises for five minutes; public GETs never ingest.
- FFIEC `RetrieveUBPRXBRLFacsimile` uses the existing server credentials, signed Vercel/Supabase gateway, worker lease and shared five-second/600-hourly/2400-daily request gate. Preparing a bank queues its available recent UBPR quarters. Active banks refresh weekly; work remains inside the four-quarter window. Original XBRL, retrieval date and SHA-256 are retained; the source endpoint requires the exact version hash.
- The bank XBRL feed contains **bank ratios**, not official peer averages or percentile ranks. These reference ratios are displayed separately, with a link to the full FFIEC reports. Do not label BankScope cohort statistics as official UBPR statistics or inject UBPR values into the FDIC distributions.

## Model `bankscope-peers-1`

Require complete lending and funding inputs; exclude the subject. Rank at most 30 candidates in an asset band of ¼–4×, widening to ⅛–8× when fewer than ten qualify. Always disclose the wider band and retain the actual cohort count.

Distance = 40% size + 35% lending + 25% funding:

- Size = `min(1, abs(log2(peer assets / subject assets)) / 3)`.
- Lending = 75% total-variation distance across real estate, C&I, consumer and other loans, plus 25% absolute loans/assets difference.
- Funding = mean absolute difference across deposits/assets, noninterest/domestic deposits and brokered/domestic deposits.

Performance outcomes do not influence matching. Raw source values, broad categories and strict identity joins are intentional; specialty models, tax treatment and foreign-office activity still require analyst judgment.

FDIC distributions use ROA, NIMY, ROE, RBC1AAJ, NCLNLSR and NTLNLSR. Use valid values only; at least five are required. Quartiles use linear interpolation. Percentiles use midranks: `(below + 0.5 × equal) / valid count × 100`. The subject is excluded. No trimming, risk rating or higher-is-better coloring is applied.

UBPR reference mappings use Summary Ratios page 1 of the official v187 guide: UBPRE013, UBPRE018, UBPRD486, UBPR7414 and UBPRE019. Computed UBPR ratios are already percentages, unlike raw Call Report pure fractions. Require the correct RSSD, instant date, unit, report date fact and positive bank asset fact; reject conflicting duplicates and unsafe XML.

## Validation

`tests/bankscope-peers.test.js` covers source completeness, source identity, null/zero handling, matching dimensions, unbiased outcome selection, tie ranks, quartiles, small cohorts, UBPR scaling and lineage, cached source reprocessing, API validation, coalesced reads, SQL atomic publication, lease enforcement, shared quotas and anonymous-access denial. The UBPR fixture is an excerpt from Wells Fargo's official June 2026 document, retrieved September 25, 2026.
