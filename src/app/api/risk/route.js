// ============================================================================
// api/risk — multi-pillar risk profile for a company, from SEC primary data.
//
// GET /api/risk?ticker=JPM
//
// Pipeline:
//   1. ticker → CIK (operating companies only)
//   2. fetch companyfacts (XBRL) + submissions (SIC code, recent filings) in parallel
//   3. assessRisk(facts, sic) — pure engine in utils/riskAnalysis.js
//   4. scan the latest 10-K's text for credit-risk language (going concern,
//      covenant, material weakness, …) with paragraph excerpts, source-linked
//
// The XBRL facts change at most quarterly and the language scan is tied to a
// specific accession, so the response is edge-cached for hours, not minutes.
// ============================================================================

import { NextResponse } from 'next/server';
import { assessRisk, scanRiskLanguage } from '../../../utils/riskAnalysis.js';
import { getOperatingTicker } from '../../../utils/tickerMap.js';
import { fetchFilingText, buildFilingUrl } from '../../../utils/filingTextParser.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DEFAULT_USER_AGENT = 'EDGAR Terminal research-tool (secedgarterminal.com)';

async function fetchSecJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': process.env.SEC_USER_AGENT || DEFAULT_USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, data: null };
    return { error: null, data: await res.json() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'SEC request timed out' : err.message, data: null };
  } finally {
    clearTimeout(t);
  }
}

/** Pick the most recent original 10-K from a submissions JSON. */
function latestTenK(submissions) {
  const recent = submissions?.filings?.recent;
  if (!recent?.accessionNumber) return null;
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    if (recent.form[i] === '10-K') {
      return {
        accession: recent.accessionNumber[i],
        form: recent.form[i],
        filingDate: recent.filingDate[i],
        reportDate: recent.reportDate[i],
        primaryDoc: recent.primaryDocument[i],
      };
    }
  }
  return null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tickerRaw = searchParams.get('ticker');
  if (!tickerRaw) {
    return NextResponse.json({ error: 'ticker parameter required' }, { status: 400 });
  }
  const ticker = tickerRaw.trim().toUpperCase();

  // Each request costs two SEC JSON fetches plus one full filing-text fetch.
  const ip = getClientIp(request);
  const rl = await checkRateLimit({ key: `rl:risk:${ip}`, windowMs: 60_000, max: 15 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  let entry;
  try {
    entry = await getOperatingTicker(ticker);
  } catch (err) {
    return NextResponse.json({ error: `Ticker lookup failed: ${err.message}` }, { status: 502 });
  }
  if (!entry) {
    return NextResponse.json(
      {
        error: `Ticker not found among SEC operating companies: ${ticker}. Fund tickers (ETFs, mutual funds) are covered on the Funds page.`,
        ticker,
      },
      { status: 404 },
    );
  }

  const cik = entry.cik;
  const cikPadded = String(cik).padStart(10, '0');

  const [factsRes, subsRes] = await Promise.all([
    fetchSecJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`),
    fetchSecJson(`https://data.sec.gov/submissions/CIK${cikPadded}.json`),
  ]);

  if (factsRes.error || !factsRes.data?.facts) {
    return NextResponse.json(
      { error: `Could not load XBRL company facts from SEC: ${factsRes.error || 'no facts in response'}`, ticker, cik },
      { status: 502 },
    );
  }

  const sic = subsRes.data?.sic || null;
  const sicDescription = subsRes.data?.sicDescription || null;
  const companyName = subsRes.data?.name || entry.name;

  // Pure computation over the facts.
  const risk = assessRisk(factsRes.data.facts, sic, cik);

  // Credit-language scan of the latest 10-K (non-fatal if it can't be read).
  let filingScan = null;
  const tenK = subsRes.error ? null : latestTenK(subsRes.data);
  if (tenK) {
    const textInfo = await fetchFilingText(cik, tenK.accession, tenK.primaryDoc);
    if (textInfo.error || !textInfo.text) {
      filingScan = {
        form: tenK.form,
        filingDate: tenK.filingDate,
        url: buildFilingUrl(cik, tenK.accession, tenK.primaryDoc),
        error: `Could not read the filing text: ${textInfo.error || 'empty document'}`,
        terms: [],
      };
    } else {
      filingScan = {
        form: tenK.form,
        filingDate: tenK.filingDate,
        reportDate: tenK.reportDate,
        url: buildFilingUrl(cik, tenK.accession, tenK.primaryDoc),
        accession: tenK.accession,
        terms: scanRiskLanguage(textInfo.text),
        error: null,
      };
    }
  }

  return NextResponse.json(
    {
      ticker,
      cik,
      companyName,
      sic,
      sicDescription,
      ...risk,
      filingScan,
      generatedAt: new Date().toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
      },
    },
  );
}
