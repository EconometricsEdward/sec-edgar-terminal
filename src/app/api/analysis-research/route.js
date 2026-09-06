import { gzipSync, gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { loadResearchCompany } from "../../../utils/secResearchData.js";
import { validTicker } from "../../../utils/researchWorkspace.js";
import {
  buildAnalysisCompany,
  packAnalysisCompany,
  ANALYSIS_VERSION,
} from "../../../utils/analysisResearch.js";
import { warmGet, warmSet } from "../../../utils/warmCache.js";
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
    const id = `${ANALYSIS_VERSION}:${ticker}:${basis}:${asOf}`;
    const cached = await warmGet("analysis-research", id);
    if (cached?.gzip) {
      try {
        return NextResponse.json(
          JSON.parse(
            gunzipSync(Buffer.from(cached.gzip, "base64")).toString("utf8"),
          ),
          { headers: { "Cache-Control": "private, no-store" } },
        );
      } catch {
        /* A corrupt cache entry falls through to public SEC data. */
      }
    }
    const company = await loadResearchCompany(ticker, {
      signal: AbortSignal.timeout(25000),
    });
    const result = packAnalysisCompany(
      buildAnalysisCompany(company, { basis, asOf }),
    );
    await warmSet(
      "analysis-research",
      id,
      { gzip: gzipSync(JSON.stringify(result)).toString("base64") },
      300,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ticker,
        error:
          error.message ||
          "SEC data could not be retrieved. Retry this issuer.",
      },
      { status: 502 },
    );
  }
}
