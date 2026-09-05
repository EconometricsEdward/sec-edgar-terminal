import { NextResponse } from 'next/server';
import { loadResearchCompany } from '../../../utils/secResearchData.js';
import { compareDisclosureText, compareFinancialReports, selectFilingPair, CHANGE_VERSION } from '../../../utils/filingChanges.js';
import { fetchFilingText } from '../../../utils/filingTextParser.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { validTicker } from '../../../utils/researchWorkspace.js';
import { warmGet, warmSet } from '../../../utils/warmCache.js';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  const baseline = params.get('baseline') || '';
  const comparison = params.get('comparison') === 'previous' ? 'previous' : 'year';
  if (!validTicker(ticker) || (baseline && !/^\d{10}-\d{2}-\d{6}$/.test(baseline))) return NextResponse.json({ error: 'Provide a valid ticker and, when used, a valid baseline accession.' }, { status: 400 });
  const limit = await checkRateLimit({ key: `rl:filing-changes:${getClientIp(request)}`, windowMs: 60000, max: 6 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const company = await loadResearchCompany(ticker, { history: true, signal: AbortSignal.timeout(35000) });
    const pair = selectFilingPair(company.filings, { comparison, baseline });
    const base = { ticker, cik: company.cik, companyName: company.companyName, pair, historyLimited: company.historyLimited, generatedAt: new Date().toISOString() };
    if (!pair.current || !pair.prior || pair.unchanged) return NextResponse.json({ ...base, financials: [], disclosure: null });
    const key = `${CHANGE_VERSION}:${company.cik}:${pair.prior.accession}:${pair.current.accession}`;
    const cached = await warmGet('filing-changes', key);
    if (cached) return NextResponse.json({ ...base, ...cached });
    const financials = compareFinancialReports(company.facts, company.sic, pair.prior, pair.current);
    const [priorText, currentText] = await Promise.all([
      fetchFilingText(company.cik, pair.prior.accession, pair.prior.primaryDoc),
      fetchFilingText(company.cik, pair.current.accession, pair.current.primaryDoc),
    ]);
    const errors = [priorText.error && `Prior filing: ${priorText.error}`, currentText.error && `Current filing: ${currentText.error}`].filter(Boolean);
    const disclosure = errors.length ? { error: errors.join(' '), changes: [], coverage: [] }
      : compareDisclosureText(priorText.text, currentText.text, pair.prior.form, pair.current.form);
    const result = { financials, disclosure };
    // A transient SEC document failure must not poison the immutable-pair cache.
    if (!errors.length) await warmSet('filing-changes', key, result, 86400);
    return NextResponse.json({ ...base, ...result }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error.message || 'Could not compare SEC filings.' }, { status: 502 });
  }
}
