// Bounded memory only. Switching a lens reuses recent reads without creating
// localStorage histories or writes. No polling, focus revalidation or retries.
const cache = new Map(), pending = new Map();
const MAX_ENTRIES = 12;
export async function readRiskEvidence(url) {
  if (!/^\/api\/(?:risk\/context$|banks\?(?:q=|rssds=))/.test(url)) throw new Error('Unsupported risk evidence request.');
  const cached = cache.get(url);
  if (cached && cached.until > Date.now()) return cached.data;
  if (pending.has(url)) return pending.get(url);
  const task = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'This source could not be loaded.');
    const incomplete = data.jobs?.some(job => ['queued', 'running', 'retry'].includes(job.status))
      || url.includes('rssds=') && (!data.reports?.length || data.reports.some(report => !report.validation?.passed))
      || url === '/api/risk/context' && (!data.funding || !data.derivatives);
    cache.delete(url);
    cache.set(url, { data, until: Date.now() + (incomplete ? 3000 : 60000) });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return data;
  })().finally(() => pending.delete(url));
  pending.set(url, task);
  return task;
}
