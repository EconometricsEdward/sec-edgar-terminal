/** Small, process-local cache for public API reads. Rate limits belong outside
 * this helper and still run for every request, including hits and joined reads.
 * Only caller-validated public results are retained; no errors or stale fallback.
 */
export function createBankApiReadCache({ now = Date.now, ttlMs = 30000,
  maxEntries = 64, maxBytes = 4 * 1024 * 1024, maxEntryBytes = 512 * 1024, maxInFlight = 16 } = {}) {
  const entries = new Map(), pending = new Map();
  let bytes = 0, inFlight = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  };
  return async (key, load, { refresh = false, reusable = () => false, lifetime = () => ttlMs } = {}) => {
    for (const [id, entry] of entries) if (entry.until <= now() || entry.checkedAt > now()) remove(id);
    const normalKey = JSON.stringify([key, false]), refreshKey = JSON.stringify([key, true]);
    // A refresh supersedes an ordinary in-flight read. Earlier subscribers may
    // finish, but their result cannot replace the explicitly refreshed entry.
    if (refresh) {
      remove(key);
      const ordinary = pending.get(normalKey);
      if (ordinary) ordinary.retain = false;
    }
    const refreshing = pending.get(refreshKey);
    if (refreshing) return structuredClone(await refreshing.promise);
    if (!refresh) {
      const hit = entries.get(key);
      if (hit) return { data: JSON.parse(hit.json), ageMs: now() - hit.checkedAt };
      const ordinary = pending.get(normalKey);
      if (ordinary?.retain) return structuredClone(await ordinary.promise);
    }
    if (inFlight >= maxInFlight) throw new Error('Several bank reads are in progress.');
    const pendingKey = refresh ? refreshKey : normalKey;
    const state = { retain: true, promise: null };
    inFlight++;
    state.promise = (async () => {
      const data = await load();
      const duration = Math.min(ttlMs, lifetime(data));
      if (state.retain && duration > 0 && reusable(data)) {
        const json = JSON.stringify(data), size = new TextEncoder().encode(json).byteLength;
        if (size <= maxEntryBytes && size <= maxBytes && maxEntries > 0) {
          remove(key);
          while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
          const checkedAt = now();
          entries.set(key, { json, bytes: size, checkedAt, until: checkedAt + duration });
          bytes += size;
        }
      }
      return { data, ageMs: 0 };
    })().finally(() => { inFlight--; if (pending.get(pendingKey) === state) pending.delete(pendingKey); });
    pending.set(pendingKey, state);
    return structuredClone(await state.promise);
  };
}

export function bankApiRefresh(request) {
  return ['no-cache', 'reload', 'no-store'].includes(request.cache)
    || /(?:^|,)\s*(?:no-cache|no-store|max-age\s*=\s*0)(?:\s*(?:,|$))/i.test(request.headers.get('cache-control') || '')
    || /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(request.headers.get('pragma') || '');
}
