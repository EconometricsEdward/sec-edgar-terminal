import { getOperatingDirectory, getFundDirectory } from './tickerMap.js';
import { searchSecFilers } from './secFilerSearchServer.js';
import { secFetch } from './secClient.js';
import { KNOWN_ETFS } from './knownFunds.js';
import { isBrokerDealerForm } from './brokerDealerForms.js';

const LIMIT = 20;
const SEC_FUND_SEARCH = 'https://www.sec.gov/cgi-bin/browse-edgar';
const CIK = /^(?!0000000000)\d{10}$/;
const TICKER = /^[A-Z][A-Z0-9.-]{0,14}$/;
const words = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const normalizedCik = value => /^\d{1,10}$/.test(String(value)) && Number(value) > 0 ? String(value).padStart(10, '0') : null;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export function parseReportSearch(params) {
  if (!(params instanceof URLSearchParams) || [...params.keys()].some(key => !['q', 'kind'].includes(key))
    || params.getAll('q').length !== 1 || params.getAll('kind').length !== 1)
    throw fail('Provide one search term and a report type.', 400);
  const kind = params.get('kind'), raw = params.get('q');
  if (!['company', 'nport', '13f'].includes(kind)) throw fail('Choose Company, N-PORT fund, or 13F manager.', 400);
  if (typeof raw !== 'string' || raw.length > 160 || /[\u0000-\u001f\u007f<>\\{}\[\]*?=:"|]/.test(raw) || /(?:https?\b|www\.)/i.test(raw))
    throw fail('Enter a name, ticker, or SEC identifier using at most 160 characters.', 400);
  const query = raw.trim().replace(/\s+/g, ' ');
  const numeric = /^(?:CIK\s*)?(\d+)$/i.exec(query);
  if (!query || !words(query).length || numeric && !normalizedCik(numeric[1])) throw fail('Enter a valid name, ticker, or SEC identifier.', 400);
  if (kind === '13f' && query.length < 2 && !numeric) throw fail('Enter at least two characters of a manager name or its CIK.', 400);
  return { query, kind, cik: numeric ? normalizedCik(numeric[1]) : null };
}

function affinity(name, query, ticker = '') {
  const term = words(query).join(' '), candidate = words(name).join(' '), requested = words(query);
  if (ticker === query.toUpperCase()) return 0;
  if (candidate === term) return 1;
  if (ticker.startsWith(query.toUpperCase())) return 2;
  if (candidate.startsWith(term)) return 3;
  if (requested.every(word => words(name).some(part => part.startsWith(word)))) return 4;
  return 10;
}

function decodeText(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity.slice(2, -1), point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).trim().replace(/\s+/g, ' ');
}

/** SEC's own mutual-fund search names a registrant before its series rows.
 * Preserve that association; a neighboring registrant can never donate a CIK.
 * Source form: https://www.sec.gov/search-filings/mutual-funds-search
 */
export function parseReportFundSearch(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024
    || !/<title>\s*EDGAR (?:Series|Company|Search) Results\s*<\/title>/i.test(html))
    throw fail('SEC fund search returned an unrecognized response. Retry or search by ticker.');
  const result = [], seen = new Map();
  let cik = null, registrant = '';
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const anchors = [...row[1].matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
      try {
        const url = new URL(decodeText(match[1]), 'https://www.sec.gov');
        if (url.origin !== 'https://www.sec.gov' || url.pathname !== '/cgi-bin/browse-edgar') return [];
        return [{ id: url.searchParams.get('CIK'), name: decodeText(match[2]) }];
      } catch { return []; }
    });
    const owner = anchors.find(anchor => CIK.test(anchor.id || '') && anchor.name === anchor.id);
    if (owner) {
      cik = owner.id;
      registrant = anchors.find(anchor => anchor.id === cik && anchor.name !== cik)?.name || '';
      if (!registrant || registrant.length > 1000) throw fail('SEC fund search returned an incomplete registrant identity.');
    }
    const series = anchors.find(anchor => /^S\d{9}$/.test(anchor.id || '') && anchor.name !== anchor.id);
    if (!series) continue;
    if (!cik || !series.name || series.name.length > 1000) throw fail('SEC fund search returned a series without a verified registrant.');
    if (seen.has(series.id) && seen.get(series.id) !== cik) throw fail('SEC fund search returned conflicting series identities.');
    if (!seen.has(series.id)) result.push({ cik, seriesId: series.id, name: series.name, registrant });
    seen.set(series.id, cik);
  }
  const count = /Found\s+([\d,]+)\s+records/i.exec(html);
  // Exact series/class/registrant searches use an Items range instead of Found.
  const items = /Items\s+([\d,]+)\s*-\s*([\d,]+)/i.exec(html);
  if (!count && !items && !/No matching|No records|No results|No CIK|0 records/i.test(html))
    throw fail('SEC fund search coverage could not be verified. Retry or search by ticker.');
  return { series: result, truncated: Boolean(count && Number(count[1].replaceAll(',', '')) > result.length
    || items && /(?:value|alt)=["']Next\s|>\s*Next\s*(?:\d+\s*)?(?:&gt;|<)/i.test(html)) };
}

function abortable(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('Search timed out. Refine the name or retry.', 503));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createReportSearch({ operatingDirectory = getOperatingDirectory, fundDirectory = getFundDirectory,
  filerSearch = searchSecFilers, fetchSec = secFetch, now = Date.now, ttlMs = 300000, maxEntries = 100, maxPending = 12,
  companySupplementMs = 8000 } = {}) {
  const cache = new Map(), pending = new Map();
  async function discover({ query, kind, cik }) {
    const signal = AbortSignal.timeout(26000);
    const base = { query, kind, results: [], truncated: false };
    if (kind === '13f') {
      const found = await abortable(filerSearch(query), signal);
      base.results = found.results.filter(item => cik || item.formTypes.some(form => /^13F-(?:HR|NT)(?:\/A)?$/.test(form)))
        .map(item => ({ kind, id: item.cik, name: item.name, cik: item.cik,
          detail: item.formTypes.some(form => /^13F-HR(?:\/A)?$/.test(form)) ? 'SEC 13F holdings reporter'
            : item.formTypes.length ? 'SEC 13F notice filer; a holdings table may not be available'
              : 'SEC filer; public 13F holdings availability will be checked' }));
      return { ...base, truncated: found.truncated, ...(found.warning ? { warning: found.warning } : {}), source: found.source };
    }
    const [companies, funds] = await abortable(Promise.all([operatingDirectory(), fundDirectory()]), signal);
    if (kind === 'company') {
      const matches = Object.entries(companies).flatMap(([ticker, entry]) => {
        if (funds[ticker] || KNOWN_ETFS.has(ticker)) return [];
        const rank = cik ? entry.cik === cik ? 0 : 10 : affinity(entry.name, query, ticker);
        return rank < 10 ? [{ ticker, entry, rank }] : [];
      });
      matches.sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length || a.ticker.localeCompare(b.ticker));
      base.results = matches.slice(0, LIMIT).map(({ ticker, entry }) => ({ kind, id: ticker, ticker, name: entry.name, cik: entry.cik, detail: `SEC company · CIK ${entry.cik}` }));
      base.truncated = matches.length > LIMIT;
      // Exact ticker/CIK choices keep the directory-only fast path. A company
      // name must also discover untickered issuers even when listed names match.
      const exactTicker = matches.some(({ ticker }) => ticker === query.toUpperCase());
      if (!exactTicker && !(cik && base.results.length) && (cik || query.length >= 2)) {
        const fundCiks = new Set(Object.values(funds).map(item => item.cik));
        for (const ticker of KNOWN_ETFS) if (companies[ticker]) fundCiks.add(companies[ticker].cik);
        try {
          // Existing choices stay useful when the broader SEC name index is
          // slow. Its supplementary check shares the overall search deadline.
          const supplementSignal = base.results.length
            ? AbortSignal.any([signal, AbortSignal.timeout(companySupplementMs)]) : signal;
          const found = await abortable(filerSearch(cik || query), supplementSignal);
          const choices = matches.map(({ ticker, entry }) => ({ kind, id: ticker, ticker, name: entry.name, cik: entry.cik, detail: `SEC company · CIK ${entry.cik}` }));
          const coveredCiks = new Set(matches.map(({ entry }) => entry.cik));
          for (const item of found.results) {
            // Keep the directory's individual share-class tickers; add a CIK
            // result only when that issuer has no existing matching choice.
            if (fundCiks.has(item.cik) || coveredCiks.has(item.cik)) continue;
            coveredCiks.add(item.cik);
            choices.push({ kind, id: item.cik, name: item.name, cik: item.cik,
              ...(item.formTypes?.some(isBrokerDealerForm) ? { brokerDealerForm: 'X-17A-5' } : {}),
              detail: item.formTypes?.some(isBrokerDealerForm)
                ? 'Broker-dealer · X-17A-5 public filing documents · Exact SEC registrant'
                : 'SEC filer · Company financial-data availability will be checked' });
          }
          choices.sort((a, b) => affinity(a.name, query, a.ticker) - affinity(b.name, query, b.ticker)
            || a.name.length - b.name.length || a.id.localeCompare(b.id));
          base.results = choices.slice(0, LIMIT);
          base.truncated ||= Boolean(found.truncated || found.warning || choices.length > LIMIT);
          if (found.warning) base.warning = found.warning;
        } catch (error) {
          if (!base.results.length) throw error;
          base.truncated = true;
          base.warning = 'Additional SEC company names could not be checked. Directory matches are shown; results may be incomplete. Retry or enter the company’s CIK.';
        }
      }
      return base;
    }
    const exact = funds[query.toUpperCase()];
    if (exact && TICKER.test(query.toUpperCase())) {
      const ticker = query.toUpperCase();
      return { ...base, results: [{ kind, id: ticker, ticker, name: companies[ticker]?.name || `${ticker} · Fund portfolio`,
        cik: exact.cik, seriesId: exact.seriesId, detail: `SEC series ${exact.seriesId} · CIK ${exact.cik}` }] };
    }
    const seriesId = /^S\d{9}$/i.test(query) ? query.toUpperCase() : null;
    const classId = /^C\d{9}$/i.test(query) ? query.toUpperCase() : null;
    const url = new URL(SEC_FUND_SEARCH);
    url.search = new URLSearchParams({ action: 'getcompany', ...(cik || seriesId || classId ? { CIK: cik || seriesId || classId } : { scname: query }), view: 'mutual-fund', scd: 'series', count: '100' }).toString();
    let named = [], warning = '', nameFailure = null;
    try {
      const response = await fetchSec(url.href, { signal, timeoutMs: 10000, retries: 1, maxBytes: 2 * 1024 * 1024 });
      if (!response.ok) throw fail('SEC fund name search is unavailable. Search by the exact fund ticker.', 503);
      const parsed = parseReportFundSearch(await response.text());
      named = parsed.series.filter(item => cik ? item.cik === cik : seriesId ? item.seriesId === seriesId : classId || affinity(`${item.name} ${item.registrant}`, query) < 10);
      base.truncated = parsed.truncated;
    } catch (failure) {
      if (!cik && !seriesId && !classId) throw failure;
      nameFailure = failure;
      warning = 'SEC fund names are temporarily unavailable. These exact identities come from the SEC ticker directory.';
    }
    const names = new Map(named.map(item => [`${item.cik}:${item.seriesId}`, item]));
    const matches = Object.entries(funds).filter(([ticker, entry]) => TICKER.test(ticker)
      && (cik ? entry.cik === cik : seriesId ? entry.seriesId === seriesId : classId ? entry.classId === classId : names.has(`${entry.cik}:${entry.seriesId}`)));
    matches.sort(([at, a], [bt, b]) => affinity(names.get(`${a.cik}:${a.seriesId}`)?.name || at, query, at) - affinity(names.get(`${b.cik}:${b.seriesId}`)?.name || bt, query, bt) || at.localeCompare(bt));
    const mapped = matches.map(([ticker, entry]) => ({ kind, id: ticker, ticker,
      name: names.get(`${entry.cik}:${entry.seriesId}`)?.name || companies[ticker]?.name || `${ticker} · Fund portfolio`,
      cik: entry.cik, seriesId: entry.seriesId, detail: `${names.get(`${entry.cik}:${entry.seriesId}`)?.registrant || 'SEC fund'} · ${entry.seriesId} · Share class ${ticker}` }));
    const covered = new Set(matches.map(([, entry]) => `${entry.cik}:${entry.seriesId}`));
    // A verified series is a portfolio identity in its own right. The Reports
    // series loader independently verifies the CIK and original N-PORT XML.
    // Class-only queries cannot assign another class or tickerless series.
    const unmapped = classId ? [] : named.filter(item => !covered.has(`${item.cik}:${item.seriesId}`)).map(item => ({
      kind, id: item.seriesId, name: item.name, cik: item.cik, seriesId: item.seriesId,
      detail: `${item.registrant} · SEC series portfolio · No ticker required`,
    }));
    const choices = [...mapped, ...unmapped].sort((a, b) => affinity(a.name, query, a.ticker) - affinity(b.name, query, b.ticker)
      || Number(!a.ticker) - Number(!b.ticker) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // Without even a directory identity, a blocked name source is an outage,
    // not a verified empty search. Let the UI offer its normal Retry action.
    if (nameFailure && !choices.length) throw nameFailure;
    base.results = choices.slice(0, LIMIT);
    base.truncated ||= choices.length > LIMIT;
    return { ...base, ...(warning ? { warning } : {}) };
  }
  return async function searchReports(input) {
    const parsed = input instanceof URLSearchParams ? parseReportSearch(input) : parseReportSearch(new URLSearchParams({ q: input?.query ?? '', kind: input?.kind ?? '' }));
    const key = `${parsed.kind}:${parsed.query.toUpperCase()}`;
    const cached = cache.get(key);
    if (cached?.expiresAt > now()) return { ...structuredClone(cached.value), query: parsed.query };
    cache.delete(key);
    if (pending.has(key)) return { ...structuredClone(await pending.get(key)), query: parsed.query };
    if (pending.size >= maxPending) throw fail('Several report searches are in progress. Retry shortly.', 503);
    const request = discover(parsed).then(value => ({ ...value, warnings: value.warning ? [value.warning] : [] }));
    pending.set(key, request);
    try {
      const value = await request;
      if (!value.warning) {
        cache.set(key, { value, expiresAt: now() + (value.results.length ? ttlMs : Math.min(ttlMs, 30000)) });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
      }
      return structuredClone(value);
    } finally { pending.delete(key); }
  };
}

export const searchReports = createReportSearch();
