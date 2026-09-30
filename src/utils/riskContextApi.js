import { riskMaturityContext, riskMarketContext, riskBankContext } from './riskContext.js';

const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
// Dependencies are explicit so tests can prove this route never initiates ingestion.
export function createRiskContextApi({ readMaturities, readMarket, readBank, rateLimit, cftcEnabled = true, now = Date.now }) {
  return async request => {
    const p = new URL(request.url).searchParams, source = p.get('source');
    const allowed = source === 'maturities' ? ['source', 'cik'] : source === 'bank' ? ['source', 'rssd'] : source === 'markets' ? ['source'] : [];
    if (!allowed.length || [...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)
      || source === 'maturities' && !/^(?!0{10})\d{10}$/.test(p.get('cik') || '')
      || source === 'bank' && !/^[1-9]\d{0,9}$/.test(p.get('rssd') || '')) {
      return Response.json({ error: 'Choose a valid risk evidence source and identifier.' }, { status: 400, headers: PRIVATE });
    }
    const blocked = await rateLimit(request);
    if (blocked) return blocked;
    try {
      let data, ttl = 900;
      if (source === 'maturities') {
        data = riskMaturityContext(await readMaturities(), p.get('cik'), now()); ttl = data.ttl; delete data.ttl;
      } else if (source === 'markets') {
        const results = await Promise.allSettled([readMarket('funding'), cftcEnabled ? readMarket('derivatives') : Promise.resolve(null)]);
        data = riskMarketContext(...results.map(result => result.status === 'fulfilled' ? result.value : null), now());
        if (!data.funding && !data.swaps) throw new Error('No prepared markets');
        if (!data.funding || cftcEnabled && !data.swaps) ttl = 0;
      } else {
        data = riskBankContext(await readBank('read', { rssds: [Number(p.get('rssd'))] }), Number(p.get('rssd')));
        ttl = data.status === 'ready' && !data.stale ? 30 : 0;
      }
      return Response.json(data, { headers: { ...PRIVATE,
        // No stale extension: maturity hard expiry and bank freshness stay bounded.
        'Cache-Control': ttl ? `public, max-age=${Math.min(60, ttl)}, s-maxage=${ttl}` : PRIVATE['Cache-Control'],
      } });
    } catch {
      return Response.json({ error: 'This prepared evidence is temporarily unavailable. Other risk sections remain available.' },
        { status: 503, headers: { ...PRIVATE, 'Retry-After': '30' } });
    }
  };
}
