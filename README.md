# EDGAR Terminal

EDGAR Terminal is a free, accountless SEC filings explorer for public-company research. It is built with Next.js and reads from SEC public APIs so users can trace filings, XBRL financials, insider activity, peer comparisons, and crypto-asset disclosures back to source documents.

Live site: https://secedgarterminal.com/

## What It Does

- Browses 10-K, 10-Q, 8-K, Form 4, proxy, and other SEC filings by ticker.
- Shows source-linked XBRL financial statements and calculated ratios.
- Adapts ratio views by industry, including banking, technology, retail, REIT, oil and gas, and airline-specific notes.
- Overlays filing markers and insider Form 4 transactions on price-history charts.
- Compares up to five peer companies side by side.
- Scans recent SEC filings for bitcoin, crypto, digital-asset, stablecoin, mining, custody, ETF, and related disclosure terms.

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
```

## Environment Variables

See `.env.example` for the current set of expected variables. The important production variable is `SEC_USER_AGENT`; Redis-backed features also use Upstash configuration when enabled.

## Data Sources

- SEC submissions and XBRL company facts from `data.sec.gov`.
- SEC filing documents from `www.sec.gov`.
- Public price data with fallback providers in the app utilities.
- Crypto price data through public exchange APIs used by the crypto scanner.

## Limitations

EDGAR Terminal is for research and education only. It is not investment advice, financial advice, legal advice, tax advice, a broker-dealer service, or a recommendation to buy, sell, or hold any security. Always verify important numbers against the original SEC filing before relying on them.

XBRL values can be affected by restatements, non-standard company tags, amended filings, late filings, and period-selection ambiguity. The app favors source visibility over black-box interpretation.

## Support And Fixed-Scope Checks

The app is free. If it saves time, there are two transparent support paths:

- Paid SEC snapshot API: https://secedgarterminal.com/paid-api
- Optional no-service tip: `0.01 SOL` with memo `QuickProofTip`.
- Fixed-scope public-page/data-source check: https://pages.share-html.com/quickproof-micro-audit-20260609

The paid API is a machine-readable HTTP 402-style endpoint for compact public SEC filing snapshots. It costs `0.001 SOL`, verifies an exact `EdgarSnapshot:<TICKER>:<nonce>` memo on Solana mainnet, and returns JSON after confirmation. It uses public SEC data only and is still not investment, financial, legal, or tax advice.

The paid check is limited to public URLs and public repository or data-source observations. It does not include investment advice, trading recommendations, private data review, security testing, legal/compliance certification, or guaranteed ranking, traffic, revenue, or accuracy outcomes.

Public QuickProof proof gallery: https://rentry.co/quickproof-value-first-sample-gallery-20260609-v2

## License

No license file is currently included. Treat the repository as source-available unless a license is added.
