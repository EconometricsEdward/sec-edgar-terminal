# EDGAR Terminal

EDGAR Terminal is a free, accountless research terminal for source-linked SEC evidence and separately presented official CFTC Commitments of Traders positioning. It is built with Next.js so users can trace filings, XBRL financials, insider activity, peer comparisons, disclosure searches, and futures-positioning calculations back to their public sources.

Live site: https://secedgarterminal.com/

## What It Does

- Browses 10-K, 10-Q, 8-K, Form 4, proxy, and other SEC filings by ticker.
- Shows source-linked XBRL financial statements and calculated ratios with annual, standalone quarter, year-to-date, and trailing-twelve-month bases.
- Opens company research with current financials, an evidence drawer, notes, saved review baselines, peer groups, and Markdown research-brief exports.
- Supports portfolio overview and research in `/workspace`, with saved company lists, financial comparisons, SEC evidence and portfolio exports.
- Compares the latest report with the same reporting season, a prior report of the same form, or the exact accession saved at review. Financial changes and paired disclosure passages retain both source filings.
- Adapts ratio views by industry, including banking, technology, retail, REIT, oil and gas, and airline-specific notes.
- Adds an SEC-only Fundamental Lab for breadth, paired change, dispersion, and within-sector context, alongside a separate official CFTC positioning workspace.
- Compares up to five peer companies side by side.
- Searches recent SEC filings for user-defined words or phrases, returning source-linked filing excerpts.

## Tech Stack

- Next.js App Router
- React
- Tailwind CSS
- Recharts
- Upstash Redis for rate limits and cache
- Vercel Analytics and Speed Insights

## Local Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set a descriptive `SEC_USER_AGENT` in `.env.local` before calling SEC endpoints. SEC fair-access guidance expects automated clients to identify themselves. Deployed runtimes also require the shared Upstash/KV settings shown in `.env.example`; the application fails closed rather than issuing uncoordinated SEC traffic.

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm test
npm run test:cftc-live
```

## Operations

- `GET /api/health` returns a briefly edge-cached JSON health summary for deployment checks. It reports whether the required SEC user agent, warm cache, and shared SEC request gate are configured, plus the Vercel environment/commit serving the request. Degraded responses are never cached.
- `GET /api/v1/cftc/status` reads prepared TFF and Disaggregated cache state independently. It recomputes cache age and report currency without contacting the upstream CFTC service.
- `GET /api/cron/cftc` prepares both CFTC report families with a durable per-family checkpoint, so a successful family is not repeated when the other family needs a bounded retry. Prepared snapshots are fresh for six hours and may fall back to a disclosed last-good snapshot for no more than 15 days.
- `/.well-known/security.txt` publishes the public issue tracker as the security contact channel.

The live source smoke test is intentionally opt-in: `CFTC_LIVE_SMOKE=1 npm run test:cftc-live`. It performs bounded, read-only checks against both official datasets.

### Migration maintenance

- Treat schema or methodology changes as explicit versions. Publish and validate a new contract before retiring an old one; never reinterpret retired price-derived fields inside Fundamental Lab v2 or CFTC v1.
- The two CFTC report families refresh independently. A one-family failure remains visible as partial/degraded status; a validated last-good family snapshot may be served with its original clocks for at most 15 days.
- A provider-free rollback may disable the CFTC tab or cron while preserving SEC research, but must not restore third-party security-price acquisition or the retired return APIs.
- The authenticated production route `GET /api/cron/provider-retirement` runs the bounded, checkpointed cleanup. Verify that both Fundamental Lab bases are valid first, then repeat the route until `complete: true`; only audited legacy cache prefixes are removed.

## Environment Variables

See `.env.example` for the current set of expected variables. `SEC_USER_AGENT`, `CRON_SECRET`, and the Upstash/KV REST URL and token are required in deployed runtimes. Vercel invokes the bounded refresh routes with `Authorization: Bearer $CRON_SECRET`; unauthenticated calls are rejected. `CFTC_APP_TOKEN` is optional; the official CFTC resource endpoints also support bounded tokenless reads. Local development may omit Redis and uses a conservative per-process SEC pacer.

## Data Sources

- SEC submissions and XBRL company facts from `data.sec.gov`.
- SEC filing documents from `www.sec.gov`.
- Official futures-only CFTC TFF (`gpe5-46if`) and Disaggregated (`72hh-3qpy`) Public Reporting datasets. These provide positioning context, not a security-price feed.

## Limitations

EDGAR Terminal is for research and education only. It is not investment advice, financial advice, legal advice, tax advice, a broker-dealer service, or a recommendation to buy, sell, or hold any security. Always verify important numbers against the original SEC filing or CFTC source, as applicable, before relying on them.

XBRL values can be affected by restatements, non-standard company tags, amended filings, late filings, and period-selection ambiguity. The app favors source visibility over black-box interpretation.

## Research data and scope

- Financial selection requires the exact end date, compatible duration, and unit. Missing data remains unavailable. Standalone quarters can be calculated from cumulative contexts with the same concept and fiscal-year start; all inputs are retained. EPS and weighted-average shares are not subtracted. TTM requires a reported full-year context or four consecutive compatible quarters.
- Report comparisons select facts available by each filing date. Different filed values for the same start/end/unit context are flagged for inspection, without assuming every change is a restatement. Interim return ratios use annualization and average beginning/end balances; NIM requires earning assets and pre-provision net interest income.
- Filing-text comparison inspects Risk Factors and MD&A in bounded sections (220 narrative paragraphs per section, 40 displayed changes). It suppresses unchanged normalized paragraphs and pairs similar wording. Topic matches are review prompts, not conclusions about risk. Reference-only sections, missing headings, retrieval failures, and bounded filing history are exposed. Foreign-form layouts can have missing section coverage.
- Saved research uses versioned browser local storage. Notes, pinned evidence, and baselines do not sync across devices. A review baseline changes only on **Mark reviewed**; checks do not advance it. Portfolio research refreshes run on request. Email delivery and background monitoring are not configured.
- The geographic table contains curated research groupings. Optional globe allocations and flows are explicitly illustrative scenarios, with a user-controlled scale and a component error boundary. They are not issuer-reported geographic exposure or historical observations.
- Cohort history records actual calculation timestamps, with up to 30 daily observations and no invented backfill. Shared market snapshots require the existing Upstash warm-cache configuration; the page reports when persistence is unavailable. Cohort composition and latest reported periods may change between observations.

## License

No license file is currently included. Treat the repository as source-available unless a license is added.
