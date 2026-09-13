/** Stable cache partition for deployed and local runtimes. */
export function cacheDeploymentScope(environment = process.env.VERCEL_ENV, commit = process.env.VERCEL_GIT_COMMIT_SHA) {
  if (environment === 'production') return 'production';
  if (environment === 'preview') return `preview-${String(commit || 'unknown').slice(0, 12)}`;
  return 'local';
}

export function isProductionDeployment(environment = process.env.VERCEL_ENV) {
  return environment === 'production';
}
