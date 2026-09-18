import { NextResponse } from "next/server";
import { validTicker } from "../../../utils/researchWorkspace.js";
import { readPreparedAnalysis } from "../../../utils/preparedFinancialData.js";
import { loadInteractiveAnalysis } from "../../../utils/analysisResearchServer.js";
import { preparedDataHeaders, preparedCacheControl, PreparedSecUnavailableError } from "../../../utils/secDocumentStore.js";
import { analysisSourceCachePolicy } from "../../../utils/analysisSourceCoverage.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get("ticker") || "").trim().toUpperCase();
  const basis = params.get("basis") || "annual";
  const asOf = params.get("asOf") || "";
  if (
    !validTicker(ticker) ||
    !["annual", "quarter", "ytd", "ttm"].includes(basis) ||
    (asOf &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
        !Number.isFinite(Date.parse(asOf)) ||
        new Date(asOf).toISOString().slice(0, 10) !== asOf ||
        asOf > new Date().toISOString().slice(0, 10)))
  ) {
    return NextResponse.json(
      {
        error:
          "Use a valid ticker, annual/quarter/ytd/ttm basis, and a valid filing cutoff no later than today.",
      },
      { status: 400 },
    );
  }
  const limit = await checkRateLimit({
    key: `rl:analysis:${getClientIp(request)}`,
    windowMs: 60000,
    max: 45,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    let prepared;
    try {
      prepared = await readPreparedAnalysis({ ticker, basis, asOf });
    } catch (error) {
      // A calculation-version rollout can precede the scheduled prepared build.
      // The bounded interactive loader still uses canonical prepared SEC inputs
      // for covered issuers and verifies the requested selection before serving.
      if (!(error instanceof PreparedSecUnavailableError)) throw error;
    }
    if (prepared) return new NextResponse(prepared.serializedPayload || JSON.stringify(prepared.payload), {
      headers: { "Content-Type": "application/json", "Cache-Control": preparedCacheControl(prepared), ...preparedDataHeaders(prepared, prepared.cacheSource) },
    });
    const result = await loadInteractiveAnalysis({ ticker, basis, asOf }, request.signal);
    return new NextResponse(result.serializedPayload, {
      headers: { "Content-Type": "application/json", "Cache-Control": analysisSourceCachePolicy(result.payload).cacheControl, "X-Cache-Source": result.cacheSource },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ticker,
        error:
          error.message ||
          "SEC data could not be retrieved. Retry this issuer.",
      },
      { status: error.status || 502, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
