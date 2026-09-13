import { authorizeDataMigration, readMigrationOperation } from '../../../../utils/dataMigrationOperations.js';
import { getDataStoreMode, readDataStoreStatus,
  dataStoreRetentionDryRun, dataStoreOrphanDryRun, readDataset, readFinancialMetrics } from '../../../../utils/dataStore.js';
import { financialPreparedKey } from '../../../../utils/preparedFinancialData.js';
import { runSecMigrationJob } from '../../../../utils/dataMigrationJob.js';
import { cftcPersistence } from '../../../../utils/cftcPersistence.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const headers = { 'Cache-Control': 'private, no-store' };
const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401, headers });

/** Protected aggregated evidence; never returns credentials or source documents. */
export async function GET(request) {
  if (!authorizeDataMigration(request)) return unauthorized();
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['financial', 'basis'].includes(key))) return Response.json({ error: 'Unknown status parameter.' }, { status: 400, headers });
  try {
    if (params.has('financial')) {
      const key = financialPreparedKey(params.get('financial'), params.get('basis') || 'annual');
      if (!key) return Response.json({ error: 'Choose a cohort company and supported financial basis.' }, { status: 400, headers });
      const record = await readDataset('financial', key, { allowStale: true });
      if (!record) return Response.json({ status: 'not-prepared' }, { status: 404, headers });
      return Response.json({ key, metadata: record.metadata, observations: await readFinancialMetrics(record.metadata.versionId) }, { headers });
    }
    const status = await readDataStoreStatus();
    const retention = await dataStoreRetentionDryRun({ limit: 25, before: new Date(Date.now() - 30 * 86400000).toISOString() });
    const orphans = await dataStoreOrphanDryRun({ limit: 25 });
    return Response.json({ flags: Object.fromEntries(['cftc', 'sec', 'financial'].map(dataset => [dataset, getDataStoreMode(dataset)])),
      status, retention, orphans, cftc: cftcPersistence.status(), alerts: 'unconfigured' }, { headers });
  } catch {
    return Response.json({ error: 'Durable storage status is unavailable or not configured.' }, { status: 503, headers });
  }
}

/** Manual, bounded rehearsal only. No scheduler is registered by this change. */
export async function POST(request) {
  if (!authorizeDataMigration(request)) return unauthorized();
  if (process.env.VERCEL_ENV === 'preview') return Response.json({ error: 'Privileged ingestion is disabled in previews.' }, { status: 403, headers });
  if (['sec', 'financial'].some(dataset => getDataStoreMode(dataset) === 'off')) return Response.json({ status: 'disabled', reason: 'SEC and financial flags must both be enabled for this rehearsal.' }, { status: 409, headers });
  let operation;
  try {
    operation = await readMigrationOperation(request);
  } catch {
    return Response.json({ error: 'Use refresh-sec with maxCompanies 1 or 2.' }, { status: 400, headers });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Migration invocation deadline.')), 240000);
  try {
    const result = await runSecMigrationJob({ maxCompanies: operation.maxCompanies,
      signal: controller.signal, deadline: Date.now() + 230000 });
    return Response.json(result, { status: result.status === 'done' ? 200 : 202, headers });
  } catch {
    return Response.json({ error: 'Migration work stopped safely; check protected status and retry after the cooldown.' }, { status: 503, headers });
  } finally { clearTimeout(timer); }
}
