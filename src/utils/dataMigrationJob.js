import { enqueueDataStoreJob, claimDataStoreJob, finishDataStoreJob, checkpointDataStoreJob } from './dataStore.js';
import { refreshSecFinancialCohort } from './preparedFinancialData.js';
import { migrationRetrySeconds } from './dataMigrationOperations.js';

/** One durable claim covers at most four issuers, with no detached promises. */
export async function runSecMigrationJob({ maxCompanies = 1, maxBatches = 1, signal, deadline = Date.now() + 230000 } = {}, {
  enqueue = enqueueDataStoreJob, claimJob = claimDataStoreJob, finish = finishDataStoreJob, checkpointJob = checkpointDataStoreJob, refresh = refreshSecFinancialCohort,
} = {}) {
  if (![1, 2].includes(maxCompanies) || ![1, 2].includes(maxBatches)) throw new Error('Unbounded migration invocation.');
  const jobKey = `sec-financial-cohort-v1:${new Date().toISOString().slice(0, 10)}`;
  await enqueue({ dataset: 'sec', key: 'financial-cohort-v1', jobKey, checkpoint: { cursor: 0 }, maxAttempts: 10 });
  // Resume the oldest eligible cohort job, including one interrupted yesterday.
  // A fresh daily job remains queued while older work finishes; source reads
  // always revalidate the latest SEC documents, regardless of the job's date.
  const claim = await claimJob({ dataset: 'sec', leaseSeconds: 270 });
  if (!claim) return { status: 'busy-or-finished', retryAfterSeconds: 30 };
  let cursor = claim.checkpoint.cursor || 0;
  const results = [];
  try {
    let result;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      result = await refresh({ cursor, maxCompanies, signal, deadline });
      results.push(...result.results);
      const advanced = result.nextCursor > cursor;
      cursor = result.nextCursor;
      if (advanced && !result.done && batch + 1 < maxBatches) {
        const saved = await checkpointJob(claim, { checkpoint: { cursor, coverage: result.coverage }, leaseSeconds: 270 });
        if (!saved) throw new Error('Job checkpoint ownership expired.');
      }
      if (result.done || !advanced || result.results.some(item => item.status === 'failed') || signal?.aborted) break;
    }
    const failure = results.find(item => item.status === 'failed');
    const acknowledged = await finish(claim, { checkpoint: { cursor, coverage: result.coverage }, status: result.done ? 'done' : 'retry',
      errorCode: failure ? 'SEC_COHORT_REFRESH_FAILED' : null, retryAfterSeconds: failure ? migrationRetrySeconds(failure, claim.attempts) : 2 });
    if (!acknowledged) throw new Error('Job ownership expired before checkpoint publication.');
    return { ...result, results, jobId: claim.id, status: result.done ? 'done' : 'resume-required' };
  } catch (error) {
    await finish(claim, { checkpoint: { ...claim.checkpoint, cursor }, status: 'retry', errorCode: 'MIGRATION_INVOCATION_FAILED',
      retryAfterSeconds: migrationRetrySeconds(error, claim.attempts) }).catch(() => false);
    throw error;
  }
}
