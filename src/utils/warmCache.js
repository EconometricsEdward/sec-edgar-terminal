/**
 * Warm cache — shared key/value storage in Vercel KV (Upstash under the hood).
 *
 * This is what the pre-warmer writes to, and what the API routes read from
 * when the CDN cache misses. The layering is:
 *
 *   Request -> Vercel edge CDN (60s-24h) -> API route -> warm cache (Vercel KV)
 *                                                    -> allowlisted public sources
 *
 * The CDN is the fastest layer and handles the bulk of repeated traffic. The
 * warm cache catches cold-CDN requests after edge expiry and retains prepared
 * datasets without forcing every reader back to a public upstream source.
 *
 * Keys are namespaced: `warm:<type>:<ticker>` so multiple data types for the
 * same ticker don't collide.
 *
 * Vercel KV env vars — Vercel KV is Upstash Redis with Vercel-branded env var
 * names. We support both naming schemes so this code works whether you:
 *   - Use Vercel KV (which injects KV_REST_API_URL / KV_REST_API_TOKEN)
 *   - Use direct Upstash (which uses UPSTASH_REDIS_REST_URL / _TOKEN)
 *
 * If neither is set, reads return null and writes are swallowed — API routes
 * keep working, we just lose the warm layer.
 */

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ENABLED = !!(REST_URL && REST_TOKEN);

function key(type, id) {
  return `warm:${type}:${String(id).toUpperCase()}`;
}

/**
 * Read a value from the warm cache. Returns parsed JSON or null on miss/error.
 */
