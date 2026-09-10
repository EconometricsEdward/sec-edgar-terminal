import { withFactorReadingGuide } from '../../../../utils/marketFactorInsights.js';
import {
  MARKET_SIGNALS_METHODOLOGY_VERSION,
  MARKET_SIGNALS_SCHEMA_VERSION,
  loadMarketSignal,
  validateMarketSignalOptions,
} from '../../../../utils/marketSignalsServer.js';
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
  rateLimitHeaders,
} from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ALLOWED_PARAMETERS = new Set(['ticker', 'window', 'basis', 'cohort', 'sector_proxy']);
const PUBLIC_API_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version, X-Methodology-Version, X-Data-Through, X-Cache-Source, X-Data-Stale, Warning, Retry-After' };

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
  const limit = await checkRateLimit({
    key: `rl:market-signals-v1:${getClientIp(request)}`,
    windowMs: 10 * 60_000,
    max: 60,
    cost: 6,
  });
  if (!limit.allowed) return rateLimitedResponse(limit, PUBLIC_API_HEADERS);

  try {
    const options = readRequest(request.url);
    const result = withFactorReadingGuide(await loadMarketSignal(options));
    const stale = result.cache_status === 'stale'
      || result.status === 'stale'
      || result.quality?.sec_snapshot_status === 'stale';
    const degraded = result.warnings?.some((warning) => warning.code === 'PRICE_BASIS_UNVERIFIED');
    const withheld = result.status === 'withheld';
    return Response.json(result, {
      headers: {
        ...PUBLIC_API_HEADERS,
        'Cache-Control': degraded || withheld
          ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=60'
          : stale
          ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=604800'
          : 'public, max-age=300, s-maxage=21600, stale-while-revalidate=43200, stale-if-error=604800',
        'Content-Type': 'application/json; charset=utf-8',
        Link: '</schemas/market-signals-v1.schema.json>; rel="describedby"; type="application/schema+json", </market/factors>; rel="about"',
        'X-Schema-Version': MARKET_SIGNALS_SCHEMA_VERSION,
        'X-Methodology-Version': MARKET_SIGNALS_METHODOLOGY_VERSION,
        'X-Data-Through': result.data_through || 'unavailable',
        'X-Cache-Source': result.cache_status || 'computed',
        ...(stale ? { Warning: '110 - "Response is stale"', 'X-Data-Stale': '1' } : {}),
      },
    });
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

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...PUBLIC_API_HEADERS,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Accept',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
}
