import { buildKeywordDefinitions } from '../../../utils/disclosureKeywords.js';
import { resolveDisclosureCompany } from '../../../utils/tickerMap.js';
import { parseDisclosureQuery } from '../../../utils/disclosureQuery.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { secFetch } from '../../../utils/secClient.js';
import { compileDisclosureIndexQuery, disclosureIndexPagination, disclosureIndexPageCoverage } from '../../../utils/disclosureIndexSearch.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SEC_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const DEFAULT_USER_AGENT = 'SEC EDGAR Terminal research@secedgarterminal.com';
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 120;
const MAX_FOCUS_TERMS = 5;
const DEFAULT_FORMS = ['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A', '20-F', '40-F', 'N-CSR'];
const ALLOWED_FORMS = new Set([
  '10-K',
  '10-Q',
  '8-K',
  'S-1',
  'S-3',
  'S-4',
  'DEF 14A',
  'DEFM14A',
  '20-F',
  '40-F',
  'N-CSR',
  'NPORT-P',
  '10-K/A', '10-Q/A', '8-K/A', '20-F/A', '40-F/A', '6-K', '6-K/A', 'S-1/A', 'S-3/A', 'S-4/A', 'N-CSR/A', 'NPORT-P/A', 'DEF 14A/A', 'DEFM14A/A',
]);

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function monthsAgo(months) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

function parseForms(rawForms) {
  if (!rawForms) return DEFAULT_FORMS;
  const forms = rawForms
    .split(',')
    .map((form) => form.trim().toUpperCase())
    .filter((form) => ALLOWED_FORMS.has(form));
  return forms.length ? Array.from(new Set(forms)) : DEFAULT_FORMS;
}

function quoteSearchTerm(term) {
  const clean = String(term || '')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `"${clean}"`;
}

function parseMatchMode(value) {
  return String(value || '').toLowerCase() === 'all' ? 'all' : 'any';
}

function buildSecQuery(terms, matchMode = 'any') {
  return terms.map(quoteSearchTerm).join(matchMode === 'all' ? ' ' : ' OR ');
}

function buildSearchParams({ secQuery, forms, startDate, endDate, from, size, ciks = [] }) {
  return new URLSearchParams({
    q: secQuery,
    forms: forms.join(','),
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: String(from),
    size: String(size),
    ...(ciks.length ? { ciks: ciks.join(',') } : {}),
  });
}

function totalValue(data) {
  const total = data?.hits?.total;
  if (typeof total === 'number') return total;
  const value = total?.value || 0;
  return Number.isFinite(value) ? value : 0;
}

