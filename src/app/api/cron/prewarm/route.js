/**
 * Pre-warmer cron endpoint — GET /api/cron/prewarm
 *
 * Runs on a schedule (see vercel.json → crons). For each popular ticker,
 * fetches upstream data and stores it in the warm cache (Upstash). API
 * routes check the warm cache on miss before calling upstream, so users
 * hitting "cold" cache windows get instant responses.
 *
 * What this covers per ticker:
 *   - Stock price history  (Yahoo → Stooq fallback)
 *   - SEC submissions      (data.sec.gov)
 *   - Recent Form 4s       (SEC filings for the last ~20 Form 4 accessions)
 *
 * Concurrency rules:
 *   - SEC: max 5 concurrent requests (SEC's published limit is 10/sec global,
 *          and we want to leave headroom for user traffic happening in parallel)
 *   - Yahoo: max 3 concurrent (Yahoo is easily angered and hits us from
 *            shared Vercel IPs, so we stay conservative)
 *
 * Time budget:
 *   - Vercel Pro cron max duration is 300s (5 min). We aim to finish in
 *     ~4 min to leave safety margin.
 *   - If we approach the budget, we emit partial results rather than
 *     timing out mid-write and leaving cache in a half-state.
 *
 * Security:
 *   - Requires the `CRON_SECRET` env var. Vercel's cron automatically
 *     attaches the `Authorization: Bearer <CRON_SECRET>` header to scheduled
 *     invocations. Manual invocations must do the same. Without this, anyone
 *     on the internet could trigger expensive upstream fetches from your IP.
 */

import { NextResponse } from 'next/server';
import { getPopularStocks } from '../../../../utils/popularTickers.js';
import { getOperatingTickers } from '../../../../utils/tickerMap.js';
import { warmSet, warmCacheEnabled } from '../../../../utils/warmCache.js';

export const runtime = 'nodejs';
// Vercel function duration cap:
//   Hobby plan: 60 seconds (our current setting)
//   Pro plan:   300 seconds — when you upgrade, change this to 300 and
//               bump BUDGET_MS below to 290_000 for full pre-warm coverage.
export const maxDuration = 60;
// Crucial: we do NOT want Next.js or the CDN to cache this endpoint. Every
// cron tick must actually execute.
export const dynamic = 'force-dynamic';

// Hard time budget for the whole pre-warm run. Must stay under maxDuration.
// We reserve SAFETY_MARGIN_MS at the end for the response to flush before
// Vercel kills the function.
const BUDGET_MS = 55_000;

// Concurrency caps per upstream
const SEC_CONCURRENCY = 5;
const YAHOO_CONCURRENCY = 3;

// Per-item timeouts — if a single ticker is slow, skip it rather than stall
const YAHOO_ITEM_TIMEOUT_MS = 10_000;
const SEC_ITEM_TIMEOUT_MS = 10_000;
// Leave this much time at the end for response assembly before Vercel's
// hard function timeout hits.
const SAFETY_MARGIN_MS = 3_000;

const USER_AGENT = process.env.SEC_USER_AGENT || 'EDGAR Terminal Prewarmer research@example.com';

// ---------------------------------------------------------------------------
// Small concurrency-pool helper. Runs `worker(item)` for each item in `items`
// with at most `limit` in flight at once. Individual failures are captured
// and returned alongside successes — one bad ticker doesn't kill the batch.
// ---------------------------------------------------------------------------
async function runPool(items, limit, worker) {
  const results = [];
  const errors = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const r = await worker(item);
        if (r !== undefined) results.push(r);
      } catch (err) {
        errors.push({ item, error: err.message });
      }
    }
  });
  await Promise.all(workers);
  return { results, errors };
}

// ---------------------------------------------------------------------------
// Individual warmers. Each is responsible for: (1) fetching upstream, (2)
// writing to the warm cache under an agreed key, (3) returning a brief
// status object for the response summary.
// ---------------------------------------------------------------------------

