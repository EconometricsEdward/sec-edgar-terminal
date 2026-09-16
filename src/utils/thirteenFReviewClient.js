const snapshots = new Map();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 24;
const RETAIN_MS = 30 * 60 * 1000;
const periodPattern = /^\d{4}-(03-31|06-30|09-30|12-31)$/;
const cacheKey = (cik, period) => `${cik}:${period || 'latest'}`;

export function valid13FReviewSnapshot(value, cik, period = '') {
  return value?.job?.cik === cik && /^\d{10}$/.test(cik || '') && periodPattern.test(value.job.period || '')
    && (!period || value.job.period === period) && value.report?.cik === cik && value.report.period === value.job.period
    && /^[a-fA-F0-9]{64}$/.test(value.job.reportHash || '') && Array.isArray(value.rows) && value.rows.length <= 50
    && Array.isArray(value.markets) && value.markets.length <= 100 && value.coverage && value.page
    && value.rows.every(row => row?.holding?.key && row.key === row.holding.key)
    && new Set(value.rows.map(row => row.key)).size === value.rows.length
    && Number.isInteger(value.job.total) && value.job.total >= 0 && value.job.total <= 20000;
}

/** This is a bounded return-visit cache, never an assertion of source freshness.
 * Every mounted viewer checks the publication again and keeps original dates. */
export function readCached13FReview(cik, period = '', now = Date.now()) {
  const key = cacheKey(cik, period), entry = snapshots.get(key);
  if (!entry) return null;
  if (entry.savedAt + RETAIN_MS <= now) { snapshots.delete(key); return null; }
  snapshots.delete(key); snapshots.set(key, entry);
  return entry.value;
}

export function cache13FReview(value, { cik = '', period = '', now = Date.now() } = {}) {
  if (!valid13FReviewSnapshot(value, cik, period)) return false;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_ENTRY_BYTES) return false;
  for (const [key, entry] of snapshots) if (entry.savedAt + RETAIN_MS <= now) snapshots.delete(key);
  const keys = [...new Set([cacheKey(cik, period), cacheKey(cik, value.job.period)])];
  for (const key of keys) {
    snapshots.delete(key);
    let total = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (snapshots.size && (snapshots.size >= MAX_ENTRIES || total + bytes > MAX_BYTES)) {
      const oldest = snapshots.keys().next().value;
      total -= snapshots.get(oldest).bytes; snapshots.delete(oldest);
    }
    snapshots.set(key, { value, bytes, savedAt: now });
  }
  return true;
}

export function clearCached13FReview() { snapshots.clear(); }
export function deleteCached13FReview(cik, period = '') { snapshots.delete(cacheKey(cik, period)); }
