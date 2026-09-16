import { isCftcEnabled } from '../../../../../../utils/cftcFeature.js';
import { PORTFOLIO_CFTC_CHANGES_VERSION } from '../../../../../../utils/portfolioCftcChanges.js';
import { readPreparedDemoCftcChanges } from '../../../../../../utils/portfolioCftcPreparation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Schema-Version, Retry-After',
  'X-Schema-Version': PORTFOLIO_CFTC_CHANGES_VERSION,
};

function unavailable(status, code, error, retryable = true) {
  return Response.json({ schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION, status, code, error, retryable }, {
    status: 503,
    headers: { ...headers, 'Cache-Control': 'private, no-store', ...(retryable ? { 'Retry-After': '60' } : {}) },
  });
}

/** Public prepared results only: a read never starts SEC or CFTC acquisition. */
export async function GET(request) {
  if (!isCftcEnabled()) return unavailable('disabled', 'CFTC_DISABLED', 'CFTC context is disabled.', false);
  const query = new URL(request.url).searchParams;
  const days = query.get('days') ?? '30';
  if ([...query.keys()].some(key => key !== 'days') || query.getAll('days').length > 1
    || !/^[1-9]\d?$/.test(days) || Number(days) > 90) {
    return Response.json({ schemaVersion: PORTFOLIO_CFTC_CHANGES_VERSION, code: 'INVALID_DEMO_CFTC_REQUEST',
      error: 'Only days is supported; use an integer from 1 to 90.', retryable: false }, {
      status: 400, headers: { ...headers, 'Cache-Control': 'private, no-store' },
    });
  }
  try {
    const result = await readPreparedDemoCftcChanges({ days: Number(days),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]) });
    if (!result) return unavailable('pending', 'DEMO_CFTC_NOT_PREPARED', 'The public demo research has not been prepared yet.');
    return Response.json(result, {
      headers: { ...headers, 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=60' },
    });
  } catch {
    return unavailable('unavailable', 'DEMO_CFTC_UNAVAILABLE', 'Prepared demo research is temporarily unavailable.');
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...headers,
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Accept', 'Access-Control-Max-Age': '86400' } });
}
