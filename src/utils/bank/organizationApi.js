import { bankRssd } from './catalog.js';
import { getBankOrganization } from './organizationService.js';
import { createBankApiReadCache, bankApiRefresh } from './apiReadCache.js';
import { reusableOrganizationResult } from './organizationResult.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../rateLimit.js';

export function createOrganizationApi({ read = getBankOrganization, rateLimit = checkRateLimit, now = Date.now,
  readCache = createBankApiReadCache({ now }) } = {}) {
  return async function GET(request) {
    const params = new URL(request.url).searchParams;
    let rssd, part;
    const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    try {
      if ([...params.keys()].some(k => !['rssd', 'part'].includes(k) || params.getAll(k).length !== 1)) throw new Error();
      rssd = bankRssd(params.get('rssd')); part = params.get('part') || 'profile';
      if (!['profile', 'network', 'sec'].includes(part)) throw new Error();
    } catch { return Response.json({ error: 'Choose a valid bank and organization view.' }, { status: 400, headers: privateHeaders }); }
    try {
      const limit = await rateLimit({ key: `rl:bankscope:organization:${getClientIp(request)}`, windowMs: 60000, max: 40 });
      if (!limit.allowed) return rateLimitedResponse(limit);
      const { data, ageMs } = await readCache(JSON.stringify([rssd, part]), () => read(rssd, part), {
        refresh: bankApiRefresh(request), reusable: data => reusableOrganizationResult(data, rssd, part),
      });
      const age = Math.ceil(ageMs / 1000);
      return Response.json(data, { headers: { ...privateHeaders, 'Cache-Control': reusableOrganizationResult(data, rssd, part)
        ? `public, max-age=${Math.max(0, 60 - age)}, s-maxage=${Math.max(0, 900 - age)}` : 'private, no-store' } });
    } catch { return Response.json({ error: 'Organization data is temporarily unavailable. Please try again.' }, { status: 503, headers: { ...privateHeaders, 'Retry-After': '60' } }); }
  };
}
