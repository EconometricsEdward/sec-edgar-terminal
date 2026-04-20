/**
 * Shared ticker → CIK lookup cache.
 *
 * The SEC publishes company_tickers.json (~1.5MB) and company_tickers_mf.json
 * for the full ticker/CIK mapping. These files update roughly weekly.
 *
 * Previously we fetched these on every API invocation, which meant:
 *   - ~1.5MB transferred from SEC on every crypto-scan / fund request
 *   - Counted against SEC's 10 req/sec global limit
 *   - Added 200-500ms of latency to every request
 *
 * Now we cache in memory per serverless instance with a 6-hour TTL. On a cold
 * instance, concurrent requests share a single in-flight fetch via the
 * promise-memoization pattern (no thundering herd).
 *
 * Per-instance memory cache is fine for this data because:
 *   (1) It's public and identical for every user
 *   (2) A stale hit for up to 6h is harmless — ticker mappings rarely change
 *   (3) Upstash would work too but adds a network hop for data we're happy
 *       to keep per-instance
 *
 * If you later want cross-instance coherence (e.g. for immediate ticker
 * additions), swap the in-memory Map for Upstash Redis.
 */

const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Per-instance caches
let operatingCache = null; // { data, expiresAt }
let fundCache = null;
let operatingInFlight = null; // Promise<{ data, expiresAt }> — prevents thundering herd
let fundInFlight = null;

const OPERATING_URL = 'https://www.sec.gov/files/company_tickers.json';
const FUND_URL = 'https://www.sec.gov/files/company_tickers_mf.json';

function getUserAgent() {
  return process.env.SEC_USER_AGENT || 'SEC EDGAR Terminal research@secedgarterminal.com';
}

async function fetchAndIndex(url, buildIndex) {
  const res = await fetch(url, {
    headers: { 'User-Agent': getUserAgent() },
    // Even module-scope data shouldn't hang indefinitely
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`SEC ticker file fetch failed: HTTP ${res.status}`);
  }
  const raw = await res.json();
  const indexed = buildIndex(raw);
  return { data: indexed, expiresAt: Date.now() + TTL_MS };
}

/**
 * Index the operating-companies ticker file into a plain object:
 *   { AAPL: { cik: "0000320193", name: "Apple Inc." }, ... }
 */
function buildOperatingIndex(raw) {
  const index = {};
  for (const entry of Object.values(raw)) {
    if (!entry?.ticker) continue;
    index[entry.ticker.toUpperCase()] = {
      cik: String(entry.cik_str).padStart(10, '0'),
      name: entry.title,
    };
  }
  return index;
}

/**
 * The mutual-fund file has shape:
 *   { fields: ["cik","seriesId","classId","symbol"], data: [[...], ...] }
 */
function buildFundIndex(raw) {
  const index = {};
  if (!raw?.data) return index;
  for (const row of raw.data) {
    const symbol = row[3];
    if (!symbol) continue;
    index[String(symbol).toUpperCase()] = {
      cik: String(row[0]).padStart(10, '0'),
      seriesId: row[1],
      classId: row[2],
    };
  }
  return index;
}

async function getCached(which) {
  const isOp = which === 'operating';
  const cache = isOp ? operatingCache : fundCache;
  const now = Date.now();

  if (cache && cache.expiresAt > now) {
    return cache.data;
  }

  // If a fetch is already in flight, join it rather than starting a second one
  if (isOp && operatingInFlight) return (await operatingInFlight).data;
  if (!isOp && fundInFlight) return (await fundInFlight).data;

  const url = isOp ? OPERATING_URL : FUND_URL;
  const builder = isOp ? buildOperatingIndex : buildFundIndex;
  const promise = fetchAndIndex(url, builder);

  if (isOp) operatingInFlight = promise; else fundInFlight = promise;

  try {
    const fresh = await promise;
    if (isOp) operatingCache = fresh; else fundCache = fresh;
    return fresh.data;
  } catch (err) {
    // On failure, serve stale if we have it — better than nothing for a
    // file that only changes weekly
    if (cache) {
      console.warn(`[tickerMap] Refresh failed, serving stale: ${err.message}`);
      return cache.data;
    }
    throw err;
  } finally {
    if (isOp) operatingInFlight = null; else fundInFlight = null;
  }
}

/**
 * Look up a single operating-company ticker.
 * @param {string} ticker
 * @returns {Promise<{ cik: string, name: string } | null>}
 */
export async function getOperatingTicker(ticker) {
  if (!ticker) return null;
  const index = await getCached('operating');
  return index[ticker.toUpperCase()] || null;
}

/**
 * Look up a single fund ticker.
 * @param {string} ticker
 * @returns {Promise<{ cik: string, seriesId: string, classId: string } | null>}
 */
export async function getFundTicker(ticker) {
  if (!ticker) return null;
  const index = await getCached('fund');
  return index[ticker.toUpperCase()] || null;
}

/**
 * Unified lookup — operating first, then fund. Use this when you don't know
 * which category a ticker belongs to (as in the fund detection route).
 */
export async function getAnyTicker(ticker) {
  const op = await getOperatingTicker(ticker);
  if (op) return { ...op, kind: 'operating' };
  const fund = await getFundTicker(ticker);
  if (fund) return { ...fund, kind: 'fund' };
  return null;
}

/**
 * Batch version — takes an array of tickers, returns a map of
 * { TICKER: { cik, name } } for operating companies. Missing tickers are omitted.
 */
export async function getOperatingTickers(tickers) {
  const index = await getCached('operating');
  const out = {};
  for (const t of tickers) {
    const entry = index[String(t).toUpperCase()];
    if (entry) out[String(t).toUpperCase()] = entry;
  }
  return out;
}
