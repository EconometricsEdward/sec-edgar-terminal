import { getOperatingTicker } from './tickerMap.js';
import { warmGet, warmSet } from './warmCache.js';
import { MARKET_LENSES } from './marketCohorts.js';
import { buildMarketCompany, marketCompanySummary } from './marketResearchData.js';
import { MARKET_VERSION, metricStats } from './marketResearch.js';
import { appendSnapshot } from './marketEvidence.js';

const TTL = 6 * 3600000;
const pending = new Map();
const memory = new Map();
let atlas = null;
let atlasPending = null;
let nextSecRequestAt = 0;
export const marketTickers = [...new Set(MARKET_LENSES.flatMap((c) => c.tickers))];

async function secJson(path) {
  const scheduledAt = Math.max(Date.now(), nextSecRequestAt);
  nextSecRequestAt = scheduledAt + 180;
  if (scheduledAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now()));
  const response = await fetch(`https://data.sec.gov${path}`, {
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'EDGAR Terminal research@secedgarterminal.com', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000), cache: 'no-store',
  });
  if (!response.ok) throw new Error(`SEC data request returned HTTP ${response.status}.`);
  return response.json();
}
export async function loadMarketCompany(ticker) {
  const existing = memory.get(ticker);
  if (existing && Date.now() - Date.parse(existing.observedAt) < TTL) return existing;
  if (pending.has(ticker)) return pending.get(ticker);
  const task = (async () => {
    const cached = await warmGet(MARKET_VERSION, ticker);
    if (cached && Date.now() - Date.parse(cached.observedAt) < TTL) { memory.set(ticker, cached); return cached; }
    const entry = await getOperatingTicker(ticker);
    if (!entry) { const error = new Error('Ticker is absent from the current SEC operating-company map.'); error.name = 'UnresolvedTicker'; throw error; }
    const cik = String(entry.cik).padStart(10, '0');
    const [submissions, data] = await Promise.all([
      secJson(`/submissions/CIK${cik}.json`), secJson(`/api/xbrl/companyfacts/CIK${cik}.json`),
    ]);
    if (!data.facts || !submissions.sic) throw new Error('SEC financial facts or industry classification are unavailable.');
    const company = buildMarketCompany({ ticker, cik, name: submissions.name || entry.name, sic: submissions.sic, facts: data.facts },
      MARKET_LENSES.filter((c) => c.tickers.includes(ticker)).map((c) => c.id));
    memory.set(ticker, company);
    await warmSet(MARKET_VERSION, ticker, company, TTL / 1000);
    return company;
  })();
  pending.set(ticker, task);
  try { return await task; } finally { pending.delete(ticker); }
}

export async function loadMarketAtlas() {
  if (atlas && Date.now() < atlas.expiresAt) return atlas.data;
  if (atlasPending) return atlasPending;
  atlasPending = (async () => {
    const cached = await warmGet(MARKET_VERSION, 'atlas');
    if (cached && Date.now() - Date.parse(cached.generatedAt) < (cached.failures.some((f) => f.retryable) ? 300000 : TTL)) {
      atlas = { data: cached, expiresAt: Date.now() + 60000 };
      return cached;
    }
    const companies = [], failures = [];
    // Bounded batches; upstream requests are spaced independently of cache reads.
    // Concurrent requests on this instance share this calculation and company loads.
    for (let i = 0; i < marketTickers.length; i += 3) {
      const tickers = marketTickers.slice(i, i + 3);
      const results = await Promise.allSettled(tickers.map(loadMarketCompany));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') companies.push(marketCompanySummary(result.value));
        else failures.push({ ticker: tickers[index], reason: result.reason?.message || 'Company data unavailable.', retryable: result.reason?.name !== 'UnresolvedTicker' });
      });
    }
    if (!companies.length) throw new Error('SEC company data is temporarily unavailable. Please retry.');
    const generatedAt = new Date().toISOString();
    const cohorts = MARKET_LENSES.map((c) => ({ id: c.id, label: c.assetClass, title: c.title, description: c.description, tickers: c.tickers, disclosureTerms: c.disclosureTerms }));
    const data = { version: MARKET_VERSION, generatedAt, requested: marketTickers.length, companies: companies.sort((a, b) => a.ticker.localeCompare(b.ticker)), cohorts, failures };
    const previous = await warmGet(MARKET_VERSION, 'observations');
    data.observations = appendSnapshot(previous, {
      observedAt: generatedAt, companies: companies.length, tickers: companies.map((c) => c.ticker).sort(),
      revenueGrowth: metricStats(companies, 'ttm', 'revenueGrowth'), netMargin: metricStats(companies, 'ttm', 'netMargin'),
    });
    data.historyPersistence = await warmSet(MARKET_VERSION, 'observations', data.observations, 90 * 86400);
    const duration = failures.some((f) => f.retryable) ? 300 : TTL / 1000;
    await warmSet(MARKET_VERSION, 'atlas', data, duration);
    atlas = { data, expiresAt: Date.now() + duration * 1000 };
    return data;
  })();
  try { return await atlasPending; } finally { atlasPending = null; }
}
