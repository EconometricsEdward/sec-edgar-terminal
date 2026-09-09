import { createHash } from 'node:crypto';
import {
  MARKET_SIGNALS_METHODOLOGY_VERSION,
  MARKET_SIGNALS_SCHEMA_VERSION,
  loadMarketSignal,
  validateMarketSignalOptions,
} from '../../../../utils/marketSignalsServer.js';
import {
  checkRateLimit,
  getClientIp,
  rateLimitHeaders,
} from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ALLOWED_PARAMETERS = new Set(['ticker', 'window', 'basis', 'cohort', 'sector_proxy']);
const PUBLIC_API_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Methodology-Version, X-Data-Through, X-Cache-Source, X-Data-Stale, Warning, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Remaining, ETag, Last-Modified, Content-Location, Server-Timing, Link' };

function canonicalLocation(result) {
  const request = result.request || {};
  const params = new URLSearchParams({
    ticker: request.ticker || '',
    window: request.window || '3y',
    basis: request.basis || 'ttm',
    cohort: request.cohort || 'auto',
    sector_proxy: request.sector_proxy || 'auto',
  });
  return `/api/v1/market-signals?${params.toString()}`;
}

function matchesIfNoneMatch(value, etag) {
  if (!value) return false;
  return value.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

function rateLimitedMarketSignalResponse(limit) {
  const retryAfter = String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000)));
  return Response.json({
    schema_version: MARKET_SIGNALS_SCHEMA_VERSION,
    error: 'Rate limit exceeded. Please wait before retrying.',
    code: 'RATE_LIMITED',
    details: null,
    retryable: true,
    links: {
      methodology: 'https://secedgarterminal.com/market/factors',
      schema: 'https://secedgarterminal.com/schemas/market-signals-v1.schema.json',
    },
  }, {
    status: 429,
    headers: {
      ...PUBLIC_API_HEADERS,
      ...rateLimitHeaders(limit),
      'Retry-After': retryAfter,
      'Cache-Control': 'private, no-store',
    },
  });
}

function readRequest(url) {
  const { searchParams } = new URL(url);
  for (const key of searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) {
      const error = new Error(`Unknown query parameter: ${key}`);
      error.code = 'UNKNOWN_QUERY_PARAMETER';
      error.status = 400;
      throw error;
    }
    if (searchParams.getAll(key).length > 1) {
      const error = new Error(`Query parameter may appear only once: ${key}`);
      error.code = 'DUPLICATE_QUERY_PARAMETER';
      error.status = 400;
      throw error;
    }
  }
  return validateMarketSignalOptions({
    ticker: searchParams.get('ticker') || '',
    window: searchParams.get('window') || '3y',
    basis: searchParams.get('basis') || 'ttm',
    cohort: searchParams.get('cohort') || 'auto',
    sectorProxy: searchParams.get('sector_proxy') || 'auto',
  });
}

export async function GET(request) {
  const startedAt = performance.now();
  const limit = await checkRateLimit({
    key: `rl:market-signals-v1:${getClientIp(request)}`,
    windowMs: 10 * 60_000,
    max: 60,
    cost: 6,
  });
  const rateLimitMs = performance.now() - startedAt;
  if (!limit.allowed) return rateLimitedMarketSignalResponse(limit);

  try {
    const options = readRequest(request.url);
    const result = await loadMarketSignal(options);
    const body = JSON.stringify(result);
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    const stale = result.cache_status === 'stale'
      || result.status === 'stale'
      || result.quality?.sec_snapshot_status === 'stale';
    const degraded = result.warnings?.some((warning) => warning.code === 'PRICE_BASIS_UNVERIFIED');
    const headers = {
      ...PUBLIC_API_HEADERS,
      'Cache-Control': degraded
          ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
          : stale
          ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=604800'
          : 'public, max-age=300, s-maxage=21600, stale-while-revalidate=43200, stale-if-error=604800',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Location': canonicalLocation(result),
      ETag: etag,
      'Last-Modified': new Date(result.generated_at).toUTCString(),
      Link: '</schemas/market-signals-v1.schema.json>; rel="describedby"; type="application/schema+json", </market/factors>; rel="about"',
      'Server-Timing': `rate-limit;dur=${rateLimitMs.toFixed(1)}, total;dur=${(performance.now() - startedAt).toFixed(1)}`,
      'X-Schema-Version': MARKET_SIGNALS_SCHEMA_VERSION,
      'X-Methodology-Version': MARKET_SIGNALS_METHODOLOGY_VERSION,
      'X-Data-Through': result.data_through || 'unavailable',
      'X-Cache-Source': result.cache_status || 'computed',
      ...(stale ? { Warning: '110 - "Response is stale"', 'X-Data-Stale': '1' } : {}),
    };
    if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return Response.json(
      {
        schema_version: MARKET_SIGNALS_SCHEMA_VERSION,
        error: error?.message || 'The market model is temporarily unavailable.',
        code: error?.code || 'MARKET_SIGNAL_UNAVAILABLE',
        details: error?.details || null,
        retryable: !error?.status || error.status >= 500,
        links: {
          methodology: 'https://secedgarterminal.com/market/factors',
          schema: 'https://secedgarterminal.com/schemas/market-signals-v1.schema.json',
        },
      },
      {
        status: error?.status || 502,
        headers: { ...PUBLIC_API_HEADERS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' },
      },
    );
  }
}

export async function HEAD() {
  return new Response(null, {
    status: 405,
    headers: {
      ...PUBLIC_API_HEADERS,
      Allow: 'GET, OPTIONS',
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_API_HEADERS,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept, If-None-Match',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
}
