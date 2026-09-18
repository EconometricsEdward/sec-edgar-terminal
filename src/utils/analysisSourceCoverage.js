export function analysisSourcesDegraded(data) {
  const coverage = data?.sourceCoverage;
  // A verified filing can legitimately add no supported concepts or balance
  // classifications. That is a disclosed coverage limit, not a failed fetch:
  // repeated retries would never make the same source support another metric.
  return coverage?.filingFallback?.status === 'unavailable'
    || coverage?.continuity?.status === 'partial';
}

/** Retried gaps must not restart a long CDN stale-while-revalidate window. */
export function analysisSourceCachePolicy(data) {
  return analysisSourcesDegraded(data)
    ? { ttlSeconds: 60, cacheControl: 'public, max-age=0, s-maxage=60, must-revalidate' }
    : { ttlSeconds: 300, cacheControl: 'public, s-maxage=300, stale-while-revalidate=300' };
}
