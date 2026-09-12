/**
 * SEC-only Market overview prewarmer. Price-provider work was retired.
 */
import { NextResponse } from 'next/server';
import { warmCacheEnabled } from '../../../../utils/warmCache.js';
import { loadMarketAtlas } from '../../../../utils/marketResearchServer.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Server misconfigured: CRON_SECRET is unavailable.' }, { status: 500, headers });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (!warmCacheEnabled()) return NextResponse.json({ error: 'Shared prepared-data storage is unavailable.' }, { status: 503, headers });
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(new Error('SEC Market prewarm deadline reached.')),285000);
  try {
    const market = await loadMarketAtlas({ signal: controller.signal, forceRefresh: true });
    return NextResponse.json({ schema_version: 'edgar.sec-market-prewarm.v2', started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now()-startedAt, source: 'SEC', companies: market.companies.length, generated_at: market.generatedAt, cache_status: market.cache?.status || 'current' }, { headers });
  } catch (error) {
    return NextResponse.json({ schema_version: 'edgar.sec-market-prewarm.v2', error: error.message, code: 'SEC_MARKET_PREWARM_FAILED' }, { status: error.status || 503, headers });
  } finally { clearTimeout(timer); }
}
