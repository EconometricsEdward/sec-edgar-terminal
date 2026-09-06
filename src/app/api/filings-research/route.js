import { loadFilingsArchive, loadFilingsCompany } from '../../../utils/filingsResearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';
import { validTicker } from '../../../utils/researchWorkspace.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ticker = (params.get('ticker') || '').trim().toUpperCase();
  const archive = params.get('archive') || '';
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!validTicker(ticker) || archive && !/^CIK\d{10}-submissions-\d+\.json$/.test(archive)) return Response.json({ error: 'Provide a valid ticker and SEC archive name.', code: 'INVALID_REQUEST' }, { status: 400, headers });
  const limit = await checkRateLimit({ key: `rl:filings-research:${getClientIp(request)}`, windowMs: 60000, max: 60 });
  if (!limit.allowed) {
    const response = rateLimitedResponse(limit);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45000)]);
    const data = archive ? await loadFilingsArchive(ticker, archive, { signal }) : await loadFilingsCompany(ticker, { signal });
    // Larger issuer archives remain complete even beyond buffered response limits.
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    const responseHeaders = { ...headers, 'Content-Type': 'application/json; charset=utf-8' };
    if (bytes.length < 3500000) return new Response(bytes, { headers: responseHeaders });
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 32768)); offset += 32768;
    } }), { headers: responseHeaders });
  } catch (error) {
    return Response.json({ error: error.message || 'SEC filings could not be loaded. Retry this request.', code: error.code || 'SEC_UNAVAILABLE' }, { status: error.status || 502, headers });
  }
}
