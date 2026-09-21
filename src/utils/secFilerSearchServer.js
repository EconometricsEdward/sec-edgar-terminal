/**
 * SEC filer discovery includes entities without trading symbols. The SEC's own
 * getCompanyHints implementation uses search-index?keysTyped= (not ?keys=):
 * https://www.sec.gov/edgar/search/js/edgar_full_text_search.js
 *
 * Hints stop at ten and ignore pagination. Supplement them with entityName
 * searches of filing metadata, never document-text q searches. A root-form
 * search keeps managers and broker-dealers discoverable when private funds
 * outrank them in hints. Root forms already include their amendments; adding
 * /A forms to the same request would accidentally require amendments only.
 */
import { secFetch } from './secClient.js';
import { isBrokerDealerForm, normalizeBrokerDealerForm } from './brokerDealerForms.js';

export const SEC_FILER_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
export const SEC_FILER_RESULT_LIMIT = 12;
const FORM_13F = /^13F-(?:HR|NT)(?:\/A)?$/;
const supportedDiscoveryForm = value => FORM_13F.test(value) || isBrokerDealerForm(value);
const MAX_BYTES = 2 * 1024 * 1024;
const SEARCH_DEADLINE_MS = 25000;
const WARNING = 'Some SEC name sources could not be checked. Results may be incomplete. Retry or enter the filer’s CIK.';
const normalizedCik = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanName = value => typeof value === 'string' && value.trim() && value.length <= 1000 && !/[\u0000-\u001f\u007f<>]/.test(value) ? value.trim().replace(/\s+/g, ' ') : null;
const words = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

function error(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

export function parseSecFilerQuery(value) {
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f<>\\{}\[\]*?=:"|]/.test(value) || /(?:https?\b|www\.)/i.test(value))
    throw error('Enter a filer name or CIK, using at most 160 characters.', 400);
  const query = value.trim().replace(/\s+/g, ' ');
  const identifier = /^(?:CIK\s*)?(\d{1,10})$/i.exec(query);
  if (identifier) {
    const cik = normalizedCik(identifier[1]);
    if (!cik) throw error('Enter a valid SEC CIK.', 400);
    return { query, cik };
  }
  if (query.length < 2 || !words(query).length || /^\d+$/.test(query))
    throw error('Enter at least two characters of a filer name or a valid CIK.', 400);
  return { query, cik: null };
}

function nameAffinity(name, query) {
  const candidate = words(name), requested = words(query);
  const full = candidate.join(' '), term = requested.join(' ');
  if (full === term) return 0;
  if (full.startsWith(`${term} `)) return 1;
  if (` ${full} `.includes(` ${term} `)) return 2;
  return requested.every(part => candidate.some(word => word.startsWith(part))) ? 3 : 4;
}

function validateSearchPayload(payload) {
  if (!record(payload) || payload.error || payload.timed_out === true || Number(payload._shards?.failed || 0) > 0 || !Array.isArray(payload.hits?.hits) || payload.hits.hits.length > 100)
    throw error('The SEC filer search returned incomplete or invalid data. Please retry.');
  const total = typeof payload.hits.total === 'number' ? payload.hits.total : payload.hits.total?.value;
  if (!Number.isSafeInteger(total) || total < 0 || total < payload.hits.hits.length)
    throw error('The SEC filer search returned an invalid result count. Please retry.');
  return { hits: payload.hits.hits, truncated: total > payload.hits.hits.length || payload.hits.total?.relation === 'gte' };
}

function hintResults(payload, query) {
  const page = validateSearchPayload(payload);
  const results = [];
  for (const hit of page.hits) {
    const cik = normalizedCik(hit?._id), name = cleanName(hit?._source?.entity);
    if (!cik || !name) throw error('The SEC name index returned an invalid filer identity. Please retry.');
    // The hint service can also match a ticker. Keep that exact official alias
    // without pretending a trading symbol exists for every institutional filer.
    const tickerMatch = Array.isArray(hit._source.tickers) && hit._source.tickers.some(ticker => typeof ticker === 'string' && ticker.toLowerCase() === query.toLowerCase());
    if (nameAffinity(name, query) < 4 || tickerMatch) results.push({ cik, name, formTypes: [] });
  }
  return { ...page, results };
}

function filingResults(payload, query, restrictedForms) {
  const page = validateSearchPayload(payload);
  const results = [];
  for (const hit of page.hits) {
    const filing = hit?._source;
    // Valid joint applications can name hundreds of entities. The transport's
    // 2 MiB bound remains authoritative; do not reject those records at 100.
    if (!record(filing) || !Array.isArray(filing.ciks) || !Array.isArray(filing.display_names) || filing.ciks.length > 10000 || filing.display_names.length > 10000)
      throw error('The SEC filing index returned invalid filer identities. Please retry.');
    const ciks = new Set(filing.ciks.map(normalizedCik));
    if (ciks.has(null)) throw error('The SEC filing index returned an invalid CIK. Please retry.');
    const form = normalizeBrokerDealerForm(filing.form) || (typeof filing.form === 'string' ? filing.form : '');
    if (restrictedForms && !supportedDiscoveryForm(form)) throw error('The SEC filer discovery search returned an unexpected form. Please retry.');
    for (const display of filing.display_names) {
      if (typeof display !== 'string' || display.length > 1200) throw error('The SEC filing index returned an invalid name. Please retry.');
      const match = /^(.*?)\s*\(CIK (\d{10})\)\s*$/.exec(display);
      if (!match || !ciks.has(match[2])) continue;
      // SEC appends trading aliases between the company name and CIK, using a
      // double-space delimiter. Do not remove genuine parentheses in a name.
      const name = cleanName(match[1].replace(/\s{2,}\([^)]*\)\s*$/, ''));
      if (!name || nameAffinity(name, query) >= 4) continue;
      results.push({ cik: match[2], name,
        // Multi-party ownership filings do not prove every named party filed a
        // 13F or broker-dealer filing. Only a single-entity record
        // establishes the corresponding filing badge.
        formTypes: supportedDiscoveryForm(form) && ciks.size === 1 ? [form] : [] });
    }
  }
  return { ...page, results };
}

