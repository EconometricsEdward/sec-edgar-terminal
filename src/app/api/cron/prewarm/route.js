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
 *
 * Concurrency rules:
 *   - SEC: max 5 concurrent requests (SEC's published limit is 10/sec global,
 *          and we want to leave headroom for user traffic happening in parallel)
 *   - Yahoo: max 3 concurrent (Yahoo is easily angered and hits us from
 *            shared Vercel IPs, so we stay conservative)
 *
 * Time budget:
 *   - Vercel Fluid Compute allows a 300s ceiling on the current plans. We
 *     stop at 287s so the response can flush before the hard timeout.
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
import { secFetch } from '../../../../utils/secClient.js';
import { loadPriceSeries } from '../../../../utils/priceDataServer.js';
import { loadMarketAtlas } from '../../../../utils/marketResearchServer.js';
import { loadMarketSignal } from '../../../../utils/marketSignalsServer.js';

export const runtime = 'nodejs';
// Fluid-compute Vercel functions support a five-minute Hobby ceiling as of
// 2026. Keep a response-flush margin below that hard limit.
export const maxDuration = 300;
// Crucial: we do NOT want Next.js or the CDN to cache this endpoint. Every
// cron tick must actually execute.
export const dynamic = 'force-dynamic';

// Hard time budget for the whole pre-warm run. Must stay under maxDuration.
// We reserve SAFETY_MARGIN_MS at the end for the response to flush before
// Vercel kills the function.
const BUDGET_MS = 290_000;

// Concurrency caps per upstream
const SEC_CONCURRENCY = 5;
const YAHOO_CONCURRENCY = 3;

// Per-item timeouts — if a single ticker is slow, skip it rather than stall
const SEC_ITEM_TIMEOUT_MS = 10_000;
// Leave this much time at the end for response assembly before Vercel's
// hard function timeout hits.
const SAFETY_MARGIN_MS = 3_000;

const USER_AGENT = process.env.SEC_USER_AGENT || 'EDGAR Terminal Prewarmer research@example.com';
const FACTOR_BENCHMARKS = ['SPY', 'XLF', 'XLRE', 'XHB', 'XLE', 'XLY', 'XLK', 'XLI', 'XLV', 'XLU'];
const FACTOR_DEFAULT_REQUESTS = [
  { ticker: 'MSFT', requiredPrices: ['MSFT', 'SPY', 'XLK'] },
  { ticker: 'NVDA', requiredPrices: ['NVDA', 'SPY', 'XLK'] },
  { ticker: 'JPM', requiredPrices: ['JPM', 'SPY', 'XLF'] },
];
const FACTOR_DEFAULT_TICKERS = FACTOR_DEFAULT_REQUESTS.map((request) => request.ticker);

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

async function warmStockPrice(ticker, signal) {
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - 10);
  const result = await loadPriceSeries({
    ticker,
    fromIso: from.toISOString().slice(0, 10),
    forceRefresh: true,
    signal,
  });
  return {
    ticker,
    ok: true,
    provider: result.provider,
    priceBasis: result.priceBasis,
    rows: result.count,
  };
}

