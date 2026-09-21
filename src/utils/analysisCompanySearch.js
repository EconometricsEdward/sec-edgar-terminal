const normalized = (value) => String(value || "").trim().toUpperCase();
const nameOf = (value) => normalized(value).replace(/[^A-Z0-9]+/g, " ").trim();
const baseNameOf = (value) => nameOf(value)
  .replace(/(?:\s+(?:INCORPORATED|INC|CORPORATION|CORP|LIMITED|LTD|PLC|LLC|CO))+$/, "");
const symbolAlias = (value) => normalized(value).replace(/\./g, "-");

export function analysisCikIdentifier(query) {
  const matched = /^(?:CIK\s*)?(\d{1,10})$/i.exec(String(query || '').trim());
  return matched && Number(matched[1]) > 0 ? matched[1].padStart(10, '0') : null;
}

/** Filer identities stay separate from listed parent/share-class tickers. */
export function analysisBrokerDealerMatches(filers = []) {
  return filers.flatMap(filer => {
    const cik = analysisCikIdentifier(filer?.cik);
    if (!cik || typeof filer.name !== 'string' || !filer.name.trim() || !filer.formTypes?.some(isBrokerDealerAnnualForm)) return [];
    return [{ name: filer.name, cik, ticker: cik, isFund: false, isBrokerDealer: true }];
  });
}

/** Search the complete SEC directory; the landing-page samples are unrelated. */
export function findAnalysisCompanyMatches(query, tickerMap, limit = 6) {
  const q = normalized(query);
  const nameQuery = nameOf(query);
  if (!q || !nameQuery || !tickerMap) return [];
  return Object.values(tickerMap)
    .map((company) => {
      const ticker = normalized(company.ticker);
      const name = nameOf(company.name);
      const priority = ticker === q ? 0
        : symbolAlias(ticker) === symbolAlias(q) ? 1
          : name === nameQuery || baseNameOf(company.name) === nameQuery ? 2
            : ticker.startsWith(q) ? 3
              : name.startsWith(nameQuery) ? 4
                : name.includes(nameQuery) ? 5 : -1;
      return { company, priority };
    })
    .filter(({ priority }) => priority >= 0)
    .sort((a, b) => a.priority - b.priority || a.company.ticker.localeCompare(b.company.ticker))
    .slice(0, limit)
    .map(({ company }) => company);
}

export function analysisCompanyPath(company) {
  return `/${company.isFund ? "fund" : "analysis"}/${encodeURIComponent(company.ticker)}`;
}

/** A word that looks like a ticker (TESLA, AMAZON) is not proof that it is one. */
export function resolveAnalysisCompany(query, tickerMap) {
  const q = normalized(query);
  if (!q) return { kind: "empty", company: null };
  if (!tickerMap) return { kind: "unavailable", company: null };
  const matches = findAnalysisCompanyMatches(query, tickerMap, Infinity);
  const exactTicker = matches.find((company) => normalized(company.ticker) === q);
  if (exactTicker) return { kind: "match", company: exactTicker };
  const aliases = matches.filter((company) => symbolAlias(company.ticker) === symbolAlias(q));
  if (aliases.length === 1) return { kind: "match", company: aliases[0] };
  const exactNames = matches.filter((company) =>
    nameOf(company.name) === nameOf(query) || baseNameOf(company.name) === nameOf(query));
  if (exactNames.length === 1) return { kind: "match", company: exactNames[0] };
  if (matches.length === 1) return { kind: "match", company: matches[0] };
  return { kind: matches.length ? "ambiguous" : "not_found", company: null };
}
import { isBrokerDealerAnnualForm } from './brokerDealerForms.js';
