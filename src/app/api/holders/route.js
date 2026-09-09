import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { warmGet, warmSet } from '../../../utils/warmCache.js';
import { secFetch } from '../../../utils/secClient.js';

// ============================================================================
// api/holders — 13F Institutional Holders (Next.js route handler)
//
// v1 relied on SEC's full-text search, which doesn't rank results by holder
// size. Result: we got small family offices instead of Vanguard / BlackRock.
//
// v2 uses a hybrid approach:
//   1. Known-filer lookup: a curated list of ~50 major institutional managers
//      whose CIKs we query directly for their most recent 13F-HR filings.
//   2. Search fallback: SEC full-text search catches additional holders we
//      don't have hardcoded.
//
// For each filer we find:
//   - Most recent 13F-HR filing via submissions API
//   - Information table XML containing all holdings
//   - Regex scan for rows matching our target CUSIP
//   - Sum up share/value across multiple rows (same filer can report multiple
//     positions of the same security for different funds/share classes)
//
// Performance: controlled-concurrency batches respect SEC's 10 req/sec limit.
// Typical response time: 5-10 seconds for a mega-cap ticker.
// ============================================================================

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HOLDER_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=43200, stale-while-revalidate=604800, stale-if-error=604800',
};
const HOLDER_FRESH_MS = 12 * 60 * 60 * 1000;
const holderPending = new Map();

// ----------------------------------------------------------------------------
// Known institutional 13F filers, ranked roughly by AUM / 13F visibility.
// These CIKs are publicly visible at sec.gov; all file quarterly 13F-HR forms.
// Structure: { cik, name, type }
// ----------------------------------------------------------------------------
const KNOWN_FILERS = [
  // Index fund / passive giants — these hold everything in the S&P 500
  { cik: '0000102909', name: 'Vanguard Group', type: 'index' },
  { cik: '0001364742', name: 'BlackRock', type: 'index' },
  { cik: '0000093751', name: 'State Street', type: 'index' },
  { cik: '0001541617', name: 'Geode Capital Management', type: 'index' },
  { cik: '0000315066', name: 'Fidelity (FMR LLC)', type: 'active' },
  { cik: '0000216105', name: 'T. Rowe Price', type: 'active' },
  { cik: '0000073124', name: 'Northern Trust', type: 'custody' },
  { cik: '0000895421', name: 'Morgan Stanley', type: 'bank' },
  { cik: '0000886982', name: 'Goldman Sachs', type: 'bank' },
  { cik: '0000019617', name: 'JPMorgan Chase', type: 'bank' },
  { cik: '0000036405', name: 'Bank of America', type: 'bank' },
  { cik: '0000072971', name: 'Wells Fargo', type: 'bank' },
  { cik: '0000867626', name: 'UBS Group', type: 'bank' },
  { cik: '0001067983', name: 'Berkshire Hathaway', type: 'active' },
  { cik: '0000902771', name: 'Wellington Management', type: 'active' },
  { cik: '0000764462', name: 'Invesco', type: 'active' },
  { cik: '0000820313', name: 'Capital World Investors', type: 'active' },
  { cik: '0001086364', name: 'Capital Research Global Investors', type: 'active' },
  { cik: '0000354204', name: 'Capital International Investors', type: 'active' },
  { cik: '0001350694', name: 'Bridgewater Associates', type: 'hedge' },
  { cik: '0001037389', name: 'Renaissance Technologies', type: 'hedge' },
  { cik: '0001167483', name: 'D.E. Shaw', type: 'hedge' },
  { cik: '0001167557', name: 'Citadel Advisors', type: 'hedge' },
  { cik: '0001179392', name: 'Two Sigma Investments', type: 'hedge' },
  { cik: '0001167482', name: 'AQR Capital Management', type: 'hedge' },
  { cik: '0001336528', name: 'Viking Global Investors', type: 'hedge' },
  { cik: '0001418814', name: 'Tiger Global Management', type: 'hedge' },
  { cik: '0001336528', name: 'Viking Global', type: 'hedge' },
  { cik: '0001034621', name: 'Baillie Gifford', type: 'active' },
  { cik: '0001603466', name: 'Elliott Investment Management', type: 'hedge' },
  { cik: '0001336528', name: 'Lone Pine Capital', type: 'hedge' },
  { cik: '0001350694', name: 'Coatue Management', type: 'hedge' },
  { cik: '0001647314', name: 'Pershing Square Capital', type: 'hedge' },
  { cik: '0001040273', name: 'Third Point', type: 'hedge' },
  { cik: '0001079114', name: 'Greenlight Capital', type: 'hedge' },
  { cik: '0001067837', name: 'Appaloosa Management', type: 'hedge' },
  { cik: '0001061768', name: 'Point72 Asset Management', type: 'hedge' },
  { cik: '0001061768', name: 'Millennium Management', type: 'hedge' },
  { cik: '0001100663', name: 'Dimensional Fund Advisors', type: 'index' },
  { cik: '0001029160', name: 'Franklin Resources', type: 'active' },
  { cik: '0000354204', name: 'Janus Henderson', type: 'active' },
  { cik: '0001166559', name: 'Legg Mason / ClearBridge', type: 'active' },
  { cik: '0000764478', name: 'Nuveen', type: 'active' },
  { cik: '0001655327', name: 'TIAA / Teachers Advisors', type: 'active' },
  { cik: '0000315066', name: 'Fidelity Management Research', type: 'active' },
  { cik: '0001166559', name: 'Putnam Investments', type: 'active' },
  { cik: '0001168164', name: 'Legal & General Investment', type: 'index' },
  { cik: '0001535538', name: 'Charles Schwab Investment', type: 'index' },
  { cik: '0001166559', name: 'Lazard Asset Management', type: 'active' },
  { cik: '0001336528', name: 'Maverick Capital', type: 'hedge' },
  { cik: '0001603466', name: 'ValueAct Capital', type: 'hedge' },
];

