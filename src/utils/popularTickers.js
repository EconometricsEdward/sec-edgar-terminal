/**
 * Popular tickers manager.
 *
 * The pre-warmer needs to know which tickers to refresh on a schedule. We
 * support THREE sources, in order of priority:
 *
 *   1. A hardcoded seed list (below) — always included, survives any KV
 *      outage, and guarantees the top-traffic tickers stay warm even if
 *      the override is unset.
 *
 *   2. Auto-warm "hot" tickers — any ticker that hit 3+ distinct-IP views
 *      in 24h gets promoted automatically, via utils/viewTracker.js. The
 *      tracker maintains this list in KV; we just merge it in here. Entries
 *      age out 3 days after the last view. This lets trending tickers get
 *      pre-warmed by the next cron run without manual intervention.
 *
 *   3. A Vercel KV manual override list — lets you add/remove tickers without
 *      redeploying. Set it by running (from any KV console or redis-cli):
 *
 *         SADD popular_tickers NVDA AMD ORCL
 *         SREM popular_tickers SOME_TICKER
 *
 * Merge order: seed first, then hot, then manual override. Deduped and
 * capped at MAX_* so a runaway hot list or override can't blow past the
 * cron's time budget.
 *
 * Seed list sizing — Vercel Hobby vs Pro:
 *   Vercel Hobby caps functions at 60 seconds. Pre-warming is roughly:
 *     - Stock price:       ~0.3s per ticker (Yahoo v8)
 *     - Submissions:       ~0.3s per ticker (SEC)
 *     - Form 4 scan:       ~0.3s per ticker (SEC submissions)
 *     - Crypto scan:       ~5-30s per ticker (expensive)
 *
 *   With 3 concurrent Yahoo workers and 5 concurrent SEC workers, ~15
 *   stocks × 3 stages ≈ 20-30s, leaving room for ~3 crypto-heavy tickers
 *   within the 60s budget. MAX_STOCKS is set to 25 to give hot tickers
 *   10 extra slots beyond the 15 seed stocks.
 *
 *   On Pro (300s cap), we'd want ~50 stocks + 10 crypto-heavy. When you
 *   upgrade, grow the two seed lists below and widen MAX_* accordingly.
 */

import { getHotTickers } from './viewTracker.js';

// Hardcoded seed — sized for Hobby's 60s cap.
// TO EXPAND WHEN YOU UPGRADE TO PRO: uncomment the second batch below.
const SEED_STOCKS = [
  // Mega-cap tech — highest traffic
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA',
  // Popular retail-investor names
  'AMD', 'PLTR', 'GME',
  // Mega-cap non-tech
  'BRK-B', 'JPM', 'V', 'WMT', 'XOM',

  // ---- When upgrading to Pro, uncomment this block ----
  // 'GOOG', 'MA', 'UNH', 'JNJ', 'CVX',
  // 'AVGO', 'ORCL', 'ADBE', 'CRM', 'INTC', 'QCOM', 'TSM',
  // 'HD', 'COST', 'NKE', 'SBUX', 'MCD', 'DIS', 'NFLX',
  // 'BAC', 'WFC', 'GS', 'MS', 'PYPL', 'SQ',
  // 'SOFI', 'RIVN', 'LCID', 'AMC',
];

// Crypto-heavy tickers — expensive to pre-warm (full filing scans).
// Kept small on Hobby since crypto-scan can take 30s+ per ticker.
const SEED_CRYPTO_HEAVY = [
  'MSTR',  // MicroStrategy — the headline one
  'COIN',  // Coinbase
  'MARA',  // Marathon Digital

  // ---- When upgrading to Pro, uncomment this block ----
  // 'HOOD', 'TSLA', 'BKKT', 'RIOT', 'CLSK', 'HUT', 'SQ',
];

// Absolute caps — keep the pre-warm bounded even if someone adds too many
// tickers to the KV override or the hot list. 25 stocks leaves ~10 slots for
// hot tickers beyond the 15 seed stocks. On Pro, raise these to 60 / 15.
const MAX_STOCKS = 25;
const MAX_CRYPTO_HEAVY = 5;

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvSetMembers(key) {
  if (!REST_URL || !REST_TOKEN) return null;
  try {
    const res = await fetch(`${REST_URL}/smembers/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REST_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.result) ? data.result : null;
  } catch (err) {
    console.warn(`[popularTickers] KV read failed for ${key}: ${err.message}`);
    return null;
  }
}

/**
 * Normalize + dedupe a list of raw ticker strings.
 */
function cleanList(tickers) {
  const seen = new Set();
  const out = [];
  for (const t of tickers) {
    if (typeof t !== 'string') continue;
    const norm = t.trim().toUpperCase();
    // Ticker sanity check — same pattern as the stock route
    if (!/^[A-Z0-9.\-]{1,10}$/.test(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Returns the merged stock list (seed + hot tickers + manual override),
 * deduped and capped. This is what the pre-warmer reads on each cron run.
 *
 * Order matters: seed first (guaranteed coverage), then auto-warm hot
 * tickers (dynamic based on traffic), then manual override (admin choices).
 * After MAX_STOCKS entries, additional hot or override tickers are dropped.
 * In practice this means seed always wins — if you ever need to bump a
 * trending ticker out of the seed, remove it from SEED_STOCKS above.
 */
export async function getPopularStocks() {
  // Run hot-list and override lookups in parallel to save round-trips
  const [hot, override] = await Promise.all([
    getHotTickers().catch((err) => {
      console.warn(`[popularTickers] hot-list read failed: ${err.message}`);
      return [];
    }),
    kvSetMembers('popular_tickers').then((v) => v || []),
  ]);

  const merged = cleanList([...SEED_STOCKS, ...hot, ...override]);
  return merged.slice(0, MAX_STOCKS);
}

/**
 * Returns the merged crypto-heavy list (seed + KV override), deduped and capped.
 * Override key: `popular_crypto_tickers`.
 */
export async function getPopularCryptoTickers() {
  const override = (await kvSetMembers('popular_crypto_tickers')) || [];
  const merged = cleanList([...SEED_CRYPTO_HEAVY, ...override]);
  return merged.slice(0, MAX_CRYPTO_HEAVY);
}