async function fetchSearchPage({ secQuery, forms, startDate, endDate, from, size, signal, ciks = [] }) {
  const params = buildSearchParams({
    secQuery,
    forms,
    startDate,
    endDate,
    from,
    size,
    ciks,
  });
  const requestUrl = `${SEC_SEARCH_URL}?${params}`;
  const response = await secFetch(requestUrl, {
    headers: {
      'User-Agent': process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
    signal,
    timeoutMs: 10_000,
  });

  if (!response.ok) {
    const error = new Error(`SEC full-text search returned HTTP ${response.status}`);
    error.status = response.status;
    error.requestUrl = requestUrl;
    throw error;
  }

  return {
    data: await response.json(),
    requestUrl,
  };
}

function parseFocusTerms(rawFocus) {
  if (!rawFocus) return [];
  return rawFocus
    .split(',')
    .map((term) => term.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, MAX_FOCUS_TERMS)
    .map((raw) => {
      const upper = raw.toUpperCase();
      const digits = raw.replace(/\D/g, '');
      const isCik = /^\d{1,10}$/.test(raw);
      const isTicker = /^[A-Z][A-Z0-9.-]{0,9}$/.test(upper);
      return {
        raw,
        upper,
        lower: raw.toLowerCase(),
        cik: isCik ? digits.padStart(10, '0') : null,
        ticker: isTicker ? upper : null,
      };
    });
}

function parseDisplayName(displayName, cik) {
  const fallback = cik ? `CIK ${cik}` : 'Unknown filer';
  if (!displayName) return { companyName: fallback, tickers: [] };

  const withoutCik = displayName.replace(/\s*\(CIK\s+\d+\)\s*$/i, '').trim();
  const tickerMatch = withoutCik.match(/\(([^()]+)\)\s*$/);
  const tickers = tickerMatch
    ? tickerMatch[1]
        .split(',')
        .map((ticker) => ticker.trim().toUpperCase())
        .filter(Boolean)
    : [];
  const companyName = tickerMatch
    ? withoutCik.slice(0, tickerMatch.index).trim()
    : withoutCik;

  return {
    companyName: companyName || fallback,
    tickers,
  };
}

function documentNameFromHit(hit) {
  const id = String(hit?._id || '');
  const colonIndex = id.indexOf(':');
  if (colonIndex >= 0) return id.slice(colonIndex + 1);
  return '';
}

function buildDocumentUrl(cik, accession, documentName) {
  if (!/^\d{1,10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
    || !/^[\w][\w.\/-]*$/.test(documentName) || documentName.includes('..')
    || documentName.includes('//')) return null;
  const cikInt = Number.parseInt(cik, 10);
  if (!Number.isFinite(cikInt)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession.replace(/-/g, '')}/${documentName}`;
}

function normalizeHit(hit, rank, focusTerms = []) {
  const source = hit?._source || {};
  const focusedIndex = (source.ciks || []).findIndex((cik) => focusTerms.some((f) => f.cik === String(cik).padStart(10, '0')));
  const issuerIndex = Math.max(0, focusedIndex);
  const cik = String(source.ciks?.[issuerIndex] || '').padStart(10, '0');
  const displayName = source.display_names?.[issuerIndex] || source.display_names?.[0] || '';
  const display = parseDisplayName(displayName, cik);
  const accession = source.adsh || '';
  const documentName = documentNameFromHit(hit);
  const documentUrl = buildDocumentUrl(cik, accession, documentName);
  const form = source.form || source.root_forms?.[0] || '';

  return {
    rank,
    secRank: rank,
    score: Number.isFinite(hit?._score) ? hit._score : null,
    cik,
    requestedTicker: focusTerms.find((f) => f.cik === cik)?.ticker || null,
    companyName: display.companyName,
    tickers: display.tickers,
    displayName,
    accession,
    form,
    rootForms: source.root_forms || [],
    filingDate: source.file_date || '',
    periodEnding: source.period_ending || '',
    documentName,
    documentUrl,
    fileType: source.file_type || '',
    fileDescription: source.file_description || '',
    items: source.items || [],
    sic: source.sics?.[0] || '',
    businessLocation: source.biz_locations?.[0] || '',
    incorporationState: source.inc_states?.[0] || '',
    filmNumber: source.film_num?.[0] || '',
  };
}

function filingTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function latestSourceFromHits(hits) {
  return [...hits]
    .filter((hit) => hit.documentUrl)
    .sort((a, b) => (
      filingTime(b.filingDate) - filingTime(a.filingDate)
      || (a.rank || 0) - (b.rank || 0)
    ))[0] || null;
}

function buildSummary(hits, { focusApplied }) {
  const companyMap = new Map();
  const formMap = new Map();
  let firstFilingDate = '';
  let latestFilingDate = '';

  for (const hit of hits) {
    const companyKey = hit.cik || hit.companyName || 'unknown';
    const company = companyMap.get(companyKey) || {
      cik: hit.cik,
      companyName: hit.companyName || 'Unknown filer',
      requestedTicker: hit.requestedTicker || null,
      tickers: [],
      hits: 0,
      forms: {},
      firstFilingDate: '',
      latestFilingDate: '',
      latestSource: null,
      bestSecRank: null,
    };

    company.hits += 1;
    company.forms[hit.form || 'Filing'] = (company.forms[hit.form || 'Filing'] || 0) + 1;
    company.tickers = Array.from(new Set([...company.tickers, ...(hit.tickers || [])])).sort();
    company.bestSecRank = company.bestSecRank == null
      ? hit.rank
      : Math.min(company.bestSecRank, hit.rank);
    if (!company.firstFilingDate || filingTime(hit.filingDate) < filingTime(company.firstFilingDate)) {
      company.firstFilingDate = hit.filingDate || company.firstFilingDate;
    }
    if (!company.latestFilingDate || filingTime(hit.filingDate) > filingTime(company.latestFilingDate)) {
      company.latestFilingDate = hit.filingDate || company.latestFilingDate;
      company.latestSource = {
        form: hit.form,
        filingDate: hit.filingDate,
        accession: hit.accession,
        documentName: hit.documentName,
        documentUrl: hit.documentUrl,
        fileDescription: hit.fileDescription || hit.fileType || hit.documentName,
      };
    }
    companyMap.set(companyKey, company);

    const formKey = hit.form || 'Filing';
    const form = formMap.get(formKey) || {
      form: formKey,
      hits: 0,
      companies: new Set(),
      latestSource: null,
    };
    form.hits += 1;
    if (hit.cik) form.companies.add(hit.cik);
    if (!form.latestSource || filingTime(hit.filingDate) > filingTime(form.latestSource.filingDate)) {
      form.latestSource = {
        companyName: hit.companyName,
        tickers: hit.tickers || [],
        filingDate: hit.filingDate,
        documentUrl: hit.documentUrl,
      };
    }
    formMap.set(formKey, form);

    if (!firstFilingDate || filingTime(hit.filingDate) < filingTime(firstFilingDate)) {
      firstFilingDate = hit.filingDate || firstFilingDate;
    }
    if (!latestFilingDate || filingTime(hit.filingDate) > filingTime(latestFilingDate)) {
      latestFilingDate = hit.filingDate || latestFilingDate;
    }
  }

  const topCompanies = Array.from(companyMap.values())
    .sort((a, b) => (
      b.hits - a.hits
      || filingTime(b.latestFilingDate) - filingTime(a.latestFilingDate)
      || (a.bestSecRank || 999999) - (b.bestSecRank || 999999)
      || a.companyName.localeCompare(b.companyName)
    ))
    .slice(0, 10);

  const formMix = Array.from(formMap.values())
    .map((form) => ({
      form: form.form,
      hits: form.hits,
      companies: form.companies.size,
      latestSource: form.latestSource,
    }))
    .sort((a, b) => b.hits - a.hits || a.form.localeCompare(b.form));

  return {
    scope: focusApplied ? 'focused-sec-hits' : 'returned-sec-hits',
    analyzedHits: hits.length,
    companyCount: companyMap.size,
    formCount: formMap.size,
    dateSpan: {
      firstFilingDate,
      latestFilingDate,
    },
    latestSource: latestSourceFromHits(hits),
    topCompanies,
    formMix,
  };
}

export async function GET(request) {
  const url = new URL(request.url);
  const rawQuery = url.searchParams.get('query') || url.searchParams.get('keywords') || '';
  const expression = url.searchParams.get('expression');
  let advanced, parsed, pagination;
  try {
    if (rawQuery.length > 1000) throw new Error('Keep the query under 1,000 characters.');
    advanced = expression ? parseDisclosureQuery(expression) : null;
    parsed = advanced ? { terms: advanced.positive, definitions: advanced.positive, rejected: [] } : buildKeywordDefinitions(rawQuery);
    if (!parsed.definitions.length) throw new Error('Enter one or more words or phrases.');
    pagination = disclosureIndexPagination(url.searchParams);
  } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  const { from, limit } = pagination;
  const months = parsePositiveInt(url.searchParams.get('months'), DEFAULT_MONTHS, MAX_MONTHS);
  const rawForms = url.searchParams.get('forms');
  if (rawForms && rawForms.split(',').some(f => !ALLOWED_FORMS.has(f.trim().toUpperCase())))
    return Response.json({ error: 'Choose supported SEC filing forms.' }, { status: 400 });
  const forms = parseForms(rawForms);
  const rawFocus = url.searchParams.get('focus') || url.searchParams.get('ticker') || url.searchParams.get('cik') || url.searchParams.get('company') || '';
  if (rawFocus.length > 500 || rawFocus.split(',').filter(s => s.trim()).length > MAX_FOCUS_TERMS)
    return Response.json({ error: 'Focus the index on at most five companies.' }, { status: 400 });
  let focusTerms = parseFocusTerms(rawFocus);
  const matchMode = parseMatchMode(url.searchParams.get('match') || url.searchParams.get('matchMode'));
  const startDate = url.searchParams.get('startdt') || isoDate(monthsAgo(months));
  const today = isoDate(new Date());
  const endDate = url.searchParams.get('enddt') || today;
  if (![startDate, endDate].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) || startDate > endDate || startDate < '2001-01-01' || endDate > today)
    return Response.json({ error: 'Provide a valid filing-date range between 2001 and today.' }, { status: 400 });
  const compiled = advanced ? compileDisclosureIndexQuery(advanced) : null;
  const secQuery = compiled?.secQuery || buildSecQuery(parsed.terms, matchMode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new DOMException('SEC search timed out.', 'TimeoutError')), 25000);
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  const startedAt = performance.now();
  try {
    signal.throwIfAborted();
    const rate = await checkRateLimit({ key: `rl:edgar-index-search:${getClientIp(request)}`, windowMs: 5 * 60_000, max: 60, cost: 2 });
    if (!rate.allowed) return rateLimitedResponse(rate);
    try {
      focusTerms = await Promise.all(focusTerms.map(async focus => {
        signal.throwIfAborted();
        const resolved = await resolveDisclosureCompany(focus.raw);
        signal.throwIfAborted();
        return { ...focus, cik: resolved.cik, ticker: /^\d+$/.test(resolved.ticker) ? null : resolved.ticker };
      }));
    } catch (error) {
      signal.throwIfAborted();
      return Response.json({ error: error.message }, { status: 400 });
    }
    // Exactly one bounded SEC page per request; continuation starts at the
    // next raw hit so filtered/invalid document pointers never cause repeats.
    const { data, requestUrl } = await fetchSearchPage({ secQuery, forms, startDate, endDate, from, size: limit, signal, ciks: focusTerms.map(f => f.cik) });
    signal.throwIfAborted();
    // EFTS may ignore size and return its default batch. Consume only the
    // requested raw window so continuation cannot skip the unconsumed hits.
    const upstreamHits = Array.isArray(data?.hits?.hits) ? data.hits.hits : [];
    const rawHits = upstreamHits.slice(0, limit);
    const totalHits = totalValue(data);
    const totalRelation = data?.hits?.total?.relation === 'gte' ? 'gte' : 'eq';
    const seen = new Set();
    const requestedForms = new Set(forms);
    let excludedFormHits = 0;
    const results = rawHits.map((hit, index) => normalizeHit(hit, from + index + 1, focusTerms)).filter(hit => {
      // The SEC forms filter can also include amendments implicitly. Only
      // explicitly requested forms belong in this result set.
      if (!requestedForms.has(hit.form)) { excludedFormHits++; return false; }
      const key = `${hit.cik}:${hit.accession}:${hit.documentName}`;
      if (!hit.documentUrl || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const timedOut = Boolean(data?.timed_out);
    const page = disclosureIndexPageCoverage({ from, limit, rawHits: rawHits.length, totalHits, totalRelation, returnedHits: results.length, timedOut });
    page.coverage.excludedFormHits = excludedFormHits;
    page.coverage.upstreamHitsReceived = upstreamHits.length;
    page.coverage.totalHitsScope = 'SEC index total before exact form filtering; amendments are returned only when explicitly requested.';
    return Response.json({
      scannedAt: new Date().toISOString(), mode: 'edgar-index', cacheBackend: 'sec-index',
      source: { label: 'SEC full-text search index', url: requestUrl, requests: [requestUrl], pagesSearched: 1, pageSize: limit, fallback: null },
      query: {
        raw: expression || rawQuery, terms: parsed.terms, rejected: parsed.rejected, secQuery,
        fallbackSecQueries: [], matchMode, candidateSearch: true,
        exactPositiveLogic: compiled?.exactPositiveLogic ?? true,
        exclusionsDeferred: compiled?.exclusionsDeferred ?? false,
        nestedGroupsDeferred: compiled?.nestedGroupsDeferred ?? false,
        notes: compiled?.notes || [],
        verification: compiled?.verification || 'SEC index candidates; filing text has not been verified.',
      },
      focus: { raw: rawFocus, terms: focusTerms.map(f => f.raw), applied: focusTerms.length > 0,
        resolved: focusTerms.map(f => ({ requested: f.raw, ticker: f.ticker, cik: f.cik })),
        constrainedAtSource: focusTerms.length > 0, matchedHits: focusTerms.length ? results.length : null,
        searchedHits: rawHits.length, pagesSearched: 1, maxPages: 1 },
      dateRange: { start: startDate, end: endDate, months }, forms, totalHits, totalRelation,
      returnedHits: results.length, limit, ...page, tookMs: data?.took || null,
      elapsedMs: Math.round(performance.now() - startedAt), timedOut,
      summary: buildSummary(results, { focusApplied: focusTerms.length > 0 }), results, errors: [],
    }, { headers: { 'Cache-Control': timedOut ? 'private, no-store' : 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600, stale-if-error=86400' } });
  } catch (error) {
    const cancelled = request.signal?.aborted;
    const timeout = controller.signal.aborted || error?.name === 'TimeoutError';
    return Response.json({ error: cancelled ? 'Search cancelled.' : timeout ? 'SEC full-text search timed out. Try a shorter date range.' : error.message || 'SEC full-text search failed.' },
      { status: cancelled ? 499 : timeout ? 504 : error.status || 502, headers: { 'Cache-Control': 'private, no-store' } });
  } finally { clearTimeout(timeoutId); }
}
