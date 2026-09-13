import { gzipSync, gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { loadResearchCompany } from "../../../utils/secResearchData.js";
import { validTicker } from "../../../utils/researchWorkspace.js";
import {
  buildCompareCompany,
  COMPARE_VERSION,
} from "../../../utils/compareResearch.js";
import { warmGet, warmSet } from "../../../utils/warmCache.js";
import { packAnalysisCompany } from "../../../utils/analysisResearch.js";
import { readPreparedCompare } from "../../../utils/preparedResearchStore.js";
import { preparedDataHeaders, preparedCacheControl } from "../../../utils/secDocumentStore.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";

export const runtime = "nodejs";
export const maxDuration = 60;
const PUBLIC_RESEARCH_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400";
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
    const prepared = await readPreparedCompare({ ticker, basis, asOf, format });
    if (prepared) return NextResponse.json(prepared.payload, {
      headers: { "Cache-Control": preparedCacheControl(prepared), ...preparedDataHeaders(prepared, prepared.cacheSource) },
    });
    const id = `${COMPARE_VERSION}:${ticker}:${basis}:${asOf}`;
    const cached = await warmGet("compare-research", id);
    if (cached?.gzip) {
      try {
        const payload = JSON.parse(gunzipSync(Buffer.from(cached.gzip, "base64")).toString("utf8"));
        return NextResponse.json(
          format === "packed" ? packAnalysisCompany(payload) : payload,
          { headers: { "Cache-Control": PUBLIC_RESEARCH_CACHE, "X-Cache-Source": "warm" } },
        );
      } catch {
        /* A corrupt cache entry falls through to public SEC data. */
      }
    }
    const company = await loadResearchCompany(ticker, {
      signal: AbortSignal.timeout(25000),
    });
    const result = buildCompareCompany(company, { basis, asOf });
    await warmSet(
      "compare-research",
      id,
      { gzip: gzipSync(JSON.stringify(result)).toString("base64") },
      300,
    );
    return NextResponse.json(format === "packed" ? packAnalysisCompany(result) : result, {
      headers: { "Cache-Control": PUBLIC_RESEARCH_CACHE, "X-Cache-Source": "upstream" },
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
