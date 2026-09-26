import funding from '../../data/market-research/funding.json' with { type: 'json' };
import derivatives from '../../data/market-research/derivatives.json' with { type: 'json' };
import { marketResearchStore } from './store.js';
import { validSnapshot } from './normalize.js';
import { fundingNotice } from './catalog.js';
const BOOTSTRAP = { funding, derivatives };
const cache = new Map(), pending = new Map();
export async function getMarketResearch(kind, { store = marketResearchStore, useCache = true } = {}) {
  if (!Object.hasOwn(BOOTSTRAP, kind)) throw new Error('Invalid market research kind');
  const cached = cache.get(kind);
  if (useCache && cached && Date.now() - cached.at < 60000) return cached.data;
  if (useCache && pending.has(kind)) return pending.get(kind);
  const work = (async () => {
    let data;
    try {
      const result = await store('read', { kind });
      if (!validSnapshot(result?.snapshot, kind)) throw new Error('No published snapshot');
      data = { ...result.snapshot, availability: result.refresh?.[kind] === 'retained' ? 'retained' : 'ready' };
    } catch { data = { ...(cached?.data || BOOTSTRAP[kind]), availability: 'retained' }; }
    if (kind === 'funding') data.notice = fundingNotice(data.generatedAt.slice(0, 4));
    if (useCache) cache.set(kind, { data, at: Date.now() });
    return data;
  })();
  if (useCache) pending.set(kind, work);
  try { return await work; } finally { if (useCache) pending.delete(kind); }
}
