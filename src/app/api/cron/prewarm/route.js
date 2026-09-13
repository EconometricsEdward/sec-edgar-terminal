/**
 * SEC-only Market overview prewarmer. Price-provider work was retired.
 */
import { warmCacheEnabled } from '../../../../utils/warmCache.js';
import { loadMarketAtlas } from '../../../../utils/marketResearchServer.js';
import { prewarmSecSubmissions, readSecPrewarmTickers } from '../../../../utils/secPrewarm.js';
import { getDataStoreMode } from '../../../../utils/dataStore.js';
import { SEC_MIGRATION_COHORT } from '../../../../utils/secDocumentStore.js';
import { runSecMigrationJob } from '../../../../utils/dataMigrationJob.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'Server misconfigured: CRON_SECRET is unavailable.' }, { status: 500, headers });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== 'production') return Response.json({ error: 'SEC prewarming runs only in production.' }, { status: 403, headers });
  if (!warmCacheEnabled()) return Response.json({ error: 'Shared prepared-data storage is unavailable.' }, { status: 503, headers });
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(new Error('SEC Market prewarm deadline reached.')),285000);
  try {
    const deadline = startedAt + 280_000;
    const migrationScheduled = process.env.EDGAR_DATASTORE_SEC_SCHEDULE === '1'
      && ['sec', 'financial'].every(dataset => getDataStoreMode(dataset) !== 'off');
    const tickers = migrationScheduled
      ? (await readSecPrewarmTickers()).filter(ticker => !SEC_MIGRATION_COHORT.some(company => company.ticker === ticker)) : undefined;
    const [marketResult, submissionsResult, migrationResult] = await Promise.allSettled([
      loadMarketAtlas({ signal: controller.signal, forceRefresh: true }),
      prewarmSecSubmissions({ signal: controller.signal, deadline, ...(tickers ? { tickers } : {}) }),
      migrationScheduled ? runSecMigrationJob({ signal: controller.signal, deadline: startedAt + 230000, maxCompanies: 2, maxBatches: 2 }) : Promise.resolve(null),
    ]);
    if (marketResult.status === 'rejected' && submissionsResult.status === 'rejected') throw new Error(`SEC Market and submissions prewarming failed: ${marketResult.reason?.message || 'Market unavailable'}; ${submissionsResult.reason?.message || 'submissions unavailable'}`);
    const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
    const submissions = submissionsResult.status === 'fulfilled' ? submissionsResult.value : { requested: 0, succeeded: 0, failed: 1, unresolved: 0, skipped: 0, failures: [{ reason: submissionsResult.reason?.message || 'SEC submissions prewarm failed.' }] };
    return Response.json({
      schema_version: 'edgar.sec-market-prewarm.v2', started_at: new Date(startedAt).toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now()-startedAt, source: 'SEC',
      status: market && submissions.failed === 0 && submissions.unresolved === 0 && submissions.skipped === 0
        && (!migrationScheduled || migrationResult.status === 'fulfilled' && migrationResult.value?.status === 'done') ? 'ready' : 'partial',
      market: market ? { companies: market.companies.length, generated_at: market.generatedAt, cache_status: market.cache?.status || 'current' } : { failed: true, reason: marketResult.reason?.message || 'SEC Market prewarm failed.' },
      submissions,
      ...(migrationScheduled ? { migration: migrationResult.status === 'fulfilled' ? migrationResult.value : { status: 'failed', code: 'DURABLE_COHORT_REFRESH_FAILED' } } : {}),
    }, { headers });
  } catch (error) {
    return Response.json({ schema_version: 'edgar.sec-market-prewarm.v2', error: error.message, code: 'SEC_MARKET_PREWARM_FAILED' }, { status: error.status || 503, headers });
  } finally { clearTimeout(timer); }
}
