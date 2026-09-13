import { getOperatingTickers } from './tickerMap.js';
import { secFetch } from './secClient.js';
import { warmReadRawSetMembers, warmSet } from './warmCache.js';

const PREWARM_OVERRIDE_KEY = 'popular_tickers';
const MAX_TICKERS = 25;
const MAX_CONCURRENCY = 3;
const ITEM_TIMEOUT_MS = 12_000;

/** Stable SEC-only launch set. The optional raw set adds operator-selected CIK lookups. */
export const SEC_PREWARM_SEED_TICKERS = Object.freeze([
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  'AMD', 'PLTR', 'GME', 'BRK-B', 'JPM', 'V', 'WMT', 'XOM',
]);

export function normalizeSecPrewarmTickers(values, limit = MAX_TICKERS) {
  if (!Array.isArray(values) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TICKERS) return [];
  const seen = new Set(), tickers = [];
  for (const value of values) {
    const ticker = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker); tickers.push(ticker);
    if (tickers.length >= limit) break;
  }
  return tickers;
}

export async function readSecPrewarmTickers({ readOverrides = warmReadRawSetMembers } = {}) {
  const overrides = await readOverrides(PREWARM_OVERRIDE_KEY, MAX_TICKERS).catch(() => null);
  return normalizeSecPrewarmTickers([...SEC_PREWARM_SEED_TICKERS, ...(Array.isArray(overrides) ? [...overrides].sort() : [])]);
}

function validSubmissions(value, cik) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && String(value.cik || '').replace(/^0+/, '') === String(cik).replace(/^0+/, '')
    && value.filings && typeof value.filings === 'object' && value.filings.recent && typeof value.filings.recent === 'object';
}

/** Prepare only SEC submissions consumed by `/api/sec`; no market-price work occurs here. */
export async function prewarmSecSubmissions({
  signal,
  deadline = Date.now() + 240_000,
  tickers,
  resolveTickers = getOperatingTickers,
  fetchSec = secFetch,
  store = warmSet,
} = {}) {
  const selected = normalizeSecPrewarmTickers(tickers || await readSecPrewarmTickers());
  const directory = await resolveTickers(selected);
  const queue = selected.flatMap(ticker => {
    const rawCik = String(directory?.[ticker]?.cik || '').trim();
    const cik = /^\d{1,10}$/.test(rawCik) && Number(rawCik) > 0
      ? rawCik.padStart(10, '0')
      : '';
    return /^\d{10}$/.test(cik) ? [{ ticker, cik }] : [];
  });
  const unresolved = selected.length - queue.length;
  const results = [], failures = [];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !signal?.aborted && Date.now() < deadline - ITEM_TIMEOUT_MS - 2000) {
      const item = queue.shift();
      try {
        const response = await fetchSec(`https://data.sec.gov/submissions/CIK${item.cik}.json`, {
          headers: { Accept: 'application/json' }, signal, timeoutMs: ITEM_TIMEOUT_MS, retries: 0, cache: 'no-store',
        });
        if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
        const payload = await response.json();
        if (!validSubmissions(payload, item.cik)) throw new Error('SEC submissions payload failed validation.');
        if (!await store('submissions-cik', item.cik, payload, 25 * 3600)) throw new Error('SEC submissions checkpoint could not be persisted.');
        results.push(item.ticker);
      } catch (error) {
        failures.push({ ticker: item.ticker, reason: String(error?.message || error).slice(0, 240) });
      }
    }
  });
  await Promise.all(workers);
  return {
    requested: selected.length,
    succeeded: results.length,
    failed: failures.length,
    unresolved,
    skipped: queue.length,
    failures: failures.slice(0, 8),
  };
}