function mergedResults(pages, query) {
  const byCik = new Map();
  for (const page of pages) for (const incoming of page.results) {
    const current = byCik.get(incoming.cik);
    if (!current) { byCik.set(incoming.cik, { ...incoming, formTypes: [...incoming.formTypes] }); continue; }
    // Prefer the better matching alias, retaining one explicit CIK per choice.
    if (nameAffinity(incoming.name, query) < nameAffinity(current.name, query)) current.name = incoming.name;
    current.formTypes = [...new Set([...current.formTypes, ...incoming.formTypes])].sort();
  }
  // A notice identifies a related manager but does not supply a holdings
  // table. Prefer actual holdings reporters when legal-name relevance ties.
  const reportRank = filer => filer.formTypes.some(form => /^13F-HR(?:\/A)?$/.test(form) || isBrokerDealerForm(form)) ? 0 : filer.formTypes.length ? 1 : 2;
  return [...byCik.values()].sort((a, b) =>
    nameAffinity(a.name, query) - nameAffinity(b.name, query)
    || reportRank(a) - reportRank(b)
    || a.name.length - b.name.length || a.name.localeCompare(b.name) || a.cik.localeCompare(b.cik));
}

/** Small bounded per-instance query cache; no unreviewed shared-cache namespace. */
export function createSecFilerSearch({ fetchSec = secFetch, now = Date.now, ttlMs = 5 * 60000, maxEntries = 200, maxPending = 24 } = {}) {
  const cache = new Map(), pending = new Map();
  async function fetchJson(url, signal) {
    signal.throwIfAborted();
    const response = await fetchSec(url, { headers: { Accept: 'application/json' }, signal, timeoutMs: 8000, retries: 1, maxBytes: MAX_BYTES });
    if (!response.ok) {
      if (response.status === 404) throw error('No public SEC filing record was found for this CIK.', 404);
      throw error('SEC filer search is temporarily unavailable. Please retry or enter a CIK.', [403, 429, 503].includes(response.status) ? 503 : 502);
    }
    try { return await response.json(); } catch { throw error('The SEC filer search returned invalid data. Please retry.'); }
  }
  async function discover({ query, cik }) {
    const fetchedAt = new Date(now()).toISOString();
    // Both source stages share one deadline, so a transient SEC retry cannot
    // extend discovery beyond the API's 30-second function budget. The shared
    // SEC transport still owns retry delays and provider cooldown handling.
    const signal = AbortSignal.timeout(SEARCH_DEADLINE_MS);
    if (cik) {
      const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
      const payload = await fetchJson(url, signal), name = cleanName(payload?.name);
      if (normalizedCik(payload?.cik) !== cik || !name || !Array.isArray(payload?.filings?.recent?.form))
        throw error('The SEC response did not match the requested filer identity. Please retry.');
      return { query, results: [{ cik, name, formTypes: [...new Set(payload.filings.recent.form.filter(form => typeof form === 'string' && supportedDiscoveryForm(form)).map(form => normalizeBrokerDealerForm(form) || form))].sort() }],
        source: { url, fetchedAt, coverage: 'SEC public submissions for this CIK; older filings may be in additional history files.' }, truncated: false };
    }
    const hintUrl = `${SEC_FILER_SEARCH_URL}?${new URLSearchParams({ keysTyped: query })}`;
    const managerUrl = `${SEC_FILER_SEARCH_URL}?${new URLSearchParams({ entityName: query, forms: '13F-HR,13F-NT,X-17A-5', dateRange: 'all', from: '0' })}`;
    const attempts = await Promise.allSettled([
      fetchJson(hintUrl, signal).then(payload => hintResults(payload, query)),
      fetchJson(managerUrl, signal).then(payload => filingResults(payload, query, true)),
    ]);
    const urls = [hintUrl, managerUrl], pages = [], failures = [];
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') pages.push(attempt.value);
      else failures.push(attempt.reason);
    }
    const hints = attempts[0].status === 'fulfilled' ? attempts[0].value : null;
    // Broader filer-name discovery fills gaps from the SEC's fixed ten hints;
    // unlike q=text, this searches entity metadata, including private filers.
    if (!hints || hints.truncated || !pages.some(page => page.results.length)) {
      const url = `${SEC_FILER_SEARCH_URL}?${new URLSearchParams({ entityName: query, dateRange: 'all', from: '0' })}`;
      urls.push(url);
      try { pages.push(filingResults(await fetchJson(url, signal), query, false)); } catch (failure) { failures.push(failure); }
    }
    const results = mergedResults(pages, query);
    if (failures.length && !results.length) throw failures[0];
    return { query, results: results.slice(0, SEC_FILER_RESULT_LIMIT),
      source: { url: SEC_FILER_SEARCH_URL, urls, fetchedAt, coverageStart: '2001-01-01',
        coverage: 'SEC entity-name suggestions and indexed electronic filings from 2001. A CIK opens the filer’s public submissions directly.' },
      truncated: results.length > SEC_FILER_RESULT_LIMIT || pages.some(page => page.truncated) || failures.length > 0,
      ...(failures.length ? { warning: WARNING } : {}) };
  }
  return async function searchSecFilers(value) {
    const parsed = parseSecFilerQuery(value), key = parsed.cik || parsed.query.toLowerCase();
    const previous = cache.get(key);
    if (previous && previous.expiresAt > now()) {
      cache.delete(key); cache.set(key, previous);
      return { ...structuredClone(previous.value), query: parsed.query };
    }
    cache.delete(key);
    if (pending.has(key)) return { ...structuredClone(await pending.get(key)), query: parsed.query };
    if (pending.size >= maxPending) throw error('SEC filer search is busy. Please retry shortly.', 503);
    const request = discover(parsed);
    pending.set(key, request);
    try {
      const result = await request;
      // Partial results are useful, but must not suppress a retry after recovery.
      if (!result.warning) {
        cache.set(key, { value: result, expiresAt: now() + (result.results.length ? ttlMs : Math.min(ttlMs, 60000)) });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return structuredClone(result);
    } finally { pending.delete(key); }
  };
}

export const searchSecFilers = createSecFilerSearch();