async function warmSubmissions(ticker, cik, signal) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await secFetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: SEC_ITEM_TIMEOUT_MS,
    retries: 0,
    signal,
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status}`);
  const data = await res.json();

  // /api/sec reads this exact namespace. Avoid parallel ticker aliases and
  // Form 4 lists that no production route consumes.
  await warmSet('submissions-cik', cik, data);
  return { ticker, ok: true };
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
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error('Prewarm deadline reached.')),
    Math.max(1, deadline - Date.now()),
  );

  const stocks = await getPopularStocks();
  const priceTickers = [...new Set([...FACTOR_BENCHMARKS, ...FACTOR_DEFAULT_TICKERS, ...stocks])];

  // Resolve tickers → CIKs up front in one batch (shared cache). We need the
  // CIK for SEC-backed warmers. Tickers without a CIK are treated as
  // price-only (still get stock price warming, skip SEC/Form4).
  const cikMap = await getOperatingTickers([...new Set(stocks)]);

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    stockCount: stocks.length,
    priceCount: priceTickers.length,
    stages: {},
    durationMs: null,
    timedOut: false,
  };
  let warmedMarketAtlas = null;
  const yahooAdjustedPrices = new Set();

  try {
    // --- Stage 1: point-in-time SEC Market atlas ----------------------------
    // Factor Lab is cache-only for SEC data, so the scheduled job must make
    // the versioned atlas ready without waiting for a visitor to open Market.
    if (timeLeft() > 120_000) {
      try {
        const market = await loadMarketAtlas({ signal: controller.signal, forceRefresh: true });
        warmedMarketAtlas = market;
        summary.stages.marketAtlas = {
          companies: market.companies.length,
          generatedAt: market.generatedAt,
          cacheStatus: market.cache?.status || 'current',
        };
      } catch (error) {
        summary.stages.marketAtlas = { failed: true, error: error.message };
      }
    } else {
      summary.stages.marketAtlas = { skipped: 'insufficient time budget' };
    }

    // --- Stage 2: Stock prices (all popular stocks) -------------------------
    // A new item needs enough budget for bounded Yahoo and fallback attempts.
    if (timeLeft() > 30_000) {
      const stage = await runPool(priceTickers, YAHOO_CONCURRENCY, async (ticker) => {
        if (timeLeft() < 25_000 || controller.signal.aborted) return;
        return await warmStockPrice(ticker, controller.signal);
      });
      summary.stages.prices = {
        succeeded: stage.results.length,
        failed: stage.errors.length,
        errors: stage.errors.slice(0, 5),
      };
      for (const result of stage.results) {
        if (result.provider === 'yahoo_finance' && result.priceBasis === 'adjusted_close') yahooAdjustedPrices.add(result.ticker);
      }
    } else {
      summary.stages.prices = { skipped: 'insufficient time budget' };
    }

    // --- Stage 3: SEC submissions (all popular stocks with a CIK) -----------
    if (timeLeft() > 25_000) {
      const items = stocks
        .filter((t) => cikMap[t])
        .map((t) => ({ ticker: t, cik: cikMap[t].cik }));
      const stage = await runPool(items, SEC_CONCURRENCY, async ({ ticker, cik }) => {
        if (timeLeft() < 20_000 || controller.signal.aborted) return;
        return await warmSubmissions(ticker, cik, controller.signal);
      });
      summary.stages.submissions = {
        succeeded: stage.results.length,
        failed: stage.errors.length,
        errors: stage.errors.slice(0, 5),
      };
    } else {
      summary.stages.submissions = { skipped: 'insufficient time budget' };
    }

    // --- Stage 4: Default Factor Lab results --------------------------------
    // This optional work runs only after the core SEC warmers and only when
    // Stage 2 just confirmed every dependency as Yahoo adjusted close. That
    // makes the calculation cache-only and prevents a second provider attempt.
    const factorCandidates = FACTOR_DEFAULT_REQUESTS.filter((item) => (
      item.requiredPrices.every((ticker) => yahooAdjustedPrices.has(ticker))
    ));
    if (timeLeft() > 35_000 && warmedMarketAtlas && factorCandidates.length) {
      const stage = await runPool(factorCandidates, 2, async ({ ticker }) => {
        if (timeLeft() < 20_000 || controller.signal.aborted) return;
        const result = await loadMarketSignal(
          { ticker, window: '3y', basis: 'ttm', cohort: 'auto', sectorProxy: 'auto' },
          { atlas: warmedMarketAtlas, signal: controller.signal },
        );
        return { ticker, status: result.status, cacheStatus: result.cache_status, dataThrough: result.data_through };
      });
      summary.stages.factorSignals = {
        eligible: factorCandidates.length,
        succeeded: stage.results.length,
        failed: stage.errors.length,
        results: stage.results,
        errors: stage.errors.slice(0, 3),
      };
    } else {
      summary.stages.factorSignals = {
        skipped: timeLeft() <= 35_000
          ? 'insufficient time budget'
          : !warmedMarketAtlas
            ? 'fresh Market atlas unavailable'
            : 'Yahoo adjusted-price dependencies were not all warmed',
      };
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  summary.durationMs = Date.now() - startedAt;
  summary.finishedAt = new Date().toISOString();
  summary.timedOut = controller.signal.aborted;

  return NextResponse.json(summary);
}
