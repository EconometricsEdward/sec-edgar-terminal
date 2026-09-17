export const HUB_VIEWS = [
  ["overview", "Overview"],
  ["portfolios", "Portfolio research"],
];
const ids = new Set(HUB_VIEWS.map(([id]) => id));
export const ANALYTICS_AREAS = [
  "overview",
  "concentration",
  "financial",
  "coverage",
];
export const PORTFOLIO_TABS = [
  "analytics",
  "research",
  "changes",
  "allocation",
  "filings",
  "disclosures",
  "ownership",
  "exports",
];
const portfolioTab = (value) => (PORTFOLIO_TABS.includes(value) ? value : "");
const localId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : "";
/** Retired pages resolve to the five-page workspace while evidence tools stay available. */
export function normalizePortfolioDestination(options = {}) {
  let tab = portfolioTab(options.portfolioTab);
  let area = ANALYTICS_AREAS.includes(options.analyticsArea)
    ? options.analyticsArea
    : "";
  let holdingsMode = options.holdingsMode === "screen" || options.holdingsMode === "all"
    ? options.holdingsMode
    : "";
  if (!tab || tab === "analytics") {
    if (options.analyticsArea === "metrics") {
      tab = "analytics";
      area = "financial";
    } else if (options.analyticsArea === "screener") {
      tab = "research";
      area = "";
      holdingsMode = "screen";
    } else if (options.analyticsArea === "scenario") {
      tab = "analytics";
      area = "overview";
    }
  }
  return {
    portfolioTab: tab,
    analyticsArea: area,
    holdingsMode: tab === "research" ? holdingsMode : "",
  };
}

export function parseHubLocation(value) {
  const url = new URL(value, "https://secedgarterminal.com");
  const view = url.searchParams.get("view") || "";
  return {
    view: ids.has(view)
      ? view
      : url.searchParams.has("portfolio")
        ? "portfolios"
        : "overview",
    portfolioId: localId(url.searchParams.get("portfolio")),
    rowId: localId(url.searchParams.get("row")),
    portfolioViewId: localId(url.searchParams.get("portfolioView")),
    ...normalizePortfolioDestination({
      portfolioTab: url.searchParams.get("portfolioTab"),
      analyticsArea: url.searchParams.get("analyticsArea"),
      holdingsMode: url.searchParams.get("holdingsMode"),
    }),
  };
}
/** Only local navigation identifiers enter the URL; research text stays in this browser. */
export function hubDestination(view, options = {}) {
  const params = new URLSearchParams();
  params.set("view", ids.has(view) ? view : "overview");
  if (view === "portfolios" && localId(options.portfolioId))
    params.set("portfolio", options.portfolioId);
  if (view === "portfolios" && localId(options.rowId))
    params.set("row", options.rowId);
  if (view === "portfolios" && localId(options.portfolioViewId))
    params.set("portfolioView", options.portfolioViewId);
  if (view === "portfolios") {
    const destination = normalizePortfolioDestination(options);
    if (destination.portfolioTab) params.set("portfolioTab", destination.portfolioTab);
    if (destination.analyticsArea) params.set("analyticsArea", destination.analyticsArea);
    if (destination.holdingsMode) params.set("holdingsMode", destination.holdingsMode);
  }
  return `/workspace?${params}`;
}
