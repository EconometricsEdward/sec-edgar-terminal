import { disclosureSettings } from '../../../../utils/disclosureResearchServer.js';
import { searchDisclosurePassageIndex } from '../../../../utils/disclosurePassageIndex.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 15;
const HEADERS = { 'Cache-Control': 'private, no-store' };
const PARAMETERS = new Set(['query', 'tickers', 'forms', 'start', 'end', 'section', 'scope', 'depth', 'amendments', 'comparison', 'offset', 'limit']);

export async function GET(request) {
  let settings, tickers, offset, pageSize;
  try {
    const params = new URL(request.url).searchParams;
    if (request.url.length > 7000 || [...params.keys()].some(key => !PARAMETERS.has(key) || params.getAll(key).length !== 1))
      throw new Error('Provide one query and supported search filters.');
    settings = disclosureSettings(params);
    tickers = (params.get('tickers') || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    if (tickers.length > 100 || tickers.some(ticker => !/^[A-Z0-9.-]{1,15}$/.test(ticker))) throw new Error('Use up to 100 ticker or CIK filters.');
    offset = Number(params.get('offset') || 0); pageSize = Number(params.get('limit') || 20);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
      throw new Error('Use a valid passage continuation offset and a page size between 1 and 50.');
  } catch (error) { return Response.json({ error: error.message, code: 'INVALID_PASSAGE_SEARCH' }, { status: 400, headers: HEADERS }); }
  const allowance = await checkRateLimit({ key: `rl:disclosure-passages:${getClientIp(request)}`, max: 90, windowMs: 60000 });
  if (!allowance.allowed) return rateLimitedResponse(allowance, HEADERS);
  try {
    request.signal.throwIfAborted();
    const started = performance.now();
    const result = await searchDisclosurePassageIndex(settings, { tickers, offset, limit: pageSize, signal: request.signal });
    return Response.json({ ...result, elapsedMs: Math.round(performance.now() - started) }, { headers: HEADERS });
  } catch {
    if (request.signal.aborted) return Response.json({ error: 'Passage search cancelled.', code: 'CANCELLED' }, { status: 499, headers: HEADERS });
    return Response.json({ results: [], hasMore: false, coverage: { available: false, partial: true, reason: 'index_unavailable' } }, { headers: HEADERS });
  }
}
