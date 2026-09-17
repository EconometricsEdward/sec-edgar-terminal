import { isCftcEnabled } from '../../../../../utils/cftcFeature.js';
import { PORTFOLIO_MARKET_COMPARISON_VERSION, loadPortfolioMarketComparison } from '../../../../../utils/portfolioMarketComparisonServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from '../../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Schema-Version, Link, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-RateLimit-Remaining, Retry-After',
  'X-Schema-Version': PORTFOLIO_MARKET_COMPARISON_VERSION,
};

export async function GET(request) {
  if (!isCftcEnabled()) return Response.json({
    schemaVersion: PORTFOLIO_MARKET_COMPARISON_VERSION, status: 'disabled',
    error: 'CFTC data is currently disabled.', code: 'CFTC_DISABLED', retryable: false,
  }, { status: 503, headers: { ...HEADERS, 'Cache-Control': 'private, no-store' } });
  const limit = await checkRateLimit({ key: `rl:cftc-market-comparison:${PORTFOLIO_MARKET_COMPARISON_VERSION}:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 20 });
  if (!limit.allowed) return rateLimitedResponse(limit, HEADERS);
  if (new URL(request.url).searchParams.size) return Response.json({
    schemaVersion: PORTFOLIO_MARKET_COMPARISON_VERSION,
    error: 'The public market comparison does not accept query parameters.', code: 'UNKNOWN_QUERY_PARAMETER', retryable: false,
  }, { status: 400, headers: { ...HEADERS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
  try {
    const result = await loadPortfolioMarketComparison({ signal: request.signal });
    return Response.json(result, { headers: {
      ...HEADERS, ...rateLimitHeaders(limit),
      Link: '</schemas/portfolio-market-comparison-v1.schema.json>; rel="describedby"; type="application/schema+json"',
      'Cache-Control': result.status === 'ready'
        ? 'public, max-age=300, s-maxage=3600, stale-while-revalidate=3600'
        : 'public, max-age=0, s-maxage=60',
    } });
  } catch {
    return Response.json({
      schemaVersion: PORTFOLIO_MARKET_COMPARISON_VERSION, status: 'unavailable',
      error: 'Prepared CFTC market comparison is temporarily unavailable.', code: 'CFTC_COMPARISON_UNAVAILABLE', retryable: true,
    }, { status: 503, headers: { ...HEADERS, ...rateLimitHeaders(limit), 'Cache-Control': 'private, no-store' } });
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: {
    ...HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400',
  } });
}
