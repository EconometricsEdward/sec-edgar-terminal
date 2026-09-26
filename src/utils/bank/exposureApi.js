import { bankRssd } from './catalog.js';
import { getExposures } from './exposureService.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../rateLimit.js';

export function createExposureApi({ analyze = getExposures, rateLimit = checkRateLimit } = {}) {
  return async function GET(request) {
    let rssd, period;
    try {
      const p = new URL(request.url).searchParams;
      if ([...p.keys()].some(k => !['rssd','period'].includes(k) || p.getAll(k).length !== 1) || !/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(p.get('period') || '')) throw new Error();
      rssd = bankRssd(p.get('rssd')); period = p.get('period');
    } catch { return Response.json({ error: 'Choose a bank and a valid reporting quarter.' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
    try {
      const limit = await rateLimit({ key: `rl:bankscope:exposures:${getClientIp(request)}`, windowMs: 60000, max: 60 });
      if (!limit.allowed) return rateLimitedResponse(limit);
      const data = await analyze(rssd, period);
      return Response.json(data, { headers: { 'Cache-Control': data.unavailable || data.missing?.length ? 'private, no-store' : 'public, max-age=0, s-maxage=30, stale-while-revalidate=60', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return Response.json({ error: 'Exposure details are temporarily unavailable. Please try again.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
  };
}
