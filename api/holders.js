// ============================================================================
// api/holders.js — 13F Institutional Holders
//
// SEC Form 13F is filed quarterly by institutional investors managing $100M+.
// It lists every security they hold. This function finds the most recent 13F
// filings that include the given company's CUSIP and returns top holders.
//
// HOW THIS WORKS:
// Finding "who holds AAPL" is NOT a direct SEC API call. There's no endpoint
// like "/holders/AAPL.json". We have to work backwards:
//
//   1. Get the target company's CUSIP from its submissions data (if available)
//      or from the XBRL companyfacts (there's a tickers + cusip mapping endpoint).
//   2. Use SEC's full-text search to find 13F filings mentioning that CUSIP.
//   3. Fetch each 13F filing's information table (info.xml or similar).
//   4. Parse holdings for matching CUSIP and aggregate by filer.
//   5. Return top N holders sorted by shares or value.
//
// This is expensive and slow if done fully. For a v1, we use a simpler approach:
// query SEC's full-text search API directly for 13F-HR filings with the CUSIP,
// then parse ONLY the top 30 most recent results.
//
// LIMITATIONS ACKNOWLEDGED UP FRONT:
//   - Only covers filings from roughly the last 1-2 quarters
//   - CUSIP lookup via SEC is imperfect; we fall back to common tickers
//   - Full-text search has rate limits; we cache aggressively
//   - Some 13F-HR filings use "infotable.xml", others use variants
//
// This is a v1. Good enough to show Berkshire holds AAPL, BlackRock holds JPM,
// etc. Not a replacement for WhaleWisdom or similar specialized tools.
// ============================================================================

