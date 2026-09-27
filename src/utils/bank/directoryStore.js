import { unstable_cache } from 'next/cache.js';
import { bankScopeStore, isBankScopeEnvironment } from './scopeStore.js';
import { BankDataError } from './errors.js';
import { isBankDirectory } from './directory.js';

// Only public directory metadata is shared. Credentials and bank financials never
// enter this cache. A failed refresh preserves the last successful snapshot.
export function createCachedBankDirectory({ store = bankScopeStore, cache = unstable_cache, env = process.env, now = Date.now } = {}) {
  const load = async () => {
    const directory = await store('search', { query: '' });
    if (!isBankDirectory(directory)) throw new BankDataError('database_failure');
    return { ...directory, cachedAt: new Date(now()).toISOString() };
  };
  const cached = cache(load, ['bankscope-directory-v1', env.VERCEL_ENV || 'local'], { revalidate: 300 });
  return async () => {
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) throw new BankDataError('bank_service_unavailable');
    if (env.VERCEL_ENV !== 'production') return load();
    let directory = await cached();
    const age = now() - Date.parse(directory.cachedAt);
    // Bound stale service even when repeated background revalidation fails.
    if (!Number.isFinite(age) || age < 0 || age > 6 * 60 * 60 * 1000) directory = await load();
    return { ...directory, stale: now() - Date.parse(directory.cachedAt) > 10 * 60 * 1000 };
  };
}

export const getBankDirectory = createCachedBankDirectory();
