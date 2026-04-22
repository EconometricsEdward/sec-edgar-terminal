/**
 * Stock price proxy — Next.js route handler.
 *
 * Cache layers:
 *   User -> CDN -> this function -> warm cache -> Yahoo -> Stooq fallback
 *
 * Why this endpoint: Yahoo's legacy /v7/finance/download/ endpoint started returning
 * 401 Unauthorized sometime in 2024 for unauthenticated requests. The /v8/finance/chart/
 * endpoint still works without authentication and returns richer data (adjusted close,
 * splits, dividends) as JSON instead of CSV.
 *
 * Fallback strategy: If Yahoo v8 fails, we try Stooq as a secondary. Stooq sometimes
 * works from cloud IPs, sometimes doesn't.
 *
 * Warm cache: the pre-warmer stores the raw Yahoo JSON response under
 * 'stock-raw-yahoo:<TICKER>'. On a cache hit, we skip Yahoo entirely and
 * parse the stored payload — this is important because Vercel's shared
 * egress IPs get rate-limited by Yahoo unpredictably. By pre-fetching on
 * a schedule and serving from warm cache, most user requests for popular
 * tickers never touch Yahoo.
 *
 * No Finnhub: Finnhub moved /stock/candle behind a paywall in 2024. Not usable.
 */

import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { warmGet } from '../../../utils/warmCache.js';
import { recordView } from '../../../utils/viewTracker.js';

export const runtime = 'nodejs';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Shared Yahoo-payload parser. Used for BOTH live Yahoo responses and warm
// cache hits (which store the raw Yahoo JSON verbatim). Keeping one parser
// means the warmer and the live path can't drift out of sync.
// ---------------------------------------------------------------------------
function parseYahooPayload(data, fromIso) {
  if (data.chart?.error) {
    throw new Error(`Yahoo error: ${data.chart.error.description || data.chart.error.code}`);
  }

  const result = data.chart?.result?.[0];
  if (!result) throw new Error('Yahoo returned no result');

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  if (timestamps.length === 0) throw new Error('Yahoo returned empty price series');

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = adjClose[i] ?? closes[i];
    if (!Number.isFinite(close)) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    // If the caller asked for a narrower window than the warm-cached payload
    // contains, trim accordingly
    if (fromIso && date < fromIso) continue;
    rows.push({
      date,
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close,
      volume: volumes[i] ?? null,
    });
  }

  if (rows.length === 0) throw new Error('Yahoo series had no valid rows');
  return rows;
}

// ---------------------------------------------------------------------------
// Source 1: Yahoo v8 chart endpoint (live)
// ---------------------------------------------------------------------------

