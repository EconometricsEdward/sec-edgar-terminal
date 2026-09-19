const normalizedName = (name) => String(name || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const issuerIdentity = (company) => /^\d{1,10}$/.test(String(company?.cik || "")) && Number(company.cik) > 0
  ? String(company.cik).padStart(10, "0") : null;
const fundSuggestion = (company) => company.isFund === true || company.kind === "fund"
  || (/^S\d{9}$/.test(company.seriesId || "") && /^C\d{9}$/.test(company.classId || ""))
  || /\bETFS?\b|\bEXCHANGE TRADED FUNDS?\b/.test(company.searchName);
const commonSymbol = (company) => /^[A-Z0-9]+$/.test(company.ticker);

/** Normalize directory text once, rather than once per keystroke. */
export function buildCompareCompanyIndex(directory) {
  const records = Object.entries(directory || {}).map(([key, company]) => {
    const record = { ...company, ticker: company.ticker || key, searchName: normalizedName(company.name) };
    return { ...record, searchCik: issuerIdentity(record), searchFund: fundSuggestion(record), searchCommonSymbol: commonSymbol(record) };
  });
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
  const selectedIssuers = new Set(selected.map((ticker) => index.resolveTicker(ticker)?.searchCik).filter(Boolean));
  const matches = index.records
    .filter((company) => !excluded.has(company.ticker)
      && (company === exact || (!company.searchFund && !selectedIssuers.has(company.searchCik))) && (
      company === exact || company.ticker.includes(query) || company.searchName.includes(nameQuery)))
    .sort((a, b) => Number(b === exact) - Number(a === exact) ||
      Number(b.ticker.startsWith(query)) - Number(a.ticker.startsWith(query)) ||
      Number(b.searchName.startsWith(nameQuery)) - Number(a.searchName.startsWith(nameQuery)) ||
      Number(b.searchCommonSymbol) - Number(a.searchCommonSymbol) ||
      a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker));
  // A name search represents issuers, not every preferred or share-class symbol.
  // Explicit tickers keep their identity; only verified equal CIKs collapse.
  const seenIssuers = new Set();
  return matches.filter((company) => {
    const cik = company.searchCik;
    if (cik && seenIssuers.has(cik)) return false;
    if (cik) seenIssuers.add(cik);
    return true;
  }).slice(0, limit);
}
