import { NextResponse } from 'next/server';
import { buildKeywordDefinitions } from '../../../utils/disclosureKeywords.js';

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

function buildSecQuery(terms) {
  return terms.map(quoteSearchTerm).join(' OR ');
}

function buildSearchParams({ secQuery, forms, startDate, endDate, from, size }) {
  return new URLSearchParams({
    q: secQuery,
    forms: forms.join(','),
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: String(from),
    size: String(size),
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
    const key = `${hit.accession}:${hit.documentName}:${hit.cik}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function normalizeHit(hit, rank) {
  const source = hit?._source || {};
  const cik = String(source.ciks?.[0] || '').padStart(10, '0');
  const displayName = source.display_names?.[0] || '';
  const display = parseDisplayName(displayName, cik);
  const accession = source.adsh || '';
  const documentName = documentNameFromHit(hit);
  const documentUrl = buildDocumentUrl(cik, accession, documentName);
  const form = source.form || source.root_forms?.[0] || '';

  return {
    rank,
    score: hit?._score || 0,
    cik,
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
  const parsed = buildKeywordDefinitions(rawQuery);

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
  const focusTerms = parseFocusTerms(rawFocus);
  const startDate = url.searchParams.get('startdt') || isoDate(monthsAgo(months));
  const endDate = url.searchParams.get('enddt') || isoDate(new Date());
  const secQuery = buildSecQuery(parsed.terms);
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

    for (let page = 0; page < maxPages; page += 1) {
      const from = page * pageSize;
      const params = buildSearchParams({
        secQuery,
        forms,
        startDate,
        endDate,
        from,
        size: pageSize,
      });
      const requestUrl = `${SEC_SEARCH_URL}?${params}`;
      sourceUrls.push(requestUrl);

      const response = await fetch(requestUrl, {
        headers: {
          'User-Agent': process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: `SEC full-text search returned HTTP ${response.status}` },
          { status: 502 },
        );
      }

      const data = await response.json();
      const hits = data?.hits?.hits || [];
      if (page === 0) {
        totalHits = totalValue(data);
        totalRelation = data?.hits?.total?.relation || 'eq';
      }
      tookMs += data?.took || 0;
      timedOut = timedOut || Boolean(data?.timed_out);

      const normalizedPage = hits
        .map((hit, index) => normalizeHit(hit, from + index + 1))
        .filter((hit) => hit.documentUrl);
      normalizedPages.push(...normalizedPage);

      const focusedSoFar = focusTerms.length
        ? normalizedPages.filter((hit) => matchesFocus(hit, focusTerms))
        : normalizedPages;
      if (focusTerms.length && focusedSoFar.length >= limit) break;
      if (hits.length < pageSize) break;
      if (totalHits && from + hits.length >= totalHits) break;
    }

    const normalizedHits = uniqueHits(normalizedPages);
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
        },
        query: {
          raw: rawQuery,
          terms: parsed.terms,
          rejected: parsed.rejected,
          secQuery,
        },
        focus: {
          raw: rawFocus,
          terms: focusTerms.map((focus) => focus.raw),
          applied: focusTerms.length > 0,
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
        errors: [],
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
      : `SEC full-text search failed: ${err.message}`;
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
