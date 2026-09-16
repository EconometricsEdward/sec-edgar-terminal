import { publicAnalysisSelection, readPublicAnalysis } from '../../../../../utils/analysisPublicResearch.js';

export const runtime = 'nodejs';
export const maxDuration = 30;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
export async function GET(request, { params }) {
  const query = new URL(request.url).searchParams;
  const allowed = ['basis', 'end', 'asOf'];
  const selected = publicAnalysisSelection({ ticker: (await params).ticker, basis: query.get('basis') || 'annual', end: query.get('end') || '', asOf: query.get('asOf') || '' });
  if (!selected || [...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1 || query.has(key) && !query.get(key))) {
    return Response.json({ error: 'Choose one ticker, reporting basis and optional period end or filing cutoff.', code: 'INVALID_ANALYSIS_SELECTION' }, { status: 400, headers: privateHeaders });
  }
  let summary;
  try { summary = await readPublicAnalysis(selected); } catch { /* Never expose storage errors or acquire new source data. */ }
  if (summary?.status !== 'ready') return Response.json(summary || { status: 'not-prepared', ticker: selected.ticker, reason: 'Verified prepared financial research is unavailable. This request does not start SEC acquisition.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
  return Response.json(summary, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } }); }
