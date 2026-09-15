import { prewarmDisclosureCompany } from './disclosureResearchServer.js';

// Recent passages are a small acceleration layer. The SEC index remains the
// discovery source for every filer and for material outside this cohort.
const COHORT = ['MSFT', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'GOOGL', 'META', 'BAC', 'WFC', 'GS', 'UNH', 'XOM', 'WMT', 'F', 'CCL', 'AAL'];

export async function prewarmDisclosureSearch({ signal, now = Date.now(), deadline = Date.now() + 60000 } = {}) {
  const offset = Math.floor(now / 86400000) % 2 * 8;
  const tickers = COHORT.slice(offset, offset + 8);
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, Math.min(60000, deadline - Date.now())))]);
  const results = []; let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (!boundedSignal.aborted && Date.now() < deadline) {
      const ticker = tickers[cursor++];
      if (!ticker) return;
      try { results.push({ ticker, ...await prewarmDisclosureCompany(ticker, { signal: boundedSignal, maxDocuments: 1 }) }); }
      catch { results.push({ ticker, failed: 1, indexed: 0 }); }
    }
  }));
  return { scope: 'rotating-popular-company-cohort', requested: tickers.length, completed: results.length,
    indexed: results.reduce((n, r) => n + (r.indexed || 0), 0),
    failed: results.reduce((n, r) => n + (r.failed || 0), 0), results };
}
