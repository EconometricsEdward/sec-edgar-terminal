import {
  exactFilerMatch,
  filerCik,
  filerNameQuery,
  hasThirteenFHoldings,
  hasBrokerDealerFilings,
  normalizedFilerName,
  secFilerResearchPath,
} from "./secFilerSearch.js";

const words = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function nameScore(query, name) {
  if (normalizedFilerName(query) === normalizedFilerName(name)) return 1000;
  const requested = words(query), candidate = words(name);
  if (!requested.length) return 0;
  const term = requested.join(" "), full = candidate.join(" ");
  if (full.startsWith(`${term} `)) return 100;
  if (` ${full} `.includes(` ${term} `)) return 60;
  return requested.every(part => candidate.some(word => word.startsWith(part))) ? 40 : 0;
}

/**
 * A verified manager is more useful than a similarly named private fund.
 * Ranking is only a suggestion: partial names and incomplete SEC responses
 * never become an automatic entity selection.
 */
export function rankGlobalFilerMatches(query, results, { truncated = false, warning = "", filingIntent = "" } = {}) {
  const input = filerNameQuery(query);
  const source = Array.isArray(results) ? results : [];
  const seen = new Set();
  const filers = source.slice(0, 20).flatMap(filer => {
    const cik = filerCik(filer?.cik);
    if (!cik || seen.has(cik) || typeof filer?.name !== "string" || !filer.name.trim()
      || filer.name.length > 1000 || /[\u0000-\u001f\u007f]/.test(filer.name)) return [];
    const path = secFilerResearchPath(filer, { filingIntent });
    if (!path) return [];
    seen.add(cik);
    const brokerDealer = hasBrokerDealerFilings(filer);
    const manager = hasThirteenFHoldings(filer) && !brokerDealer && !filingIntent;
    return [{ ...filer, cik, name: filer.name.trim(), path, manager, brokerDealer,
      score: nameScore(input, filer.name) + (manager || brokerDealer ? 20 : 0) }];
  }).sort((a, b) => b.score - a.score || a.name.length - b.name.length
    || a.name.localeCompare(b.name) || a.cik.localeCompare(b.cik));
  const exact = input ? exactFilerMatch(input, filers, { truncated: truncated || source.length > 20, warning }) : null;
  return {
    items: filers.slice(0, 12).map(filer => ({
      id: `filer:${filer.cik}`,
      label: filer.name,
      description: `${filer.brokerDealer ? "Broker-dealer filings · X-17A-5" : filer.manager ? "13F holdings" : "SEC filings"} · CIK ${filer.cik}`,
      path: filer.path,
      type: filer.manager ? "manager" : "filer",
      group: "Managers & SEC filers",
      query: input,
      cik: filer.cik,
      identityType: "cik",
    })),
    exactPath: exact?.path || null,
  };
}
