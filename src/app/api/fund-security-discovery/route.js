import { discoverFundSecurity } from "../../../utils/globalFundDiscoveryServer.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") || "").trim();
  const asset = params.get("asset") || "EC";
  const cursor = params.get("cursor") || "";
  if (
    query.length < 1 ||
    query.length > 100 ||
    cursor.length > 6000 ||
    !["EC", "all"].includes(asset)
  )
    return Response.json(
      {
        error:
          "Enter a company, ticker or security identifier and a valid security type.",
      },
      { status: 400 },
    );
  const limit = await checkRateLimit({
    key: `rl:global-fund-security:${getClientIp(request)}`,
    windowMs: 60000,
    max: 20,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const result = await discoverFundSecurity({ query, asset, cursor });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const validation =
      /cursor|search has changed|Invalid search|more specific company|search date|Enter a company/i.test(
        error.message,
      );
    return Response.json(
      {
        error:
          error.message ||
          "The SEC fund search is temporarily unavailable. Please retry.",
      },
      {
        status: validation ? 400 : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