export async function warmGet(type, id) {
  if (!ENABLED) return null;
  try {
    const res = await fetch(`${REST_URL}/get/${encodeURIComponent(key(type, id))}`, {
      headers: { Authorization: `Bearer ${REST_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.result;
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // If it doesn't parse, it's corrupt — treat as miss.
      return null;
    }
  } catch (err) {
    // Fail-open: cache miss on any error. API route will fall through to upstream.
    console.warn(`[warmCache] read failed for ${type}/${id}: ${err.message}`);
    return null;
  }
}

/** Bounded multi-key reads for scheduled coverage work; order matches ids. */
export async function warmGetMany(type, ids, { signal, deadline = Date.now() + 30000 } = {}) {
  if (!ENABLED) return ids.map(() => null);
  const output = new Array(ids.length), batches = [];
  for (let offset = 0; offset < ids.length; offset += 25) batches.push({ offset, ids: ids.slice(offset, offset + 25) });
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (batches.length) {
      if (requestSignal.aborted || Date.now() >= deadline) throw new Error('Cache batch deadline reached.');
      const batch = batches.shift();
      const response = await fetch(REST_URL, {
        method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['MGET', ...batch.ids.map(id => key(type, id))]),
        signal: AbortSignal.any([requestSignal, AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))]),
      });
      const data = response.ok ? await response.json() : null;
      if (!Array.isArray(data?.result) || data.result.length !== batch.ids.length) throw new Error(`Incomplete cache batch: ${String(data?.error||response.status).slice(0,200)}`);
      data.result.forEach((value, index) => { try { output[batch.offset + index] = value === null ? null : JSON.parse(value); } catch { throw new Error('Corrupt cache checkpoint.'); } });
    }
  });
  try { await Promise.all(workers); return output; }
  catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
}

/**
 * Write a value to the warm cache with a TTL.
 *
 * Default TTL is 25 hours — slightly longer than the daily cron interval so
 * there's always overlap: the new cron run writes fresh values before the
 * old ones expire, avoiding "dead windows" where readers would see misses.
 *
 * When the project upgrades to Pro + 6-hour crons, callers can override
 * this to a shorter TTL if desired, but 25h still works fine — the values
 * just get refreshed more often than they expire.
 */
export async function warmSet(type, id, value, ttlSeconds = 25 * 3600) {
  if (!ENABLED) return false;
  try {
    const body = JSON.stringify(value);
    // Size sanity check — KV REST has a ~1MB per-value limit. Anything big
    // is probably a bug (or needs a different caching strategy). Skip
    // rather than fail the whole pre-warm run.
    if (new TextEncoder().encode(body).byteLength > 900_000) {
      console.warn(
        `[warmCache] skipping ${type}/${id}: payload ${body.length} bytes exceeds 900KB limit`
      );
      return false;
    }

    const url = `${REST_URL}/set/${encodeURIComponent(key(type, id))}?EX=${ttlSeconds}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const result = await res.json().catch(() => null);
    if (!res.ok || result?.result !== 'OK') {
      console.warn(`[warmCache] write rejected for ${type}: HTTP ${res.status}; ${String(result?.error || 'no write acknowledgement').slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[warmCache] write failed for ${type}/${id}: ${err.message}`);
    return false;
  }
}

/** Return the remaining TTL for a coordination marker, or null on miss/error. */
export async function warmCooldownRemaining(type, id) {
  if (!ENABLED) return null;
  try {
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['PTTL', key(type, id)]]),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ttl = Number(data?.[0]?.result);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  } catch {
    return null;
  }
}

/** Atomically extend (never shorten) a distributed cooldown marker. */
export async function warmExtendCooldown(type, id, ttlMs) {
  if (!ENABLED || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  try {
    const script = `
      local current = redis.call('PTTL', KEYS[1])
      local candidate = tonumber(ARGV[1])
      if candidate > current then
        redis.call('SET', KEYS[1], '1', 'PX', candidate)
        return candidate
      end
      return current
    `;
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([['EVAL', script, 1, key(type, id), Math.ceil(ttlMs)]]),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Number(data?.[0]?.result) > 0;
  } catch {
    return false;
  }
}

/**
 * Acquire a short distributed lease. A null result means either another
 * worker owns the lease or the shared store is unavailable; callers should
 * serve stale data or stop rather than duplicate expensive upstream work.
 */
export async function warmAcquireLease(type, id, ttlMs = 60_000) {
  if (!ENABLED) return null;
  const token = crypto.randomUUID();
  try {
    // Use the command-array form so NX/PX are unambiguously Redis command
    // arguments rather than REST query-string flags.
    const res = await fetch(REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        'SET',
        key(`lease:${type}`, id),
        token,
        'NX',
        'PX',
        Math.max(1000, Math.ceil(ttlMs)),
      ]),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => null);
      console.warn(`[warmCache] coordination unavailable: HTTP ${res.status}; ${String(error?.error || 'request rejected').slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    if (data?.error) console.warn(`[warmCache] coordination unavailable: ${String(data.error).slice(0, 200)}`);
    return data?.result === 'OK' ? token : null;
  } catch (err) {
    console.warn(`[warmCache] lease acquisition failed for ${type}/${id}: ${err.message}`);
    return null;
  }
}

/** Release only the lease owned by this token. */
export async function warmReleaseLease(type, id, token) {
  if (!ENABLED || !token) return false;
  try {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    const res = await fetch(`${REST_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['EVAL', script, 1, key(`lease:${type}`, id), token],
      ]),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Number(data?.[0]?.result || 0) === 1;
  } catch (err) {
    console.warn(`[warmCache] lease release failed for ${type}/${id}: ${err.message}`);
    return false;
  }
}

/**
 * Check if warm cache is wired up — useful for health checks / debug endpoints.
 */
export function warmCacheEnabled() {
  return ENABLED;
}

/**
 * Read a bounded page of members from an audited raw Redis set. This is kept
 * separate from the `warm:*` helpers because a small number of operational
 * sets predate the namespaced cache. Callers must provide a fixed internal key;
 * request input must never reach this helper.
 */
export async function warmReadRawSetMembers(rawKey, maxMembers = 100) {
  if (!ENABLED) return [];
  if (typeof rawKey !== 'string' || !/^[a-z0-9:_-]{3,120}$/i.test(rawKey) || !Number.isSafeInteger(maxMembers) || maxMembers < 1 || maxMembers > 250) return null;
  try {
    let cursor = '0';
    const members = new Set();
    for (let page = 0; page < 8 && members.size < maxMembers; page += 1) {
      const response = await fetch(REST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SSCAN', rawKey, cursor, 'COUNT', String(Math.min(100, maxMembers))]),
        signal: AbortSignal.timeout(3000),
      });
      const data = await response.json();
      const nextCursor = String(data?.result?.[0] ?? ''), values = data?.result?.[1];
      if (!response.ok || !/^\d+$/.test(nextCursor) || !Array.isArray(values) || values.some(value => typeof value !== 'string')) return null;
      values.slice(0, maxMembers - members.size).forEach(value => members.add(value));
      cursor = nextCursor;
      if (cursor === '0') break;
    }
    return [...members];
  } catch {
    return null;
  }
}

