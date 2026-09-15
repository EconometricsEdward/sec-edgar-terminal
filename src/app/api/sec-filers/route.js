import { parseSecFilerQuery, searchSecFilers } from '../../../utils/secFilerSearchServer.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  try {
    if (params.getAll('query').length !== 1 || [...params.keys()].some(key => key !== 'query'))
      throw Object.assign(new Error('Provide one filer name or CIK using query.'), { status: 400 });
    const { query } = parseSecFilerQuery(params.get('query'));
    const limit = await checkRateLimit({ key: `rl:sec-filers:${getClientIp(request)}`, windowMs: 60000, max: 40 });
    if (!limit.allowed) return rateLimitedResponse(limit);
    const result = await searchSecFilers(query);
    return Response.json(result, { headers: { 'Cache-Control': result.warning ? 'private, no-store' : 'public, max-age=60, s-maxage=300' } });
  } catch (failure) {
    const status = [400, 404, 429, 502, 503].includes(failure.status) ? failure.status : 502;
    return Response.json({ error: status === 400 || status === 404 ? failure.message : 'SEC filer search is temporarily unavailable. Please retry or enter a CIK.' },
      { status, headers: { 'Cache-Control': 'private, no-store', ...(status === 503 ? { 'Retry-After': '10' } : {}) } });
  }
}