// Keep the first label for duplicate CIKs; the response ultimately uses the
// authoritative filer name returned by SEC submissions.
const UNIQUE_FILERS = KNOWN_FILERS.filter(
  (filer, index, rows) => rows.findIndex((candidate) => candidate.cik === filer.cik) === index,
);

// ----------------------------------------------------------------------------
// Target CUSIPs for common tickers. SEC doesn't expose ticker→CUSIP directly.
// ----------------------------------------------------------------------------
const KNOWN_CUSIPS = {
  'AAPL': '037833100',
  'MSFT': '594918104',
  'GOOGL': '02079K305',
  'GOOG': '02079K107',
  'AMZN': '023135106',
  'META': '30303M102',
  'TSLA': '88160R101',
  'NVDA': '67066G104',
  'JPM': '46625H100',
  'BAC': '060505104',
  'WFC': '949746101',
  'C': '172967424',
  'GS': '38141G104',
  'MS': '617446448',
  'BRK.A': '084670108',
  'BRK.B': '084670702',
  'V': '92826C839',
  'MA': '57636Q104',
  'JNJ': '478160104',
  'PG': '742718109',
  'XOM': '30231G102',
  'CVX': '166764100',
  'WMT': '931142103',
  'HD': '437076102',
  'DIS': '254687106',
  'NFLX': '64110L106',
  'KO': '191216100',
  'PEP': '713448108',
  'MCD': '580135101',
  'NKE': '654106103',
  'SBUX': '855244109',
  'INTC': '458140100',
  'AMD': '007903107',
  'CRM': '79466L302',
  'ORCL': '68389X105',
  'IBM': '459200101',
  'T': '00206R102',
  'VZ': '92343V104',
  'UNH': '91324P102',
  'PFE': '717081103',
  'BA': '097023105',
  'CAT': '149123101',
  'GE': '369604301',
  'F': '345370860',
  'GM': '37045V100',
};

// ============================================================================
// Main handler
// ============================================================================

