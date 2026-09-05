# EDGAR Terminal

EDGAR Terminal is a free, accountless SEC filings explorer for public-company research. It is built with Next.js and reads from SEC public APIs so users can trace filings, XBRL financials, insider activity, peer comparisons, and keyword-level disclosure searches back to source documents.

Live site: https://secedgarterminal.com/

## What It Does

- Browses 10-K, 10-Q, 8-K, Form 4, proxy, and other SEC filings by ticker.
- Shows source-linked XBRL financial statements and calculated ratios with annual, standalone quarter, year-to-date, and trailing-twelve-month bases.
- Opens company research with current financials, an evidence drawer, notes, saved review baselines, peer groups, and Markdown research-brief exports.
- Saves companies in `/workspace`, with manual in-app change checks and JSON workspace exports.
- Compares the latest report with the same reporting season, a prior report of the same form, or the exact accession saved at review. Financial changes and paired disclosure passages retain both source filings.
- Adapts ratio views by industry, including banking, technology, retail, REIT, oil and gas, and airline-specific notes.
- Overlays filing markers and insider Form 4 transactions on price-history charts.
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

Set a descriptive `SEC_USER_AGENT` in `.env.local` before calling SEC endpoints. SEC fair-access guidance expects automated clients to identify themselves.

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm test
```

## Operations

- `GET /api/health` returns a no-store JSON health summary for deployment checks. It reports whether the required SEC user agent is configured, whether the warm cache layer is wired, and which Vercel environment/commit is serving the request.
- `/.well-known/security.txt` publishes the public issue tracker as the security contact channel.

## Environment Variables

See `.env.example` for the current set of expected variables. The important production variable is `SEC_USER_AGENT`; Redis-backed features also use Upstash configuration when enabled.

## Data Sources

- SEC submissions and XBRL company facts from `data.sec.gov`.
- SEC filing documents from `www.sec.gov`.
- Public price data with fallback providers in the app utilities.

## Limitations

EDGAR Terminal is for research and education only. It is not investment advice, financial advice, legal advice, tax advice, a broker-dealer service, or a recommendation to buy, sell, or hold any security. Always verify important numbers against the original SEC filing before relying on them.

XBRL values can be affected by restatements, non-standard company tags, amended filings, late filings, and period-selection ambiguity. The app favors source visibility over black-box interpretation.

## Research data and scope

- Financial selection requires the exact end date, compatible duration, and unit. Missing data remains unavailable. Standalone quarters can be calculated from cumulative contexts with the same concept and fiscal-year start; all inputs are retained. EPS and weighted-average shares are not subtracted. TTM requires a reported full-year context or four consecutive compatible quarters.
- Report comparisons select facts available by each filing date. Different filed values for the same start/end/unit context are flagged for inspection, without assuming every change is a restatement. Interim return ratios use annualization and average beginning/end balances; NIM requires earning assets and pre-provision net interest income.
- Filing-text comparison inspects Risk Factors and MD&A in bounded sections (220 narrative paragraphs per section, 40 displayed changes). It suppresses unchanged normalized paragraphs and pairs similar wording. Topic matches are review prompts, not conclusions about risk. Reference-only sections, missing headings, retrieval failures, and bounded filing history are exposed. Foreign-form layouts can have missing section coverage.
- Saved research uses versioned browser local storage. Notes, pinned evidence, and baselines do not sync across devices. A review baseline changes only on **Mark reviewed**; checks do not advance it. In-app alerts run when the user checks the workspace, with up to 20 companies checked per request batch. Email delivery and background monitoring are not configured.
- The geographic table contains curated research groupings. Optional globe allocations and flows are explicitly illustrative scenarios, with a user-controlled scale and a component error boundary. They are not issuer-reported geographic exposure or historical observations.
- Cohort history records actual calculation timestamps, with up to 30 daily observations and no invented backfill. Shared market snapshots require the existing Upstash warm-cache configuration; the page reports when persistence is unavailable. Cohort composition and latest reported periods may change between observations.

## License

No license file is currently included. Treat the repository as source-available unless a license is added.
