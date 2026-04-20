import { NextResponse } from 'next/server';
import { fetchRecentFilings, fetchFilingText } from '../../../utils/filingTextParser.js';
import { findMatches, extractParagraph, CATEGORIES } from '../../../utils/cryptoKeywords.js';
import { getCachedScan, setCachedScan, invalidateScan, getBackendType } from '../../../utils/scannerCache.js';
import { getOperatingTickers } from '../../../utils/tickerMap.js';

// Runtime must be nodejs (not edge) because we use dynamic imports and longer timeouts
export const runtime = 'nodejs';
// Max duration: 300 seconds (5 minutes) — needed for deep scans of multiple tickers.
// Vercel Hobby plan limits to 60s; Pro allows up to 300s.
export const maxDuration = 300;

// Default scan depth if not specified
const DEFAULT_DEPTH = 50;
const MAX_DEPTH = 50;
const MAX_TICKERS = 5;

// Form types that are most likely to contain crypto mentions
// (10-K annual, 10-Q quarterly, 8-K current events, S-1 prospectus, DEF 14A proxy)
const SCAN_FORM_TYPES = ['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A', 'DEFM14A', '20-F', '40-F', 'N-CSR'];

// Max excerpts to return per filing (prevents response bloat)
const MAX_EXCERPTS_PER_FILING = 5;

/**
 * Scan a single ticker's filings for crypto mentions.
 *
 * @param {string} ticker
 * @param {string} cik
 * @param {number} depth - Max filings to scan
 * @returns {Promise<object>} - Scan result for this ticker
 */
