import { publicAnalysisSelection, readPublicAnalysis } from '../../../../../utils/analysisPublicResearch.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
export async function GET(request, { params }) {
  const query = new URL(request.url).searchParams;
  const allowed = ['basis', 'end', 'asOf'];
  const selected = publicAnalysisSelection({ ticker: (await params).ticker, basis: query.get('basis') || 'annual', end: query.get('end') || '', asOf: query.get('asOf') || '' });
  if (!selected || [...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) {
    return Response.json({ error: 'Choose one ticker, reporting basis and optional period end or filing cutoff.', code: 'INVALID_ANALYSIS_SELECTION' }, { status: 400, headers: privateHeaders });
  }
  if (/^\d+$/.test(selected.ticker)) {
    if (!/^(?!0+$)\d{1,10}$/.test(selected.ticker)) return Response.json({ error: 'Choose a valid SEC CIK.' }, { status: 400, headers: privateHeaders });
    if (selected.basis !== 'annual' || selected.end || selected.asOf) return Response.json({ error: 'Broker-dealer analysis uses each document’s own reporting period. Select an exact filing in the broker-dealer workspace; quarter, TTM and historical-cutoff conversions are not inferred.', code: 'UNSUPPORTED_BROKER_DEALER_BASIS' }, { status: 422, headers: privateHeaders });
    try {
      const { checkRateLimit, getClientIp, rateLimitedResponse } = await import('../../../../../utils/rateLimit.js');
      const limit = await checkRateLimit({ key: `rl:broker-analysis:${getClientIp(request)}`, windowMs: 60000, max: 12 });
      if (!limit.allowed) return rateLimitedResponse(limit, privateHeaders);
      const { loadBrokerDealerResearch } = await import('../../../../../utils/brokerDealerResearch.js');
      const research = await loadBrokerDealerResearch(selected.ticker, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(280000)]) });
      if (research.status !== 'available' || !research.analysis) return Response.json({ status: 'unavailable', cik: research.company?.cik,
        reason: 'No analyzable public X-17A-5 report was found in the SEC submission history checked for this registrant.', coverage: research.coverage }, { status: 404, headers: privateHeaders });
      if (research.extraction?.retryable && research.analysis.status === 'unavailable') return Response.json({ status: 'unavailable', cik: research.company.cik,
        reason: 'Document extraction could not finish. Retry to read the available public filing.', coverage: research.extraction },
      { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
      const classification = research.classification || research.analysis.classification;
      if (query.has('basis') && classification?.family !== 'annual-report') return Response.json({
        error: 'The latest document is not established as an annual report. Select a classified annual attachment or omit the basis filter to read this document with its actual classification.',
        code: 'INCOMPATIBLE_BROKER_DEALER_REPORT_TYPE', classification: classification || null,
      }, { status: 422, headers: privateHeaders });
      return Response.json({ schemaVersion: 'edgar.broker-dealer-analysis.v2',
        name: research.company.name, cik: research.company.cik, filing: research.filing,
        ...research.analysis, classification: classification || null,
        basis: research.analysis.basis || 'unknown',
        observedAt: research.observedAt, filingCoverage: research.coverage,
        interactiveUrl: `/analysis/${research.company.cik}`, filingsUrl: `/filings/${research.company.cik}` },
      { headers: research.extraction?.retryable ? privateHeaders : { 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=3600', 'Access-Control-Allow-Origin': '*' } });
    } catch {
      return Response.json({ status: 'unavailable', reason: 'The public broker-dealer document could not be analyzed at this time. Retry or inspect the original SEC filing.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
    }
  }
  let summary;
  try { summary = await readPublicAnalysis(selected); } catch { /* Never expose storage errors or acquire new source data. */ }
  if (summary?.status !== 'ready') return Response.json(summary || { status: 'not-prepared', ticker: selected.ticker, reason: 'Verified prepared financial research is unavailable. This request does not start SEC acquisition.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
  return Response.json(summary, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } }); }
