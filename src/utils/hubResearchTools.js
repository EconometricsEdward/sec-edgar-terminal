export function filterHubPortfolios(
  portfolios,
  { query = "", status = "all", sort = "recent" } = {},
) {
  const term = query.trim().toLowerCase();
  return portfolios
    .filter(
      (p) =>
        (!term || p.name.toLowerCase().includes(term)) &&
        (status === "all" ||
          (status === "unresearched" && !p.hasSnapshot) ||
          (status === "attention" && (p.unresolved || p.incomplete)) ||
          (status === "captured" &&
            p.hasSnapshot &&
            !p.unresolved &&
            !p.incomplete)),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "coverage"
          ? (a.coveragePct ?? -1) - (b.coveragePct ?? -1) ||
            a.name.localeCompare(b.name)
          : (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
}

/** Explicitly requested batches only: never repeat checked issuers just to fill 20. */
export function nextWatchlistBatch(
  companies,
  results = {},
  mode = "unchecked",
  limit = 20,
) {
  return companies
    .filter((row) =>
      mode === "failed"
        ? Boolean(results[row.ticker]?.error)
        : !results[row.ticker],
    )
    .slice(0, Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 20)));
}
