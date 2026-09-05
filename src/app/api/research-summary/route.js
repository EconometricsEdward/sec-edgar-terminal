import { NextResponse } from 'next/server';
import { extractAnnualPeriods, extractQuarterlyPeriods, withPeriodKind } from '../../../utils/xbrlParser.js';
import { loadResearchCompany } from '../../../utils/secResearchData.js';
import { companySnapshot, validTicker } from '../../../utils/researchWorkspace.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request) {
  const ticker = (new URL(request.url).searchParams.get('ticker') || '').trim().toUpperCase();
  if (!validTicker(ticker)) return NextResponse.json({ error: 'Valid ticker required.' }, { status: 400 });
  const limit = await checkRateLimit({ key: `rl:research-summary:${getClientIp(request)}`, windowMs: 60000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const company = await loadResearchCompany(ticker);
    const basis = new URL(request.url).searchParams.get('basis');
    const period = basis === 'annual' ? extractAnnualPeriods(company.facts)[0] : ['ytd', 'ttm'].includes(basis) ? withPeriodKind(extractQuarterlyPeriods(company.facts), basis)[0] : null;
    return NextResponse.json({ ticker, cik: company.cik, name: company.companyName,
      snapshot: companySnapshot(company.facts, company.sic, company.filings, period), filings: company.filings.slice(0, 80) },
    { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return NextResponse.json({ error: error.message }, { status: 502 }); }
}