async function tryYahoo(ticker, fromEpoch, toEpoch, fromIso) {
  // Class shares: Yahoo uses dash, not dot (BRK-B, not BRK.B)
  const yahooTicker = ticker.toUpperCase().replace(/\./g, '-');
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}` +
    `?period1=${fromEpoch}&period2=${toEpoch}&interval=1d&events=history&includeAdjustedClose=true`;

  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
  });

  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const data = await r.json();
  return parseYahooPayload(data, fromIso);
}

// ---------------------------------------------------------------------------
// Source 2: Stooq (best-effort backup)
// ---------------------------------------------------------------------------

async function tryStooq(ticker, fromIso) {
  const stooqTicker = ticker.toLowerCase().replace(/\./g, '-') + '.us';
  const url = `https://stooq.com/q/d/l/?s=${stooqTicker}&i=d`;

  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/csv,text/plain,*/*',
    },
  });

  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);

  const text = await r.text();
  const cleaned = text.replace(/^\uFEFF/, '').trim();

  if (!cleaned || cleaned.length < 50) throw new Error('Stooq empty response');
  if (cleaned.startsWith('<')) throw new Error('Stooq returned HTML');
  if (cleaned.startsWith('No data')) throw new Error('Stooq has no data for ticker');
  if (cleaned.toLowerCase().includes('exceeded') && cleaned.length < 500) {
    throw new Error('Stooq rate limit hit');
  }

  const lines = cleaned.split(/\r?\n/);
  const header = (lines[0] || '').toLowerCase();
  if (!header.includes('date') || !header.includes('close')) {
    throw new Error(`Stooq not CSV: "${lines[0]?.slice(0, 80)}"`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const [date, open, high, low, close, volume] = cols;
    const closeNum = parseFloat(close);
    if (!Number.isFinite(closeNum)) continue;
    rows.push({
      date,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: closeNum,
      volume: volume ? parseInt(volume, 10) : null,
    });
  }

  if (rows.length === 0) throw new Error('Stooq CSV had no parseable rows');
  return fromIso ? rows.filter((r) => r.date >= fromIso) : rows;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('ticker');
  const from = searchParams.get('from');

  if (!ticker || typeof ticker !== 'string') {
    return Response.json({ error: 'Missing ticker parameter' }, { status: 400 });
  }
  if (!/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
    return Response.json({ error: 'Invalid ticker format' }, { status: 400 });
  }

  const ip = getClientIp(request);
  const limit = await checkRateLimit({
    key: `rl:stock:${ip}`,
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);

  // Track this ticker view for the auto-warm list. Fire-and-forget — this
  // does NOT block the response. If KV is slow or down, we silently drop
  // the tracking event. Placed AFTER rate-limit check so abusers don't
  // inflate view counts, but BEFORE warm cache read so even cache hits
  // contribute to popularity signals.
  recordView(ticker, ip);

  // Default: 10 years of history
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 10);
  const fromIso = from && /^\d{4}-\d{2}-\d{2}$/.test(from)
    ? from
    : defaultFrom.toISOString().slice(0, 10);
  const fromEpoch = Math.floor(new Date(fromIso).getTime() / 1000);
  const toEpoch = Math.floor(now.getTime() / 1000);

  const attempts = [];

  // ------- Warm cache check ------------------------------------------------
  // The pre-warmer stores 10 years of Yahoo data. If the user's `from` is
  // within that window, the warm payload covers it and we serve instantly.
  // If they ask for an older date than we warmed, fall through to live Yahoo.
  const warmPayload = await warmGet('stock-raw-yahoo', ticker.toUpperCase());
  if (warmPayload) {
    try {
      const rows = parseYahooPayload(warmPayload, fromIso);
      if (rows.length > 0) {
        attempts.push({ source: 'warm', status: 'success', rowCount: rows.length });
        return Response.json(
          {
            ticker,
            source: 'warm',
            from: rows[0].date,
            to: rows[rows.length - 1].date,
            count: rows.length,
            prices: rows,
            attempts,
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400',
              'X-Cache-Source': 'warm',
            },
          }
        );
      }
      attempts.push({ source: 'warm', status: 'empty' });
    } catch (err) {
      // Warm payload was malformed somehow — fall through to live sources
      attempts.push({ source: 'warm', status: 'failed', error: err.message });
    }
  }

  // ------- Live upstream sources -------------------------------------------
  const sources = [
    { name: 'yahoo', fn: () => tryYahoo(ticker, fromEpoch, toEpoch, fromIso) },
    { name: 'stooq', fn: () => tryStooq(ticker, fromIso) },
  ];

  for (const { name, fn } of sources) {
    try {
      const rows = await fn();
      if (rows && rows.length > 0) {
        attempts.push({ source: name, status: 'success', rowCount: rows.length });
        return Response.json(
          {
            ticker,
            source: name,
            from: rows[0].date,
            to: rows[rows.length - 1].date,
            count: rows.length,
            prices: rows,
            attempts,
          },
          {
            status: 200,
            headers: {
              'Cache-Control': 'public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400',
              'X-Cache-Source': 'upstream',
            },
          }
        );
      }
      attempts.push({ source: name, status: 'empty' });
    } catch (err) {
      attempts.push({ source: name, status: 'failed', error: err.message });
    }
  }

  return Response.json(
    {
      error: `Price sources unavailable for ticker "${ticker}"`,
      ticker,
      attempts,
      note: 'Yahoo Finance is the primary source; Stooq is a backup. Both may occasionally be unreachable from cloud hosting IPs.',
    },
    {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    }
  );
}
