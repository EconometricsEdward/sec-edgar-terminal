import { getDataStoreMode } from '../../../../utils/dataStore.js';
import { isSecCoverageScheduleEnabled } from '../../../../utils/dataStoreDeployment.js';
import { authorizeSecCoverageSchedule } from '../../../../utils/secCoverageScheduleAuth.js';
import { runSecCoverageJob } from '../../../../utils/secCoverageJobs.js';
import { maintainSecCoverageMembership } from '../../../../utils/secCoverageMaintenance.js';
import { maintainRedisCache } from '../../../../utils/redisMaintenance.js';
import { maintainProviderRetirement } from '../../../../utils/providerRetirementMaintenance.js';
import { runCftcHistoryPreparation } from '../../../../utils/cftcHistoryPreparation.js';
import { isCftcEnabled } from '../../../../utils/cftcFeature.js';
import { runPortfolioCftcPreparation } from '../../../../utils/portfolioCftcPreparation.js';
import { runThirteenFReviewWorker } from '../../../../utils/thirteenFReviewWorker.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Only the configured scheduler can enqueue coverage work. */
export async function GET(request) {
  const requestStartedAt = Date.now();
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!await authorizeSecCoverageSchedule(request)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== 'production') return Response.json({ error: 'Coverage scheduling requires production.' }, { status: 403, headers });
  // Explicit shard selection is reserved for bounded operator backfills using
  // the existing CRON_SECRET; signed scheduler messages require an empty query.
  const params = new URL(request.url).searchParams;
  const shardText = params.get('shard'), countText = params.get('maxCompanies');
  if ([...params.keys()].some(key => !['shard', 'maxCompanies'].includes(key) || params.getAll(key).length !== 1)
    || shardText !== null && (!/^\d{1,2}$/.test(shardText) || Number(shardText) > 31)
    || countText !== null && !/^[1-6]$/.test(countText)) return Response.json({ error: 'Invalid bounded coverage operation.' }, { status: 400, headers });
  if (!isSecCoverageScheduleEnabled(process.env) || ['sec', 'financial'].some(dataset => getDataStoreMode(dataset) === 'off')) {
    return Response.json({ status: 'disabled' }, { headers });
  }
  const startedAt = Date.now();
  // The durable manager queue has its own global lease, daily SQL budget and
  // two-worker SEC pacing. Its independent bounded task shares this invocation;
  // it cannot steal the demo's continuation or depend on a visitor staying open.
  const reviewBudget = Math.min(75_000, requestStartedAt + 275_000 - startedAt);
  const reviewTask = isCftcEnabled() && getDataStoreMode('cftc') === 'supabase'
    && getDataStoreMode('sec') === 'supabase' && !request.signal.aborted && reviewBudget >= 10_000
    ? runThirteenFReviewWorker({
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(reviewBudget)]),
      deadline: startedAt + reviewBudget,
    }).catch(() => ({ status: 'unavailable', code: 'THIRTEEN_F_REVIEW_UNAVAILABLE' }))
    : Promise.resolve({ status: 'disabled' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 230_000);
  let responseBody, responseStatus = 200;
  try {
    const membership = await maintainSecCoverageMembership({ signal: controller.signal,
      deadline: startedAt + 125_000 });
    const result = await runSecCoverageJob({ ...(shardText === null ? {} : { shard: Number(shardText) }),
      dynamicMembership: true, maxCompanies: countText === null ? 6 : Number(countText),
      signal: controller.signal, deadline: startedAt + 225_000 });
    // Cache housekeeping uses only the time left after scheduled research work.
    // Its independent lease and byte/command budgets cannot extend this route
    // or turn an acknowledged company refresh into a failed refresh response.
    let cacheMaintenance = { status: 'deferred', reason: 'research-budget' };
    if (!controller.signal.aborted && Date.now() < startedAt + 200_000) {
      try {
        cacheMaintenance = await maintainRedisCache({ signal: controller.signal,
          deadline: Math.min(startedAt + 225_000, Date.now() + 20_000) });
      } catch {
        cacheMaintenance = { status: 'unavailable', code: 'CACHE_MAINTENANCE_UNAVAILABLE' };
      }
    }
    // The retired-provider checkpoint needs a little free Redis capacity to
    // acquire its lease. Start only after acknowledged migration has freed
    // space; the helper independently rechecks operator mode and writer drain.
    let providerRetirement = { status: 'deferred', reason: 'cache-migration' };
    if (cacheMaintenance?.version === 1 && cacheMaintenance.mode === 'migrate'
      && cacheMaintenance.phase === 'migration'
      && ['progress', 'partial', 'waiting', 'migration_pass_complete'].includes(cacheMaintenance.status)
      && Number.isSafeInteger(cacheMaintenance.counters?.removed) && cacheMaintenance.counters.removed > 0) {
      const remaining = startedAt + 225_000 - Date.now();
      if (!controller.signal.aborted && remaining >= 20_000) {
        try {
          providerRetirement = await maintainProviderRetirement({ signal: controller.signal,
            deadline: Math.min(startedAt + 225_000, Date.now() + 20_000) });
        } catch {
          providerRetirement = { status: 'unavailable', code: 'PROVIDER_RETIREMENT_UNAVAILABLE' };
        }
      } else providerRetirement = { status: 'deferred', reason: 'research-budget' };
    }
    // SEC refresh always runs first. CFTC preparation has its own database
    // enablement gate, fenced jobs and source pacing, and uses only spare time.
    // A failed CFTC batch must not undo an acknowledged SEC refresh.
    const cftcPreparationEnabled = isCftcEnabled() && getDataStoreMode('cftc') === 'supabase';
    let cftcHistoryPreparation = cftcPreparationEnabled
      ? { status: 'deferred', reason: 'research-budget' } : { status: 'disabled' };
    if (cftcPreparationEnabled
      && !controller.signal.aborted && startedAt + 225_000 - Date.now() >= 45_000) {
      try {
        cftcHistoryPreparation = await runCftcHistoryPreparation({ signal: controller.signal,
          deadline: Math.min(startedAt + 225_000, Date.now() + 180_000), maxContracts: 12 });
      } catch {
        cftcHistoryPreparation = { status: 'unavailable', code: 'CFTC_HISTORY_PREPARATION_UNAVAILABLE' };
      }
    }
    responseBody = { schema_version: 'edgar.sec-coverage-job.v1', ...result,
      membership, cacheMaintenance, providerRetirement, cftcHistoryPreparation,
      started_at: new Date(startedAt).toISOString() };
  } catch {
    responseStatus = 503;
    responseBody = { schema_version: 'edgar.sec-coverage-job.v1', status: 'failed', code: 'SEC_COVERAGE_JOB_FAILED' };
  } finally { clearTimeout(timer); }
  // Preserve the existing 225-second SEC/CFTC research budget. The demo gets its
  // own bounded continuation even when SEC failed or consumed its entire budget.
  // Include signature verification time in the signed scheduler's 280-second
  // HTTP timeout while preserving the existing research budget after authorization.
  let portfolioCftcPreparation = { status: 'disabled' };
  const preparationDeadline = Math.min(requestStartedAt + 275_000, Date.now() + 45_000);
  const preparationBudget = preparationDeadline - Date.now();
  if (isCftcEnabled() && getDataStoreMode('cftc') === 'supabase') {
    portfolioCftcPreparation = { status: 'deferred', reason: 'request-budget' };
    if (!request.signal.aborted && preparationBudget >= 10_000) {
      try {
        portfolioCftcPreparation = await runPortfolioCftcPreparation({
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(preparationBudget)]),
          deadline: preparationDeadline, maxCompanies: 6,
        });
      } catch { portfolioCftcPreparation = { status: 'unavailable', code: 'PORTFOLIO_CFTC_PREPARATION_UNAVAILABLE' }; }
    }
  }
  const thirteenFReview = await reviewTask;
  return Response.json({ ...responseBody, portfolioCftcPreparation, thirteenFReview, duration_ms: Date.now() - startedAt }, { status: responseStatus, headers });
}
