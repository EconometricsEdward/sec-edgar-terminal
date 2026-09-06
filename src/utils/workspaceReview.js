import { validTicker } from "./researchWorkspace.js";
import { validFilingDate } from "./filingsResearch.js";

export const FUND_SHELF_KEY = "edgar-funds-shelf-v1";
export function parseFundShelf(raw) {
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (
    !Array.isArray(data) ||
    data.length > 30 ||
    data.some((ticker) => typeof ticker !== "string" || !validTicker(ticker))
  ) {
    throw new Error(
      "Saved funds could not be read. Existing data has been preserved.",
    );
  }
  return [...new Set(data)];
}
export function toggleFundShelf(storage, ticker) {
  if (!validTicker(ticker)) throw new Error("Choose a valid fund ticker.");
  const current = parseFundShelf(storage.getItem(FUND_SHELF_KEY));
  if (!current.includes(ticker) && current.length >= 30)
    throw new Error(
      "Your shelf holds 30 funds. Unsave a fund before adding another.",
    );
  const next = current.includes(ticker)
    ? current.filter((t) => t !== ticker)
    : [...current, ticker];
  storage.setItem(FUND_SHELF_KEY, JSON.stringify(next));
  return next;
}
export function removeFundFromShelf(storage, ticker) {
  const next = parseFundShelf(storage.getItem(FUND_SHELF_KEY)).filter(
    (item) => item !== ticker,
  );
  storage.setItem(FUND_SHELF_KEY, JSON.stringify(next));
  return next;
}

// Analysis v2 and the original financial snapshot have different metric models.
// Display each review faithfully; never compare the two baselines as equivalents.
export function companyReview(company = {}) {
  const modern =
    company.analysisBaseline && typeof company.analysisBaseline === "object";
  const baseline = modern ? company.analysisBaseline : company.baseline;
  const reviewedAt = modern ? company.analysisReviewedAt : company.reviewedAt;
  return {
    kind: modern ? "analysis" : baseline ? "legacy" : "none",
    reviewedAt:
      typeof reviewedAt === "string" && Number.isFinite(Date.parse(reviewedAt))
        ? reviewedAt
        : "",
    basis: baseline?.basis || baseline?.period?.kind || "",
    period: validFilingDate(baseline?.period?.end) ? baseline.period.end : "",
    asOf: validFilingDate(baseline?.asOf) ? baseline.asOf : "",
  };
}

export function consolidatedWatchlist(workspace, market = {}, funds = []) {
  const rows = new Map();
  for (const company of Object.values(workspace?.companies || {})) {
    if (!company?.saved || !validTicker(company.ticker)) continue;
    rows.set(company.ticker, {
      ...company,
      kind: "company",
      sources: ["Workspace"],
      review: companyReview(company),
    });
  }
  for (const ticker of market.watchlist || []) {
    if (!validTicker(ticker)) continue;
    const current = rows.get(ticker);
    rows.set(
      ticker,
      current
        ? { ...current, sources: [...current.sources, "Market"] }
        : {
            ticker,
            kind: "company",
            sources: ["Market"],
            review: companyReview(workspace?.companies?.[ticker]),
          },
    );
  }
  for (const ticker of funds) {
    if (!validTicker(ticker)) continue;
    rows.set(`fund:${ticker}`, {
      ticker,
      kind: "fund",
      sources: ["Funds"],
      review: companyReview(),
    });
  }
  return [...rows.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.kind.localeCompare(b.kind),
  );
}

// This is a filing-date check, not a financial-delta calculation or a full archive scan.
export function summarizeWorkspaceFilings(company, since = "") {
  if (since && !validFilingDate(since))
    throw new Error("Choose a valid review date.");
  const all = company.filings || [];
  const periodic = all.filter((f) =>
    /^(10-K|10-Q|20-F|40-F|8-K|6-K)(\/A)?$/.test(f.form),
  );
  const after = since ? periodic.filter((f) => f.filingDate > since) : [];
  const sameDay = since
    ? periodic.filter((f) => f.filingDate === since).length
    : 0;
  const dates = all
    .map((f) => f.filingDate)
    .filter(validFilingDate)
    .sort();
  const archiveOverlap = since
    ? company.archives?.some((a) => a.filingTo > since) || false
    : false;
  const omitted =
    Number(company.omittedRecords || 0) + Number(company.omittedArchives || 0);
  return {
    ticker: company.ticker,
    cik: company.cik,
    name: company.name,
    kind: company.kind,
    observedAt: company.observedAt,
    since,
    count: since ? after.length : null,
    sameDay,
    filings: (since ? after : periodic).slice(0, 8),
    coverage: {
      loaded: all.length,
      from: dates[0] || "",
      to: dates.at(-1) || "",
      archives: company.archives?.length || 0,
      archiveOverlap,
      omitted,
      completeSinceReview: Boolean(since && !archiveOverlap && !omitted),
    },
  };
}
