export function analysisSourcesDegraded(data) {
  const coverage = data?.sourceCoverage;
  return ['unavailable', 'no-supported-facts'].includes(coverage?.filingFallback?.status)
    || coverage?.continuity?.status === 'partial';
}

/** Retried gaps must not restart a long CDN stale-while-revalidate window. */
export function analysisSourceCachePolicy(data) {
  return analysisSourcesDegraded(data)
    ? { ttlSeconds: 60, cacheControl: 'public, max-age=0, s-maxage=60, must-revalidate' }
    : { ttlSeconds: 300, cacheControl: 'public, s-maxage=300, stale-while-revalidate=300' };
}
