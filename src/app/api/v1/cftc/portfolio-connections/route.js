import { isCftcEnabled } from "../../../../../utils/cftcFeature.js";
import {
  buildPortfolioMarketConnections, readPortfolioMarketConnectionsRequest,
  PORTFOLIO_MARKET_CONNECTIONS_VERSION, PORTFOLIO_MARKET_CONNECTIONS_BATCH,
} from "../../../../../utils/portfolioMarketConnectionsServer.js";
import { checkRateLimit, getClientIp, rateLimitedResponse, rateLimitHeaders } from "../../../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Schema-Version": PORTFOLIO_MARKET_CONNECTIONS_VERSION,
  "X-Portfolio-CFTC-Limit": String(PORTFOLIO_MARKET_CONNECTIONS_BATCH),
};

export async function POST(request) {
  if (!isCftcEnabled()) return Response.json({
    schemaVersion: PORTFOLIO_MARKET_CONNECTIONS_VERSION, status: "disabled",
    error: "CFTC company connections are disabled.", code: "CFTC_DISABLED", retryable: false,
  }, { status: 503, headers: HEADERS });
  // A complete 500-company scan uses 42 bounded batches, with room for retries.
  const limit = await checkRateLimit({ key: `rl:portfolio-cftc-connections:${getClientIp(request)}`, windowMs: 10 * 60_000, max: 48 });
  if (!limit.allowed) return rateLimitedResponse(limit, HEADERS);
  try {
    const input = await readPortfolioMarketConnectionsRequest(request);
    const result = await buildPortfolioMarketConnections(input, { signal: request.signal });
    return Response.json(result, { headers: { ...HEADERS, ...rateLimitHeaders(limit) } });
  } catch (cause) {
    const invalid = cause?.code === "INVALID_PORTFOLIO_CONNECTIONS_REQUEST";
    return Response.json({
      schemaVersion: PORTFOLIO_MARKET_CONNECTIONS_VERSION,
      error: invalid ? cause.message : "Company connection discovery is temporarily unavailable.",
      code: invalid ? cause.code : "PORTFOLIO_CONNECTIONS_UNAVAILABLE", retryable: !invalid,
    }, { status: invalid ? cause.status : 503, headers: { ...HEADERS, ...rateLimitHeaders(limit) } });
  }
}
