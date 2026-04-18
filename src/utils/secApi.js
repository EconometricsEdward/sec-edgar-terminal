/**
 * Returns the correct URL for SEC API calls based on whether we're in dev or production.
 *
 * In dev: /sec-files/... and /sec-data/... are handled by Vite's proxy (vite.config.js).
 * In prod (Vercel): /api/sec?host=...&path=... is handled by api/sec.js serverless function.
 */

const isProd = import.meta.env.PROD;

/** Build URL for data.sec.gov endpoints (submissions, companyfacts, etc.) */
export function secDataUrl(path) {
  // path should start with "/" — e.g. "/submissions/CIK0000320193.json"
  if (isProd) return `/api/sec?host=data&path=${encodeURIComponent(path)}`;
  return `/sec-data${path}`;
}

/** Build URL for www.sec.gov/files/* endpoints (company_tickers.json, etc.) */
export function secFilesUrl(filename) {
  // filename should NOT include leading slash — e.g. "company_tickers.json"
  if (isProd) return `/api/sec?host=www&path=${encodeURIComponent('/files/' + filename)}`;
  return `/sec-files/${filename}`;
}
