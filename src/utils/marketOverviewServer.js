import { buildMarketOverview, MARKET_OVERVIEW_VERSION } from './marketOverview.js';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION } from './marketResearch.js';
import { isMarketAtlas, isMarketOverview } from './marketResearchValidation.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { warmGet } from './warmCache.js';

const RETENTION = 7 * 86400;
let memory = null, pending = null;
function retained(value) {
  const age = Date.now() - Date.parse(value?.generatedAt);
  if (!isMarketOverview(value) || !Number.isFinite(age) || age < 0 || age >= RETENTION * 1000) return null;
  return age > MARKET_ATLAS_FRESH_MS ? { ...value, cache: { status: 'stale', warning: 'The scheduled refresh is pending. Coverage and source dates belong to the last completed snapshot.' } } : value;
}

/** Called by the existing scheduled Quant publisher, never by a page request. */
export async function publishMarketOverview(atlas, membership, options = {}) {
  const previous = await readSnapshot(MARKET_OVERVIEW_VERSION, 'atlas');
  if (previous?.generatedAt === atlas.generatedAt && retained(previous)) return previous;
  const next = buildMarketOverview(atlas, { membership, previous, persistHistory: true });
  if (!isMarketOverview(next)) throw new Error('Market overview failed validation.');
  if (!await writeSnapshot(MARKET_OVERVIEW_VERSION, 'atlas', next, RETENTION, options)) throw new Error('Market overview publication failed.');
  memory = { value: next, until: Date.now() + 60000 };
  return next;
}

/** Cache-only public read. Recovery projects cached SEC data without fetching it. */
export async function readMarketOverview() {
  if (memory && Date.now() < memory.until) return memory.value;
  if (pending) return pending;
  pending = (async () => {
    let value = retained(await readSnapshot(MARKET_OVERVIEW_VERSION, 'atlas'));
    if (!value) {
      const { readQuantAtlas, readQuantMembership, membershipId } = await import('./quantCoverageServer.js');
      const expanded = await readQuantAtlas();
      if (expanded) {
        const membership = await readQuantMembership();
        value = retained(buildMarketOverview(expanded, { membership: membershipId(membership) === expanded.coverage.membership_id ? membership : null }));
      } else {
        const candidates = await Promise.all(['atlas', 'atlas-last-good'].map(id => warmGet(MARKET_VERSION, id)));
        const atlas = candidates.find(candidate => isMarketAtlas(candidate, MARKET_VERSION)
          && Date.now() - Date.parse(candidate.generatedAt) >= 0 && Date.now() - Date.parse(candidate.generatedAt) < RETENTION * 1000);
        if (atlas) value = retained(buildMarketOverview(atlas));
      }
    }
    if (!value) throw Object.assign(new Error('The prepared Market snapshot is unavailable. Please retry shortly.'), { status: 503 });
    memory = { value, until: Date.now() + 60000 };
    return value;
  })();
  try { return await pending; } finally { pending = null; }
}
