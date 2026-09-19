import { loadCompanyReport } from '../../../../utils/companyReport.js';
import { loadFundReport } from '../../../../utils/fundReport.js';
import { normalizeReportRequest, reportMatchesSelection } from '../../../../utils/reportRequest.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';
import { usesPublicReportSources, preparePublicReportSources } from '../../../../utils/reportPreviewSources.js';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(request) {
  const startedAt = performance.now();
  try {
    const selection = normalizeReportRequest(new URL(request.url).searchParams);
    const limit = await checkRateLimit({ key: `rl:reports:${getClientIp(request)}`, windowMs: 60000, max: 12 });
    if (!limit.allowed) return rateLimitedResponse(limit, { 'Cache-Control': 'private, no-store' });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(110000)]);
    const report = usesPublicReportSources() ? await preparePublicReportSources(selection, signal) : selection.kind === 'company'
      ? await loadCompanyReport({ ticker: selection.id, basis: selection.basis }, signal)
      : await loadFundReport(selection, signal);
    if (!reportMatchesSelection(report, selection)) throw new Error('The prepared report did not match the selected entity. Please retry.');
    const bytes = new TextEncoder().encode(JSON.stringify(report));
    if (bytes.length > 48 * 1024 * 1024) throw Object.assign(new Error('This report exceeds the current download preparation limit. Open the source portfolio to review its full holdings.'), { status: 413 });
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Server-Timing': `report;dur=${Math.round(performance.now() - startedAt)}` };
    // Prepared source loaders own caching and freshness. Streaming keeps large
    // complete portfolios below Vercel's buffered response limit; files are
    // generated in a browser worker from this same verified report snapshot.
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 32768)); offset += 32768;
    } }), { headers });
  } catch (error) {
    return Response.json({ error: ['AbortError', 'TimeoutError'].includes(error.name)
      ? 'SEC report preparation took too long. Please retry; previously retrieved source data can be reused.'
      : error.message || 'This report could not be prepared. Please retry.',
      code: error.code || 'REPORT_UNAVAILABLE' },
    { status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502,
      headers: { 'Cache-Control': 'private, no-store' } });
  }
}
