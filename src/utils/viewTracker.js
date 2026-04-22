/**
 * View tracker — records ticker views and identifies "hot" tickers.
 *
 * Purpose: automatically promote tickers into the warm cache when they
 * start getting real user traffic, even if they're not in the hardcoded
 * seed list. This means a ticker that suddenly trends (e.g. posted on a
 * finance forum) gets pre-warmed by the next nightly cron run.
 *
 * How it works:
 *   - On each `/api/prices` request, we record the viewer's IP under the
 *     ticker, inside a Redis set with a TTL
 *   - The set's cardinality tells us the count of DISTINCT IPs that viewed
 *     that ticker in the last 24 hours — a better signal of "real
 *     popularity" than raw request count (which is gameable by refreshing)
 *   - A separate sorted set (`hot_tickers`) tracks every ticker with at
 *     least one recent view, scored by the timestamp of the last view.
 *     This lets us both (a) enumerate hot tickers efficiently and (b) age
 *     out stale entries without scanning all views.
 *
 * Design choices for the given configuration:
 *   - Threshold: 3 distinct IPs in 24h to be considered "hot"
 *   - TTL on hot-list membership: 3 days since last view
 *   - View-set TTL: 24h rolling window per ticker
 *
 * KV operations per request:
 *   - SADD + EXPIRE on the ticker's view set (2 ops, pipelined)
 *   - ZADD on the hot-tickers sorted set (1 op)
 *   Total: 3 KV commands per tracked request.
 *
 * This runs asynchronously without blocking the user response — if KV is
 * slow or down, we just silently drop tracking. User-facing latency is
 * unaffected.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ENABLED = !!(REST_URL && REST_TOKEN);

// Configuration
const VIEW_WINDOW_SEC = 24 * 3600;      // 24h rolling view window
const HOT_TTL_SEC = 3 * 24 * 3600;      // 3 days since last view
const HOT_THRESHOLD = 3;                // distinct IPs to be "hot"
const MAX_HOT_TICKERS = 50;             // cap the hot list to prevent runaway growth

// Key names
const viewSetKey = (ticker) => `views:${ticker.toUpperCase()}:24h`;
const HOT_SET_KEY = 'hot_tickers';

/**
 * Fire a pipelined KV write. Returns immediately without waiting for the
 * response — we don't care about the result and don't want to block.
 *
 * This is the critical design choice: tracking must never slow down user
 * requests. If KV is having a bad day, we silently drop the tracking
 * event rather than making the user wait.
 */
function fireAndForget(commands) {
  if (!ENABLED) return;
  fetch(`${REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(2000),
  }).catch((err) => {
    // Swallow — we logged nothing to the user, we log nothing here either
    // beyond debug output. Tracking is best-effort.
    console.warn(`[viewTracker] fire-and-forget failed: ${err.message}`);
  });
}

/**
 * Record a ticker view. Non-blocking — safe to call in a hot path.
 *
 * @param {string} ticker - The ticker being viewed (will be uppercased)
 * @param {string} ip     - Client IP, used to count distinct viewers
 */
export function recordView(ticker, ip) {
  if (!ENABLED) return;
  if (!ticker || !ip) return;

  const t = ticker.toUpperCase();
  const viewKey = viewSetKey(t);
  const now = Math.floor(Date.now() / 1000);

  // Three commands, one round trip:
  //   1. Add this IP to the ticker's view set
  //   2. Set/refresh the 24h TTL on the view set
  //   3. Update the hot-tickers sorted set with "now" as the score
  //
  // We unconditionally ZADD on every view (not just when threshold is
  // crossed) because the score serves two purposes: (a) aging, so old
  // entries fall off, and (b) recency for tie-breaking when the hot
  // list is trimmed. Cheap enough to update always.
  fireAndForget([
    ['SADD', viewKey, ip],
    ['EXPIRE', viewKey, VIEW_WINDOW_SEC],
    ['ZADD', HOT_SET_KEY, String(now), t],
  ]);
}

/**
 * Blocking KV read — used only by the cron pre-warmer, not hot paths.
 */
async function kvPipeline(commands) {
  if (!ENABLED) return null;
  try {
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[viewTracker] pipeline read failed: ${err.message}`);
    return null;
  }
}

/**
 * Returns the list of tickers currently considered "hot" — meaning they've
 * crossed the distinct-IP threshold within the rolling window, AND have
 * been viewed within the TTL retention window.
 *
 * Returns up to MAX_HOT_TICKERS, sorted by most recent view first.
 *
 * Used by the pre-warmer and popularTickers to merge into the seed list.
 *
 * Note: this does a bit of work (one ZRANGE + N SCARDs) but runs at most
 * once per day from the cron, so the cost is negligible.
 */
export async function getHotTickers() {
  if (!ENABLED) return [];

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - HOT_TTL_SEC;

  // Step 1: get all tickers with recent views. We also opportunistically
  // prune old entries (tickers not viewed in > HOT_TTL_SEC).
  //   ZREMRANGEBYSCORE: delete entries older than cutoff
  //   ZREVRANGEBYSCORE: get remaining, sorted newest-first, up to limit
  const candidateRes = await kvPipeline([
    ['ZREMRANGEBYSCORE', HOT_SET_KEY, '-inf', String(cutoff)],
    ['ZREVRANGEBYSCORE', HOT_SET_KEY, '+inf', String(cutoff), 'LIMIT', '0', String(MAX_HOT_TICKERS * 2)],
  ]);
  if (!candidateRes) return [];

  const candidates = candidateRes?.[1]?.result;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // Step 2: check each candidate's current 24h-window distinct-IP count.
  // Only tickers >= HOT_THRESHOLD qualify as actually hot.
  //
  // This is N round-trips, but N is bounded at MAX_HOT_TICKERS * 2 = 100
  // and happens once a day. Cost is fine.
  const scardCommands = candidates.map((t) => ['SCARD', viewSetKey(t)]);
  const scardRes = await kvPipeline(scardCommands);
  if (!scardRes) return [];

  const hot = [];
  for (let i = 0; i < candidates.length; i++) {
    const count = Number(scardRes[i]?.result ?? 0);
    if (count >= HOT_THRESHOLD) {
      hot.push(candidates[i]);
    }
    if (hot.length >= MAX_HOT_TICKERS) break;
  }

  return hot;
}

/**
 * Debug/inspection helper — returns the raw view count for a ticker.
 * Not used in production flow; handy for manual debugging via curl.
 */
export async function getViewCount(ticker) {
  if (!ENABLED) return 0;
  const res = await kvPipeline([['SCARD', viewSetKey(ticker)]]);
  return Number(res?.[0]?.result ?? 0);
}
