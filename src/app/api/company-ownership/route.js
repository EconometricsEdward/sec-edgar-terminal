import { companyOwnership } from '../../../utils/companyOwnershipServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
export const runtime = 'nodejs';
export const maxDuration = 120;
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(error) {
  const status = error instanceof RangeError ? 400 : error?.status === 503 ? 503 : 502;
  return Response.json({ error: status === 400 || status === 503 ? error.message
    : 'The SEC holdings review could not finish. Retry, or open the fund research page.' }, { status, headers: noStore });
}
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['ticker', 'asOf'].includes(key)) || params.getAll('ticker').length !== 1 || params.getAll('asOf').length > 1)
      throw new RangeError('Use one company ticker and an optional SEC filing cutoff.');
    const limit = await checkRateLimit({ key: `rl:company-ownership:${getClientIp(request)}`, windowMs: 60000, max: 30 });
    if (!limit.allowed) return rateLimitedResponse(limit);
    const data = await companyOwnership.read(params.get('ticker'), { asOf: params.get('asOf') || '', signal: request.signal });
    return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60' } });
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  try {
    // Preparation is deliberate and bounded to a single known portfolio.
    if (Number(request.headers.get('content-length')) > 2048) throw new RangeError('The report selection is too large.');
    const raw = await request.text();
    if (raw.length > 2048) throw new RangeError('The report selection is too large.');
    let body; try { body = JSON.parse(raw); } catch { throw new RangeError('Provide a valid report selection.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['ticker', 'asOf', 'kind', 'id'].includes(key)))
      throw new RangeError('Provide a company and one listed SEC report.');
    const limit = await checkRateLimit({ key: `rl:company-ownership-prepare:${getClientIp(request)}`, windowMs: 60000, max: 4 });
    if (!limit.allowed) return rateLimitedResponse(limit);
    const data = await companyOwnership.prepare(body.ticker, { asOf: body.asOf || '', kind: body.kind, id: body.id, signal: request.signal });
    return Response.json(data, { headers: noStore });
  } catch (error) { return failure(error); }
}