// Common CUSIPs hardcoded as fallback. SEC doesn't expose CUSIPs directly
// via the submissions/companyfacts APIs, so we either need to derive from
// filings or use a known mapping. For v1, support the most-queried tickers.
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
        message: '13F holder data is currently available for common large-cap tickers only. CUSIP mapping for this ticker has not been added yet.',
      },
    });
  }

  const userAgent = process.env.SEC_USER_AGENT || 'EDGAR Terminal research-tool@example.com';

  try {
    // SEC Full-Text Search API
    // Endpoint: https://efts.sec.gov/LATEST/search-index?q=CUSIP&forms=13F-HR
    // Returns a list of filings that match.
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${cusip}%22&forms=13F-HR&dateRange=custom&startdt=${getDateMonthsAgo(6)}&enddt=${today()}`;

    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
    });

    if (!searchRes.ok) {
      throw new Error(`SEC search returned ${searchRes.status}`);
    }

    const searchData = await searchRes.json();
    const hits = searchData?.hits?.hits || [];

    if (!hits.length) {
      return res.status(200).json({
        holders: [],
        meta: { ticker: tickerUpper, cusip, message: 'No recent 13F-HR filings found mentioning this CUSIP.' },
      });
    }

    // For each filing, get the filer name and CIK. We need to aggregate by filer
    // since a single institution files one 13F per quarter.
    const byFiler = new Map();

    // Process up to top 30 most recent filings. Any more and we risk rate limits
    // and the tail filings are too small to matter for a "top holders" view.
    const topHits = hits.slice(0, 30);

    for (const hit of topHits) {
      const source = hit._source || {};
      const ciks = source.ciks || [];
      const filerCik = ciks[0];
      const displayNames = source.display_names || [];
      const filerName = displayNames[0] || 'Unknown filer';
      const fileDate = source.file_date;
      const accession = (hit._id || '').split(':')[0];
      const periodOfReport = source.period_of_report;

      if (!filerCik || !accession) continue;

      // Only keep the most recent filing per filer
      const existing = byFiler.get(filerCik);
      if (existing && existing.fileDate >= fileDate) continue;

      byFiler.set(filerCik, {
        filerCik,
        filerName: filerName.replace(/\s+\(CIK.*?\)/, '').trim(),
        fileDate,
        accession,
        periodOfReport,
      });
    }

    // Now fetch each filer's information table (XML) to get the actual shares/value
    // for this specific CUSIP. Process in batches of 5 to avoid hammering SEC.
    const filers = Array.from(byFiler.values());
    const holders = [];

    // Process in small batches to respect rate limits (10 req/sec target)
    const batchSize = 5;
    for (let i = 0; i < filers.length; i += batchSize) {
      const batch = filers.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((filer) => extractHolding(filer, cusip, userAgent))
      );
      holders.push(...results.filter(Boolean));
      // Small delay between batches
      if (i + batchSize < filers.length) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    // Sort by value descending, take top 25
    holders.sort((a, b) => (b.value || 0) - (a.value || 0));
    const topHolders = holders.slice(0, 25);

    return res.status(200).json({
      holders: topHolders,
      meta: {
        ticker: tickerUpper,
        cusip,
        totalFilings: hits.length,
        extractedHolders: holders.length,
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

/**
 * Fetch a single 13F filing's information table and extract the holding for the given CUSIP.
 * Returns { filerCik, filerName, fileDate, shares, value, ... } or null on failure.
 */
async function extractHolding(filer, cusip, userAgent) {
  try {
    const accnNoHyphens = filer.accession.replace(/-/g, '');
    const cikStripped = String(filer.filerCik).replace(/^0+/, '');

    // Get the filing's file list to find the info table XML
    const indexUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikStripped}&type=13F-HR&dateb=&owner=include&count=40`;

    // Actually, the more direct approach: information table XML is usually named
    // "informationtable.xml" or similar in the filing's folder.
    // Folder path: /Archives/edgar/data/{cikStripped}/{accnNoHyphens}/
    const folderUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/`;
    const indexJsonUrl = `${folderUrl}index.json`;

    const idxRes = await fetch(indexJsonUrl, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
    });
    if (!idxRes.ok) return null;
    const idx = await idxRes.json();
    const items = idx?.directory?.item || [];

    // Find the information table XML (filename varies but always contains "informationtable"
    // or ends with "info" or is an XML that's NOT the primary_doc.xml)
    const infoTable = items.find((i) =>
      i.name.toLowerCase().includes('informationtable') && i.name.endsWith('.xml')
    ) || items.find((i) => i.name.match(/infotable.*\.xml$/i));

    if (!infoTable) return null;

    const xmlUrl = `${folderUrl}${infoTable.name}`;
    const xmlRes = await fetch(xmlUrl, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/xml' },
    });
    if (!xmlRes.ok) return null;
    const xmlText = await xmlRes.text();

    // Parse the info table to find the row matching our CUSIP
    // Structure is something like:
    // <infoTable>
    //   <nameOfIssuer>APPLE INC</nameOfIssuer>
    //   <cusip>037833100</cusip>
    //   <value>5000000</value>  (historically thousands, newer filings raw $)
    //   <shrsOrPrnAmt><sshPrnamt>123456</sshPrnamt></shrsOrPrnAmt>
    // </infoTable>
    //
    // Use simple regex since we don't need full XML parsing.
    const holdingRegex = new RegExp(
      `<infoTable[^>]*>([\\s\\S]*?${cusip}[\\s\\S]*?)</infoTable>`,
      'gi'
    );
    const matches = [...xmlText.matchAll(holdingRegex)];

    if (!matches.length) return null;

    // Sum across all matching rows (some filers break up positions by class)
    let totalShares = 0;
    let totalValue = 0;
    let issuerName = null;

    for (const m of matches) {
      const block = m[1];
      const nameMatch = block.match(/<nameOfIssuer[^>]*>([^<]+)<\/nameOfIssuer>/i);
      if (nameMatch && !issuerName) issuerName = nameMatch[1].trim();

      const valueMatch = block.match(/<value[^>]*>\s*([\d.]+)\s*<\/value>/i);
      const sharesMatch = block.match(/<sshPrnamt[^>]*>\s*([\d.]+)\s*<\/sshPrnamt>/i);

      if (valueMatch) totalValue += parseFloat(valueMatch[1]);
      if (sharesMatch) totalShares += parseFloat(sharesMatch[1]);
    }

    // SEC changed Form 13F value reporting in 2022+. Older filings report value
    // in thousands of dollars, newer filings report raw dollars. We detect this
    // by checking the file date: filings after 2022-09-01 should be raw dollars.
    // This isn't perfect but most filings follow the rule.
    const valueIsThousands = filer.fileDate < '2022-09-01';
    const actualValue = valueIsThousands ? totalValue * 1000 : totalValue;

    return {
      filerCik: filer.filerCik,
      filerName: filer.filerName,
      fileDate: filer.fileDate,
      periodOfReport: filer.periodOfReport,
      accession: filer.accession,
      shares: totalShares,
      value: actualValue,
      issuerName,
    };
  } catch (err) {
    console.warn(`Failed to extract holding from ${filer.accession}:`, err.message);
    return null;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getDateMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}
