/**
 * Public stock-price proxy. Provider retrieval lives in priceDataServer so
 * charting and econometric research share one provenance-aware pipeline.
 */
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../utils/rateLimit.js';
import { loadPriceSeries, normalizePriceTicker } from '../../../utils/priceDataServer.js';
import { recordView } from '../../../utils/viewTracker.js';

export const runtime = 'nodejs';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const ALLOWED_PARAMETERS = new Set(['ticker', 'from']);

function defaultFromDate(now = new Date()) {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - 10);
  return date.toISOString().slice(0, 10);
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function requestError(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

export function parsePriceRequest(url, now = new Date()) {
  const parsed = new URL(url);
  for (const key of parsed.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) throw requestError(`Unknown query parameter: ${key}`, 'UNKNOWN_QUERY_PARAMETER');
    if (parsed.searchParams.getAll(key).length > 1) throw requestError(`Query parameter may appear only once: ${key}`, 'DUPLICATE_QUERY_PARAMETER');
  }
  const rawTicker = parsed.searchParams.get('ticker');
  const ticker = normalizePriceTicker(rawTicker);
  if (!ticker) throw requestError(rawTicker === null ? 'Missing ticker parameter' : 'Invalid ticker format', rawTicker === null ? 'MISSING_TICKER' : 'INVALID_TICKER');
  const earliest = defaultFromDate(now);
  const exclusiveEnd = now.toISOString().slice(0, 10);
  const requestedFrom = parsed.searchParams.get('from');
  if (requestedFrom !== null && !validIsoDate(requestedFrom)) throw requestError('Invalid from date; use YYYY-MM-DD.', 'INVALID_FROM_DATE');
  const from = requestedFrom || earliest;
  if (from < earliest) throw requestError('The from date may not be more than ten years ago.', 'LOOKBACK_TOO_LARGE');
  if (from >= exclusiveEnd) throw requestError('The from date must precede today.', 'FROM_DATE_NOT_COMPLETE');
  const canonical = new URL(parsed.pathname, parsed.origin);
  canonical.searchParams.set('ticker', ticker);
  if (from !== earliest) canonical.searchParams.set('from', from);
  return { ticker, from, canonicalUrl: canonical.toString(), isCanonical: parsed.toString() === canonical.toString() };
}

export async function GET(request) {
  let parsed;
  try {
    parsed = parsePriceRequest(request.url);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || 'INVALID_REQUEST' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const { ticker, from } = parsed;
  if (!parsed.isCanonical) {
    return new Response(null, {
      status: 308,
      headers: { Location: parsed.canonicalUrl, 'Cache-Control': 'public, max-age=3600, s-maxage=86400' },
    });
  }

  const ip = getClientIp(request);
  const limit = await checkRateLimit({
    key: `rl:stock:${ip}`,
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  recordView(ticker, ip);

  try {
    const result = await loadPriceSeries({ ticker, fromIso: from });
    return Response.json(
      {
        ticker,
        // Backward compatibility: `source` historically meant cache or provider.
        source: result.cacheStatus.startsWith('warm') ? 'warm' : result.provider === 'yahoo_finance' ? 'yahoo' : 'stooq',
        provider: result.provider,
        cacheStatus: result.cacheStatus,
        priceBasis: result.priceBasis,
        adjustmentCoverage: result.adjustmentCoverage,
        retrievedAt: result.retrievedAt,
        from: result.from,
        to: result.to,
        count: result.count,
        // Preserve the existing chart contract without exposing the internal
        // raw-versus-adjusted fields used by provenance and eligibility gates.
        prices: result.prices.map(({ date, open, high, low, close, volume }) => ({
          date, open, high, low, close, volume,
        })),
        attempts: result.attempts,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=604800',
          'X-Cache-Source': result.cacheStatus,
          'X-Price-Provider': result.provider,
          'X-Price-Basis': result.priceBasis,
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error: error.message || `Price sources unavailable for ticker "${ticker}"`,
        code: error.code || 'PRICE_DATA_UNAVAILABLE',
        ticker,
        note: 'Yahoo Finance adjusted prices are primary. Stooq is a provisional fallback because its adjustment treatment is not assumed equivalent.',
      },
      {
        status: error.status || 502,
        headers: { ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' },
      },
    );
  }
}
