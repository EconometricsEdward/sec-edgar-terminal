import { allocationSummary } from "./portfolioModel.js";
import { safeInternalPath } from "./siteRoutes.js";

const active = (rows) =>
  rows.filter((row) => !row.excluded && row.duplicateChoice !== "remove");
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;

/** Read-only summaries use the same coverage denominator as Portfolio Research. */
export function summarizeHubPortfolio(portfolio) {
  const rows = active(portfolio.rows || []);
  const snapshot =
    portfolio.snapshot?.basis === portfolio.research?.basis
      ? portfolio.snapshot
      : null;
  const companies = snapshot?.companies || [];
  const byCik = Object.fromEntries(
    companies.map((company) => [company.cik, company]),
  );
  const summary = allocationSummary(
    portfolio.rows || [],
    portfolio.allocation || { basis: "none" },
    byCik,
  );
  const issuerCiks = new Set(
    rows
      .filter(
        (row) =>
          row.resolution?.status === "resolved" &&
          row.resolution?.kind !== "fund",
      )
      .map((row) => row.resolution?.cik)
      .filter(Boolean),
  );
  const incomplete = [...issuerCiks].filter((cik) => {
    const company = byCik[cik];
    return (
      !company ||
      company.status === "failed" ||
      ["failed", "pending", "not_checked", "stale"].includes(
        company.refreshStatus,
      ) ||
      ["stale", "unavailable"].includes(company.cache?.status)
    );
  }).length;
  const unresolved = summary.coverage.unresolvedPositions;
  const capturedAt = timestamp(snapshot?.generated_at);
  const status = unresolved
    ? "Identity review needed"
    : !snapshot
      ? "Ready to research"
      : incomplete
        ? "Research needs a refresh"
        : "Evidence captured";
  return {
    id: portfolio.id,
    name: portfolio.name,
    updatedAt: timestamp(portfolio.updatedAt),
    capturedAt,
    hasSnapshot: Boolean(snapshot),
    basis: portfolio.research?.basis === "ttm" ? "TTM" : "Annual",
    rowCount: rows.length,
    issuerCount: summary.issuers.length,
    fundCount: summary.fundCount,
    unresolved,
    incomplete,
    status,
    availableCompanies: snapshot ? summary.coverage.availableCompanies : null,
    totalCompanies: summary.coverage.totalCompanies,
    coveragePct: snapshot ? summary.coverage.companyPct : null,
    weighted: summary.mode === "weighted",
  };
}

/**
 * Stable saved destinations only; private text is indexed locally, never retrieved.
 * @param {{portfolios?: any[]}} input
 */
export function buildHubSearchIndex({
  portfolios = [],
} = {}) {
  const items = [];
  const seen = new Set();
  function add(item) {
    if (seen.has(item.id) || !safeInternalPath(item.href)) return;
    seen.add(item.id);
    items.push({
      ...item,
      searchText:
        `${item.title} ${item.text || ""} ${item.ticker || ""} ${item.kind} ${item.source}`.toLocaleLowerCase(
          "en-US",
        ),
    });
  }
  for (const portfolio of portfolios.slice(0, 20)) {
    const rows = active(portfolio.rows || []);
    add({
      id: `portfolio:${portfolio.id}`,
      portfolioId: portfolio.id,
      title: portfolio.name,
      text: rows
        .map(
          (row) =>
            `${row.resolution?.ticker || row.input?.ticker || ""} ${row.resolution?.name || row.input?.company_name || ""} ${row.input?.notes || ""}`,
        )
        .join(" "),
      description: `${rows.length} included positions · saved portfolio`,
      kind: "Portfolio",
      source: "Portfolio Research",
      href: `/workspace?view=portfolios&portfolio=${encodeURIComponent(portfolio.id)}`,
      date: timestamp(portfolio.updatedAt),
    });
  }
  return items;
}

/** Exact ticker/title matches lead; all search terms must match. Results are bounded. */
export function searchHubResearch(
  index,
  query,
  limit = 12,
  { kind = "all", sort = "relevance" } = {},
) {
  const text = String(query || "")
    .trim()
    .toLocaleLowerCase("en-US")
    .slice(0, 300);
  if (!text) return { results: [], total: 0 };
  const terms = text.split(/\s+/);
  const matches = index.filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      terms.every((term) => item.searchText.includes(term)),
  );
  const rank = (item) =>
    item.ticker?.toLocaleLowerCase("en-US") === text
      ? 0
      : item.title.toLocaleLowerCase("en-US") === text
        ? 1
        : item.title.toLocaleLowerCase("en-US").includes(text)
          ? 2
          : 3;
  matches.sort(
    (a, b) =>
      (sort === "recent" ? 0 : rank(a) - rank(b)) ||
      (b.date || "").localeCompare(a.date || "") ||
      a.title.localeCompare(b.title),
  );
  const boundedLimit = Number.isInteger(limit)
    ? Math.max(1, Math.min(limit, 50))
    : 12;
  return { results: matches.slice(0, boundedLimit), total: matches.length };
}
