import { loadCompanyConcentrations } from '../../../../utils/companyConcentrationsServer.js';
import { parseRiskNoteRequest } from '../../../../utils/riskNoteFactsServer.js';
import { COMPANY_CONCENTRATIONS_VERSION } from '../../../../utils/companyConcentrations.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  let selection;
  try { selection = parseRiskNoteRequest(request.url); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } }); }
  const limit = await checkRateLimit({ key: `rl:risk-concentrations:${getClientIp(request)}`, windowMs: 600_000, max: 30 });
  if (!limit.allowed) return rateLimitedResponse(limit);
  try {
    const result = await loadCompanyConcentrations(selection, { signal: request.signal });
    return Response.json(result, { headers: { 'Cache-Control': result.coverage.historyLimited ? 'private, no-store' : 'public, max-age=60, s-maxage=900' } });
  } catch (error) {
    return Response.json({ schemaVersion: COMPANY_CONCENTRATIONS_VERSION, status: 'unavailable', error: error.message || 'Company concentrations could not be loaded.' },
      { status: error.status || 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
