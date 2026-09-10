import { getOperatingTicker, getOperatingTickers } from './tickerMap.js';
import { warmAcquireLease, warmCacheEnabled, warmGet, warmReleaseLease, warmSet } from './warmCache.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { buildMarketCompany, marketAcceptanceTimes, marketCompanySummary } from './marketResearchData.js';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION, metricStats } from './marketResearch.js';
import { appendSnapshot } from './marketEvidence.js';
import { secFetch } from './secClient.js';
import { isMarketAtlas } from './marketResearchValidation.js';

const COMPANY_FRESH_MS = MARKET_ATLAS_FRESH_MS;
const MINIMUM_ATLAS_COVERAGE = 0.95;
const MARKET_REBUILD_LEASE = 'sec-market-rebuild';
const MARKET_REBUILD_LEASE_ID = 'global';
const pending = new Map();
const memory = new Map();
let atlas = null;
let atlasPending = null;
export const marketTickers = [...new Set(MARKET_LENSES.flatMap((c) => c.tickers))];

async function secJson(path, signal) {
  const response = await secFetch(`https://data.sec.gov${path}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: 15000,
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`SEC data request returned HTTP ${response.status}.`);
  return response.json();
}
export async function loadMarketCompany(ticker, knownEntry = null, { signal, forceRefresh = false } = {}) {
  const existing = memory.get(ticker);
  if (!forceRefresh && existing && Date.now() - Date.parse(existing.observedAt) < COMPANY_FRESH_MS) return existing;
  if (pending.has(ticker)) return pending.get(ticker);
  const task = (async () => {
    const cached = await warmGet(MARKET_VERSION, ticker);
    if (!forceRefresh && cached && Date.now() - Date.parse(cached.observedAt) < COMPANY_FRESH_MS) { memory.set(ticker, cached); return cached; }
    try {
      const entry = knownEntry || await getOperatingTicker(ticker);
      if (!entry) { const error = new Error('Ticker is absent from the current SEC operating-company map.'); error.name = 'UnresolvedTicker'; throw error; }
      const cik = String(entry.cik).padStart(10, '0');
      const [submissions, data] = await Promise.all([
        secJson(`/submissions/CIK${cik}.json`, signal), secJson(`/api/xbrl/companyfacts/CIK${cik}.json`, signal),
      ]);
      if (!data.facts || !submissions.sic) throw new Error('SEC financial facts or industry classification are unavailable.');
      const company = buildMarketCompany({ ticker, cik, name: submissions.name || entry.name, sic: submissions.sic, facts: data.facts,
        acceptanceTimes: marketAcceptanceTimes(submissions) },
        MARKET_LENSES.filter((c) => c.tickers.includes(ticker)).map((c) => c.id));
      memory.set(ticker, company);
      await warmSet(MARKET_VERSION, ticker, company, 7 * 86400);
      return company;
    } catch (error) {
      if (cached) {
        const stale = { ...cached, cache: { status: 'stale', warning: 'SEC refresh failed; using the last completed company snapshot.' } };
        memory.set(ticker, stale);
        return stale;
      }
      throw error;
    }
  })();
  pending.set(ticker, task);
  try { return await task; } finally { pending.delete(ticker); }
}

export async function loadMarketAtlas({ signal, forceRefresh = false } = {}) {
  if (!forceRefresh && atlas && Date.now() < atlas.expiresAt) return atlas.data;
  if (atlasPending) return atlasPending;
  atlasPending = (async () => {
    const [cachedValue, lastGoodValue] = await Promise.all([
      warmGet(MARKET_VERSION, 'atlas'),
      warmGet(MARKET_VERSION, 'atlas-last-good'),
    ]);
    const cached = isMarketAtlas(cachedValue, MARKET_VERSION) ? cachedValue : null;
    const lastGood = isMarketAtlas(lastGoodValue, MARKET_VERSION) ? lastGoodValue : null;
    const cachedAge = cached ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;
    if (!forceRefresh && cached && cachedAge >= 0 && cachedAge < ((cached.failures || []).some((f) => f.retryable) ? 300000 : MARKET_ATLAS_FRESH_MS)) {
      atlas = { data: cached, expiresAt: Date.now() + 60000 };
      return cached;
    }
    // Public callers never start a universe-wide SEC rebuild.
    if (!forceRefresh) {
      const fallback = lastGood || cached;
      if (fallback) return { ...fallback, cache: { status: 'stale', warning: 'Showing the last completed Market snapshot while its scheduled refresh is pending.' } };
      throw Object.assign(new Error('The scheduled Market snapshot is not available yet. Please retry later.'), { status: 503 });
    }
    const lease = await warmAcquireLease(MARKET_REBUILD_LEASE, MARKET_REBUILD_LEASE_ID, 6 * 60_000);
    if (warmCacheEnabled() && !lease) {
      const fallback = lastGood || cached;
      if (fallback) {
        const stale = {
          ...fallback,
          cache: {
            status: 'stale',
            warning: 'Another worker is refreshing Market data. Showing the last complete snapshot.',
          },
        };
        atlas = { data: stale, expiresAt: Date.now() + 60_000 };
        return stale;
      }
      throw Object.assign(new Error('A Market refresh is already in progress. Retry shortly.'), { status: 503 });
    }
    try {
    const directory = await getOperatingTickers(marketTickers);
    const priorCount = (lastGood || cached)?.companies?.length || 0;
    const minimumCompanies = Math.max(
      Math.ceil(marketTickers.length * MINIMUM_ATLAS_COVERAGE),
      Math.ceil(priorCount * MINIMUM_ATLAS_COVERAGE),
    );
    if (Object.keys(directory).length < minimumCompanies) {
      throw new Error(`The SEC ticker directory resolved only ${Object.keys(directory).length} of ${marketTickers.length} Market companies.`);
    }
    const companies = [], failures = [];
    // Bounded batches; upstream requests are spaced independently of cache reads.
    // Concurrent requests on this instance share this calculation and company loads.
    for (let i = 0; i < marketTickers.length; i += 3) {
      if (signal?.aborted) throw signal.reason || new Error('Market refresh was aborted.');
      const tickers = marketTickers.slice(i, i + 3);
      const results = await Promise.allSettled(
        tickers.map((ticker) => loadMarketCompany(ticker, directory[ticker], { signal, forceRefresh })),
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') companies.push(marketCompanySummary(result.value));
        else failures.push({ ticker: tickers[index], reason: result.reason?.message || 'Company data unavailable.', retryable: result.reason?.name !== 'UnresolvedTicker' });
      });
    }
    if (!companies.length) throw new Error('SEC company data is temporarily unavailable. Please retry.');
    if (companies.length < minimumCompanies) {
      throw new Error(`Only ${companies.length} of ${marketTickers.length} Market companies loaded; the last complete snapshot was retained.`);
    }
    const staleCompanies = companies.filter((company) => company.cache?.status === 'stale');
    const retryableFailures = failures.filter((failure) => failure.retryable);
    const fallback = lastGood || cached;
    if ((staleCompanies.length || retryableFailures.length) && fallback) {
      const stale = {
        ...fallback,
        cache: {
          status: 'stale',
          warning: `The latest refresh was incomplete (${staleCompanies.length} stale compan${staleCompanies.length === 1 ? 'y' : 'ies'}, ${retryableFailures.length} unavailable). Showing the last complete Market snapshot.`,
        },
      };
      atlas = { data: stale, expiresAt: Date.now() + 5 * 60_000 };
      return stale;
    }
    const generatedAt = new Date().toISOString();
    const cohorts = MARKET_LENSES.map((c) => ({ id: c.id, label: c.assetClass, title: c.title, description: c.description, tickers: c.tickers, disclosureTerms: c.disclosureTerms }));
    const data = { version: MARKET_VERSION, generatedAt, requested: marketTickers.length, companies: companies.sort((a, b) => a.ticker.localeCompare(b.ticker)), cohorts, failures };
    const previous = await warmGet(MARKET_VERSION, 'observations');
    const incomplete = staleCompanies.length > 0 || retryableFailures.length > 0;
    if (incomplete) {
      data.cache = {
        status: 'stale',
        warning: `This partial snapshot includes ${staleCompanies.length} stale compan${staleCompanies.length === 1 ? 'y' : 'ies'} and ${retryableFailures.length} unavailable refresh${retryableFailures.length === 1 ? '' : 'es'}.`,
      };
      data.observations = Array.isArray(previous) ? previous : [];
      data.historyPersistence = Array.isArray(previous);
    } else {
      data.observations = appendSnapshot(previous, {
        observedAt: generatedAt, companies: companies.length, tickers: companies.map((c) => c.ticker).sort(),
        revenueGrowth: metricStats(companies, 'ttm', 'revenueGrowth'), netMargin: metricStats(companies, 'ttm', 'netMargin'),
      });
      data.historyPersistence = await warmSet(MARKET_VERSION, 'observations', data.observations, 90 * 86400);
    }
    const duration = incomplete ? 300 : MARKET_ATLAS_FRESH_MS / 1000;
    if (incomplete) {
      const stored = await warmSet(MARKET_VERSION, 'atlas', data, 300);
      if (warmCacheEnabled() && !stored) throw new Error('The compact Market snapshot could not be persisted safely.');
    } else {
      const stored = await Promise.all([
        warmSet(MARKET_VERSION, 'atlas', data, 7 * 86400),
        warmSet(MARKET_VERSION, 'atlas-last-good', data, 7 * 86400),
      ]);
      if (warmCacheEnabled() && stored.some((value) => !value)) {
        throw new Error('The compact Market snapshot could not be persisted safely.');
      }
    }
    atlas = { data, expiresAt: Date.now() + duration * 1000 };
      return data;
    } catch (error) {
      const fallback = lastGood || cached;
      if (fallback) {
        const stale = {
          ...fallback,
          cache: {
            status: 'stale',
            warning: 'The SEC refresh failed; showing the last completed Market snapshot.',
          },
        };
        atlas = { data: stale, expiresAt: Date.now() + 5 * 60_000 };
        return stale;
      }
      throw error;
    } finally {
      if (lease) await warmReleaseLease(MARKET_REBUILD_LEASE, MARKET_REBUILD_LEASE_ID, lease);
    }
  })();
  try { return await atlasPending; } finally { atlasPending = null; }
}
