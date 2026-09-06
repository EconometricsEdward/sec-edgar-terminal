import { loadFilingsCompany } from "../../../utils/filingsResearchServer.js";
import { summarizeWorkspaceFilings } from "../../../utils/workspaceReview.js";
import { validTicker } from "../../../utils/researchWorkspace.js";
import { validFilingDate } from "../../../utils/filingsResearch.js";
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
  const since = params.get("since") || "";
  const headers = { "Cache-Control": "private, no-store" };
  if (!validTicker(ticker) || (since && !validFilingDate(since)))
    return Response.json(
      { error: "Provide a valid ticker and review date." },
      { status: 400, headers },
    );
  const limit = await checkRateLimit({
    key: `rl:workspace-check:${getClientIp(request)}`,
    windowMs: 60000,
    max: 40,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const company = await loadFilingsCompany(ticker, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    });
    if (company.kind === "fund")
      return Response.json(
        {
          error:
            "This ticker is a fund. Open its Funds page to review N-PORT holdings.",
          kind: "fund",
        },
        { status: 422, headers },
      );
    return Response.json(summarizeWorkspaceFilings(company, since), {
      headers,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error.message ||
          "SEC filings could not be checked. Retry this company.",
      },
      { status: error.status || 502, headers },
    );
  }
}
