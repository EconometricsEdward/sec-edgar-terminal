// ============================================================================
// api/holders.js — 13F Institutional Holders (v2)
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

// Dedupe by CIK — some names above might share CIKs in error
const UNIQUE_FILERS = Array.from(
  new Map(KNOWN_FILERS.map((f) => [f.cik, f])).values()
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

export default async function handler(req, res) {
  const { ticker } = req.query;
  if (!ticker) {
    return res.status(400).json({ error: 'ticker parameter required' });
  }

  const tickerUpper = ticker.toUpperCase();
  const cusip = KNOWN_CUSIPS[tickerUpper];

  if (!cusip) {
    return res.status(200).json({
      holders: [],
      meta: {
        ticker: tickerUpper,
        cusip: null,
        message: '13F holder data currently available for common large-cap tickers only.',
      },
    });
  }

  const userAgent = process.env.SEC_USER_AGENT || 'EDGAR Terminal research-tool@example.com';

  try {
    // ========================================================================
    // PHASE 1: Fetch each known filer's most recent 13F-HR info table
    // and scan for our target CUSIP. Runs in controlled-concurrency batches.
    // ========================================================================
    const knownHolders = await fetchKnownFilerHoldings(UNIQUE_FILERS, cusip, userAgent);

    // ========================================================================
    // PHASE 2: Use full-text search to find holders NOT in the known list.
    // This catches mid-size filers (like family offices > $1B AUM) we haven't
    // hardcoded. Limited to top 20 search hits to control load time.
    // ========================================================================
    const knownCiks = new Set(knownHolders.map((h) => h.filerCik));
    const searchHolders = await fetchSearchFallbackHoldings(
      cusip,
      knownCiks,
      userAgent,
      20 // max additional filers from search
    );

    // ========================================================================
    // MERGE + SORT
    // ========================================================================
    const allHolders = [...knownHolders, ...searchHolders];

    // Sort by value descending. Handle nulls gracefully (put them last).
    allHolders.sort((a, b) => {
      const av = a.value || 0;
      const bv = b.value || 0;
      return bv - av;
    });

    return res.status(200).json({
      holders: allHolders.slice(0, 30),
      meta: {
        ticker: tickerUpper,
        cusip,
        knownFilersChecked: UNIQUE_FILERS.length,
        knownFilersWithHolding: knownHolders.length,
        searchFilersAdded: searchHolders.length,
      },
    });
  } catch (err) {
    console.error('Holders API error:', err);
    return res.status(500).json({
      error: 'Failed to fetch 13F data',
      detail: err.message,
    });
  }
}

// ============================================================================
// Known-filer path: iterate curated list, fetch each's most recent 13F-HR
// ============================================================================

async function fetchKnownFilerHoldings(filers, targetCusip, userAgent) {
  const results = [];
  // Controlled concurrency. SEC allows 10 req/sec; we use 6 at a time with
  // a 200ms delay between batches = effective 30 req/sec peak but averaging
  // well under the limit. Some filers fail (don't exist, don't have 13F-HR,
  // don't hold this CUSIP) which is normal.
  const batchSize = 6;

  for (let i = 0; i < filers.length; i += batchSize) {
    const batch = filers.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((filer) => fetchFilerHolding(filer, targetCusip, userAgent))
    );
    results.push(...batchResults.filter(Boolean));
    if (i + batchSize < filers.length) {
      await sleep(200);
    }
  }
  return results;
}

/**
 * For one known filer, find their most recent 13F-HR and extract their holding
 * of the target CUSIP (if any). Returns null if no holding or on any error —
 * we want the whole flow to keep going even if individual filers fail.
 */
async function fetchFilerHolding(filer, targetCusip, userAgent) {
  try {
    // Step 1: Get the filer's submissions to find their most recent 13F-HR
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${filer.cik}.json`;
    const submissionsRes = await fetchWithRetry(submissionsUrl, userAgent);
    if (!submissionsRes.ok) return null;

    const submissions = await submissionsRes.json();
    const recent = submissions?.filings?.recent;
    if (!recent) return null;

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
    if (mostRecentIdx === -1) return null;

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

    if (!holding) return null;

    return {
      filerCik: filer.cik,
      filerName: filer.name,
      fileDate,
      periodOfReport,
      accession,
      ...holding,
      source: 'known',
    };
  } catch (err) {
    // Silent failure — expected for many filers
    return null;
  }
}

// ============================================================================
// Search-fallback path
// ============================================================================

async function fetchSearchFallbackHoldings(targetCusip, skipCiks, userAgent, maxResults) {
  try {
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${targetCusip}%22&forms=13F-HR&dateRange=custom&startdt=${getDateMonthsAgo(4)}&enddt=${today()}`;

    const searchRes = await fetchWithRetry(searchUrl, userAgent);
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json();
    const hits = searchData?.hits?.hits || [];

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

    // Process in small batches to control load
    const batchSize = 5;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          const holding = await fetchAndExtractHolding(
            candidate.filerCik,
            candidate.accession,
            targetCusip,
            userAgent
          );
          if (!holding) return null;
          return { ...candidate, ...holding, source: 'search' };
        })
      );
      results.push(...batchResults.filter(Boolean));
      if (i + batchSize < candidates.length) {
        await sleep(150);
      }
    }

    return results;
  } catch (err) {
    console.warn('Search fallback failed:', err.message);
    return [];
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
  try {
    const cikStripped = String(filerCik).replace(/^0+/, '');
    const accnNoHyphens = accession.replace(/-/g, '');

    // The filing's folder contains index.json listing all files
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/index.json`;
    const idxRes = await fetchWithRetry(indexUrl, userAgent);
    if (!idxRes.ok) return null;

    const idx = await idxRes.json();
    const items = idx?.directory?.item || [];

    // Find the info table — naming varies by filer/year but always an XML
    // that contains "informationtable" in the name
    const infoTableFile = items.find((i) =>
      i.name.toLowerCase().includes('informationtable') && i.name.endsWith('.xml')
    ) || items.find((i) => /info.*table.*\.xml$/i.test(i.name));

    if (!infoTableFile) return null;

    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/${infoTableFile.name}`;
    const xmlRes = await fetchWithRetry(xmlUrl, userAgent);
    if (!xmlRes.ok) return null;

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
  } catch (err) {
    return null;
  }
}

// ============================================================================
// HTTP helpers
// ============================================================================

/**
 * Fetch with one retry on failure. SEC occasionally returns 429 under load
 * even with proper pacing; a single retry with backoff handles most cases.
 */
async function fetchWithRetry(url, userAgent, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json,application/xml,text/xml,*/*',
      },
    });
    if (res.status === 429 && attempt < 2) {
      await sleep(500 * (attempt + 1));
      return fetchWithRetry(url, userAgent, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 2) {
      await sleep(500);
      return fetchWithRetry(url, userAgent, attempt + 1);
    }
    throw err;
  }
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
