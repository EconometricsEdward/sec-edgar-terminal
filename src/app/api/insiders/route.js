/**
 * Form 4 insider trading parser — Next.js route handler.
 *
 * Takes a CIK and a list of accession numbers, fetches the Form 4 primary XML
 * document for each, parses out the insider transaction details, and returns JSON.
 *
 * Form 4 XML structure (simplified):
 *   <ownershipDocument>
 *     <issuer>
 *       <issuerName>COMPANY NAME</issuerName>
 *       <issuerTradingSymbol>TICKER</issuerTradingSymbol>
 *     </issuer>
 *     <reportingOwner>
 *       <reportingOwnerId>
 *         <rptOwnerName>JOHN DOE</rptOwnerName>
 *       </reportingOwnerId>
 *       <reportingOwnerRelationship>
 *         <isDirector>1</isDirector>
 *         <isOfficer>1</isOfficer>
 *         <officerTitle>CHIEF EXECUTIVE OFFICER</officerTitle>
 *         <isTenPercentOwner>0</isTenPercentOwner>
 *       </reportingOwnerRelationship>
 *     </reportingOwner>
 *     <nonDerivativeTable>
 *       <nonDerivativeTransaction>
 *         <securityTitle><value>Common Stock</value></securityTitle>
 *         <transactionDate><value>2024-10-15</value></transactionDate>
 *         <transactionCoding>
 *           <transactionCode>S</transactionCode>  <!-- P=purchase, S=sale, A=award, etc -->
 *         </transactionCoding>
 *         <transactionAmounts>
 *           <transactionShares><value>10000</value></transactionShares>
 *           <transactionPricePerShare><value>225.50</value></transactionPricePerShare>
 *           <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
 *         </transactionAmounts>
 *       </nonDerivativeTransaction>
 *     </nonDerivativeTable>
 *   </ownershipDocument>
 *
 * Transaction codes reference:
 *   P = open-market purchase (usually bullish)
 *   S = open-market sale (usually bearish, but could be planned)
 *   A = award/grant (compensation, not market-driven)
 *   M = option exercise
 *   F = payment of tax liability
 *   G = gift
 *   D = sale to issuer (buyback participation)
 *   X = exercise of in-the-money derivative
 *
 * Acquired/Disposed code ("A" or "D"):
 *   A = acquired (buying or receiving shares)
 *   D = disposed (selling or giving away shares)
 */

import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const runtime = 'nodejs';
// Removed force-dynamic — Form 4 XML is immutable once filed, so we want the
// CDN to serve these essentially forever.

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Simple XML value extractor — regex-based, not a full parser.
 * Form 4 XML is consistent enough that this works reliably.
 */
function extractXmlValue(xml, tagPath) {
  // tagPath is like "issuer/issuerName" or "transactionCoding/transactionCode"
  const tags = tagPath.split('/');
  let remaining = xml;
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = remaining.match(regex);
    if (!match) return null;
    remaining = match[1];
  }
  // Many Form 4 fields wrap values in <value>...</value>
  const valueMatch = remaining.match(/<value[^>]*>([\s\S]*?)<\/value>/i);
  return (valueMatch ? valueMatch[1] : remaining).trim();
}

/**
 * Find all occurrences of a tag (for tables with multiple rows).
 */