export async function GET(request) {
  const tickerUpper = (new URL(request.url).searchParams.get('ticker') || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(tickerUpper)) {
    return Response.json(
      { error: 'Provide one valid ticker.' },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const cusip = KNOWN_CUSIPS[tickerUpper];

  if (!cusip) {
    return Response.json(
      {
        holders: [],
        meta: {
          ticker: tickerUpper,
          cusip: null,
          message: '13F holder data currently available for common large-cap tickers only.',
        },
      },
      { headers: HOLDER_CACHE_HEADERS },
    );
  }

  const cached = await warmGet('holders-v3', tickerUpper);
  if (cached && Date.now() - Date.parse(cached.retrievedAt) < HOLDER_FRESH_MS) {
    return Response.json(
      { ...cached, meta: { ...cached.meta, cache: 'shared' } },
      { headers: { ...HOLDER_CACHE_HEADERS, 'X-Cache-Source': 'warm' } },
    );
  }

  // One request can inspect dozens of reports, so charge it as expensive
  // work rather than as one ordinary API call.
  const limit = await checkRateLimit({
    key: `rl:holders:${getClientIp(request)}`,
    windowMs: 10 * 60_000,
    max: 120,
    cost: 60,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);

  const userAgent = process.env.SEC_USER_AGENT || 'EDGAR Terminal research-tool@example.com';

  try {
    let task = holderPending.get(tickerUpper);
    if (!task) {
      task = (async () => {
        const knownScan = await fetchKnownFilerHoldings(UNIQUE_FILERS, cusip, userAgent);
        const minimumCoverage = Math.ceil(UNIQUE_FILERS.length * 0.75);
        if (knownScan.checked < minimumCoverage) {
          throw new Error(`Only ${knownScan.checked} of ${UNIQUE_FILERS.length} institutional filings could be checked.`);
        }
        const knownHolders = knownScan.holdings;
        const knownCiks = new Set(UNIQUE_FILERS.map((filer) => filer.cik));
        const searchScan = await fetchSearchFallbackHoldings(cusip, knownCiks, userAgent, 20);
        const searchHolders = searchScan.holdings;
        const complete = knownScan.failed === 0 && searchScan.complete;
        const allHolders = [...knownHolders, ...searchHolders]
          .sort((a, b) => (b.value || 0) - (a.value || 0));
        return {
          holders: allHolders.slice(0, 30),
          retrievedAt: new Date().toISOString(),
          meta: {
            ticker: tickerUpper,
            cusip,
            knownFilersChecked: UNIQUE_FILERS.length,
            knownFilersVerified: knownScan.checked,
            knownFilersWithHolding: knownHolders.length,
            searchFilersAdded: searchHolders.length,
            failedChecks: knownScan.failed + searchScan.failed,
            complete,
            cache: 'upstream',
          },
        };
      })();
      holderPending.set(tickerUpper, task);
    }
    try {
      const payload = await task;
      if (!payload.meta.complete) {
        if (cached) throw new Error('The latest 13F refresh was incomplete.');
        return Response.json(
          { ...payload, meta: { ...payload.meta, warning: 'Some institutional filings could not be checked; this partial result was not retained.' } },
          { headers: { 'Cache-Control': 'private, no-store', 'X-Data-Partial': '1' } },
        );
      }
      await warmSet('holders-v3', tickerUpper, payload, 7 * 86400);
      return Response.json(payload, { headers: { ...HOLDER_CACHE_HEADERS, 'X-Cache-Source': 'upstream' } });
    } finally {
      if (holderPending.get(tickerUpper) === task) holderPending.delete(tickerUpper);
    }
  } catch (err) {
    console.error('Holders API error:', err);
    if (cached) {
      return Response.json(
        { ...cached, meta: { ...cached.meta, cache: 'stale', warning: 'Holder refresh failed; showing the last completed 13F snapshot.' } },
        { headers: { ...HOLDER_CACHE_HEADERS, Warning: '110 - "Response is stale"', 'X-Data-Stale': '1' } },
      );
    }
    return Response.json(
      { error: 'Failed to fetch 13F data', detail: err.message },
      { status: 502, headers: { 'Cache-Control': 'private, no-store' } }
    );
  }
}

// ============================================================================
// Known-filer path: iterate curated list, fetch each's most recent 13F-HR
// ============================================================================

async function fetchKnownFilerHoldings(filers, targetCusip, userAgent) {
  const holdings = [];
  let checked = 0;
  let failed = 0;
  // Keep memory bounded while the shared SEC transport paces request starts.
  const batchSize = 2;

  for (let i = 0; i < filers.length; i += batchSize) {
    const batch = filers.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((filer) => fetchFilerHolding(filer, targetCusip, userAgent))
    );
    for (const result of batchResults) {
      if (result.ok) {
        checked += 1;
        if (result.holding) holdings.push(result.holding);
      } else {
        failed += 1;
      }
    }
    if (i + batchSize < filers.length) {
      await sleep(100);
    }
  }
  return { holdings, checked, failed };
}

/**
 * For one known filer, find their most recent 13F-HR and extract their holding
 * of the target CUSIP (if any). A checked non-holder is distinct from a failed
 * filing request so outages cannot become a cached empty answer.
 */
async function fetchFilerHolding(filer, targetCusip, userAgent) {
  try {
    // Step 1: Get the filer's submissions to find their most recent 13F-HR
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${filer.cik}.json`;
    const submissionsRes = await fetchWithRetry(submissionsUrl, userAgent);
    if (!submissionsRes.ok) throw new Error(`SEC submissions returned HTTP ${submissionsRes.status}.`);

    const submissions = await submissionsRes.json();
    const recent = submissions?.filings?.recent;
    if (!recent) return { ok: true, holding: null };

    // Find index of most recent 13F-HR
    let mostRecentIdx = -1;
    let mostRecentDate = '';
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i];
      if (form === '13F-HR' || form === '13F-HR/A') {
        const date = recent.filingDate[i];
        if (date > mostRecentDate) {
          mostRecentDate = date;
          mostRecentIdx = i;
        }
      }
    }
    if (mostRecentIdx === -1) return { ok: true, holding: null };

    const accession = recent.accessionNumber[mostRecentIdx];
    const fileDate = recent.filingDate[mostRecentIdx];
    const periodOfReport = recent.reportDate?.[mostRecentIdx];

    // Step 2: Fetch the information table XML
    const holding = await fetchAndExtractHolding(
      filer.cik,
      accession,
      targetCusip,
      userAgent
    );

    if (!holding) return { ok: true, holding: null };

    return {
      ok: true,
      holding: {
        filerCik: filer.cik,
        filerName: submissions.name || filer.name,
        fileDate,
        periodOfReport,
        accession,
        ...holding,
        source: 'known',
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// Search-fallback path
// ============================================================================

async function fetchSearchFallbackHoldings(targetCusip, skipCiks, userAgent, maxResults) {
  try {
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${targetCusip}%22&forms=13F-HR&dateRange=custom&startdt=${getDateMonthsAgo(4)}&enddt=${today()}`;

    const searchRes = await fetchWithRetry(searchUrl, userAgent);
    if (!searchRes.ok) {
      return { holdings: [], complete: false, failed: 1 };
    }

    const searchData = await searchRes.json();
    if (!Array.isArray(searchData?.hits?.hits)) {
      return { holdings: [], complete: false, failed: 1 };
    }
    const hits = searchData.hits.hits;

    // Dedupe by filer CIK, skip anyone already in known list.
    // Take most recent filing per filer.
    const byFiler = new Map();
    for (const hit of hits) {
      const source = hit._source || {};
      const ciks = source.ciks || [];
      const filerCik = ciks[0];
      if (!filerCik || skipCiks.has(filerCik)) continue;

      const displayNames = source.display_names || [];
      const filerName = displayNames[0] || 'Unknown';
      const accession = (hit._id || '').split(':')[0];
      if (!accession) continue;

      const fileDate = source.file_date;
      const existing = byFiler.get(filerCik);
      if (existing && existing.fileDate > fileDate) continue; // keep later file date

      byFiler.set(filerCik, {
        filerCik,
        filerName: filerName.replace(/\s+\(CIK.*?\)/, '').trim(),
        accession,
        fileDate,
        periodOfReport: source.period_of_report,
      });
    }

    const candidates = Array.from(byFiler.values()).slice(0, maxResults);
    const results = [];
    let failed = 0;

    // Process in small batches to control load
    const batchSize = 2;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          try {
            const holding = await fetchAndExtractHolding(
              candidate.filerCik,
              candidate.accession,
              targetCusip,
              userAgent
            );
            if (!holding) return null;
            return { ...candidate, ...holding, source: 'search' };
          } catch {
            failed += 1;
            return null;
          }
        })
      );
      results.push(...batchResults.filter(Boolean));
      if (i + batchSize < candidates.length) {
        await sleep(150);
      }
    }

    return { holdings: results, complete: failed === 0, failed };
  } catch (err) {
    console.warn('Search fallback failed:', err.message);
    return { holdings: [], complete: false, failed: 1 };
  }
}

