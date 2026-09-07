import { createHash } from "node:crypto";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";
import {
  loadWorkspaceFunds,
  fundWorkspaceMetadata,
} from "../../../utils/fundWorkspaceServer.js";
import {
  compareFundPortfolios,
  fundComparisonCsv,
} from "../../../utils/fundComparison.js";
import {
  searchFundHoldings,
  searchFundHoldingsCsv,
} from "../../../utils/fundSecuritySearch.js";
import {
  buildFundAllocation,
  fundAllocationCsv,
  validateFundAllocations,
} from "../../../utils/fundAllocation.js";
import {
  buildFundChanges,
  fundChangesCsv,
} from "../../../utils/fundChanges.js";
export const runtime = "nodejs";
export const maxDuration = 120;
const tickerPattern = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;
function objectParameter(value, name) {
  if (!value) return {};
  if (value.length > 1500) throw new Error(`${name} is too large.`);
  let result;
  try {
    result = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a valid object.`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error(`${name} must be a valid object.`);
  return result;
}
function csvResponse(csv, filename) {
  const bytes = new TextEncoder().encode("\uFEFF" + csv);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 32768));
        offset += 32768;
      },
    }),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  let mode, tickers, reports, weights, before, after, allocation;
  try {
    mode = p.get("mode") || "compare";
    if (!["compare", "search", "allocation", "changes"].includes(mode))
      throw new Error("Choose a supported fund research mode.");
    const raw =
      (mode === "changes"
        ? p.get("ticker") || p.get("tickers")
        : p.get("tickers")) || "";
    const list = raw.split(",").map((v) => v.trim().toUpperCase());
    if (
      list.length > 4 ||
      !list.length ||
      list.some((v) => !tickerPattern.test(v))
    )
      throw new Error("Choose between one and four valid fund tickers.");
    tickers = [...new Set(list)];
    if (mode === "changes" && tickers.length !== 1)
      throw new Error("Choose one fund for report changes.");
    reports = objectParameter(p.get("reports"), "Reports");
    for (const [ticker, accession] of Object.entries(reports))
      if (
        !tickers.includes(ticker) ||
        typeof accession !== "string" ||
        (accession && !accessionPattern.test(accession))
      )
        throw new Error(
          "Report selections must reference the selected funds and valid accessions.",
        );
    weights = objectParameter(p.get("weights"), "Allocations");
    for (const [ticker, weight] of Object.entries(weights))
      if (
        !tickers.includes(ticker) ||
        !["string", "number"].includes(typeof weight) ||
        String(weight).length > 40
      )
        throw new Error(
          "Allocation entries must reference the selected funds.",
        );
    if (mode === "allocation") {
      allocation = validateFundAllocations(tickers, weights);
      if (!allocation.valid) throw new Error(allocation.errors.join(" "));
    }
    before = p.get("before") || "";
    after = p.get("after") || "";
    if (
      (before && !accessionPattern.test(before)) ||
      (after && !accessionPattern.test(after))
    )
      throw new Error("Choose valid filing accessions.");
    if (before && before === after)
      throw new Error("Choose two different filings.");
  } catch (error) {
    return Response.json(
      { error: error.message },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const limit = await checkRateLimit({
    key: `rl:fund-workspace:${getClientIp(request)}`,
    windowMs: 60000,
    max: 45,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const loaded = await loadWorkspaceFunds(
      mode === "allocation"
        ? tickers.filter((ticker) => allocation.weights[ticker] > 0)
        : tickers,
      mode === "changes" && after ? { [tickers[0]]: after } : reports,
    );
    const { portfolios, errors } = loaded;
    let result,
      exporter,
      resolvedBefore = "",
      resolvedAfter = "";
    if (mode === "compare") {
      result = compareFundPortfolios(portfolios, {
        left: p.get("left") || tickers[0],
        right: p.get("right") || tickers[1],
        scope: ["all", "shared", "left", "right"].includes(p.get("scope"))
          ? p.get("scope")
          : "all",
        query: p.get("q") || "",
      });
      exporter = fundComparisonCsv;
    } else if (mode === "search") {
      result = searchFundHoldings(portfolios, {
        query: p.get("q") || "",
        asset: p.get("asset") || "",
        country: p.get("country") || "",
      });
      exporter = searchFundHoldingsCsv;
    } else if (mode === "allocation") {
      result = buildFundAllocation(portfolios, { tickers, weights, errors });
      exporter = fundAllocationCsv;
    } else {
      const newer = portfolios[0] || null;
      let older = null;
      resolvedAfter = newer?.accession || after;
      const automatic = newer?.reports
        ?.filter((r) => r.reportDate && r.reportDate < newer.asOf)
        .sort(
          (a, b) =>
            b.reportDate.localeCompare(a.reportDate) ||
            b.filingDate.localeCompare(a.filingDate),
        )[0];
      resolvedBefore = before || automatic?.accession || "";
      if (newer && resolvedBefore && resolvedBefore !== newer.accession) {
        const previous = await loadWorkspaceFunds(tickers, {
          [tickers[0]]: resolvedBefore,
        });
        older = previous.portfolios[0] || null;
        errors.push(
          ...previous.errors.map((error) => ({
            ...error,
            message: `Earlier report: ${error.message}`,
          })),
        );
        if (older) portfolios.push(older);
      }
      result = buildFundChanges(older, newer, {
        scope: p.get("scope") || "all",
        query: p.get("q") || p.get("query") || "",
      });
      exporter = fundChangesCsv;
    }
    const resolvedReports = Object.fromEntries(
      portfolios.map((fund) => [fund.ticker, fund.accession]),
    );
    if (mode === "changes" && resolvedAfter)
      resolvedReports[tickers[0]] = resolvedAfter;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (p.get("format") === "csv")
      return csvResponse(
        exporter({ ...result, errors }),
        `fund-${mode}-${tickers.join("-")}.csv`,
      );
    const pageCount = Math.max(1, Math.ceil(rows.length / 50)),
      rawPage = Number(p.get("page"));
    const page = Math.min(
      pageCount,
      Math.max(1, Number.isFinite(rawPage) ? Math.floor(rawPage) : 1),
    );
    return Response.json(
      {
        mode,
        funds: portfolios.map(fundWorkspaceMetadata),
        errors,
        resolvedReports,
        ...(mode === "changes" ? { resolvedBefore, resolvedAfter } : {}),
        requestFingerprint: createHash("sha256")
          .update(request.url)
          .digest("hex")
          .slice(0, 16),
        result: { ...result, rows: rows.slice((page - 1) * 50, page * 50) },
        pagination: { page, pageCount, pageSize: 50, total: rows.length },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.warn("[fund-workspace]", mode, error.message);
    return Response.json(
      {
        error:
          error.message || "Fund research could not be loaded. Please retry.",
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
