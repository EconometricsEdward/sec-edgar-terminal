import { NextResponse } from 'next/server';
import { assessRisk, scanRiskLanguage } from '../../../utils/riskAnalysis.js';
import { decorateRiskProfile, RISK_VERSION } from '../../../utils/riskWorkspace.js';
import { getOperatingTicker } from '../../../utils/tickerMap.js';
import { fetchFilingText } from '../../../utils/filingTextParser.js';
import { secResearchJson, submissionRows } from '../../../utils/secResearchData.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { warmGet, warmSet } from '../../../utils/warmCache.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
const response = (data) => NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=900' } });

// The long document scan is requested separately, so it cannot delay ratios.
async function readAnnualDisclosure(submissions, cik) {
  let filings = submissionRows(submissions.filings?.recent, cik);
  let annual = filings.find((f) => f.form === '10-K');
  let limited = false;
  if (!annual) {
    const files = [...(submissions.filings?.files || [])].sort((a, b) => (b.filingTo || '').localeCompare(a.filingTo || ''));
    limited = files.length > 4;
    for (const file of files.slice(0, 4)) {
      if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) continue;
      try {
        const res = await fetch(`https://data.sec.gov/submissions/${file.name}`, { headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com' }, signal: AbortSignal.timeout(6000) });
        if (!res.ok) { limited = true; continue; }
        filings = filings.concat(submissionRows(await res.json(), cik));
        annual = filings.filter((f) => f.form === '10-K').sort((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
        if (annual) break;
      } catch { limited = true; }
    }
  }
  if (!annual) return { error: `No original 10-K located${limited ? ' within the bounded filing-history search' : ' in available submissions'}. Foreign annual forms are not scanned.`, terms: [], historyLimited: limited };
  const cached = await warmGet(`${RISK_VERSION}-scan`, annual.accession);
  if (cached) return cached;
  const text = await fetchFilingText(cik, annual.accession, annual.primaryDoc);
  const scan = { ...annual, url: annual.documentUrl, historyLimited: limited, error: text.error || (!text.text ? 'The filing text was empty.' : null), terms: text.text ? scanRiskLanguage(text.text) : [] };
  if (!scan.error) await warmSet(`${RISK_VERSION}-scan`, annual.accession, scan, 86400);
  return scan;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)) return NextResponse.json({ error: 'Enter a valid company ticker (for example JPM or BRK.B).' }, { status: 400 });
  const rl = await checkRateLimit({ key: `rl:risk:${getClientIp(request)}`, windowMs: 60000, max: 20 });
  if (!rl.allowed) return rateLimitedResponse(rl);
  const scanOnly = params.get('include') === 'disclosures';
  try {
    if (!scanOnly) {
      const cached = await warmGet(RISK_VERSION, ticker);
      if (cached) return response(cached);
    }
    const entry = await getOperatingTicker(ticker);
    if (!entry) return NextResponse.json({ error: `No SEC operating company matched ${ticker}. Fund tickers are covered on the Funds page.` }, { status: 404 });
    const cik = String(entry.cik).padStart(10, '0');
    const [submissions, company] = await Promise.all([
      secResearchJson(`/submissions/CIK${cik}.json`),
      scanOnly ? Promise.resolve(null) : secResearchJson(`/api/xbrl/companyfacts/CIK${cik}.json`),
    ]);
    if (scanOnly) return response({ ticker, filingScan: await readAnnualDisclosure(submissions, cik) });
    // A missing classification must never silently apply industrial models to a bank.
    if (!submissions.sic || !company?.facts) throw new Error('SEC industry classification or company facts are unavailable. Please retry.');
    const annual = decorateRiskProfile(assessRisk(company.facts, submissions.sic, cik));
    const current = decorateRiskProfile(assessRisk(company.facts, submissions.sic, cik, { basis: 'ttm' }));
    const data = { ticker, cik, companyName: submissions.name || entry.name, sic: submissions.sic, sicDescription: submissions.sicDescription,
      annual, current, version: RISK_VERSION, generatedAt: new Date().toISOString() };
    await warmSet(RISK_VERSION, ticker, data, 900);
    return response(data);
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Could not load the SEC risk profile. Please retry.' }, { status: 502 });
  }
}
