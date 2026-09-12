import { CFTC_SCHEMA_VERSION } from '../../../../../utils/cftc.js';
import { readCftcCacheStatus } from '../../../../../utils/cftcServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const commonHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Schema-Version', 'X-Schema-Version': CFTC_SCHEMA_VERSION };

export async function GET() {
  try {
    const result = await readCftcCacheStatus();
    const usable = ['ready', 'degraded'].includes(result.status);
    return Response.json(result, { status: usable ? 200 : 503, headers: { ...commonHeaders, 'Cache-Control': usable ? 'public, max-age=0, s-maxage=30, stale-while-revalidate=30' : 'private, no-store' } });
  } catch (error) {
    return Response.json({ schema_version: CFTC_SCHEMA_VERSION, status: 'unavailable', checked_at: new Date().toISOString(), families: [], error: error.message || 'CFTC cache status is unavailable.' }, { status: 503, headers: { ...commonHeaders, 'Cache-Control': 'private, no-store' } });
  }
}

export function OPTIONS() { return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } }); }
