import { NextResponse } from 'next/server';
import { fetchRecentFilings, fetchFilingText } from '../../../utils/filingTextParser.js';
import {
  buildKeywordDefinitions,
  disclosureSignature,
  extractParagraph,
  findDisclosureMatches,
} from '../../../utils/disclosureKeywords.js';
import {
  getBackendType,
  getCachedDisclosureScan,
  invalidateDisclosureScan,
  setCachedDisclosureScan,
} from '../../../utils/scannerCache.js';
import { getOperatingTickers } from '../../../utils/tickerMap.js';
import { getDisclosureMarketMap, getDisclosureUniverse } from '../../../utils/disclosureUniverses.js';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DEFAULT_DEPTH = 35;
const MAX_DEPTH = 50;
const DEFAULT_UNIVERSE_DEPTH = 12;
const MAX_UNIVERSE_DEPTH = 20;
const DEFAULT_MARKET_DEPTH = 2;
const MAX_MARKET_DEPTH = 5;
const MAX_MANUAL_TICKERS = 5;
const MAX_UNIVERSE_TICKERS = 8;
const MAX_MARKET_TICKERS = 40;
const SCAN_FORM_TYPES = ['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A', 'DEFM14A', '20-F', '40-F', 'N-CSR'];
const MAX_EXCERPTS_PER_FILING = 6;

function parseMatchMode(value) {
  return String(value || '').toLowerCase() === 'all' ? 'all' : 'any';
}

