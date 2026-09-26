import { getDataStoreIdentityToken } from '../dataStoreIdentity.js';
const ENDPOINT = 'https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/market-research-gateway';
export function createMarketResearchStore({ env = process.env, fetchImpl = fetch, identity = getDataStoreIdentityToken } = {}) {
  return async (operation, payload = {}) => {
    if (typeof window !== 'undefined' || env.VERCEL_ENV !== 'production') throw new Error('Research store requires production workload identity');
    const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${await identity()}`, 'Content-Type': 'application/json', 'x-region': 'us-east-1' },
      body: JSON.stringify({ operation, payload }), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Research store unavailable');
    return response.json();
  };
}
export const marketResearchStore = createMarketResearchStore();