async function warmStockPrice(ticker) {
  const yahooTicker = ticker.replace(/\./g, '-');
  const now = Math.floor(Date.now() / 1000);
  const tenYearsAgo = now - 10 * 365 * 24 * 60 * 60;
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}` +
    `?period1=${tenYearsAgo}&period2=${now}&interval=1d&events=history&includeAdjustedClose=true`;

  const res = await fetch(url, {
    headers: {
      // Same UA spoof the stock route uses — Yahoo treats default Node UA as bot traffic
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
    },
    signal: AbortSignal.timeout(YAHOO_ITEM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const data = await res.json();
  if (data.chart?.error) throw new Error(`Yahoo error: ${data.chart.error.code}`);

  // Store the raw Yahoo payload verbatim. The stock route will re-parse it
  // using its existing logic rather than us trying to reimplement the
  // parsing here. This keeps the warm-layer cheap to maintain — if the
  // route's parsing changes, we don't have to update the warmer.
  await warmSet('stock-raw-yahoo', ticker, data);
  return { ticker, ok: true };
}

async function warmSubmissions(ticker, cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(SEC_ITEM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
  const data = await res.json();

  // Store both by ticker (for the common lookup path) and by CIK (for any
  // route that works directly with CIKs)
  await Promise.all([
    warmSet('submissions', ticker, data),
    warmSet('submissions-cik', cik, data),
  ]);
  return { ticker, ok: true };
}

async function warmForm4s(ticker, cik) {
  // Get submissions to find recent Form 4 accessions
  const subs = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(SEC_ITEM_TIMEOUT_MS),
  });
  if (!subs.ok) throw new Error(`SEC submissions HTTP ${subs.status}`);
  const data = await subs.json();

  const recent = data?.filings?.recent;
  if (!recent) return { ticker, ok: true, note: 'no recent filings' };

  // Find the 10 most recent Form 4 accessions (insider trades). We don't
  // pre-warm every Form 4 for the last decade — just the recent ones most
  // likely to be viewed.
  const accessions = [];
  for (let i = 0; i < recent.form.length && accessions.length < 10; i++) {
    if (recent.form[i] === '4') {
      accessions.push(recent.accessionNumber[i]);
    }
  }

  if (accessions.length === 0) return { ticker, ok: true, note: 'no form 4s' };

  // Store the accession list, not the parsed XML. The form4 route's own
  // CDN cache is what handles the actual XML — once a user (or our own
  // pre-warm pingback below) touches it, it'll stay cached for 24h.
  await warmSet('form4-recent', ticker, { cik, accessions });
  return { ticker, ok: true, count: accessions.length };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request) {
  // Auth: Vercel's cron system automatically attaches the value of the
  // CRON_SECRET env var as `Authorization: Bearer <value>`. The env var MUST
  // be named CRON_SECRET exactly — Vercel looks for that specific name and
  // won't find a differently-named variable like `CRON`.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error: 'Server misconfigured: CRON_SECRET env var not set. ' +
               'Note: Vercel requires this env var to be named CRON_SECRET ' +
               'exactly — other names will not be auto-attached to cron calls.',
      },
      { status: 500 }
    );
  }
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!warmCacheEnabled()) {
    return NextResponse.json(
      { error: 'Warm cache disabled (KV/Upstash env vars not set)' },
      { status: 503 }
    );
  }

  const startedAt = Date.now();
  const deadline = startedAt + (BUDGET_MS - SAFETY_MARGIN_MS);
  const timeLeft = () => deadline - Date.now();

  const stocks = await getPopularStocks();

  // Resolve tickers → CIKs up front in one batch (shared cache). We need the
  // CIK for SEC-backed warmers. Tickers without a CIK are treated as
  // price-only (still get stock price warming, skip SEC/Form4).
  const cikMap = await getOperatingTickers([...new Set(stocks)]);

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    stockCount: stocks.length,
    stages: {},
    durationMs: null,
    timedOut: false,
  };

  // --- Stage 1: Stock prices (all popular stocks) ---------------------------
  // Yahoo is fragile, so do this first before its shared-IP quota gets eaten
  // by the SEC work below which also shares the same egress IPs.
  if (timeLeft() > 30_000) {
    const stage = await runPool(stocks, YAHOO_CONCURRENCY, async (ticker) => {
      if (timeLeft() < 5_000) return; // bail if we're running out of time
      return await warmStockPrice(ticker);
    });
    summary.stages.prices = {
      succeeded: stage.results.length,
      failed: stage.errors.length,
      errors: stage.errors.slice(0, 5), // truncate errors to keep response small
    };
  } else {
    summary.stages.prices = { skipped: 'insufficient time budget' };
  }

  // --- Stage 2: SEC submissions (all popular stocks with a CIK) -------------
  if (timeLeft() > 30_000) {
    const items = stocks
      .filter((t) => cikMap[t])
      .map((t) => ({ ticker: t, cik: cikMap[t].cik }));
    const stage = await runPool(items, SEC_CONCURRENCY, async ({ ticker, cik }) => {
      if (timeLeft() < 5_000) return;
      return await warmSubmissions(ticker, cik);
    });
    summary.stages.submissions = {
      succeeded: stage.results.length,
      failed: stage.errors.length,
      errors: stage.errors.slice(0, 5),
    };
  } else {
    summary.stages.submissions = { skipped: 'insufficient time budget' };
  }

  // --- Stage 3: Form 4 accession lists (all popular stocks with a CIK) ------
  // This does another submissions fetch per ticker (a small % of wasted work)
  // because Stage 2 doesn't hand us the parsed forms. The duplication is
  // cheap on SEC's side and keeps the stages independent.
  if (timeLeft() > 30_000) {
    const items = stocks
      .filter((t) => cikMap[t])
      .map((t) => ({ ticker: t, cik: cikMap[t].cik }));
    const stage = await runPool(items, SEC_CONCURRENCY, async ({ ticker, cik }) => {
      if (timeLeft() < 5_000) return;
      return await warmForm4s(ticker, cik);
    });
    summary.stages.form4 = {
      succeeded: stage.results.length,
      failed: stage.errors.length,
      errors: stage.errors.slice(0, 5),
    };
  } else {
    summary.stages.form4 = { skipped: 'insufficient time budget' };
  }

  summary.durationMs = Date.now() - startedAt;
  summary.finishedAt = new Date().toISOString();

  return NextResponse.json(summary);
}
