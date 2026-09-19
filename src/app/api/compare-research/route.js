import { NextResponse } from "next/server";
import { validTicker } from "../../../utils/researchWorkspace.js";
import { unpackAnalysisCompany } from "../../../utils/analysisResearch.js";
import { loadCompareResearch } from "../../../utils/compareResearchServer.js";
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
  const format = params.get("format") || "expanded";
  if (
    !validTicker(ticker) ||
    !["annual", "quarter", "ttm"].includes(basis) ||
    !["expanded", "packed"].includes(format) ||
    (asOf &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
        !Number.isFinite(Date.parse(asOf)) ||
        new Date(asOf).toISOString().slice(0, 10) !== asOf ||
        asOf > new Date().toISOString().slice(0, 10)))
  ) {
    return NextResponse.json(
      {
        error:
          "Use a valid ticker, annual/quarter/ttm basis, expanded/packed format, and a valid filing cutoff no later than today.",
      },
      { status: 400 },
    );
  }
  const limit = await checkRateLimit({
    key: `rl:compare:${getClientIp(request)}`,
    windowMs: 60000,
    max: 45,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const result = await loadCompareResearch({ ticker, basis, asOf }, request.signal);
    return new NextResponse(format === "packed" ? result.serializedPayload : JSON.stringify(unpackAnalysisCompany(result.payload)), {
      headers: { "Content-Type": "application/json", ...result.headers },
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
