// ============================================================================
// api/fund — Mutual Fund / ETF Data (Next.js route handler)
//
// Handles ticker lookups for investment funds (mutual funds + ETFs). Returns:
//   - Fund metadata (name, family, CIK)
//   - Top holdings from most recent N-PORT filing
//   - Total net assets (AUM)
//   - Asset class breakdown
//   - Recent fund filings (N-PORT, N-CSR, N-1A, 485BPOS)
//
// Detection strategy: a ticker is considered a fund if it has filed N-PORT
// in the past year. N-PORT is the monthly holdings disclosure required of
// all mutual funds and ETFs since 2018.
//
// N-PORT structure: XML using the EDGAR:FundInvestmentReport schema.
// Contains <invstOrSec> blocks for each holding with name, CUSIP, value,
// share balance, etc. Also contains <genInfo> and <fundInfo> blocks with
// fund-level metadata and AUM.
// ============================================================================

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get('ticker');

  if (!ticker) {
    return Response.json({ error: 'ticker parameter required' }, { status: 400 });
  }

  const userAgent = process.env.SEC_USER_AGENT || 'EDGAR Terminal research-tool@example.com';
  const tickerUpper = ticker.toUpperCase();

  try {
    // Step 1: Look up ticker → CIK from SEC's official mapping
    const cik = await lookupCikForTicker(tickerUpper, userAgent);
    if (!cik) {
      return Response.json({
        isFund: false,
        ticker: tickerUpper,
        reason: 'Ticker not found in SEC database',
      });
    }

    // Step 2: Fetch submissions to determine if this is a fund
    const submissions = await fetchSubmissions(cik, userAgent);
    if (!submissions) {
      return Response.json({
        isFund: false,
        ticker: tickerUpper,
        cik,
        reason: 'Could not fetch filer submissions',
      });
    }

    // Step 3: Detect fund by looking for N-PORT filings in recent history
    const recent = submissions?.filings?.recent;
    if (!recent) {
      return Response.json({
        isFund: false,
        ticker: tickerUpper,
        cik,
        reason: 'No recent filings',
      });
    }

    // Find all fund-type filings
    const fundFilings = [];
    const nportFilings = [];
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i];
      if (isFundFormType(form)) {
        const accession = recent.accessionNumber[i];
        const filingDate = recent.filingDate[i];
        const reportDate = recent.reportDate?.[i];
        const primaryDoc = recent.primaryDocument?.[i];
        const entry = { form, accession, filingDate, reportDate, primaryDoc };
        fundFilings.push(entry);
        if (form === 'NPORT-P' || form === 'N-PORT' || form === 'NPORT-EX') {
          nportFilings.push(entry);
        }
      }
    }

    if (nportFilings.length === 0) {
      return Response.json({
        isFund: false,
        ticker: tickerUpper,
        cik,
        name: submissions.name,
        reason: 'No N-PORT filings — not a fund',
      });
    }

    // At this point we know it's a fund. Sort by filing date desc.
    nportFilings.sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));
    fundFilings.sort((a, b) => (b.filingDate || '').localeCompare(a.filingDate || ''));

    // Step 4: Extract fund metadata
    const fundMeta = {
      ticker: tickerUpper,
      cik,
      name: submissions.name,
      family: detectFundFamily(submissions.name),
      sicDescription: submissions.sicDescription,
      fiscalYearEnd: submissions.fiscalYearEnd,
      stateOfIncorporation: submissions.stateOfIncorporation,
    };

    // Step 5: Parse most recent N-PORT for holdings + AUM
    // N-PORT filings can be large; if parsing fails we still return metadata
    const mostRecentNport = nportFilings[0];
    let holdings = null;
    let fundInfo = null;
    try {
      const nportData = await parseNportFiling(cik, mostRecentNport.accession, userAgent);
      holdings = nportData.holdings;
      fundInfo = nportData.fundInfo;
    } catch (err) {
      console.warn('N-PORT parse error:', err.message);
    }

    return Response.json({
      isFund: true,
      ticker: tickerUpper,
      cik,
      name: submissions.name,
      meta: fundMeta,
      fundInfo, // totAssets, totLiabs, etc.
      holdings: holdings || [],
      holdingsAsOf: mostRecentNport.reportDate,
      holdingsFiledDate: mostRecentNport.filingDate,
      holdingsAccession: mostRecentNport.accession,
      filings: fundFilings.slice(0, 20), // top 20 recent fund filings
      filingCount: fundFilings.length,
      nportCount: nportFilings.length,
    });
  } catch (err) {
    console.error('Fund API error:', err);
    return Response.json(
      { error: 'Failed to process fund data', detail: err.message },
      { status: 500 }
    );
  }
}

// ============================================================================
// Detection helpers
// ============================================================================

