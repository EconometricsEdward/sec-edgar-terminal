import { NextResponse } from "next/server";
import {
  readPortfolioRequestBody,
  runPortfolioResearch,
} from "../../../../utils/portfolioResearchServer.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request) {
  const limit = await checkRateLimit({
    key: `rl:portfolio-v1:${getClientIp(request)}`,
    windowMs: 60000,
    max: 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const input = await readPortfolioRequestBody(request);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(95000),
    ]);
    const result = await runPortfolioResearch(input, { signal });
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-RateLimit-Remaining": String(limit.remaining),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        schema_version: "edgar.portfolio.v1",
        error: error.status
          ? error.message
          : "The SEC identity directory is temporarily unavailable. Retry this request.",
        retryable: !error.status,
      },
      {
        status: error.status || 502,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
