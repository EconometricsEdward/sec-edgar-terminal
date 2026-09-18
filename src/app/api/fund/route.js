import { loadFund, loadFundDiscovery } from "../../../utils/fundResearchServer.js";
import {
  filterHoldings,
  holdingsCsv,
  portfolioOverlap,
  fundDiscoverySummary,
} from "../../../utils/fundResearch.js";
import {
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
} from "../../../utils/rateLimit.js";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function GET(request) {
  const p = new URL(request.url).searchParams;
  const ticker = (p.get("ticker") || "").trim().toUpperCase();
  const compare = (p.get("compare") || "").trim().toUpperCase();
  const accession = p.get("accession") || "";
  const view = p.get("view") || "holdings";
  if (
    !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker) ||
    (compare && !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(compare)) ||
    (accession && !/^\d{10}-\d{2}-\d{6}$/.test(accession)) ||
    !["holdings", "summary"].includes(view) ||
    (p.has("refresh") && (view !== "summary" || p.get("refresh") !== "1")) ||
    (view === "summary" && (compare || p.has("format") || p.has("page") || ["q", "asset", "country", "sort", "direction"].some(key => p.has(key))))
  )
    return Response.json(
      { error: "Enter a valid fund ticker, filing accession and view. Summary views describe the complete portfolio." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  const limit = await checkRateLimit({
    key: `rl:fund:${getClientIp(request)}`,
    windowMs: 60000,
    max: 90,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const refresh = p.get("refresh") === "1";
    const data = view === "summary"
      ? await loadFundDiscovery(ticker, accession, { signal: request.signal, refresh })
      : await loadFund(ticker, accession, { signal: request.signal });
    const headers = {
      "Cache-Control":
        data.status !== "ready" || refresh
          ? "no-store"
          : data.cache?.stale
            ? "public, s-maxage=60, stale-while-revalidate=60"
            : "public, s-maxage=1800, stale-while-revalidate=3600",
    };
    if (view === "summary") return Response.json(fundDiscoverySummary(data), { headers });
    if (data.status !== "ready") return Response.json(data, { headers });
    if (compare) {
      const other = await loadFund(compare, "", { signal: request.signal });
      if (other.status !== "ready")
        return Response.json(
          { error: `${compare}: ${other.reason}` },
          { status: 422 },
        );
      return Response.json(portfolioOverlap(data, other), { headers });
    }
    const filtered = filterHoldings(data.holdings, {
      query: p.get("q") || "",
      asset: p.get("asset") || "",
      country: p.get("country") || "",
      sort: p.get("sort") || "value",
      direction: p.get("direction") === "asc" ? "asc" : "desc",
    });
    if (p.get("format") === "csv") {
      // Streaming avoids the buffered function response limit for large bond portfolios.
      const bytes = new TextEncoder().encode(
        "\uFEFF" + holdingsCsv(data, filtered),
      );
      let offset = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 32768));
          offset += 32768;
        },
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${ticker}-${data.asOf}-holdings.csv"`,
        },
      });
    }
    const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
    const requestedPage = Number(p.get("page"));
    const page = Math.min(
      pageCount,
      Math.max(
        1,
        Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1,
      ),
    );
    return Response.json(
      {
        ...data,
        meta: { name: data.name, family: data.family || data.registrant },
        holdingsAsOf: data.asOf,
        holdingsFiledDate: data.filingDate,
        holdingsAccession: data.accession,
        filingCount: data.filings.length,
        nportCount: data.reports.length,
        holdings: filtered.slice((page - 1) * 50, page * 50),
        pagination: {
          page,
          pageCount,
          pageSize: 50,
          total: filtered.length,
          portfolioTotal: data.holdings.length,
        },
      },
      { headers },
    );
  } catch (err) {
    console.warn("[fund-research]", ticker, err.message);
    return Response.json(
      { error: err.message || "Fund data could not be loaded. Please retry." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
