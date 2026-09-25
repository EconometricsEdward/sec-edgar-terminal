# BankScope peer benchmarks

Compare → Peer benchmarks automatically matches a bank without needing its peers' individual Call Reports to have been prepared. Compare → Selected banks retains the four-bank chart/table workflow. The `panel` URL parameter preserves the selected mode; older links with selected peers continue opening Selected banks.

## Sources and refresh

- FDIC BankFind financials: https://api.fdic.gov/banks/docs/ and its `risview_properties.yaml`. Source amounts are USD thousands; published ratios are percentages. Fetch the complete requested quarter, validate the reported total and unique RSSDs, then join RSSD **and** certificate against that quarter's FFIEC reporting panel. Missing inputs stay null. Coverage is the identity-verified intersection, not every historical or uninsured institution.
- Complete snapshots publish atomically after fenced batches of at most 500 rows. The previous complete universe remains readable on failures. The five-minute bank cron prepares one due quarter per run and checks completed quarters daily. Retain two complete snapshots per quarter. Database reads coalesce per-quarter promises for five minutes; public GETs never ingest.
- FFIEC `RetrieveUBPRXBRLFacsimile` uses the existing server credentials, signed Vercel/Supabase gateway, worker lease and shared five-second/600-hourly/2400-daily request gate. Preparing a bank queues its available recent UBPR quarters. Active banks refresh weekly; work remains inside the four-quarter window. Original XBRL, retrieval date and SHA-256 are retained; the source endpoint requires the exact version hash.
- The bank XBRL feed contains **bank ratios**, not official peer averages or percentile ranks. These reference ratios are displayed separately, with a link to the full FFIEC reports. Do not label BankScope cohort statistics as official UBPR statistics or inject UBPR values into the FDIC distributions.

## Model `bankscope-peers-2`

Require complete lending and funding inputs; exclude the subject. Rank at most 30 candidates in an asset band of ¼–4×, widening to ⅛–8× when fewer than ten qualify. Always disclose the wider band and retain the actual cohort count.

Distance = 40% size + 35% lending + 25% funding:

- Size = `min(1, abs(log2(peer assets / subject assets)) / 3)`.
- Lending = 75% total-variation distance across real estate, C&I, consumer and other loans, plus 25% absolute loans/assets difference.
- Funding = mean absolute difference across deposits/assets, noninterest/domestic deposits and brokered/domestic deposits.

Performance outcomes do not influence matching. Raw source values, broad categories and strict identity joins are intentional; specialty models, tax treatment and foreign-office activity still require analyst judgment.

FDIC distributions cover 24 metrics in `peerMetrics.js`; the original six remain the uncluttered default. Category controls expose capital, asset quality, operations, earnings, liquidity and sensitivity. Derived ratios document their source fields and denominators. Use valid values only; at least five are required. Quartiles use linear interpolation. Percentiles use midranks: `(below + 0.5 × equal) / valid count × 100`. The subject is excluded. No trimming, risk rating or higher-is-better coloring is applied.

UBPR reference mappings use Summary Ratios page 1 of the official v187 guide: UBPRE013, UBPRE018, UBPRD486, UBPR7414 and UBPRE019. Computed UBPR ratios are already percentages, unlike raw Call Report pure fractions. Require the correct RSSD, instant date, unit, report date fact and positive bank asset fact; reject conflicting duplicates and unsafe XML.

## Validation

`tests/bankscope-peers.test.js` covers source completeness, source identity, null/zero handling, matching dimensions, unbiased outcome selection, tie ranks, quartiles, small cohorts, UBPR scaling and lineage, cached source reprocessing, API validation, coalesced reads, SQL atomic publication, lease enforcement, shared quotas and anonymous-access denial. The UBPR fixture is an excerpt from Wells Fargo's official June 2026 document, retrieved September 25, 2026.

## CAMELS-style public-data review

`lens=camels` is a shareable view under Compare → Peer benchmarks. `category` preserves the selected metric group. Six component cards use three public indicators each, with same-cohort medians and numeric percentiles. There are no supervisory scores, composite grades or compliance conclusions. Management is represented only by operating proxies; sensitivity by maturity/securities proxies. Actual CAMELS ratings are confidential.

Capital context separates general U.S. bank minimums, minimum plus the 2.5 percentage point base conservation buffer, and PCA well-capitalized **numeric** references. It does not apply holding-company stress buffers or GSIB surcharges to the bank, infer an LCR/NSFR from balance-sheet ratios, or assess compliance with supplementary leverage or institution-specific constraints.

CBLR election comes only from the quarter-specific FDIC `CBLRIND`: 1 elected, 0 not elected, otherwise unknown. For electors, risk-based capital values are null even if FDIC publishes a zero placeholder. Such peers are excluded per metric, not from the business-model cohort. References use >9% through June 2026 and >8% from July 1, 2026, with the corresponding two/four-quarter grace context. Eligibility, grace use and actual PCA status are never inferred from a single ratio. References are withheld before 2022; rules were reviewed September 25, 2026. Primary links are maintained in `regulatoryContext.js`.

The latest completed snapshot's `model_version` is exposed by `peer_status`. Workers refresh an older normalization version even within the usual daily refresh window. All four retained quarters must reach version 2 before release. Existing readers remain compatible with the expanded JSON, and failed refreshes preserve the previous complete universe.

`bankscope-camels.test.js` covers real FDIC bank/CBLR fixtures, ratio denominators, true zero and negative data, CBLR placeholders, valid peer counts, date transitions, strict thresholds, distinct buffer/PCA references, versioned refresh atomicity and share links. The FDIC fixture contains three public bank records for June 2026 retrieved September 25, 2026. Estimated uninsured deposits are deliberately omitted: a source zero can mean the smaller bank was not required to report it.
