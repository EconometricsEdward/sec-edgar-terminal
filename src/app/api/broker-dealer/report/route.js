import { loadBrokerDealerResearch } from '../../../../utils/brokerDealerResearch.js';
import { brokerDealerResearchPayload, brokerDealerReportSelection } from '../../../../utils/brokerDealerPayload.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' };

export async function GET(request) {
  let choice;
  try { choice = brokerDealerReportSelection(new URL(request.url).searchParams); }
  catch (error) { return Response.json({ error: error.message }, { status: 400, headers: privateHeaders }); }
  const limit = await checkRateLimit({ key: `rl:broker-report:${getClientIp(request)}`, max: 30, windowMs: 60000 });
  if (!limit.allowed) return rateLimitedResponse(limit, privateHeaders);
  try {
    const { cik, ...selection } = choice;
    const research = await loadBrokerDealerResearch(cik, { ...selection, signal: AbortSignal.any([request.signal, AbortSignal.timeout(280000)]) });
    if (research.status !== 'available' || !research.analysis) return Response.json({ error: 'No public broker-dealer annual report was found for this exact registrant.' }, { status: 404, headers: privateHeaders });
    const retryable = research.extraction?.retryable;
    return Response.json(brokerDealerResearchPayload(research), {
      status: retryable && research.analysis.status === 'unavailable' ? 503 : 200,
      headers: retryable ? { ...privateHeaders, 'Retry-After': '60' } : {
        'Cache-Control': `public, max-age=60, s-maxage=${choice.accession ? 86400 : 900}, stale-while-revalidate=3600`,
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    const status = [400, 404, 422].includes(error.status) ? error.status : 503;
    return Response.json({ error: status < 500 ? error.message : 'This annual report could not finish loading. Retry or open its original SEC document.' }, {
      status, headers: status === 503 ? { ...privateHeaders, 'Retry-After': '60' } : privateHeaders,
    });
  }
}
