import { loadRiskNoteFacts, parseRiskNoteRequest } from '../../../../utils/riskNoteFactsServer.js';
import { RISK_NOTE_FACTS_VERSION } from '../../../../utils/riskNoteFacts.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  let selection;
  try { selection = parseRiskNoteRequest(request.url); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const limit = await checkRateLimit({ key: `rl:risk-notes:${getClientIp(request)}`, windowMs: 600_000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const result = await loadRiskNoteFacts(selection, { signal: request.signal });
    return Response.json(result, { headers: { 'Cache-Control': result.coverage.historyLimited ? 'private, no-store' : 'public, max-age=60, s-maxage=900' } });
  } catch (error) {
    return Response.json({ schemaVersion: RISK_NOTE_FACTS_VERSION, status: 'unavailable', error: error.message || 'The SEC note evidence could not be loaded.', rows: [] },
      { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