async function scanTicker(ticker, cik, depth) {
  const startedAt = Date.now();

  // Fetch the most recent N filings
  const { filings, companyName, error: fetchErr } = await fetchRecentFilings(cik, depth, SCAN_FORM_TYPES);
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

  // Fetch and scan each filing in parallel (controlled by the semaphore in filingTextParser)
  const scanResults = await Promise.all(
    filings.map(async (f) => {
      const { text, error } = await fetchFilingText(cik, f.accession, f.primaryDoc);
      if (error || !text) {
        return {
          ...f,
          url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${f.accession.replace(/-/g, '')}/${f.primaryDoc}`,
          matchCount: 0,
          skipped: !!error,
          skipReason: error || null,
          excerpts: [],
          keywordsFound: [],
          categoriesFound: [],
        };
      }

      const matches = findMatches(text);
      if (matches.length === 0) {
        return {
          ...f,
          url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${f.accession.replace(/-/g, '')}/${f.primaryDoc}`,
          matchCount: 0,
          excerpts: [],
          keywordsFound: [],
          categoriesFound: [],
        };
      }

      // Aggregate keywords and categories
      const keywordsFoundSet = new Set();
      const categoriesFoundSet = new Set();
      for (const m of matches) {
        keywordsFoundSet.add(m.canonical);
        categoriesFoundSet.add(m.category);
      }

      // Extract paragraph context for up to N excerpts (prioritize variety across keywords)
      const excerpts = [];
      const usedKeywords = new Set();
      for (const m of matches) {
        if (excerpts.length >= MAX_EXCERPTS_PER_FILING) break;
        // Prefer unique keywords for excerpt variety
        if (usedKeywords.has(m.canonical) && excerpts.length >= 2) continue;
        usedKeywords.add(m.canonical);
        const para = extractParagraph(text, m.index, m.length);
        excerpts.push({
          keyword: m.term,
          canonical: m.canonical,
          category: m.category,
          before: para.before,
          match: para.match,
          after: para.after,
          fullText: para.fullText,
        });
      }

      return {
        ...f,
        url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${f.accession.replace(/-/g, '')}/${f.primaryDoc}`,
        matchCount: matches.length,
        excerpts,
        keywordsFound: Array.from(keywordsFoundSet),
        categoriesFound: Array.from(categoriesFoundSet),
      };
    })
  );

  // Aggregate across all filings
  const filingsWithMatches = scanResults.filter((r) => r.matchCount > 0);
  const totalMatches = scanResults.reduce((sum, r) => sum + r.matchCount, 0);

  // Find first and most recent mentions
  const matchingFilings = filingsWithMatches.sort((a, b) =>
    new Date(a.filingDate) - new Date(b.filingDate)
  );
  const firstMention = matchingFilings.length > 0 ? matchingFilings[0].filingDate : null;
  const mostRecentMention = matchingFilings.length > 0 ? matchingFilings[matchingFilings.length - 1].filingDate : null;

  // Aggregate all categories and keywords across the whole company
  const allCategoriesFound = new Set();
  const allKeywordsFound = new Set();
  for (const r of filingsWithMatches) {
    for (const c of r.categoriesFound) allCategoriesFound.add(c);
    for (const k of r.keywordsFound) allKeywordsFound.add(k);
  }

  return {
    ticker,
    cik,
    companyName,
    totalFilingsScanned: filings.length,
    filingsWithMatches: filingsWithMatches.length,
    totalMatches,
    firstMention,
    mostRecentMention,
    categoriesFound: Array.from(allCategoriesFound),
    keywordsFound: Array.from(allKeywordsFound).sort(),
    matches: scanResults,
    scanDurationMs: Date.now() - startedAt,
  };
}

/**
 * GET handler — accepts ?tickers=MSTR,COIN&depth=50&fresh=false
 *
 * Query params:
 *   - tickers: comma-separated tickers (required, 1-5)
 *   - depth: max filings per ticker (optional, default 50, max 50)
 *   - fresh: if "true", bypass cache and force fresh scan (optional)
 *
 * Response body:
 *   {
 *     scannedAt: ISO timestamp,
 *     cacheBackend: "upstash" | "memory",
 *     results: [{ ...scanResult }],
 *     errors: [{ ticker, error }]
 *   }
 */
export async function GET(request) {
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers');
  const depthParam = url.searchParams.get('depth');
  const fresh = url.searchParams.get('fresh') === 'true';

  if (!tickersParam) {
    return NextResponse.json(
      { error: 'Missing required parameter: tickers (comma-separated, 1-5 tickers)' },
      { status: 400 }
    );
  }

  const tickers = tickersParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) {
    return NextResponse.json({ error: 'No valid tickers provided' }, { status: 400 });
  }

  if (tickers.length > MAX_TICKERS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_TICKERS} tickers per scan. Got ${tickers.length}.` },
      { status: 400 }
    );
  }

  let depth = depthParam ? parseInt(depthParam, 10) : DEFAULT_DEPTH;
  if (!Number.isFinite(depth) || depth < 1) depth = DEFAULT_DEPTH;
  if (depth > MAX_DEPTH) depth = MAX_DEPTH;

  // Look up CIKs using the shared in-memory cache. Previously we fetched
  // company_tickers.json (~1.5MB) from SEC on every single request — now it's
  // cached for 6h per instance and deduped via in-flight-promise memoization.
  let cikByTicker;
  try {
    cikByTicker = await getOperatingTickers(tickers);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load SEC ticker database: ${err.message}` },
      { status: 502 }
    );
  }

  const errors = [];
  const results = [];

  // Process each ticker: try cache first, fall back to full scan
  for (const ticker of tickers) {
    const entry = cikByTicker[ticker];
    if (!entry) {
      errors.push({ ticker, error: 'Ticker not found in SEC database' });
      continue;
    }

    // Check cache (unless fresh=true)
    if (!fresh) {
      try {
        const cached = await getCachedScan(ticker);
        if (cached?.result) {
          results.push({ ...cached.result, fromCache: true, cachedAt: cached.scannedAt });
          continue;
        }
      } catch (err) {
        // Cache miss / error — proceed with fresh scan
      }
    }

    // Fresh scan
    try {
      const result = await scanTicker(ticker, entry.cik, depth);
      results.push({ ...result, fromCache: false });

      // Store in cache if the scan succeeded
      if (!result.error) {
        try {
          await setCachedScan(ticker, result);
        } catch (err) {
          // Cache write failure is not fatal
          console.warn('[crypto-scan] Cache write failed for', ticker, err.message);
        }
      }
    } catch (err) {
      errors.push({ ticker, error: `Scan failed: ${err.message}` });
    }
  }

  const backend = await getBackendType();

  // CDN caching: scan results are keyed by (tickers, depth). For a popular
  // scan like "MSTR", the first user triggers the work and the next 1000
  // users within 5 minutes get served from Vercel's edge cache without
  // invoking this function at all.
  //
  // We don't include fresh=true responses in the CDN cache — those are
  // explicit cache-busts and should not be shared.
  //
  // Note: the stale-while-revalidate window is generous because these scans
  // are expensive (up to 5 min) and filings don't change retroactively.
  const headers = fresh
    ? { 'Cache-Control': 'private, no-store' }
    : {
        // 5 min edge cache, 1 hour stale-while-revalidate
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
      };

  return NextResponse.json(
    {
      scannedAt: new Date().toISOString(),
      cacheBackend: backend,
      depth,
      results,
      errors,
    },
    { headers }
  );
}

/**
 * DELETE handler — invalidate cache for specific tickers
 * DELETE /api/crypto-scan?tickers=MSTR,COIN
 */
export async function DELETE(request) {
  const url = new URL(request.url);
  const tickersParam = url.searchParams.get('tickers');
  if (!tickersParam) {
    return NextResponse.json({ error: 'Missing tickers parameter' }, { status: 400 });
  }
  const tickers = tickersParam.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  for (const t of tickers) {
    await invalidateScan(t);
  }
  return NextResponse.json({ invalidated: tickers });
}