const FUND_FORMS = new Set([
  'N-PORT',           // Monthly portfolio holdings (older name)
  'NPORT-P',          // Current version of N-PORT (P = public)
  'NPORT-EX',         // N-PORT exhibit
  'N-CSR',            // Annual certified shareholder report
  'N-CSRS',           // Semi-annual certified shareholder report
  'N-1A',             // Mutual fund registration
  '485APOS',          // Post-effective amendment (prospectus update)
  '485BPOS',          // Post-effective amendment (prospectus update, immediate)
  'N-Q',              // Legacy quarterly holdings (pre-2018)
  'N-CEN',            // Annual fund reporting
  'N-30D',            // Periodic reports to shareholders (older funds)
  'DEF 14A',          // Proxy — funds file too
]);

function isFundFormType(form) {
  if (!form) return false;
  // Direct match
  if (FUND_FORMS.has(form)) return true;
  // Partial matches for variants
  if (form.startsWith('NPORT')) return true;
  if (form.startsWith('N-CSR')) return true;
  return false;
}

/**
 * Guess the fund family from the filer name. This is a heuristic — there are
 * hundreds of fund families and we can't enumerate them all. We catch the most
 * common patterns (Vanguard, iShares/BlackRock, SPDR/State Street, Invesco,
 * Schwab, Fidelity, etc.) and fall back to "Other" for the rest.
 */
function detectFundFamily(name) {
  if (!name) return 'Unknown';
  const upper = name.toUpperCase();

  if (upper.includes('VANGUARD')) return 'Vanguard';
  if (upper.includes('ISHARES') || upper.includes('BLACKROCK')) return 'iShares / BlackRock';
  if (upper.includes('SPDR') || upper.startsWith('SSGA') || upper.includes('STATE STREET')) return 'SPDR / State Street';
  if (upper.includes('INVESCO') || upper.includes('POWERSHARES')) return 'Invesco';
  if (upper.includes('SCHWAB')) return 'Schwab';
  if (upper.includes('FIDELITY')) return 'Fidelity';
  if (upper.includes('ARK ')) return 'ARK Invest';
  if (upper.includes('PIMCO')) return 'PIMCO';
  if (upper.includes('T. ROWE PRICE') || upper.includes('T ROWE PRICE')) return 'T. Rowe Price';
  if (upper.includes('WISDOMTREE')) return 'WisdomTree';
  if (upper.includes('FIRST TRUST')) return 'First Trust';
  if (upper.includes('JANUS')) return 'Janus Henderson';
  if (upper.includes('AMERICAN FUNDS') || upper.includes('CAPITAL GROUP')) return 'American Funds';
  if (upper.includes('DIMENSIONAL') || upper.includes('DFA')) return 'Dimensional';
  if (upper.includes('PROSHARES')) return 'ProShares';
  if (upper.includes('DIREXION')) return 'Direxion';
  if (upper.includes('VANECK')) return 'VanEck';
  if (upper.includes('GLOBAL X')) return 'Global X';
  if (upper.includes('JPMORGAN') || upper.includes('JP MORGAN')) return 'JPMorgan';
  if (upper.includes('GOLDMAN')) return 'Goldman Sachs';
  if (upper.includes('FRANKLIN')) return 'Franklin Templeton';
  if (upper.includes('NUVEEN')) return 'Nuveen';

  return 'Other';
}

// ============================================================================
// SEC lookups
// ============================================================================

/**
 * Find CIK for a ticker. Uses SEC's company_tickers.json for operating
 * companies and company_tickers_mf.json for funds.
 */
async function lookupCikForTicker(ticker, userAgent) {
  // Try operating companies first
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': userAgent },
    });
    if (res.ok) {
      const data = await res.json();
      for (const entry of Object.values(data)) {
        if (entry.ticker?.toUpperCase() === ticker) {
          return String(entry.cik_str).padStart(10, '0');
        }
      }
    }
  } catch {}

  // Try mutual fund / ETF file
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers_mf.json', {
      headers: { 'User-Agent': userAgent },
    });
    if (res.ok) {
      const data = await res.json();
      // Mutual fund ticker file has structure:
      //   { "fields": ["cik","seriesId","classId","symbol"],
      //     "data": [[1234567, "S000012345", "C000012345", "SPY"], ...] }
      if (data?.data) {
        for (const row of data.data) {
          const symbol = row[3];
          if (symbol?.toUpperCase() === ticker) {
            return String(row[0]).padStart(10, '0');
          }
        }
      }
    }
  } catch {}

  return null;
}

