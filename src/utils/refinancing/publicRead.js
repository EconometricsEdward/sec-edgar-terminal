import { unstable_cache } from 'next/cache.js';
import { readRefinancingWall, encodeRefinancingCache, decodeRefinancingCache, REFINANCING_CACHE_TAG } from './server.js';
import { REFINANCING_WALL_VERSION } from './projection.js';

const unavailable = () => Object.assign(new Error('The prepared refinancing snapshot is temporarily unavailable.'), { status: 503 });

/** One shared key, independent of search/filter selections. A cold failure is
 * coalesced and cooled down; only validated successful snapshots enter Next's
 * cache. The decoder enforces hard retention even when stale revalidation fails.
 */
export function createCachedRefinancingRead({ read = readRefinancingWall, cache = unstable_cache,
  env = process.env, now = Date.now } = {}) {
  let sourcePending = null, readPending = null, retryAt = 0, recent = null;
  const produce = async () => {
    if (recent && recent.until > now()) {
      try { decodeRefinancingCache(recent.entry, now()); return recent.entry; }
      catch { recent = null; }
    }
    if (sourcePending) return sourcePending;
    if (retryAt > now()) throw unavailable();
    sourcePending = (async () => {
      const value = await read();
      const entry = encodeRefinancingCache(value);
      decodeRefinancingCache(entry, now());
      // A shared-cache outage must not send every visitor back to Supabase.
      recent = { entry, until: now() + 900000 };
      return entry;
    })().catch(() => { retryAt = now() + 10000; throw unavailable(); })
      .finally(() => { sourcePending = null; });
    return sourcePending;
  };
  const shared = cache(produce, [REFINANCING_WALL_VERSION, 'public-read-v1', env.VERCEL_ENV || 'local'],
    { revalidate: 900, tags: [REFINANCING_CACHE_TAG] });
  return async () => {
    if (typeof window !== 'undefined') throw unavailable();
    if (readPending) return readPending;
    readPending = (async () => {
      // Development and previews never share a production cache namespace.
      let entry;
      try { entry = env.VERCEL_ENV === 'production' ? await shared() : await produce(); }
      catch { entry = await produce(); } // Single-flight/cooldown prevents a second failed read.
      try { return decodeRefinancingCache(entry, now()); }
      catch { return decodeRefinancingCache(await produce(), now()); }
    })().finally(() => { readPending = null; });
    return readPending;
  };
}

export const readCachedRefinancingWall = createCachedRefinancingRead();
