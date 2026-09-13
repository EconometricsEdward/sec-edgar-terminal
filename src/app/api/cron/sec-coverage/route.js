import { getDataStoreMode } from '../../../../utils/dataStore.js';
import { isSecCoverageScheduleEnabled } from '../../../../utils/dataStoreDeployment.js';
import { authorizeSecCoverageSchedule } from '../../../../utils/secCoverageScheduleAuth.js';
import { runSecCoverageJob } from '../../../../utils/secCoverageJobs.js';
import { maintainSecCoverageMembership } from '../../../../utils/secCoverageMaintenance.js';
import { maintainRedisCache } from '../../../../utils/redisMaintenance.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Only the configured scheduler can enqueue coverage work. */
export async function GET(request) {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 230_000);
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
    return Response.json({ schema_version: 'edgar.sec-coverage-job.v1', ...result,
      membership, cacheMaintenance,
      started_at: new Date(startedAt).toISOString(), duration_ms: Date.now() - startedAt }, { headers });
  } catch {
    return Response.json({ schema_version: 'edgar.sec-coverage-job.v1', status: 'failed', code: 'SEC_COVERAGE_JOB_FAILED' }, { status: 503, headers });
  } finally { clearTimeout(timer); }
}
