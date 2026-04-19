/**
 * Stock price proxy with waterfall fallback: Yahoo → Stooq → Finnhub.
 *
 * Architecture:
 *   Client calls /api/prices?ticker=X&from=YYYY-MM-DD
 *   This function tries each source in order; first with valid data wins.
 *   Each attempt has a 6-second timeout so one slow source can't stall the response.
 *   Response includes { source } so the UI can show which feed served the data.
 *
 * Data sources and why we try in this order:
 *   1. Yahoo Finance — most reliable, best coverage, includes split/dividend adjustments,
 *      no API key needed. Suitable for personal/non-commercial/educational use.
 *   2. Stooq — free, no key, good fallback when Yahoo rate-limits or blocks.
 *   3. Finnhub — paid service with free tier (60 req/min). Requires FINNHUB_API_KEY
 *      environment variable. Used as the last-resort safety net.
 *
 * Environment variables:
 *   FINNHUB_API_KEY — set in Vercel dashboard, never in code or git.
 */

// ---------------------------------------------------------------------------
// Rate limiting (per-IP, in-memory, best-effort)
// ---------------------------------------------------------------------------

const RATE = { windowMs: 60_000, max: 30 };
const buckets = new Map();

function checkRate(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, resetAt: now + RATE.windowMs };
  if (now > b.resetAt) {
    b.count = 0;
    b.resetAt = now + RATE.windowMs;
  }
  b.count += 1;
  buckets.set(ip, b);
  return b.count <= RATE.max;
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Source 1: Yahoo Finance (unofficial CSV endpoint)
// ---------------------------------------------------------------------------

async function tryYahoo(ticker, fromEpoch, toEpoch) {
  // Yahoo uses uppercase tickers; class shares use a dash (BRK-B, not BRK.B)
  const yahooTicker = ticker.toUpperCase().replace(/\./g, '-');
  const url =
    `https://query1.finance.yahoo.com/v7/finance/download/${yahooTicker}` +
    `?period1=${fromEpoch}&period2=${toEpoch}&interval=1d&events=history&includeAdjustedClose=true`;

  const r = await fetchWithTimeout(url, {
    headers: {
      // Browser-like UA — Yahoo is less likely to rate-limit requests that look human
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/csv,text/plain,*/*',
    },
  });

  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);

  const text = await r.text();
  if (text.startsWith('<') || text.length < 100) {
    throw new Error(`Yahoo returned unexpected response (${text.length} chars)`);
  }

  // Expected CSV: Date,Open,High,Low,Close,Adj Close,Volume
  const lines = text.trim().split('\n');
  const header = lines[0]?.toLowerCase() || '';
  if (!header.includes('date') || !header.includes('close')) {
    throw new Error('Yahoo response not in expected CSV format');
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const [date, open, high, low, close, adjClose, volume] = cols;
    // Prefer adjusted close (splits/dividends) when available
    const closeNum = parseFloat(adjClose || close);
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

  if (rows.length === 0) throw new Error('Yahoo CSV had no parseable rows');
  return rows;
}

// ---------------------------------------------------------------------------
// Source 2: Stooq
// ---------------------------------------------------------------------------

async function tryStooq(ticker, fromIso) {
  const stooqTicker = ticker.toLowerCase().replace(/\./g, '-') + '.us';
  const url = `https://stooq.com/q/d/l/?s=${stooqTicker}&i=d`;

  const r = await fetchWithTimeout(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/csv,text/plain,*/*',
    },
  });

  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);

  const text = await r.text();
  if (text.startsWith('<') || text.trim().length < 50) {
    throw new Error('Stooq returned HTML or empty response');
  }
  if (text.startsWith('No data')) {
    throw new Error('Stooq has no data for this ticker');
  }

  const lines = text.trim().split('\n');
  const header = lines[0]?.toLowerCase() || '';
  if (!header.includes('date') || !header.includes('close')) {
    throw new Error('Stooq response not in CSV format');
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
  // Stooq doesn't support date range params; filter client-side
  return fromIso ? rows.filter((row) => row.date >= fromIso) : rows;
}

// ---------------------------------------------------------------------------
// Source 3: Finnhub (requires FINNHUB_API_KEY)
// ---------------------------------------------------------------------------

async function tryFinnhub(ticker, fromEpoch, toEpoch) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error('FINNHUB_API_KEY not configured');

  const finnhubTicker = ticker.toUpperCase();
  const url =
    `https://finnhub.io/api/v1/stock/candle` +
    `?symbol=${finnhubTicker}&resolution=D&from=${fromEpoch}&to=${toEpoch}&token=${apiKey}`;

  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);

  const data = await r.json();

  // Finnhub format: { s: 'ok'|'no_data', c: [closes], h, l, o, t: [timestamps], v: [volumes] }
  if (data.s !== 'ok') throw new Error(`Finnhub status: ${data.s || 'unknown'}`);
  if (!Array.isArray(data.c) || data.c.length === 0) {
    throw new Error('Finnhub returned empty price array');
  }

  const rows = [];
  for (let i = 0; i < data.c.length; i++) {
    const ts = data.t[i];
    if (!ts || !Number.isFinite(data.c[i])) continue;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    rows.push({
      date,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i] ?? null,
    });
  }

  if (rows.length === 0) throw new Error('Finnhub data had no parseable rows');
  return rows;
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

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    'unknown';
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded (30 req/min per IP)' });
  }

  // Default range: last 10 years
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 10);

  const fromIso =
    from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : defaultFrom.toISOString().slice(0, 10);
  const fromEpoch = Math.floor(new Date(fromIso).getTime() / 1000);
  const toEpoch = Math.floor(now.getTime() / 1000);

  // Waterfall
  const attempts = [];
  const sources = [
    { name: 'yahoo', fn: () => tryYahoo(ticker, fromEpoch, toEpoch) },
    { name: 'stooq', fn: () => tryStooq(ticker, fromIso) },
    { name: 'finnhub', fn: () => tryFinnhub(ticker, fromEpoch, toEpoch) },
  ];

  for (const { name, fn } of sources) {
    try {
      const rows = await fn();
      if (rows && rows.length > 0) {
        attempts.push({ source: name, status: 'success', rowCount: rows.length });
        res.setHeader(
          'Cache-Control',
          'public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400'
        );
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

  // All three sources failed — return diagnostic details
  return res.status(502).json({
    error: `All price sources failed for ticker "${ticker}"`,
    ticker,
    attempts,
  });
}
