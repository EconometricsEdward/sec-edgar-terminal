/**
 * Stock price proxy — Yahoo v8 chart endpoint.
 *
 * Why this endpoint: Yahoo's legacy /v7/finance/download/ endpoint started returning
 * 401 Unauthorized sometime in 2024 for unauthenticated requests. The /v8/finance/chart/
 * endpoint still works without authentication and returns richer data (adjusted close,
 * splits, dividends) as JSON instead of CSV.
 *
 * Fallback strategy: If Yahoo v8 fails, we try Stooq as a secondary. Stooq sometimes
 * works from cloud IPs, sometimes doesn't (shared-quota issues with Vercel). That's
 * fine as a best-effort backup.
 *
 * No Finnhub: Finnhub moved /stock/candle behind a paywall in 2024. Not usable.
 */

const RATE = { windowMs: 60_000, max: 30 };
const buckets = new Map();

function checkRate(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, resetAt: now + RATE.windowMs };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + RATE.windowMs; }
  b.count += 1;
  buckets.set(ip, b);
  return b.count <= RATE.max;
}

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
// Source 1: Yahoo v8 chart endpoint (JSON)
// ---------------------------------------------------------------------------

async function tryYahoo(ticker, fromEpoch, toEpoch) {
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

  // Response shape: { chart: { result: [{ timestamp, indicators: { quote, adjclose }}], error } }
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
  // Tolerate leading BOM or whitespace
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
    // Log first line for diagnosis
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

export default async function handler(req, res) {
  const { ticker, from } = req.query;

  if (!ticker || typeof ticker !== 'string') {
    return res.status(400).json({ error: 'Missing ticker parameter' });
  }
  if (!/^[A-Za-z0-9.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker format' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.headers['x-real-ip'] || 'unknown';
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded (30 req/min per IP)' });
  }

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
  const sources = [
    { name: 'yahoo', fn: () => tryYahoo(ticker, fromEpoch, toEpoch) },
    { name: 'stooq', fn: () => tryStooq(ticker, fromIso) },
  ];

  for (const { name, fn } of sources) {
    try {
      const rows = await fn();
      if (rows && rows.length > 0) {
        attempts.push({ source: name, status: 'success', rowCount: rows.length });
        res.setHeader('Cache-Control', 'public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400');
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).json({
          ticker,
          source: name,
          from: rows[0].date,
          to: rows[rows.length - 1].date,
          count: rows.length,
          prices: rows,
          attempts,
        });
      }
      attempts.push({ source: name, status: 'empty' });
    } catch (err) {
      attempts.push({ source: name, status: 'failed', error: err.message });
    }
  }

  return res.status(502).json({
    error: `Price sources unavailable for ticker "${ticker}"`,
    ticker,
    attempts,
    note: 'Yahoo Finance is the primary source; Stooq is a backup. Both may occasionally be unreachable from cloud hosting IPs.',
  });
}
