import { unstable_cache } from 'next/cache.js';
import { marketResearchStore } from './store.js';
import { validSnapshot } from './normalize.js';

const FRESH_MS = 15 * 60000;
const MAX_STALE_MS = 6 * 3600000;
const MAX_BYTES = 1800000;

/** Share only validated public snapshots, never the workload credential. Throw
 * failures through the cache so Next preserves the last good publication. */
export function createMarketResearchPublicRead({ store = marketResearchStore, cache = unstable_cache,
  env = process.env, now = Date.now } = {}) {
  const load = async kind => {
    const result = await store('read', { kind });
    if (!validSnapshot(result?.snapshot, kind) || Buffer.byteLength(JSON.stringify(result.snapshot)) > MAX_BYTES)
      throw new Error('Invalid prepared market research.');
    return { snapshot: result.snapshot, retained: result.refresh?.[kind] === 'retained', checkedAt: now() };
  };
  const shared = cache(load, ['market-research-public-v1', env.VERCEL_ENV || 'local'], { revalidate: FRESH_MS / 1000 });
  return async kind => {
    if (!['funding', 'derivatives'].includes(kind)) throw new Error('Invalid market research kind.');
    if (env.VERCEL_ENV !== 'production') return store('read', { kind });
    let result = await shared(kind);
    const valid = value => value && validSnapshot(value.snapshot, kind) && Number.isFinite(value.checkedAt)
      && now() >= value.checkedAt && now() - value.checkedAt <= MAX_STALE_MS
      && Buffer.byteLength(JSON.stringify(value.snapshot)) <= MAX_BYTES;
    // SWR cannot silently preserve a failed publication forever.
    if (!valid(result)) result = await load(kind);
    return { snapshot: result.snapshot, refresh: { [kind]: result.retained || now() - result.checkedAt >= FRESH_MS ? 'retained' : 'ready' } };
  };
}
export const readPublicMarketResearch = createMarketResearchPublicRead();
