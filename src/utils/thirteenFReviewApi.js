import { loadThirteenF, normalize13FRequest } from './thirteenFServer.js';
import { normalize13FMarketConnectionsRequest } from './thirteenFMarketConnectionsServer.js';
import { prepareThirteenFReviewReport, hashThirteenFReviewReport, THIRTEEN_F_REVIEW_SCHEMA } from './thirteenFSharedReview.js';
import { thirteenFReviewStore } from './thirteenFReviewStore.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from './rateLimit.js';
import { isCftcEnabled } from './cftcFeature.js';
import { createHash } from 'node:crypto';
import { loadThirteenFInitialChart } from './thirteenFInitialChart.js';

const PRIVATE = { 'Cache-Control': 'private, no-store', 'X-Schema-Version': THIRTEEN_F_REVIEW_SCHEMA };
const PUBLIC = { ...PRIVATE, 'Cache-Control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=15' };
const SNAPSHOT = { ...PRIVATE, 'Cache-Control': 'public, max-age=15, s-maxage=60, stale-while-revalidate=300' };
const STATUSES = new Set(['unchecked', 'linked', 'partial', 'disclosure_only', 'no_matches', 'no_filing', 'unresolved', 'unavailable']);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_REQUEST' });
function selection(cikInput, periodInput) {
  const value = normalize13FRequest(cikInput, periodInput);
  if (!value.period || value.period > new Date().toISOString().slice(0, 10)) throw invalid('Select a filed 13F reporting quarter.');
  return value;
}
function query(request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['cik', 'period', 'reportHash', 'market', 'status', 'query', 'offset', 'limit', 'key', 'view', 'version'].includes(key) || params.getAll(key).length !== 1))
    throw invalid('Use one value for each supported review filter.');
  if (params.has('view')) {
    const view = params.get('view'), version = params.get('version');
    if (!['snapshot', 'progress'].includes(view)
      || [...params.keys()].some(key => !['cik', 'period', 'view', 'version'].includes(key))
      || version !== null && (view !== 'snapshot' || !/^[A-Za-z0-9:._-]{1,160}$/.test(version)))
      throw invalid('Select a saved snapshot or its progress without page filters.');
    const selected = normalize13FRequest(params.get('cik'), params.get('period'));
    if (selected.period && selected.period > new Date().toISOString().slice(0, 10)) throw invalid('Select a filed 13F reporting quarter.');
    return { ...selected, period: selected.period || null, view };
  }
  if (params.has('version')) throw invalid('A publication version requires the snapshot view.');
  const value = selection(params.get('cik'), params.get('period'));
  const reportHash = params.get('reportHash');
  if (reportHash && !/^[A-Fa-f0-9]{64}$/.test(reportHash)) throw invalid('Invalid report revision.');
  if (params.has('key')) {
    if (!reportHash) throw invalid('Select saved evidence from a specific report revision.');
    if (['market', 'status', 'query', 'offset', 'limit'].some(key => params.has(key))) throw invalid('Select either a holding or a summary page.');
    return { ...normalize13FMarketConnectionsRequest(value.cik, value.period, params.get('key')), reportHash: reportHash?.toUpperCase() || null };
  }
  const market = params.get('market') || null, status = params.get('status') || null, text = params.get('query') || null;
  const offset = params.get('offset') ?? '0', limit = params.get('limit') ?? '50';
  if (market && !/^(tff|disaggregated):[A-Z0-9]{6}:(leveraged-funds|managed-money)$/.test(market)
    || status && !STATUSES.has(status) || text && (text.length > 100 || /[\x00-\x1f]/.test(text))
    || !/^\d{1,5}$/.test(offset) || Number(offset) > 20000 || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50)
    throw invalid('Use valid review filters and pages of up to 50 holdings.');
  return { ...value, reportHash: reportHash?.toUpperCase() || null, market, status, query: text, offset: Number(offset), limit: Number(limit) };
}
async function smallBody(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw invalid('Send a JSON manager and quarter.');
  if (Number(request.headers.get('content-length') || 0) > 4096) throw invalid('The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw invalid('Send a manager and report quarter.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw invalid('The request is too large.');
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['cik', 'period'].includes(key))) throw invalid('Send only a manager CIK and report quarter.');
    return selection(body.cik, body.period);
  } catch (error) { if (error.status) throw error; throw invalid('Send a valid JSON manager and report quarter.'); }
  finally { await reader.cancel().catch(() => {}); }
}
function errorResponse(error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 503;
  const message = error.code === 'fund_review_capacity' ? 'The shared review queue is full. Existing reviews keep their progress; please try again later.'
    : error.code === 'stale_generation' ? 'A newer report revision is available. Reload the saved review before opening this holding.'
      : status < 500 ? error.message : 'Shared reviews are temporarily unavailable. Saved results remain available; please retry.';
  return Response.json({ schemaVersion: THIRTEEN_F_REVIEW_SCHEMA, error: message,
    code: typeof error.code === 'string' ? error.code : 'SHARED_REVIEW_UNAVAILABLE' }, { status, headers: PRIVATE });
}

