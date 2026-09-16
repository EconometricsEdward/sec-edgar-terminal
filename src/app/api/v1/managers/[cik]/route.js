import { readPublicManagerSummary } from '../../../../../utils/fundPublicResearch.js';
import { publicManagerSelection } from '../../../../../utils/fundPublicSelectors.js';

export const runtime = 'nodejs';
export const maxDuration = 15;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
export async function GET(request, { params }) {
  const query = new URL(request.url).searchParams;
  const selected = publicManagerSelection((await params).cik, query.get('period') || '');
  if (!selected || [...query.keys()].some(key => key !== 'period') || query.getAll('period').length > 1 || query.has('period') && !query.get('period')) {
    return Response.json({ error: 'Choose one manager CIK and, optionally, one completed report quarter.', code: 'INVALID_MANAGER_SELECTION' }, { status: 400, headers: privateHeaders });
  }
  let summary;
  try { summary = await readPublicManagerSummary(selected.cik, selected.period, { signal: request.signal }); } catch { /* fail closed to missing prepared research */ }
  if (!summary || summary.status !== 'ready') return Response.json(summary || { kind: '13f', status: 'unavailable', cik: selected.cik, code: 'MANAGER_NOT_PREPARED', reason: 'A verified prepared report is not available. This request does not start SEC acquisition.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
  return Response.json(summary, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } }); }
