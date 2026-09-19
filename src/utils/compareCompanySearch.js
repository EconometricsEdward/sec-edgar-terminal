const normalizedName = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/** Normalize directory text once, rather than once per keystroke. */
export function buildCompareCompanyIndex(directory) {
  const records = Object.entries(directory || {}).map(([key, company]) => ({
    ...company,
    ticker: company.ticker || key,
    searchName: normalizedName(company.name),
  }));
  const exact = new Map(records.map((company) => [company.ticker, company]));
  const resolveTicker = (value) => {
    const ticker = String(value || "").trim().toUpperCase();
    if (exact.has(ticker)) return exact.get(ticker);
    // SEC share classes commonly use a dash. Never replace a real dot symbol.
    return ticker.includes(".") ? exact.get(ticker.replaceAll(".", "-")) || null : null;
  };
  return { records, resolveTicker };
}

export function compareCompanySuggestions(index, input, selected = [], limit = 6) {
  const query = String(input || "").trim().toUpperCase();
  if (!query) return [];
  const tokens = query.split(/[\s,;]+/);
  if (tokens.length > 1 && tokens.every((token) => index.resolveTicker(token))) return [];
  const exact = index.resolveTicker(query);
  // An existing exact ticker must not become an unrelated prefix suggestion.
  if (exact && selected.includes(exact.ticker)) return [];
  const nameQuery = normalizedName(query);
  const excluded = new Set(selected);
  return index.records
    .filter((company) => !excluded.has(company.ticker) && (
      company === exact || company.ticker.includes(query) || company.searchName.includes(nameQuery)))
    .sort((a, b) => Number(b === exact) - Number(a === exact) ||
      Number(b.ticker.startsWith(query)) - Number(a.ticker.startsWith(query)) ||
      Number(b.searchName.startsWith(nameQuery)) - Number(a.searchName.startsWith(nameQuery)) ||
      a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}
