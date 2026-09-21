import { managerHoldingsPath } from "./siteRoutes.js";
import { isBrokerDealerForm, normalizeBrokerDealerForm } from "./brokerDealerForms.js";

/** Small browser responses from SEC entity discovery; the complete index stays upstream. */
export function filerCik(value) {
  const input = String(value || "").trim();
  return /^\d{1,10}$/.test(input) && Number(input) > 0
    ? input.padStart(10, "0") : null;
}

export const normalizedFilerName = value => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
export const filerNameQuery = value => String(value || "").trim().replace(/\s+/g, " ");

/** Notices do not establish that this manager reports a holdings table. */
export function hasThirteenFHoldings(filer) {
  return Array.isArray(filer?.formTypes)
    && filer.formTypes.some(form => form === "13F-HR" || form === "13F-HR/A");
}

export function hasBrokerDealerFilings(filer) {
  return Array.isArray(filer?.formTypes) && filer.formTypes.some(isBrokerDealerForm);
}

export function secFilerResearchPath(filer, { filingIntent = '' } = {}) {
  const cik = filerCik(filer?.cik);
  if (!cik) return null;
  const requestedForm = normalizeBrokerDealerForm(filingIntent);
  if (requestedForm || hasBrokerDealerFilings(filer)) return `/filings/${cik}?form=${requestedForm || 'X-17A-5'}`;
  if (filingIntent === 'annual') return `/filings/${cik}?family=annual`;
  return hasThirteenFHoldings(filer) ? managerHoldingsPath(cik) : `/filings/${cik}`;
}

/** Legal names can contain commas; only ticker-shaped segments imply comparison. */
export function isTickerComparison(value, tickerMap = null) {
  const input = String(value || "").trim();
  if (/,\s*(?:L\.?L\.?C\.?|L\.?P\.?|INC\.?|LTD\.?|CORP\.?|PLC\.?|GROUP|HOLDINGS|CAPITAL|PARTNERS)\s*$/i.test(input)
    && !input.split(",").every(part => tickerMap?.[part.trim().toUpperCase()])) return false;
  return input.includes(",") && input.split(",").every((part, index, parts) =>
    /^[A-Z0-9][A-Z0-9.-]{0,9}$/i.test(part.trim()) || !part.trim() && index === parts.length - 1);
}

export function validateFilerSearch(value, query) {
  if (!value || value.query !== filerNameQuery(query) || !Array.isArray(value.results) || value.results.length > 20
    || typeof value.truncated !== "boolean") throw new Error("The SEC filer search returned an invalid response. Retry the search.");
  const seen = new Set();
  const results = value.results.map(result => {
    if (!result || !/^\d{10}$/.test(result.cik) || !filerCik(result.cik)
      || typeof result.name !== "string" || !result.name.trim() || result.name.length > 1000 || seen.has(result.cik)
      || result.formTypes !== undefined && (!Array.isArray(result.formTypes) || result.formTypes.length > 30
        || result.formTypes.some(form => typeof form !== "string" || form.length > 40)))
      throw new Error("The SEC filer search returned an invalid identity. Retry the search.");
    seen.add(result.cik);
    return { cik: result.cik, name: result.name, formTypes: result.formTypes || [] };
  });
  return { results, truncated: value.truncated, warning: typeof value.warning === "string" ? value.warning.slice(0, 1000) : "" };
}

export function mergeFilerSuggestions(suggestions, filers, limit = 12) {
  const securities = suggestions.filter(item => item.type !== "topic");
  const securityCiks = new Set(securities.map(item => item.cik));
  const extra = filers.filter(item => !securityCiks.has(item.cik)).map(item => ({
    ...item, type: "filer", ticker: item.cik, identityType: "cik", brokerDealer: hasBrokerDealerFilings(item), path: secFilerResearchPath(item),
  }));
  return [...securities, ...extra, ...suggestions.filter(item => item.type === "topic")].slice(0, limit);
}

/** Never choose the first prefix match when several SEC entities share a name. */
export function exactFilerMatch(query, results, { truncated = false, warning = "" } = {}) {
  if (truncated || warning) return null;
  const name = normalizedFilerName(query);
  const matches = results.filter(result => normalizedFilerName(result.name) === name);
  return matches.length === 1 ? matches[0] : null;
}

export function createFilerSearchClient({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  const cache = new Map();
  return async (query, { signal, force = false } = {}) => {
    const normalized = filerNameQuery(query);
    if (normalized.length < 2 || normalized.length > 160 || /[\x00-\x1f\x7f]/.test(normalized))
      throw new Error("Enter a filer name or CIK between 2 and 160 characters.");
    signal?.throwIfAborted();
    const key = normalized.toUpperCase(), previous = cache.get(key);
    if (!force && previous?.expiresAt > now()) return previous.data;
    const response = await fetchImpl(`/api/sec-filers?query=${encodeURIComponent(normalized)}`, { signal });
    const raw = await response.text();
    if (raw.length > 100000) throw new Error("The SEC filer search response was too large. Refine the name and retry.");
    let value; try { value = JSON.parse(raw); } catch { throw new Error("SEC filer search is temporarily unavailable. Retry the search."); }
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "SEC filer search is temporarily unavailable. Retry the search.");
    const data = validateFilerSearch(value, normalized);
    // An incomplete source response is useful, but must stay retryable.
    if (!data.warning) {
      while (cache.size >= 80) cache.delete(cache.keys().next().value);
      cache.set(key, { expiresAt: now() + 300000, data });
    }
    return data;
  };
}

export const searchSecFilers = createFilerSearchClient();
