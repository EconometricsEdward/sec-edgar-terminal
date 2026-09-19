import { getOperatingDirectory } from '../../../../utils/tickerMap.js';
import { interpretDisclosureSearch } from '../../../../utils/disclosureSearchIntent.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 30;
const HEADERS = { 'Cache-Control': 'private, no-store' };
const PARAMETERS = new Set(['query', 'style', 'tickers', 'forms', 'start', 'end', 'section', 'scope', 'depth', 'amendments', 'comparison']);

// The directory is shared in flight. A disconnected reader stops waiting but
// must not abort a fetch being used by other company-search requests.
async function boundedDirectory(signal) {
  signal.throwIfAborted();
  let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([getOperatingDirectory(), cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    if (request.url.length > 7000 || params.getAll('query').length !== 1 || [...params.keys()].some(key => !PARAMETERS.has(key) || params.getAll(key).length !== 1))
      return Response.json({ error: 'Provide one query and supported search filters.', code: 'INVALID_SEARCH_INTENT' }, { status: 400, headers: HEADERS });
    const raw = params.get('query') || '', style = params.get('style') || 'smart';
    const settings = Object.fromEntries([...params].filter(([key]) => !['query', 'style'].includes(key)));
    // Validate input before directory work and before it can enter shared caches.
    const validated = interpretDisclosureSearch(raw, { style, settings });
    const limit = await checkRateLimit({ key: `rl:disclosure-interpret:${getClientIp(request)}`, windowMs: 60000, max: 60 });
    if (!limit.allowed) return rateLimitedResponse(limit, HEADERS);
    request.signal.throwIfAborted();
    if (validated.style === 'exact') return Response.json(validated, { headers: HEADERS });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6000)]);
    let companies;
    try { companies = await boundedDirectory(signal); }
    catch {
      request.signal.throwIfAborted();
      if (validated.unresolvedTickers?.length) return Response.json({
        error: 'The SEC company directory is temporarily unavailable, so the requested company could not be verified. Retry or enter its SEC CIK in the company filter.',
        code: 'COMPANY_DIRECTORY_UNAVAILABLE',
      }, { status: 503, headers: HEADERS });
      validated.warnings.push('The SEC company directory is temporarily unavailable. Company names remain literal search terms; retry or enter a CIK in the company filter.');
      return Response.json(validated, { headers: HEADERS });
    }
    const result = interpretDisclosureSearch(raw, { style, settings, companies });
    return Response.json(result, { headers: HEADERS });
  } catch (error) {
    const aborted = request.signal.aborted;
    const status = aborted ? 499 : error.status === 400 || !error.status && /query|term|phrase|expression|parenthes|quote|positive|search|window|supported/i.test(error.message || '') ? 400 : 503;
    return Response.json({ error: aborted ? 'Search interpretation was cancelled.' : status === 400 ? error.message : 'Search interpretation is temporarily unavailable. Retry or use Exact search.', code: aborted ? 'CANCELLED' : status === 400 ? 'INVALID_SEARCH_INTENT' : 'INTERPRET_UNAVAILABLE' }, { status, headers: HEADERS });
  }
}
