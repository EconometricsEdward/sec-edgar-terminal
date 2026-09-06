import { NextResponse } from 'next/server';
import { buildKeywordDefinitions } from '../../../utils/disclosureKeywords.js';
import { resolveDisclosureCompany } from '../../../utils/tickerMap.js';
import { parseDisclosureQuery, quoteTerm } from '../../../utils/disclosureQuery.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SEC_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const DEFAULT_USER_AGENT = 'SEC EDGAR Terminal research@secedgarterminal.com';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 120;
const MAX_FOCUS_TERMS = 5;
const FOCUS_PAGE_SIZE = 100;
const MAX_FOCUS_PAGES = 5;
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

function buildFallbackQueries(terms, matchMode) {
  if (!['any', 'all'].includes(matchMode) || terms.length < 2) return [];
  return terms.map(quoteSearchTerm);
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

function uniqueHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = hitKey(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hitKey(hit) {
  return `${hit.accession}:${hit.documentName}:${hit.cik}`;
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
  const response = await fetch(requestUrl, {
    headers: {
      'User-Agent': process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
    signal,
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

function matchesFocus(hit, focusTerms) {
  if (!focusTerms.length) return true;
  const tickers = (hit.tickers || []).map((ticker) => String(ticker).toUpperCase());
  const companyName = String(hit.companyName || '').toLowerCase();
  const displayName = String(hit.displayName || '').toLowerCase();
  const cik = String(hit.cik || '').padStart(10, '0');

  return focusTerms.some((focus) => {
    if (focus.cik && cik === focus.cik) return true;
    if (focus.ticker && tickers.includes(focus.ticker)) return true;
    if (focus.lower.length >= 3 && (companyName.includes(focus.lower) || displayName.includes(focus.lower))) {
      return true;
    }
    return false;
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
  if (!cik || !accession || !documentName) return null;
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
    score: hit?._score || 0,
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
  let advanced;
  try { advanced = expression ? parseDisclosureQuery(expression) : null; }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const parsed = advanced ? { terms: advanced.positive, definitions: advanced.positive, rejected: [] } : buildKeywordDefinitions(rawQuery);

  if (parsed.definitions.length === 0) {
    return NextResponse.json(
      {
        error: 'Missing required parameter: query. Enter one or more words or phrases separated by commas.',
        rejected: parsed.rejected,
      },
      { status: 400 },
    );
  }

  const limit = parsePositiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
  const months = parsePositiveInt(url.searchParams.get('months'), DEFAULT_MONTHS, MAX_MONTHS);
  const forms = parseForms(url.searchParams.get('forms'));
  const rawFocus = url.searchParams.get('focus') || url.searchParams.get('ticker') || url.searchParams.get('cik') || url.searchParams.get('company') || '';
  let focusTerms = parseFocusTerms(rawFocus);
  if (rawFocus.split(',').filter((s) => s.trim()).length > MAX_FOCUS_TERMS) return NextResponse.json({ error: 'Focus the index on at most five companies.' }, { status: 400 });
  try {
    focusTerms = await Promise.all(focusTerms.map(async (focus) => {
      const resolved = await resolveDisclosureCompany(focus.raw);
      return { ...focus, cik: resolved.cik, ticker: /^\d+$/.test(resolved.ticker) ? null : resolved.ticker };
    }));
  } catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  const matchMode = parseMatchMode(url.searchParams.get('match') || url.searchParams.get('matchMode'));
  const startDate = url.searchParams.get('startdt') || isoDate(monthsAgo(months));
  const endDate = url.searchParams.get('enddt') || isoDate(new Date());
  if (![startDate, endDate].every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d) || startDate > endDate) return NextResponse.json({ error: 'Provide a valid filing-date range.' }, { status: 400 });
  // The SEC grammar does not recognize explicit AND or guarantee nested groups.
  // Discover a superset, then verify the full expression in the filing reader.
  const secQuery = advanced ? advanced.positive.map(quoteTerm).join(' OR ') : buildSecQuery(parsed.terms, matchMode);
  const pageSize = focusTerms.length ? FOCUS_PAGE_SIZE : limit;
  const maxPages = focusTerms.length ? MAX_FOCUS_PAGES : 1;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const normalizedPages = [];
    const sourceUrls = [];
    let totalHits = 0;
    let totalRelation = 'eq';
    let tookMs = 0;
    let timedOut = false;
    let usedFallback = false;
    let fallbackReason = '';
    let fallbackQueries = [];
    const fallbackErrors = [];
    const allFallbackHitQueries = new Map();

    const runSearchPages = async (activeSecQuery) => {
      for (let page = 0; page < maxPages; page += 1) {
        const from = page * pageSize;
        const { data, requestUrl } = await fetchSearchPage({
          secQuery: activeSecQuery,
          forms,
          startDate,
          endDate,
          from,
          size: pageSize,
          signal: controller.signal,
          ciks: focusTerms.map((f) => f.cik),
        });
        sourceUrls.push(requestUrl);

        const hits = data?.hits?.hits || [];
        if (page === 0) {
          if (usedFallback) {
            totalHits += totalValue(data);
            totalRelation = data?.hits?.total?.relation === 'gte' ? 'gte' : totalRelation;
          } else {
            totalHits = totalValue(data);
            totalRelation = data?.hits?.total?.relation || 'eq';
          }
        }
        tookMs += data?.took || 0;
        timedOut = timedOut || Boolean(data?.timed_out);

        const normalizedPage = hits
          .map((hit, index) => normalizeHit(hit, from + index + 1, focusTerms))
          .filter((hit) => hit.documentUrl);
        normalizedPages.push(...normalizedPage);

        if (usedFallback && matchMode === 'all') {
          for (const hit of normalizedPage) {
            const key = hitKey(hit);
            const querySet = allFallbackHitQueries.get(key) || new Set();
            querySet.add(activeSecQuery);
            allFallbackHitQueries.set(key, querySet);
          }
        }

        const focusedSoFar = focusTerms.length
          ? normalizedPages.filter((hit) => matchesFocus(hit, focusTerms))
          : normalizedPages;
        if (focusTerms.length && focusedSoFar.length >= limit) break;
        if (hits.length < pageSize) break;
        if (!usedFallback && totalHits && from + hits.length >= totalHits) break;
      }
    };

    try {
      await runSearchPages(secQuery);
    } catch (err) {
      fallbackQueries = advanced ? [] : buildFallbackQueries(parsed.terms, matchMode);
      if (!fallbackQueries.length) throw err;

      normalizedPages.length = 0;
      sourceUrls.length = 0;
      totalHits = 0;
      totalRelation = 'eq';
      tookMs = 0;
      timedOut = false;
      usedFallback = true;
      fallbackReason = err.message;

      for (const fallbackQuery of fallbackQueries) {
        try {
          await runSearchPages(fallbackQuery);
        } catch (fallbackErr) {
          fallbackErrors.push({
            query: fallbackQuery,
            error: fallbackErr?.message || 'SEC fallback search failed',
          });
        }
      }

      if (fallbackErrors.length === fallbackQueries.length) {
        throw err;
      }

      if (matchMode === 'all' && fallbackErrors.length > 0) {
        throw err;
      }
    }

    let normalizedHits = uniqueHits(normalizedPages);
    if (usedFallback && matchMode === 'all') {
      normalizedHits = normalizedHits.filter((hit) => (
        allFallbackHitQueries.get(hitKey(hit))?.size === fallbackQueries.length
      ));
    }
    if (usedFallback) {
      totalHits = normalizedHits.length;
      totalRelation = 'gte';
    }
    const focusedHits = normalizedHits.filter((hit) => matchesFocus(hit, focusTerms));
    const analysisHits = focusTerms.length ? focusedHits : normalizedHits;
    const summary = buildSummary(analysisHits, { focusApplied: focusTerms.length > 0 });
    const results = focusedHits
      .slice(0, limit)
      .map((hit, index) => ({
        ...hit,
        secRank: hit.rank,
        rank: index + 1,
      }));

    return NextResponse.json(
      {
        scannedAt: new Date().toISOString(),
        mode: 'edgar-index',
        cacheBackend: 'sec-index',
        source: {
          label: 'SEC full-text search index',
          url: sourceUrls[0] || null,
          requests: sourceUrls,
          pagesSearched: sourceUrls.length,
          pageSize,
          fallback: usedFallback
            ? {
                reason: fallbackReason,
                strategy: matchMode === 'all'
                  ? 'per-term all-match searches intersected by filing document'
                  : 'per-term any-match searches merged by filing document',
                errors: fallbackErrors,
              }
            : null,
        },
        query: {
          raw: expression || rawQuery,
          terms: parsed.terms,
          rejected: parsed.rejected,
          secQuery,
          fallbackSecQueries: usedFallback ? fallbackQueries : [],
          matchMode,
          candidateSearch: Boolean(advanced),
          verification: advanced ? 'Positive-term index candidates. The full Boolean query, paragraph scope, and section filter are verified only when a document is reviewed.' : 'SEC index matches; filing text has not been fetched.',
        },
        focus: {
          raw: rawFocus,
          terms: focusTerms.map((focus) => focus.raw),
          applied: focusTerms.length > 0,
          resolved: focusTerms.map((f) => ({ requested: f.raw, ticker: f.ticker, cik: f.cik })),
          constrainedAtSource: focusTerms.length > 0,
          matchedHits: focusTerms.length ? focusedHits.length : null,
          searchedHits: normalizedHits.length,
          pagesSearched: sourceUrls.length,
          maxPages,
        },
        dateRange: {
          start: startDate,
          end: endDate,
          months,
        },
        forms,
        totalHits,
        totalRelation,
        returnedHits: results.length,
        tookMs: tookMs || null,
        timedOut,
        summary,
        results,
        errors: fallbackErrors,
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
        },
      },
    );
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? 'SEC full-text search timed out'
      : err?.status
        ? err.message
        : `SEC full-text search failed: ${err.message}`;
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
