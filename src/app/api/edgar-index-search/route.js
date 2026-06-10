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
  const startDate = url.searchParams.get('startdt') || isoDate(monthsAgo(months));
  const endDate = url.searchParams.get('enddt') || isoDate(new Date());
  const secQuery = buildSecQuery(parsed.terms);

  const params = new URLSearchParams({
    q: secQuery,
    forms: forms.join(','),
    dateRange: 'custom',
    startdt: startDate,
    enddt: endDate,
    from: '0',
    size: String(limit),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(`${SEC_SEARCH_URL}?${params}`, {
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
    const results = hits
      .slice(0, limit)
      .map((hit, index) => normalizeHit(hit, index + 1))
      .filter((hit) => hit.documentUrl);

    return NextResponse.json(
      {
        scannedAt: new Date().toISOString(),
        mode: 'edgar-index',
        cacheBackend: 'sec-index',
        source: {
          label: 'SEC full-text search index',
          url: `${SEC_SEARCH_URL}?${params}`,
        },
        query: {
          raw: rawQuery,
          terms: parsed.terms,
          rejected: parsed.rejected,
          secQuery,
        },
        dateRange: {
          start: startDate,
          end: endDate,
          months,
        },
        forms,
        totalHits: data?.hits?.total?.value || 0,
        totalRelation: data?.hits?.total?.relation || 'eq',
        returnedHits: results.length,
        tookMs: data?.took || null,
        timedOut: Boolean(data?.timed_out),
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
