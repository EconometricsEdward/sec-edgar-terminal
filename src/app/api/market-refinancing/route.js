import { readCachedRefinancingWall } from '../../../utils/refinancing/publicRead.js';
import { refinancingResponse } from '../../../utils/refinancing/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request) {
  if (new URL(request.url).search) return Response.json({ error: 'Use browser filters on the shared refinancing snapshot.' },
    { status: 400, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    const value = await readCachedRefinancingWall();
    return refinancingResponse(value, request);
  } catch {
    return Response.json({ error: 'The prepared refinancing snapshot is temporarily unavailable. Please try again shortly.' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '30' } });
  }
}
