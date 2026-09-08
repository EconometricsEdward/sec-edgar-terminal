export const HUB_VIEWS = [
  ["overview", "Overview"],
  ["portfolios", "Portfolio research"],
  ["inbox", "Review inbox"],
  ["briefs", "Research briefs"],
  ["watchlist", "Watchlists"],
  ["library", "Evidence & backups"],
];
const ids = new Set(HUB_VIEWS.map(([id]) => id));
const localId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : "";
export function parseHubLocation(value) {
  const url = new URL(value, "https://secedgarterminal.com");
  const view = url.searchParams.get("view") || "";
  return {
    view: ids.has(view)
      ? view
      : url.hash === "#research-vault"
        ? "library"
        : url.searchParams.has("portfolio")
          ? "portfolios"
          : "overview",
    portfolioId: localId(url.searchParams.get("portfolio")),
    briefId: localId(url.searchParams.get("brief")),
    rowId: localId(url.searchParams.get("row")),
    portfolioViewId: localId(url.searchParams.get("portfolioView")),
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
  if (view === "briefs" && localId(options.briefId))
    params.set("brief", options.briefId);
  return `/workspace?${params}`;
}