// ============================================================================
// Information table XML extraction
// ============================================================================

/**
 * Fetch a 13F-HR filing's information table XML and extract the holding for
 * the target CUSIP. Returns { shares, value, issuerName } or null.
 */
async function fetchAndExtractHolding(filerCik, accession, targetCusip, userAgent) {
  const cikStripped = String(filerCik).replace(/^0+/, '');
  const accnNoHyphens = accession.replace(/-/g, '');

    // The filing's folder contains index.json listing all files
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/index.json`;
    const idxRes = await fetchWithRetry(indexUrl, userAgent);
    if (!idxRes.ok) throw new Error(`SEC filing index returned HTTP ${idxRes.status}.`);

    const idx = await idxRes.json();
    const items = idx?.directory?.item || [];

    // Find the info table — naming varies by filer/year but always an XML
    // that contains "informationtable" in the name
    const infoTableFile = items.find((i) =>
      i.name.toLowerCase().includes('informationtable') && i.name.endsWith('.xml')
    ) || items.find((i) => /info.*table.*\.xml$/i.test(i.name));

    if (!infoTableFile) throw new Error('The 13F information table could not be located.');

    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/${infoTableFile.name}`;
    const xmlRes = await fetchWithRetry(xmlUrl, userAgent);
    if (!xmlRes.ok) throw new Error(`SEC information table returned HTTP ${xmlRes.status}.`);

    const xmlText = await xmlRes.text();

    // Find all infoTable blocks that mention our target CUSIP.
    // A filer may list multiple rows for the same CUSIP (different funds, share classes).
    // We regex-scan instead of full XML parsing because these files can be 30MB+.
    const blockRegex = new RegExp(
      `<infoTable[^>]*>([\\s\\S]*?)</infoTable>`,
      'gi'
    );

    let totalShares = 0;
    let totalValue = 0;
    let issuerName = null;
    let matchCount = 0;

    let match;
    while ((match = blockRegex.exec(xmlText)) !== null) {
      const block = match[1];
      // Does this block contain our target CUSIP?
      if (!block.includes(targetCusip)) continue;

      const nameMatch = block.match(/<nameOfIssuer[^>]*>([^<]+)<\/nameOfIssuer>/i);
      if (nameMatch && !issuerName) {
        issuerName = nameMatch[1].trim();
      }

      const valueMatch = block.match(/<value[^>]*>\s*([\d.]+)\s*<\/value>/i);
      const sharesMatch = block.match(/<sshPrnamt[^>]*>\s*([\d.]+)\s*<\/sshPrnamt>/i);

      if (valueMatch) totalValue += parseFloat(valueMatch[1]);
      if (sharesMatch) totalShares += parseFloat(sharesMatch[1]);
      matchCount++;
    }

    if (matchCount === 0) return null;

    // Pre-September 2022, SEC reported value in thousands; post, in raw dollars.
    // We detect by file date. This isn't part of our return args, so we
    // derive the file year from the accession number.
    // Accession format: CIK-YY-NNNNNN, so year is in positions 11-12.
    const accnParts = accession.split('-');
    const accnYear = accnParts[1] ? parseInt(accnParts[1], 10) : 99;
    // Accessions with 2-digit year 22 or lower are likely pre-transition.
    // Safer: use a simple rule — if year < 23, multiply by 1000.
    const valueIsThousands = accnYear >= 0 && accnYear < 23;
    const finalValue = valueIsThousands ? totalValue * 1000 : totalValue;

  return {
    shares: totalShares,
    value: finalValue,
    issuerName,
    rowCount: matchCount,
  };
}

// ============================================================================
// HTTP helpers
// ============================================================================

/**
 * Fetch with one retry on failure. SEC occasionally returns 429 under load
 * even with proper pacing; a single retry with backoff handles most cases.
 */
async function fetchWithRetry(url, userAgent, attempt = 0) {
  return secFetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json,application/xml,text/xml,*/*' },
    timeoutMs: 12_000,
    retries: Math.max(0, 2 - attempt),
  });
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getDateMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}