function extractAllXmlBlocks(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Parse a single Form 4 XML document into a structured object.
 */
function parseForm4Xml(xml) {
  const issuerName = extractXmlValue(xml, 'issuer/issuerName');
  const issuerTicker = extractXmlValue(xml, 'issuer/issuerTradingSymbol');

  // Reporting owner
  const ownerName = extractXmlValue(xml, 'reportingOwner/reportingOwnerId/rptOwnerName');
  const isDirector = extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isDirector') === '1'
    || extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isDirector') === 'true';
  const isOfficer = extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isOfficer') === '1'
    || extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isOfficer') === 'true';
  const isTenPercent = extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isTenPercentOwner') === '1'
    || extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/isTenPercentOwner') === 'true';
  const officerTitle = extractXmlValue(xml, 'reportingOwner/reportingOwnerRelationship/officerTitle');

  const relationshipParts = [];
  if (isOfficer) relationshipParts.push(officerTitle || 'Officer');
  if (isDirector) relationshipParts.push('Director');
  if (isTenPercent) relationshipParts.push('10% Owner');
  const relationship = relationshipParts.join(' / ') || 'Other';

  // Transactions — both non-derivative (stock) and derivative (options, etc.)
  const transactions = [];

  const nonDerivBlocks = extractAllXmlBlocks(xml, 'nonDerivativeTransaction');
  for (const block of nonDerivBlocks) {
    const tx = parseTransaction(block, 'non-derivative');
    if (tx) transactions.push(tx);
  }

  const derivBlocks = extractAllXmlBlocks(xml, 'derivativeTransaction');
  for (const block of derivBlocks) {
    const tx = parseTransaction(block, 'derivative');
    if (tx) transactions.push(tx);
  }

  return {
    issuerName,
    issuerTicker,
    ownerName,
    relationship,
    isOfficer,
    isDirector,
    isTenPercent,
    transactions,
  };
}

function parseTransaction(block, type) {
  const securityTitle = extractXmlValue(block, 'securityTitle');
  const date = extractXmlValue(block, 'transactionDate');
  const code = extractXmlValue(block, 'transactionCoding/transactionCode');
  const sharesStr = extractXmlValue(block, 'transactionAmounts/transactionShares');
  const priceStr = extractXmlValue(block, 'transactionAmounts/transactionPricePerShare');
  const acquiredDisposed = extractXmlValue(block, 'transactionAmounts/transactionAcquiredDisposedCode');
  const sharesAfter = extractXmlValue(block, 'postTransactionAmounts/sharesOwnedFollowingTransaction');

  if (!date || !sharesStr) return null;
  const shares = parseFloat(sharesStr);
  const price = priceStr ? parseFloat(priceStr) : null;
  if (!Number.isFinite(shares)) return null;

  const value = price && Number.isFinite(price) ? shares * price : null;

  // Determine direction: "BUY" vs "SELL" is about economic intent
  // Code P = open market purchase, S = open market sale, etc.
  let direction = 'other';
  if (code === 'P' || code === 'A') direction = 'buy';
  else if (code === 'S' || code === 'D') direction = 'sell';
  else if (code === 'M' && acquiredDisposed === 'A') direction = 'exercise';
  else if (code === 'F') direction = 'tax';
  else if (code === 'G') direction = 'gift';

  return {
    type, // 'non-derivative' or 'derivative'
    date,
    code, // raw SEC code (P, S, A, M, etc.)
    direction, // normalized buy/sell/other
    securityTitle,
    shares,
    price,
    value,
    acquiredDisposed, // A or D
    sharesAfter: sharesAfter ? parseFloat(sharesAfter) : null,
  };
}

/**
 * Fetch Form 4 XML from SEC. Accession format: "0001234567-24-123456"
 */
async function fetchForm4(cik, accession, userAgent) {
  const accNoDash = accession.replace(/-/g, '');
  const paddedCik = String(parseInt(cik, 10));

  // Form 4 XML filename varies by filer, so we hit the filing's index.json to discover it
  const indexJsonUrl = `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${accNoDash}/index.json`;

  const indexRes = await fetchWithTimeout(indexJsonUrl, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });

  if (!indexRes.ok) throw new Error(`Index fetch failed: HTTP ${indexRes.status}`);
  const indexData = await indexRes.json();
  const items = indexData.directory?.item || [];

  // Find the XML file (usually ends with .xml, often named "primary_doc.xml" or "wk-form4_*.xml")
  const xmlFile = items.find((f) => f.name.toLowerCase().endsWith('.xml')
    && !f.name.toLowerCase().includes('xslf345x05'));
  if (!xmlFile) throw new Error('No XML file found in filing');

  const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${paddedCik}/${accNoDash}/${xmlFile.name}`;
  const xmlRes = await fetchWithTimeout(xmlUrl, {
    headers: { 'User-Agent': userAgent, Accept: 'application/xml, text/xml' },
  });

  if (!xmlRes.ok) throw new Error(`XML fetch failed: HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();

  const parsed = parseForm4Xml(xml);
  return {
    accession,
    xmlUrl,
    ...parsed,
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const cik = searchParams.get('cik');
  const accessions = searchParams.get('accessions');

  if (!cik || !/^\d{1,10}$/.test(String(cik).replace(/^0+/, ''))) {
    return Response.json({ error: 'Invalid or missing cik parameter' }, { status: 400 });
  }
  if (!accessions || typeof accessions !== 'string') {
    return Response.json({ error: 'Missing accessions parameter' }, { status: 400 });
  }

  const ip = getClientIp(request);
  const limit = await checkRateLimit({
    key: `rl:form4:${ip}`,
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
  });
  if (!limit.allowed) return rateLimitedResponse(limit);

  const accessionList = accessions.split(',').map((a) => a.trim()).filter(Boolean);
  if (accessionList.length === 0) {
    return Response.json({ error: 'No valid accessions provided' }, { status: 400 });
  }
  if (accessionList.length > 30) {
    return Response.json({ error: 'Too many accessions (max 30 per request)' }, { status: 400 });
  }

  const userAgent = process.env.SEC_USER_AGENT
    || 'EDGAR Terminal Research Tool (github.com/EconometricsEdward/sec-edgar-terminal)';

  // Fetch all Form 4s in parallel but with a small concurrency limit to respect SEC rate limits
  const results = [];
  const errors = [];
  const CONCURRENCY = 5;

  const work = [...accessionList];

  async function next() {
    if (work.length === 0) return;
    const accession = work.shift();
    try {
      const parsed = await fetchForm4(cik, accession, userAgent);
      results.push(parsed);
    } catch (err) {
      errors.push({ accession, error: err.message });
    }
  }

  // Kick off up to CONCURRENCY parallel workers
  const workers = Array.from({ length: Math.min(CONCURRENCY, accessionList.length) }, async () => {
    while (work.length > 0) {
      await next();
    }
  });

  await Promise.all(workers);

  // Flatten all transactions for easier charting, while preserving per-filing grouping
  const allTransactions = [];
  for (const filing of results) {
    for (const tx of filing.transactions) {
      allTransactions.push({
        ...tx,
        accession: filing.accession,
        ownerName: filing.ownerName,
        relationship: filing.relationship,
        isOfficer: filing.isOfficer,
        isDirector: filing.isDirector,
        isTenPercent: filing.isTenPercent,
        xmlUrl: filing.xmlUrl,
      });
    }
  }

  // Sort by date, newest first
  allTransactions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return Response.json(
    {
      cik,
      filings: results,
      transactions: allTransactions,
      errors: errors.length > 0 ? errors : undefined,
    },
    {
      status: 200,
      // Form 4 filings are immutable once filed, so we can cache aggressively.
      // The CDN will serve these essentially forever — which is exactly what
      // we want for protecting the SEC rate limit.
      headers: {
        'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
      },
    }
  );
}
