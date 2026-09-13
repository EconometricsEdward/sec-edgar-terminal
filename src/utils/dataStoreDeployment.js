/** Reviewed deployment defaults. Explicit environment flags always override these. */
export const DATA_STORE_DEPLOYMENT = Object.freeze({
  stage: 'supabase',
  secSchedule: true,
  // Writers can prepare the larger universe before its readers are activated.
  broadCoverage: false,
  secCoverageSchedule: true,
  project: 'vvkihuduqqnxqahhbphs',
  gateway: 'edgar-data-gateway',
});

export function getDeploymentDataStoreMode(dataset, env = process.env) {
  return env.VERCEL_ENV === 'production' && ['cftc', 'sec', 'financial'].includes(dataset)
    ? DATA_STORE_DEPLOYMENT.stage : 'off';
}

export function isSecMigrationScheduleEnabled(env = process.env) {
  if (Object.hasOwn(env, 'EDGAR_DATASTORE_SEC_SCHEDULE')) return env.EDGAR_DATASTORE_SEC_SCHEDULE === '1';
  return env.VERCEL_ENV === 'production' && DATA_STORE_DEPLOYMENT.secSchedule;
}

export function isSecCoverageScheduleEnabled(env = process.env) {
  if (Object.hasOwn(env, 'EDGAR_DATASTORE_SEC_COVERAGE_SCHEDULE')) return env.EDGAR_DATASTORE_SEC_COVERAGE_SCHEDULE === '1';
  return env.VERCEL_ENV === 'production' && DATA_STORE_DEPLOYMENT.secCoverageSchedule;
}

export function isBroadSecCoverageEnabled(env = process.env) {
  if (Object.hasOwn(env, 'EDGAR_DATASTORE_BROAD_COVERAGE')) return env.EDGAR_DATASTORE_BROAD_COVERAGE === '1';
  return env.VERCEL_ENV === 'production' && DATA_STORE_DEPLOYMENT.broadCoverage;
}

// Bounded bootstrap and rollback verification are complete. Administrative
// operations continue to require the existing CRON_SECRET.
export const MIGRATION_BOOTSTRAP = null;
