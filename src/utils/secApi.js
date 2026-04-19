/**
 * Returns the correct URL for SEC API calls based on whether we're in dev or production.
 *
 * In dev: SEC is called via the /api/sec proxy route (Next.js serverless function).
 * In prod: same /api/sec route, same serverless function.
 *
 * NOTE: Under Vite, this file used `import.meta.env.PROD` plus a Vite dev-server proxy
 * to `/sec-data/*` and `/sec-files/*`. Under Next.js we don't have that proxy — but we
 * also don't need it, because the /api/sec route works identically in both dev and prod.
 * So we always route through /api/sec now, regardless of environment.
 */

/** Build URL for data.sec.gov endpoints (submissions, companyfacts, etc.) */
export function secDataUrl(path) {
  // path should start with "/" — e.g. "/submissions/CIK0000320193.json"
  return `/api/sec?host=data&path=${encodeURIComponent(path)}`;
}

/** Build URL for www.sec.gov/files/* endpoints (company_tickers.json, etc.) */
export function secFilesUrl(filename) {
  // filename should NOT include leading slash — e.g. "company_tickers.json"
  return `/api/sec?host=www&path=${encodeURIComponent('/files/' + filename)}`;
}
