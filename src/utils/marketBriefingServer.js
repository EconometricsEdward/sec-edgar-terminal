import { buildMarketBriefing, buildMarketDirectory, buildMarketIndustries, MARKET_BRIEFING_VERSION, MARKET_DIRECTORY_VERSION, MARKET_INDUSTRIES_VERSION } from './marketBriefing.js';
import { isMarketBriefing, isMarketDirectory, isMarketIndustries, isMarketSectorCompanies } from './marketResearchValidation.js';
import { buildMarketSectorCompanies, MARKET_SECTOR_COMPANY_VERSION } from './marketSectorCompanies.js';
import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, releaseDatasetWrite } from './dataStore.js';
import { preparedEnvelopeUsable } from './secDocumentStore.js';
import { MARKET_ATLAS_FRESH_MS } from './marketResearch.js';
import { MARKET_PERIOD_INTEGRITY_VERSION } from './marketPeriodIntegrity.js';

export const MARKET_BRIEFING_KEY = 'research-market-briefing-v1:latest';
export const MARKET_DIRECTORY_KEY = 'research-market-directory-v1:latest';
const RETENTION_MS = 7 * 86400000;
const cached = new Map(), pending = new Map();
const definitions = {
  briefing: { key: MARKET_BRIEFING_KEY, version: MARKET_BRIEFING_VERSION, valid: isMarketBriefing, build: buildMarketBriefing },
  directory: { key: MARKET_DIRECTORY_KEY, version: MARKET_DIRECTORY_VERSION, valid: isMarketDirectory, build: buildMarketDirectory },
  industries: { key: 'research-market-industries-v1:latest', version: MARKET_INDUSTRIES_VERSION, valid: isMarketIndustries, build: buildMarketIndustries },
  sectorCompanies: { key: 'research-market-sector-companies-v1:latest', version: MARKET_SECTOR_COMPANY_VERSION, valid: isMarketSectorCompanies, build: buildMarketSectorCompanies },
};

function retained(payload, valid, now = Date.now()) {
  const age = now - Date.parse(payload?.generatedAt);
  if (!valid(payload) || !Number.isFinite(age) || age < 0 || age >= RETENTION_MS) return null;
  // Old aggregates have already lost individual filing dates. Reproject them
  // from the prepared overview, without refetching company data from the SEC.
  if (valid !== isMarketDirectory && payload.periodIntegrityVersion !== MARKET_PERIOD_INTEGRITY_VERSION) return null;
  return age > MARKET_ATLAS_FRESH_MS ? { ...payload, cache: { ...payload.cache, status: 'stale', warning: 'The scheduled refresh is pending. Source dates belong to the last completed snapshot.' } } : payload;
}

/** Recomputed by the scheduler, never by a visitor's financial-data request. */
export async function publishMarketServingViews(overview, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  publish = publishDataset, release = releaseDatasetWrite,
} = {}) {
  for (const [kind, definition] of Object.entries(definitions)) {
    let value = definition.build(overview);
    if (!definition.valid(value)) throw new Error(`Prepared Market ${kind} failed validation.`);
    if (mode !== 'off') {
      const claim = await begin('financial', definition.key, { leaseSeconds: 120 });
      if (!claim) throw new Error(`Market ${kind} publication is already running.`);
      try {
        const previous = await read('financial', definition.key, { allowStale: true });
        if (retained(previous?.payload, definition.valid) && previous.payload.generatedAt >= value.generatedAt) {
          value = previous.payload;
          await release('financial', definition.key, claim);
        } else {
          const fetchedAt = overview.companies.map(company => company.factsRetrievedAt || company.observedAt).filter(Boolean).sort()[0] || overview.generatedAt;
          await publish({ dataset: 'financial', key: definition.key, claim, payload: value,
            metadata: { sourceId: 'sec-edgar', sourceUrl: 'https://data.sec.gov/submissions/',
              fetchedAt, revalidatedAt: overview.generatedAt,
              expiresAt: new Date(Date.parse(overview.generatedAt) + 25 * 3600000).toISOString(),
              parserVersion: definition.version, calculationVersion: overview.version,
              view: definition.version, coverage: overview.companies.length },
            identityInputs: { version: definition.version, generatedAt: overview.generatedAt,
              periodIntegrityVersion: value.periodIntegrityVersion || null,
              membership: overview.coverage?.membership_id || null } });
        }
      } catch (error) { await release('financial', definition.key, claim); throw error; }
    }
    cached.set(kind, { value, until: Date.now() + 60000 });
  }
}

/** Small, shared projections. Fallback is over prepared data only, never SEC fan-out. */
export async function readMarketServingView(kind, {
  mode = getDataStoreMode('financial'), read = readDataset,
  fallback = async () => (await import('./marketOverviewServer.js')).readMarketOverview(),
} = {}) {
  const definition = definitions[kind];
  if (!definition) throw new Error('Unknown Market projection.');
  const hit = cached.get(kind);
  if (hit && hit.until > Date.now()) return retained(hit.value, definition.valid);
  if (pending.has(kind)) return pending.get(kind);
  const task = (async () => {
    let value = null;
    if (mode === 'supabase') {
      try {
        const envelope = await read('financial', definition.key, { allowStale: true });
        if (preparedEnvelopeUsable(envelope)) value = retained(envelope.payload, definition.valid);
      } catch { /* A prior prepared overview remains available during migration. */ }
    }
    if (!value) value = retained(definition.build(await fallback()), definition.valid);
    if (!value) throw Object.assign(new Error('The prepared Market snapshot is unavailable. Please retry shortly.'), { status: 503 });
    cached.set(kind, { value, until: Date.now() + 60000 });
    return value;
  })();
  pending.set(kind, task);
  try { return await task; } finally { pending.delete(kind); }
}

export const readMarketBriefing = () => readMarketServingView('briefing');
export const readMarketDirectory = () => readMarketServingView('directory');
