import { readPublicFundSummary } from '../../../../../utils/fundPublicResearch.js';
import { publicFundSelection } from '../../../../../utils/fundPublicSelectors.js';

export const runtime = 'nodejs';
export const maxDuration = 15;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' };
export async function GET(request, { params }) {
  const query = new URL(request.url).searchParams;
  const selected = publicFundSelection((await params).ticker, query.get('accession') || '');
  if (!selected || [...query.keys()].some(key => key !== 'accession') || query.getAll('accession').length > 1 || query.has('accession') && !query.get('accession')) {
    return Response.json({ error: 'Choose one fund ticker and, optionally, one exact SEC accession.', code: 'INVALID_FUND_SELECTION' }, { status: 400, headers: privateHeaders });
  }
  let summary;
  try { summary = await readPublicFundSummary(selected.ticker, selected.accession, { signal: request.signal }); } catch { /* fail closed to missing prepared research */ }
  if (!summary || summary.status !== 'ready') return Response.json(summary || { kind: 'nport', status: 'unavailable', ticker: selected.ticker, code: 'FUND_NOT_PREPARED', reason: 'A verified prepared report is not available. This request does not start SEC acquisition.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } });
  return Response.json(summary, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=60', 'Access-Control-Allow-Origin': '*' } });
}
export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } }); }