async function scanTicker(ticker, cik, depth, definitions, matchMode = 'any') {
  const startedAt = Date.now();
  const { filings, companyName, error: fetchErr } = await fetchRecentFilings(cik, depth, SCAN_FORM_TYPES);
  const requiredTerms = definitions.map((definition) => definition.canonical);

  if (fetchErr) {
    return {
      ticker,
      cik,
      companyName: null,
      error: `Failed to fetch filings: ${fetchErr}`,
      totalFilingsScanned: 0,
      filingsWithMatches: 0,
      totalMatches: 0,
      matches: [],
    };
  }

  if (filings.length === 0) {
    return {
      ticker,
      cik,
      companyName,
      totalFilingsScanned: 0,
      filingsWithMatches: 0,
      totalMatches: 0,
      matches: [],
      note: 'No matching filings found',
    };
  }

  const scanResults = await Promise.all(
    filings.map(async (filing) => {
      const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${filing.accession.replace(/-/g, '')}/${filing.primaryDoc}`;
      const { text, error } = await fetchFilingText(cik, filing.accession, filing.primaryDoc);

      if (error || !text) {
        return {
          ...filing,
          url,
          matchCount: 0,
          skipped: true,
          skipReason: error || 'No usable filing text returned',
          excerpts: [],
          keywordsFound: [],
          categoriesFound: [],
        };
      }

      const matches = findDisclosureMatches(text, definitions);
      if (matches.length === 0) {
        return {
          ...filing,
          url,
          matchCount: 0,
          excerpts: [],
          keywordsFound: [],
          categoriesFound: [],
        };
      }

      const keywordsFound = new Set(matches.map((match) => match.canonical));
      if (matchMode === 'all' && requiredTerms.some((term) => !keywordsFound.has(term))) {
        return {
          ...filing,
          url,
          matchCount: 0,
          excerpts: [],
          keywordsFound: Array.from(keywordsFound).sort(),
          categoriesFound: [],
          allTermsRequired: true,
        };
      }

      const excerpts = [];
      const usedTerms = new Set();

      for (const match of matches) {
        keywordsFound.add(match.canonical);
        if (excerpts.length >= MAX_EXCERPTS_PER_FILING) continue;
        if (usedTerms.has(match.canonical) && excerpts.length >= 2) continue;
        usedTerms.add(match.canonical);
        const paragraph = extractParagraph(text, match.index, match.length);
        excerpts.push({
          keyword: match.term,
          canonical: match.canonical,
          category: 'custom',
          before: paragraph.before,
          match: paragraph.match,
          after: paragraph.after,
          fullText: paragraph.fullText,
        });
      }

      return {
        ...filing,
        url,
        matchCount: matches.length,
        excerpts,
        keywordsFound: Array.from(keywordsFound).sort(),
        categoriesFound: ['custom'],
      };
    }),
  );

  const filingsWithMatches = scanResults.filter((result) => result.matchCount > 0);
  const totalMatches = scanResults.reduce((sum, result) => sum + result.matchCount, 0);
  const sortedMatches = [...filingsWithMatches].sort(
    (a, b) => new Date(a.filingDate) - new Date(b.filingDate),
  );
  const allKeywordsFound = new Set();

  for (const result of filingsWithMatches) {
    for (const keyword of result.keywordsFound) allKeywordsFound.add(keyword);
  }

  return {
    ticker,
    cik,
    companyName,
    totalFilingsScanned: scanResults.filter((result) => !result.skipped).length,
    totalFilingsAttempted: filings.length,
    totalFilingsFailed: scanResults.filter((result) => result.skipped).length,
    filingsWithMatches: filingsWithMatches.length,
    totalMatches,
    firstMention: sortedMatches.length ? sortedMatches[0].filingDate : null,
    mostRecentMention: sortedMatches.length ? sortedMatches[sortedMatches.length - 1].filingDate : null,
    categoriesFound: ['custom'],
    keywordsFound: Array.from(allKeywordsFound).sort(),
    matches: scanResults,
    scanDurationMs: Date.now() - startedAt,
  };
}

export async function GET(request) {
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers');
  const universeParam = url.searchParams.get('universe');
  const marketParam = url.searchParams.get('market') === 'true' || url.searchParams.get('scope') === 'market';
  const rawQuery = url.searchParams.get('query') || url.searchParams.get('keywords') || '';
  const depthParam = url.searchParams.get('depth');
  const fresh = url.searchParams.get('fresh') === 'true';
  const matchMode = parseMatchMode(url.searchParams.get('match') || url.searchParams.get('matchMode'));

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

  let selectedUniverse = null;
  let selectedMarket = null;
  let tickers = [];
  let mode = 'tickers';

  if (marketParam) {
    selectedMarket = getDisclosureMarketMap(MAX_MARKET_TICKERS);
    mode = 'market';
    tickers = selectedMarket.tickers.slice(0, MAX_MARKET_TICKERS);
  } else if (universeParam) {
    selectedUniverse = getDisclosureUniverse(universeParam);
    if (!selectedUniverse) {
      return NextResponse.json(
        { error: `Unknown disclosure universe: ${universeParam}` },
        { status: 400 },
      );
    }
    mode = 'universe';
    tickers = selectedUniverse.tickers.slice(0, MAX_UNIVERSE_TICKERS);
  } else if (tickersParam) {
    tickers = tickersParam
      .split(',')
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean);
  } else {
    return NextResponse.json(
      { error: 'Missing required parameter: tickers (comma-separated, 1-5 tickers), universe, or market=true' },
      { status: 400 },
    );
  }

  if (tickers.length === 0) {
    return NextResponse.json({ error: 'No valid tickers provided' }, { status: 400 });
  }

  if (mode === 'tickers' && tickers.length > MAX_MANUAL_TICKERS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_MANUAL_TICKERS} tickers per manual search. Got ${tickers.length}. Use a universe preset for broader scans.` },
      { status: 400 },
    );
  }

  if (mode === 'universe' && tickers.length > MAX_UNIVERSE_TICKERS) {
    tickers = tickers.slice(0, MAX_UNIVERSE_TICKERS);
  }

  if (mode === 'market' && tickers.length > MAX_MARKET_TICKERS) {
    tickers = tickers.slice(0, MAX_MARKET_TICKERS);
  }

  const defaultDepth = mode === 'market'
    ? DEFAULT_MARKET_DEPTH
    : mode === 'universe'
      ? DEFAULT_UNIVERSE_DEPTH
      : DEFAULT_DEPTH;
  const maxDepth = mode === 'market'
    ? MAX_MARKET_DEPTH
    : mode === 'universe'
      ? MAX_UNIVERSE_DEPTH
      : MAX_DEPTH;
  let depth = depthParam ? parseInt(depthParam, 10) : defaultDepth;
  if (!Number.isFinite(depth) || depth < 1) depth = defaultDepth;
  if (depth > maxDepth) depth = maxDepth;

  const signature = disclosureSignature({ terms: parsed.terms, depth, matchMode });

  let cikByTicker;
  try {
    cikByTicker = await getOperatingTickers(tickers);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load SEC ticker database: ${err.message}` },
      { status: 502 },
    );
  }

  const errors = [];
  const results = [];

  for (const ticker of tickers) {
    const entry = cikByTicker[ticker];
    if (!entry) {
      errors.push({ ticker, error: 'Ticker not found in SEC database' });
      continue;
    }

    if (!fresh) {
      try {
        const cached = await getCachedDisclosureScan(ticker, signature);
        if (cached?.result) {
          results.push({ ...cached.result, fromCache: true, cachedAt: cached.scannedAt });
          continue;
        }
      } catch {
        // Cache miss or cache backend issue; continue with a live scan.
      }
    }

    try {
      const result = await scanTicker(ticker, entry.cik, depth, parsed.definitions, matchMode);
      results.push({ ...result, fromCache: false });

      if (!result.error) {
        try {
          await setCachedDisclosureScan(ticker, signature, result);
        } catch (err) {
          console.warn('[disclosure-search] Cache write failed for', ticker, err.message);
        }
      }
    } catch (err) {
      errors.push({ ticker, error: `Search failed: ${err.message}` });
    }
  }

  const headers = fresh
    ? { 'Cache-Control': 'private, no-store' }
    : { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' };

  return NextResponse.json(
    {
      scannedAt: new Date().toISOString(),
      cacheBackend: await getBackendType(),
      depth,
      mode,
      universe: selectedUniverse
        ? {
            id: selectedUniverse.id,
            label: selectedUniverse.label,
            description: selectedUniverse.description,
            tickers,
          }
        : null,
      market: selectedMarket
        ? {
            id: selectedMarket.id,
            label: selectedMarket.label,
            description: selectedMarket.description,
            tickers,
          }
        : null,
      query: {
        raw: rawQuery,
        terms: parsed.terms,
        rejected: parsed.rejected,
        matchMode,
      },
      results,
      errors,
    },
    { headers },
  );
}

export async function DELETE(request) {
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers');
  const rawQuery = url.searchParams.get('query') || url.searchParams.get('keywords') || '';
  const depthParam = url.searchParams.get('depth');
  const matchMode = parseMatchMode(url.searchParams.get('match') || url.searchParams.get('matchMode'));

  if (!tickersParam) {
    return NextResponse.json({ error: 'Missing tickers parameter' }, { status: 400 });
  }

  const parsed = buildKeywordDefinitions(rawQuery);
  if (parsed.definitions.length === 0) {
    return NextResponse.json({ error: 'Missing query parameter' }, { status: 400 });
  }

  let depth = depthParam ? parseInt(depthParam, 10) : DEFAULT_DEPTH;
  if (!Number.isFinite(depth) || depth < 1) depth = DEFAULT_DEPTH;
  if (depth > MAX_DEPTH) depth = MAX_DEPTH;

  const signature = disclosureSignature({ terms: parsed.terms, depth, matchMode });
  const tickers = tickersParam.split(',').map((ticker) => ticker.trim().toUpperCase()).filter(Boolean);
  for (const ticker of tickers) {
    await invalidateDisclosureScan(ticker, signature);
  }

  return NextResponse.json({ invalidated: tickers, query: parsed.terms });
}
