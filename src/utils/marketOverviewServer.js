import { buildMarketOverview, MARKET_OVERVIEW_VERSION } from './marketOverview.js';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION } from './marketResearch.js';
import { isMarketAtlas, isMarketOverview } from './marketResearchValidation.js';
import { readSnapshot, writeSnapshot } from './snapshotCache.js';
import { warmGet } from './warmCache.js';
import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, releaseDatasetWrite } from './dataStore.js';
import { preparedEnvelopeUsable } from './secDocumentStore.js';
import { MARKET_DURABLE_KEY } from './preparedResearchStore.js';
import { publishMarketServingViews } from './marketBriefingServer.js';
import { sanitizeMarketOverviewPeriods } from './marketPeriodIntegrity.js';

const RETENTION = 7 * 86400;
let memory = null, pending = null;
function retained(value) {
  const age = Date.now() - Date.parse(value?.generatedAt);
  if (!isMarketOverview(value) || !Number.isFinite(age) || age < 0 || age >= RETENTION * 1000) return null;
  value = sanitizeMarketOverviewPeriods(value);
  return age > MARKET_ATLAS_FRESH_MS ? { ...value, cache: { status: 'stale', warning: 'The scheduled refresh is pending. Coverage and source dates belong to the last completed snapshot.' } } : value;
}

/** One shared screening payload, independent of the number of people opening Market. */
export async function readDurableMarketOverview({ mode = getDataStoreMode('financial'), read = readDataset } = {}) {
  if (mode !== 'supabase') return null;
  const envelope = await read('financial', MARKET_DURABLE_KEY, { allowStale: true });
  if (!preparedEnvelopeUsable(envelope)) return null;
  const value = retained(envelope.payload);
  return value ? { ...value, cache: { ...value.cache, source: 'supabase-prepared',
    checkedAt: envelope.metadata.revalidatedAt } } : null;
}

export async function publishDurableMarketOverview(value, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  publish = publishDataset, release = releaseDatasetWrite,
} = {}) {
  if (mode === 'off') return value;
  if (!isMarketOverview(value)) throw new Error('Durable Market overview failed validation.');
  value = sanitizeMarketOverviewPeriods(value);
  const claim = await begin('financial', MARKET_DURABLE_KEY, { leaseSeconds: 120 });
  if (!claim) throw new Error('A scheduled Market publication is already running.');
  try {
    const previous = await read('financial', MARKET_DURABLE_KEY, { allowStale: true });
    // A delayed scheduler may bring an older atlas. It must not replace a newer one.
    if (retained(previous?.payload) && previous.payload.generatedAt >= value.generatedAt) {
      await release('financial', MARKET_DURABLE_KEY, claim);
      return retained(previous.payload);
    }
    const sourceDates = value.companies.map((company) => company.factsRetrievedAt || company.observedAt).filter(Boolean).sort();
    const fetchedAt = sourceDates[0] || value.generatedAt;
    const metadata = { sourceId: 'sec-edgar', sourceUrl: 'https://data.sec.gov/submissions/',
      fetchedAt, revalidatedAt: value.generatedAt,
      expiresAt: new Date(Date.parse(value.generatedAt) + 25 * 3600000).toISOString(),
      parserVersion: MARKET_OVERVIEW_VERSION, calculationVersion: MARKET_VERSION,
      view: 'market-overview', coverage: value.companies.length };
    await publish({ dataset: 'financial', key: MARKET_DURABLE_KEY, claim, payload: value, metadata,
      identityInputs: { version: MARKET_OVERVIEW_VERSION, generatedAt: value.generatedAt,
        membership: value.coverage?.membership_id || null } });
    return value;
  } catch (error) {
    await release('financial', MARKET_DURABLE_KEY, claim);
    throw error;
  }
}

/** Called by the existing scheduled Quant publisher, never by a page request. */
export async function publishMarketOverview(atlas, membership, options = {}) {
  const previous = await readSnapshot(MARKET_OVERVIEW_VERSION, 'atlas');
  const next = previous?.generatedAt === atlas.generatedAt && retained(previous)
    ? retained(previous) : buildMarketOverview(atlas, { membership, previous, persistHistory: true });
  if (!isMarketOverview(next)) throw new Error('Market overview failed validation.');
  const published = await publishDurableMarketOverview(next, options.durable || {});
  if (!await writeSnapshot(MARKET_OVERVIEW_VERSION, 'atlas', published, RETENTION, options)) throw new Error('Market overview publication failed.');
  await publishMarketServingViews(published, options.durable || {});
  memory = { value: published, until: Date.now() + 60000 };
  return published;
}

/** Cache-only public read. Recovery projects cached SEC data without fetching it. */
export async function readMarketOverview() {
  if (memory && Date.now() < memory.until) return memory.value;
  if (pending) return pending;
  pending = (async () => {
    let value = retained(await readSnapshot(MARKET_OVERVIEW_VERSION, 'atlas'));
    if (!value) {
      try { value = await readDurableMarketOverview(); }
      catch { /* Continue with the independently validated prior Quant snapshot. */ }
    }
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
