# Funding & Clearing and Derivatives Explorer

Routes: `/market/funding`, `/market/derivatives`. Both are linked from Market;
BankScope overview and exposures link to funding context. Company statements and
market aggregates are explicitly separate.

## Sources and permitted scope

- New York Fed secured reference rates: SOFR, BGCR, TGCR, effective dates,
  reported percentiles and underlying daily volume. Volume arrives in USD billions.
  The display uses USD and never sums overlapping benchmark volumes.
- New York Fed primary-dealer series PDFTD/PDFTR-USTET and -UST: nominal
  Treasury plus TIPS fails, in USD millions. These are cumulative weekly amounts,
  not daily averages, unique failed trades, losses, or DTCC FICC figures.
- CFTC Weekly Swaps Report: aggregate interest-rate, credit and FX tables,
  in USD millions or trade counts. Outstanding is a stock; weekly volume and
  count are flows. Single-count clearing totals exclude participant tables.
  Currency, product, tenor and grade are separate breakdowns of the same total.
  Credit regional child rows are excluded from product totals. Credit products
  use grade-table totals; a missing product-specific clearing split is null.
- CFTC FX currency tables contain overlapping regional subtotals. Only USD
  pairs, EUR/non-USD and the final Other-pairs group are used. Credit reports
  have grade data rather than currency/tenor. FX activity and outstanding use
  different day buckets; rate-swap buckets use CFTC's month conventions.
- Small published component discrepancies are retained, not balanced by adding
  invented residuals. Missing values remain null. Notional is not market value
  or counterparty credit exposure.

New York Fed attribution and reference-rate terms appear in the UI, prepared
JSON and CSV exports. See <https://www.newyorkfed.org/privacy/termsofuse>.
CFTC sources and explanatory notes are linked from each dashboard.

DTCC general terms require written permission for automated extraction and
republication. No DTCC downloader, credentials, ingestion, or redistribution is
enabled. FICC volume, GCF Repo Index and daily Treasury fails are external links
to DTCC's reports. This implementation is not a DTCC transaction-level explorer.

Initial captures contain 744 reference-rate observations, 104 fails weeks,
five swaps aggregate reporting periods and one detailed swaps release. CFTC
direct HTTP access returned 403 in the development environment; the initial
swaps data were acquired from the official pages through web retrieval. Source
manifests explicitly identify `official-page-web-retrieval`, and hashes cover
that captured text rather than claiming to hash the original HTML. The source
captures are archived in Supabase. The direct HTTP scheduled reader must be
checked in production; failure retains and labels the previous capture.

## Pipeline and security

`/api/cron/market-research` checks the refresh lease every ten minutes,
requires the existing CRON_SECRET, and is bounded to 260 seconds within a
300-second function. Only due claims ingest sources, about twice daily;
intervening checks return immediately without fetching any source.
An atomic five-minute lease with a generation fence prevents concurrent/stale
workers from publishing. Source URL allowlists, blocked redirects, response
byte caps, parser reconciliation and release-date checks precede publication.
Each dataset publishes atomically; a failed source never replaces it with an
empty result. A denied CFTC request stops the CFTC group on its first request.
No visitor request starts upstream ingestion.

The private `market_research` schema holds prepared snapshots, normalized
observations, compressed source captures and refresh state. RLS is enabled;
anon/authenticated have no schema/table/RPC access. The gateway verifies the
exact production Vercel workload identity using RS256/JWKS. Built-in Supabase
JWT verification is disabled only because this gateway uses custom Vercel OIDC
verification. No service key is shipped to Vercel or the browser. Previews use
the source-linked bundled fallback and cannot access production storage.

Original captures are small, bounded gzip records in a separate private table;
they are not served to visitors. A large licensed bulk-feed expansion should
move archive bytes to object storage. Serving snapshots retain 104 aggregate
swaps periods and 12 detailed releases, with explicit missing earlier detail.
Reference rates retain the requested year; fails retain 104 weeks. Database
publication replaces normalized serving rows so revisions remove old products.

`/api/market-plumbing?view=funding|derivatives` is rate limited and CDN cached.
It preserves the existing `/api/market-research` company research contract.
Server-rendered titles, metrics and accessible exact-value tables provide useful
HTML; pages have canonical metadata and sitemap entries. Filter URLs are
shareable while canonical URLs remain the two main routes. Chart notes are
collapsed; charts have labels and CSV/table alternatives. Colors support the
existing dark, balanced and light themes.

## Verification

`node --test tests/market-plumbing*.test.js` covers captured values/units,
missingness, double-count exclusions, currency hierarchies, revisions, history
retention, links, rejected/oversized sources, fallback serving, gateway claims
and the actual SQL migration in PGlite (roles, leases, atomicity and revisions).
Run the repository quality gates before merging and verify both live routes,
filter/share interactions, CSV downloads, existing Market navigation and the
production refresh result after deployment.
