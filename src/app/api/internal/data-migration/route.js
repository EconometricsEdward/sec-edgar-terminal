import { authorizeDataMigration, readMigrationOperation, migrationOperationEnabled } from '../../../../utils/dataMigrationOperations.js';
import { DataStoreError, getDataStoreMode, readDataStoreStatus, readDataStoreCoverageStatus,
  dataStoreRetentionDryRun, dataStoreOrphanDryRun, readDataset, readFinancialMetrics, readCoverageOperations } from '../../../../utils/dataStore.js';
import { loadSecCoverageRegistry } from '../../../../utils/secCoverageRegistry.js';
import { summarizeCoverageOperations } from '../../../../utils/coverageOperations.js';
import { cacheStatus } from '../../../../utils/disposableCache.js';
import { summarizeDisposableCache } from '../../../../utils/cacheHealth.js';
import { summarizeRedisMaintenanceState } from '../../../../utils/redisMaintenance.js';
import { financialPreparedKey } from '../../../../utils/preparedFinancialData.js';
import { runSecMigrationJob } from '../../../../utils/dataMigrationJob.js';
import { cftcPersistence } from '../../../../utils/cftcPersistence.js';
import { refreshCftcSnapshots } from '../../../../utils/cftcServer.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers });
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeTimestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
function membershipSummary(registry) {
  const snapshot = value => value ? { id: value.id, asOf: value.reference.asOf,
    checkedAt: safeTimestamp(value.reference.checkedAt), issuerCount: safeCount(value.issuerCount), securityCount: safeCount(value.securityCount),
    excludedResiduals: Array.isArray(value.sourceExclusions) ? value.sourceExclusions.length : 0 } : null;
  const control = registry?.control || {};
  return { active: snapshot(registry?.active), candidate: snapshot(registry?.candidate),
    retainedCount: Array.isArray(registry?.retained) ? registry.retained.length : 0,
    control: { nextCheckAt: safeTimestamp(control.nextCheckAt), lastCheckedAt: safeTimestamp(control.lastCheckedAt),
      lastError: typeof control.lastError === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(control.lastError) ? control.lastError : null,
      errorCount: safeCount(control.errorCount), preparationCursor: safeCount(control.preparationCursor), leaseUntil: safeTimestamp(control.leaseUntil) } };
}

/** Protected aggregated evidence; never returns credentials or source documents. */
export async function GET(request) {
  if (!authorizeDataMigration(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['financial', 'basis'].includes(key))) return Response.json({ error: 'Unknown status parameter.' }, { status: 400, headers });
  try {
    if (params.has('financial')) {
      await loadSecCoverageRegistry({ required: true });
      const key = financialPreparedKey(params.get('financial'), params.get('basis') || 'annual');
      if (!key) return Response.json({ error: 'Choose a cohort company and supported financial basis.' }, { status: 400, headers });
      const record = await readDataset('financial', key, { allowStale: true });
      if (!record) return Response.json({ status: 'not-prepared' }, { status: 404, headers });
      return Response.json({ key, metadata: record.metadata, observations: await readFinancialMetrics(record.metadata.versionId) }, { headers });
    }
    const [status, coverage, retention, orphans, registry, operations, cache] = await Promise.all([
      readDataStoreStatus(), readDataStoreCoverageStatus(),
      dataStoreRetentionDryRun({ limit: 25, before: new Date(Date.now() - 30 * 86400000).toISOString() }),
      dataStoreOrphanDryRun({ limit: 25 }), loadSecCoverageRegistry({ force: true, required: true }), readCoverageOperations(),
      cacheStatus({ timeoutMs: 4000 }).catch(() => null),
    ]);
    return Response.json({ flags: Object.fromEntries(['cftc', 'sec', 'financial'].map(dataset => [dataset, getDataStoreMode(dataset)])),
      status, coverage, membership: membershipSummary(registry), operations, operationsSummary: summarizeCoverageOperations(operations),
      cacheStorage: summarizeDisposableCache(cache, summarizeRedisMaintenanceState(cache?.maintenance?.state)),
      retention, orphans, cftc: cftcPersistence.status(), alerts: { health: 'stored', notifications: 'unconfigured' } }, { headers });
  } catch (error) {
    const code = error instanceof DataStoreError && /^[a-z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'durable_status_unavailable';
    return Response.json({ error: 'Durable storage status is unavailable or not configured.', code }, { status: 503, headers });
  }
}

/** Manual, bounded ingestion. Schedules remain on the existing cron routes. */
export async function POST(request) {
  if (!authorizeDataMigration(request)) return unauthorized();
  if (process.env.VERCEL_ENV === 'preview') return Response.json({ error: 'Privileged ingestion is disabled in previews.' }, { status: 403, headers });
  let operation;
  try {
    operation = await readMigrationOperation(request);
  } catch {
    return Response.json({ error: 'Use refresh-sec with maxCompanies 1 or 2, or refresh-cftc with no additional arguments.' }, { status: 400, headers });
  }
  if (!migrationOperationEnabled(operation, getDataStoreMode)) return Response.json({ status: 'disabled', reason: operation.action === 'refresh-cftc'
    ? 'The CFTC flag must be enabled.' : 'SEC and financial flags must both be enabled.' }, { status: 409, headers });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Migration invocation deadline.')), 240000);
  try {
    const result = operation.action === 'refresh-cftc'
      ? await refreshCftcSnapshots({ signal: controller.signal })
      : await runSecMigrationJob({ maxCompanies: operation.maxCompanies,
        signal: controller.signal, deadline: Date.now() + 230000 });
    return Response.json(result, { status: ['done', 'ready'].includes(result.status) ? 200 : 202, headers });
  } catch {
    return Response.json({ error: 'Migration work stopped safely; check protected status and retry after the cooldown.' }, { status: 503, headers });
  } finally { clearTimeout(timer); }
}
