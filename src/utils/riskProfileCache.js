/** Temporary upstream gaps should recover quickly at both cache layers. A
 * cached partial profile must not restart a long stale-while-revalidate window.
 */
export function riskProfileCachePolicy(data) {
  const coverage = data?.sourceCoverage;
  const degraded = coverage?.filingFallback?.status === 'unavailable' || coverage?.continuity?.status === 'partial';
  return degraded
    ? { ttlSeconds: 60, cacheControl: 'public, max-age=0, s-maxage=60, must-revalidate' }
    : { ttlSeconds: 900, cacheControl: 'public, s-maxage=900, stale-while-revalidate=900' };
}