/** Remove only explicitly named reproducible cache values, in bounded batches. */
export async function warmDeleteMany(type, ids) {
  if (!ENABLED) return null;
  let removed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const response = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['DEL', ...ids.slice(i, i + 100).map(id => key(type, id))]), signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok || !Number.isSafeInteger(data?.result)) {
        console.warn(`[warmCache] cache cleanup rejected: HTTP ${response.status}; ${String(data?.error || 'no acknowledgement').slice(0, 200)}`);
        return null;
      }
      removed += data.result;
    } catch { return null; }
  }
  return removed;
}

/**
 * Delete a bounded page of keys whose cache type starts with an audited prefix.
 * This low-level helper is for versioned migrations; public callers must never
 * supply the prefix or cursor.
 */
export async function warmDeleteTypePrefix(typePrefix, cursor = '0', maxKeys = 500) {
  if (!ENABLED) return null;
  if (typeof typePrefix !== 'string' || !/^[a-z0-9.:_-]{3,80}$/i.test(typePrefix) || !/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 2500) return null;
  try {
    const response = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SCAN', String(cursor), 'MATCH', `warm:${typePrefix}:*`, 'COUNT', String(maxKeys)]), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const nextCursor = String(data?.result?.[0] ?? ''), found = data?.result?.[1];
    const keys = Array.isArray(found) ? found.slice(0, maxKeys) : found;
    if (!response.ok || !/^\d+$/.test(nextCursor) || !Array.isArray(keys) || keys.some(item => typeof item !== 'string' || !item.startsWith(`warm:${typePrefix}:`))) return null;
    let removed = 0;
    for (let offset = 0; offset < keys.length; offset += 100) {
      const deletion = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['DEL', ...keys.slice(offset, offset + 100)]), signal: AbortSignal.timeout(5000) });
      const result = await deletion.json();
      if (!deletion.ok || !Number.isSafeInteger(result?.result)) return null;
      removed += result.result;
    }
    const overflow = Array.isArray(found) && found.length > keys.length;
    return { cursor: overflow ? '0' : nextCursor, matched: keys.length, removed, complete: !overflow && nextCursor === '0' };
  } catch { return null; }
}

/** Delete exact raw Redis keys selected by an internal migration. */
export async function warmDeleteRawMany(rawKeys) {
  if (!ENABLED) return null;
  if (!Array.isArray(rawKeys) || !rawKeys.length || rawKeys.length > 100 || rawKeys.some(item => typeof item !== 'string' || !/^[a-z0-9:_-]{3,120}$/i.test(item))) return null;
  try {
    const response = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['DEL', ...rawKeys]), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    return response.ok && Number.isSafeInteger(data?.result) ? data.result : null;
  } catch { return null; }
}

/** Delete one bounded page of raw analytics keys from an audited migration. */
export async function warmDeleteRawPrefix(rawPrefix, cursor = '0', maxKeys = 500) {
  if (!ENABLED) return null;
  if (typeof rawPrefix !== 'string' || !/^[a-z0-9:_-]{3,80}$/i.test(rawPrefix) || !/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 2500) return null;
  try {
    const response = await fetch(REST_URL, { method: 'POST', headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(['SCAN', String(cursor), 'MATCH', `${rawPrefix}*`, 'COUNT', String(maxKeys)]), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const nextCursor = String(data?.result?.[0] ?? ''), found = data?.result?.[1];
    const keys = Array.isArray(found) ? found.slice(0, maxKeys) : found;
    if (!response.ok || !/^\d+$/.test(nextCursor) || !Array.isArray(keys) || keys.some(item => typeof item !== 'string' || !item.startsWith(rawPrefix))) return null;
    let removed = 0;
    for (let offset = 0; offset < keys.length; offset += 100) {
      const batchRemoved = await warmDeleteRawMany(keys.slice(offset, offset + 100));
      if (batchRemoved == null) return null;
      removed += batchRemoved;
    }
    const overflow = Array.isArray(found) && found.length > keys.length;
    return { cursor: overflow ? '0' : nextCursor, matched: keys.length, removed, complete: !overflow && nextCursor === '0' };
  } catch { return null; }
}
