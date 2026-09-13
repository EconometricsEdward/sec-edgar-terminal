/** Reviewed deployment defaults. Explicit environment flags always override these. */
export const DATA_STORE_DEPLOYMENT = Object.freeze({
  stage: 'supabase',
  secSchedule: true,
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

// Temporary, high-entropy operator credential: only its SHA256 is tracked.
// Remove after the bounded live bootstrap. This never grants access to previews.
export const MIGRATION_BOOTSTRAP = Object.freeze({
  sha256: 'cee35c4d61e0731c2a10f9ab3436f121806bd38557896418a3c46955059723c5',
  expiresAt: '2026-09-13T09:09:42.765528Z',
});