async function fetchSubmissions(cik, userAgent) {
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': userAgent },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ============================================================================
// N-PORT parsing
//
// N-PORT filings are XML in EDGAR:FundInvestmentReport format. Key sections:
//   <genInfo> — filer identification
//   <fundInfo> — fund-level totals (totAssets, totLiabs, cash, etc.)
//   <invstOrSecs> — container for all holdings
//     <invstOrSec> — one holding per block
//       <n>, <lei>, <cusip>, <balance>, <valUSD>, <pctVal>, <assetCat>, <issuerCat>
//
// Files can be 5-30MB for large funds. We stream-scan with regex rather than
// full XML parsing for memory efficiency.
// ============================================================================

async function parseNportFiling(cik, accession, userAgent) {
  const cikStripped = String(cik).replace(/^0+/, '');
  const accnNoHyphens = accession.replace(/-/g, '');

  // First find the primary N-PORT XML document (filename varies)
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/index.json`;
  const idxRes = await fetch(indexUrl, { headers: { 'User-Agent': userAgent } });
  if (!idxRes.ok) throw new Error(`Could not fetch filing index: ${idxRes.status}`);
  const idx = await idxRes.json();
  const items = idx?.directory?.item || [];

  // Look for the main N-PORT XML. Common names: primary_doc.xml, nport.xml, etc.
  // We want XML files, preferring ones with "nport" in the name.
  const xmlFile =
    items.find((i) => /nport.*\.xml$/i.test(i.name)) ||
    items.find((i) => /primary_doc\.xml$/i.test(i.name)) ||
    items.find((i) => i.name.endsWith('.xml'));

  if (!xmlFile) throw new Error('No N-PORT XML file found in filing');

  const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accnNoHyphens}/${xmlFile.name}`;
  const xmlRes = await fetch(xmlUrl, { headers: { 'User-Agent': userAgent } });
  if (!xmlRes.ok) throw new Error(`Could not fetch N-PORT XML: ${xmlRes.status}`);
  const xmlText = await xmlRes.text();

  // Extract fund-level info from <fundInfo> block
  const fundInfo = extractFundInfo(xmlText);

  // Extract all holdings from <invstOrSec> blocks
  const holdings = extractHoldings(xmlText);

  return { fundInfo, holdings };
}

function extractFundInfo(xmlText) {
  // The <fundInfo> block contains totals. Extract selected fields.
  const fundInfoMatch = xmlText.match(/<fundInfo[^>]*>([\s\S]*?)<\/fundInfo>/i);
  if (!fundInfoMatch) return null;
  const block = fundInfoMatch[1];

  const getNumeric = (tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>\\s*([-\\d.]+)\\s*</${tag}>`, 'i'));
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };

  return {
    totAssets: getNumeric('totAssets'),
    totLiabs: getNumeric('totLiabs'),
    netAssets: getNumeric('netAssets'), // some filings report this directly
    cash: getNumeric('cash'),
    // netAssets = totAssets - totLiabs if not directly reported
  };
}

function extractHoldings(xmlText) {
  const holdings = [];
  const blockRegex = /<invstOrSec[^>]*>([\s\S]*?)<\/invstOrSec>/gi;
  const maxHoldings = 100; // cap to avoid massive responses
  let match;
  let count = 0;

  while ((match = blockRegex.exec(xmlText)) !== null && count < maxHoldings) {
    const block = match[1];
    const holding = parseHoldingBlock(block);
    if (holding) {
      holdings.push(holding);
      count++;
    }
  }

  // Sort by value descending
  holdings.sort((a, b) => (b.value || 0) - (a.value || 0));

  return holdings;
}

function parseHoldingBlock(block) {
  const getText = (tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  };
  const getNumeric = (tag) => {
    const t = getText(tag);
    if (!t) return null;
    const v = parseFloat(t);
    return Number.isFinite(v) ? v : null;
  };

  const name = getText('name');
  const value = getNumeric('valUSD');

  // Skip empty or zero-value entries
  if (!name && !value) return null;

  return {
    name: name || '(unnamed)',
    lei: getText('lei'),
    cusip: getText('cusip'),
    isin: (() => {
      // ISIN lives inside a nested <identifiers> structure in some filings
      const idMatch = block.match(/<isin[^>]*>([^<]+)<\/isin>/i);
      return idMatch ? idMatch[1].trim() : null;
    })(),
    tickerSymbol: getText('ticker'), // rarely populated but worth checking
    balance: getNumeric('balance'),
    units: getText('units'), // NS (shares), PA (principal amount), OU (other units)
    value, // USD value
    pctOfNav: getNumeric('pctVal'),
    assetCat: getText('assetCat'), // e.g. "EC" (equity common), "DBT" (debt), "STIV" (ST investment)
    issuerCat: getText('issuerCat'), // e.g. "CORP", "USGA", "MUN"
    invCountry: getText('invCountry'),
    payoffProfile: getText('payoffProfile'),
  };
}
