import { getMarketResearch } from '../../../../utils/marketPlumbing/server.js';
import { createRiskContextRead } from '../../../../utils/riskMarketContext.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';
import { isCftcEnabled } from '../../../../utils/cftcFeature.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const derivativesEnabled = isCftcEnabled();
const read = createRiskContextRead({ read: getMarketResearch, derivativesEnabled });

export async function GET(request) {
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' };
  // One canonical URL, not one variant per ticker/filter/basis.
  if (new URL(request.url).search) return Response.json({ error: 'Market context uses one shared snapshot.' }, { status: 400, headers });
  const limit = await checkRateLimit({ key: `rl:risk-context:${getClientIp(request)}`, windowMs: 60000, max: 60 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const data = await read();
    return Response.json(data, { headers: { ...headers, 'Cache-Control': data.funding && (!derivativesEnabled || data.derivatives)
      ? 'public, max-age=60, s-maxage=900, stale-while-revalidate=900'
      : 'public, max-age=0, s-maxage=30, must-revalidate' } });
  } catch {
    return Response.json({ error: 'Market context is temporarily unavailable. Company financials remain available.' }, { status: 503, headers: { ...headers, 'Retry-After': '30' } });
  }
}