/** GET only reads published progress. Only the bounded POST can enqueue work;
 * no caller controls source URLs, holdings, report revision or worker budgets. */
export function createThirteenFReviewApi({ store = thirteenFReviewStore, portfolioLoader = loadThirteenF,
  rateLimit = checkRateLimit, enabled = isCftcEnabled, schedule = () => {}, initialChart = loadThirteenFInitialChart } = {}) {
  async function gate(request, write) {
    if (!enabled()) return Response.json({ error: 'CFTC market research is disabled.', code: 'CFTC_DISABLED' }, { status: 503, headers: PRIVATE });
    const limit = await rateLimit({ key: `rl:fund-13f-shared-review:${write ? 'write' : 'read'}:${getClientIp(request)}`, windowMs: 60000, max: write ? 4 : 120 });
    if (!limit.allowed) {
      const response = rateLimitedResponse(limit);
      for (const [key, value] of Object.entries(PRIVATE)) response.headers.set(key, value);
      return response;
    }
    return null;
  }
  return {
    async GET(request) {
      try {
        const params = query(request);
        const blocked = await gate(request, false); if (blocked) return blocked;
        const options = { signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]), timeoutMs: 11000 };
        const readStarted = performance.now();
        let data = params.view === 'progress' ? await store.progress(params, options)
          : params.view === 'snapshot' ? await store.snapshot(params, options)
            : params.key ? await store.result(params, options) : await store.read(params, options);
        const readMs = performance.now() - readStarted;
        if (params.key && !data) return Response.json({ error: 'This holding has no saved evidence yet.', code: 'REVIEW_RESULT_PENDING' }, { status: 404, headers: PRIVATE });
        const chartStarted = performance.now();
        if (params.view === 'snapshot' && data?.markets?.[0]) {
          const chart = await initialChart(data.markets[0], options).catch(() => null);
          if (chart) data = { ...data, initialChart: chart };
        }
        const body = JSON.stringify(data || { job: null });
        const headers = { ...(data?.job || params.key ? params.view === 'snapshot' ? SNAPSHOT : PUBLIC : PRIVATE),
          'Content-Type': 'application/json', ETag: `"${createHash('sha256').update(body).digest('hex')}"`,
          'Server-Timing': `saved;dur=${readMs.toFixed(1)}, chart;dur=${(performance.now() - chartStarted).toFixed(1)}` };
        if (data && request.headers.get('if-none-match')?.split(',').map(value => value.trim()).includes(headers.ETag))
          return new Response(null, { status: 304, headers });
        return new Response(body, { headers });
      } catch (error) { return errorResponse(error); }
    },
    async POST(request) {
      try {
        if (new URL(request.url).search) throw invalid('Send the manager and quarter in the request body.');
        const origin = request.headers.get('origin');
        if (request.headers.get('sec-fetch-site') === 'cross-site' || origin && origin !== new URL(request.url).origin)
          return Response.json({ error: 'Start a shared review from this site.', code: 'CROSS_ORIGIN_REQUEST' }, { status: 403, headers: PRIVATE });
        const params = await smallBody(request);
        const blocked = await gate(request, true); if (blocked) return blocked;
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
        const report = prepareThirteenFReviewReport(await portfolioLoader(params.cik, { period: params.period, signal }));
        // A loader may choose a fallback report; never silently enqueue that
        // different manager or quarter on behalf of the visitor.
        if (report.manager.cik !== params.cik || report.selectedPeriod !== params.period) throw invalid('The requested manager report is unavailable.');
        const job = await store.enqueue(report, hashThirteenFReviewReport(report), { signal, timeoutMs: 10000 });
        if (!job) throw Object.assign(new Error('Shared review storage did not acknowledge the job.'), { code: 'REVIEW_NOT_SAVED' });
        schedule();
        return Response.json({ schemaVersion: THIRTEEN_F_REVIEW_SCHEMA, job }, { status: 202, headers: PRIVATE });
      } catch (error) { return errorResponse(error); }
    },
  };
}
