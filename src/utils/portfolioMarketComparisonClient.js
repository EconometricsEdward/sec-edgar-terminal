import { CFTC_LAUNCH_CATALOG } from './cftc.js';
import { clearPreparedCftc, fetchPreparedCftc } from './cftcClient.js';

export const PORTFOLIO_MARKET_COMPARISON_PATH = '/api/v1/cftc/market-comparison';
const VERSION = 'edgar.portfolio-market-comparison.v1';
const keys = new Set(CFTC_LAUNCH_CATALOG.map(market => `${market.family}:${market.code}:${market.family === 'tff' ? 'leveraged-funds' : 'managed-money'}`));

/** This public response contains market data only. Portfolio membership and weights stay local. */
export function readPortfolioMarketComparison(value) {
  if (value?.schemaVersion !== VERSION || !Array.isArray(value.results) || value.results.length > keys.size
    || !['ready', 'partial', 'unavailable'].includes(value.status)) {
    throw new Error('The market comparison could not be verified. Filing connections remain available.');
  }
  /** @type {Record<string, {status: 'ready' | 'unavailable', summary: any}>} */
  const summaries = {};
  const seen = new Set();
  for (const row of value.results) {
    const key = `${row?.family}:${row?.contract}:${row?.group}`;
    if (!keys.has(key) || key !== row.key || seen.has(key)) throw new Error('The market comparison contains an unmatched market.');
    seen.add(key);
    if (row.status === 'ready' && row.summary?.key === key && row.summary.family === row.family
      && row.summary.contract === row.contract && row.summary.group === row.group) {
      summaries[key] = { status: 'ready', summary: row.summary };
    } else summaries[key] = { status: 'unavailable', summary: null };
  }
  return { summaries, generatedAt: value.generatedAt, status: value.status };
}

/** One shared, deduplicated request, independent of selected portfolio, category or row. */
export async function loadPortfolioMarketComparison({ signal } = {}) {
  return readPortfolioMarketComparison(await fetchPreparedCftc(PORTFOLIO_MARKET_COMPARISON_PATH, { signal, timeoutMs: 20_000 }));
}

export function clearPortfolioMarketComparison() {
  clearPreparedCftc(PORTFOLIO_MARKET_COMPARISON_PATH);
}
