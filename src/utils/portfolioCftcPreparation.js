import { createHash, randomUUID } from 'node:crypto';
import universeSource from '../../public/portfolio/portfolio-demo-100-universe.json' with { type: 'json' };
import { validatePortfolioDemoUniverse } from './portfolioDemoUniverse.js';
import { cacheGet, cacheGetMany, cachePut, disposableCacheEnabled } from './disposableCache.js';
import { getDataStoreMode } from './dataStore.js';
import { isCftcEnabled } from './cftcFeature.js';
import { discoverCompanyCftcContext, isCompanyCftcCachedContext, COMPANY_CFTC_CACHE_NAMESPACE } from './companyCftcServer.js';
import { companyCftcAnnualFilings } from './companyCftc.js';
import { secResearchJson } from './secResearchData.js';
import { warmGet } from './warmCache.js';
import { loadCftcHistory } from './cftcServer.js';
import { buildPortfolioCftcChanges } from './portfolioCftcChanges.js';
import { PORTFOLIO_DEMO_CIKS, PORTFOLIO_PREPARED_CACHE_TYPE as TYPE, PORTFOLIO_PREPARED_LIMITS as LIMITS } from '../../supabase/functions/edgar-data-gateway/portfolioDemoPolicy.js';

export const PORTFOLIO_PREPARATION_VERSION = 'edgar.portfolio-cftc-prepared.v1';
export const PORTFOLIO_PREPARATION_POLICY = Object.freeze({ contextRetentionSeconds: 14 * 86400,
  snapshotRetentionSeconds: 14 * 86400, sourceCheckMs: 24 * 3600_000, resultCheckMs: 6 * 3600_000,
  maxInvocationMs: 50_000, maxCompanies: 6, ...LIMITS });
const POLICY = PORTFOLIO_PREPARATION_POLICY;
const universe = validatePortfolioDemoUniverse(universeSource);
const companies = universe.companies.map(({ ticker, cik, name }) => ({ ticker, cik, name }));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const universeId = digest({ membership: universe.membership_id, companies: companies.map(({ ticker, cik }) => [ticker, cik]) });
if (companies.some(company => !PORTFOLIO_DEMO_CIKS.includes(company.cik)) || PORTFOLIO_DEMO_CIKS.length !== companies.length) throw new Error('Prepared demo policy and universe disagree.');
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const key = company => `CIK${company.cik}`;
const marketKey = selection => `${selection.family}:${selection.code || selection.contract}:${selection.group}`;
const code = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'PREPARATION_UNAVAILABLE';
function fail(value) { throw Object.assign(new Error('Prepared portfolio research could not finish this bounded step.'), { code: value }); }
function contextValid(value, company, now) {
  return value?.schemaVersion === PORTFOLIO_PREPARATION_VERSION && value.universeId === universeId
    && value.cik === company.cik && value.context?.cik === company.cik && stamp(value.checkedAt)
    && Date.parse(value.checkedAt) <= now && isCompanyCftcCachedContext(value.context, { ticker: company.ticker, asOf: null })
    && Date.parse(value.context.generatedAt) <= now && bytes(value) <= LIMITS.contextBytes;
}
function contextFresh(value, company, now) {
  return contextValid(value, company, now) && now - Date.parse(value.checkedAt) < POLICY.sourceCheckMs;
}
function stateValid(value) {
  return value?.schemaVersion === PORTFOLIO_PREPARATION_VERSION && value.universeId === universeId
    && Number.isSafeInteger(value.cursor) && value.cursor >= 0 && value.cursor < companies.length
    && (value.owner === null || typeof value.owner === 'string') && Number.isFinite(value.leaseUntil)
    && value.failures && typeof value.failures === 'object' && !Array.isArray(value.failures)
    && Object.entries(value.failures).every(([cik, entry]) => PORTFOLIO_DEMO_CIKS.includes(cik)
      && Number.isSafeInteger(entry.attempts) && entry.attempts > 0 && Number.isFinite(entry.nextAt)
      && typeof entry.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(entry.code)) && bytes(value) <= LIMITS.stateBytes;
}
function snapshotValid(value, now) {
  if (value?.schemaVersion !== PORTFOLIO_PREPARATION_VERSION || value.universeId !== universeId
    || !stamp(value.checkedAt) || Date.parse(value.checkedAt) > now || !stamp(value.nextCheckAt)
    || Date.parse(value.nextCheckAt) !== Date.parse(value.checkedAt) + POLICY.resultCheckMs
    || !Array.isArray(value.contexts) || value.contexts.length !== companies.length
    || !value.histories || typeof value.histories !== 'object' || Array.isArray(value.histories)
    || Object.keys(value.histories).length > 40 || bytes(value) > LIMITS.snapshotBytes) return false;
  return companies.every((company, i) => contextValid(value.contexts[i], company, now));
}
function trimHistory(value, now) {
  if (!value || typeof value !== 'object') return value;
  const cutoff = new Date(now - 98 * 86400_000).toISOString().slice(0, 10);
  return { ...value, history: Array.isArray(value.history) ? value.history.filter(point => point.reportDate >= cutoff).slice(-100) : value.history };
}

/** No new database schema: exactly 100 replaceable contexts, two snapshots and one CAS checkpoint.
 * Existing family byte caps and expiry cleanup bound retention; no immutable versions accumulate.
 * A checkpoint lease coordinates work. Every context/snapshot also uses its own prior-content CAS,
 * so an expired worker cannot overwrite a newer acknowledged value even after losing its lease.
 */
export function createPortfolioCftcPreparation({ enabled = () => disposableCacheEnabled() && isCftcEnabled()
  && getDataStoreMode('sec') === 'supabase' && getDataStoreMode('cftc') === 'supabase',
  read = cacheGet, readMany = cacheGetMany, put = cachePut, now = Date.now,
  readSubmissions = (company, signal) => secResearchJson(`/submissions/CIK${company.cik}.json`, signal),
  discover = discoverCompanyCftcContext, warmContext = ticker => warmGet(COMPANY_CFTC_CACHE_NAMESPACE, `${ticker}:latest`),
  history = loadCftcHistory, build = buildPortfolioCftcChanges,
} = {}) {
  async function readSnapshot(signal) {
    if (!enabled()) return null;
    const options = { signal, deadline: now() + 12_000 };
    for (const id of ['DEMO-CURRENT', 'DEMO-PREVIOUS']) {
      const record = await read(TYPE, id, options);
      if (snapshotValid(record?.payload, now())) return record;
    }
    return null;
  }
  /** @param {{companies?: Array<{ticker: string, cik?: string, rowId?: string}>, days?: number}} input
   * @param {{signal?: AbortSignal}} options */
  async function readPreparedPortfolioCftcChanges({ companies: requested = [], days = 30 } = {}, { signal } = {}) {
    if (!Array.isArray(requested) || !requested.length || requested.length > 100) return null;
    const seen = new Set();
    for (const company of requested) {
      const match = companies.find(item => item.ticker === company?.ticker && (!company.cik || item.cik === company.cik));
      if (!match || seen.has(match.ticker)) return null;
      seen.add(match.ticker);
    }
    const record = await readSnapshot(signal);
    if (!record) return null;
    const saved = record.payload, contexts = new Map(saved.contexts.map(entry => [entry.context.ticker, entry.context]));
    const result = await build({ companies: requested, days }, { signal, now: new Date(now()), companyLimit: 100,
      loadContext: async ({ ticker }) => contexts.get(ticker), loadHistory: async selection => saved.histories[marketKey(selection)] });
    const checkedAt = new Map(saved.contexts.map(entry => [entry.context.ticker, entry.checkedAt]));
    const companyChecks = result.companyChecks?.map(check => check.status === 'unavailable' ? check
      : { ...check, checkedAt: checkedAt.get(check.ticker) || check.checkedAt });
    return { ...result, ...(companyChecks ? { companyChecks } : {}), generatedAt: saved.checkedAt, preparation: { status: now() < Date.parse(saved.nextCheckAt) && !result.coverage.staleMarkets ? 'ready' : 'stale',
      checkedAt: saved.checkedAt, nextCheckAt: saved.nextCheckAt, totalCompanies: companies.length,
      completedCompanies: companies.length, universeAsOf: universe.source.asOf } };
  }
  /** @param {{days?: number, signal?: AbortSignal}} options */
  async function readPreparedDemoCftcChanges({ days = 30, signal } = {}) {
    return readPreparedPortfolioCftcChanges({ companies, days }, { signal });
  }
  /** @param {{signal?: AbortSignal}} options */
  async function readPreparationProgress({ signal } = {}) {
    if (!enabled()) return null;
    const state = await read(TYPE, 'DEMO-STATE', { signal, deadline: now() + 10_000 });
    if (!stateValid(state?.payload)) return null;
    const value = state.payload;
    return { status: value.publishedAt && value.completedCompanies === companies.length ? 'prepared' : 'preparing', totalCompanies: companies.length,
      completedCompanies: value.completedCompanies || 0, checkedAt: value.updatedAt || null,
      pendingCompanies: companies.length - (value.completedCompanies || 0), unavailableCompanies: Object.keys(value.failures).length };
  }
  /** @param {{signal?: AbortSignal, deadline?: number, maxCompanies?: number}} options */
  async function runPortfolioCftcPreparation({ signal, deadline, maxCompanies = POLICY.maxCompanies } = {}) {
    if (!enabled()) return { status: 'disabled', processed: 0 };
    const startedAt = now(), stopAt = Math.min(deadline ?? startedAt + POLICY.maxInvocationMs, startedAt + POLICY.maxInvocationMs);
    if (!Number.isSafeInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > POLICY.maxCompanies) fail('INVALID_PREPARATION_BUDGET');
    if (!Number.isFinite(stopAt) || stopAt - startedAt < 10_000 || signal?.aborted) return { status: 'budget-exhausted', processed: 0 };
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(stopAt - startedAt)));
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const options = { signal, deadline: stopAt }, current = await read(TYPE, 'DEMO-CURRENT', options);
    if (snapshotValid(current?.payload, now()) && now() < Date.parse(current.payload.nextCheckAt)) return { status: 'current', processed: 0, completedCompanies: 100 };
    const stateRecord = await read(TYPE, 'DEMO-STATE', options);
    if (stateValid(stateRecord?.payload) && stateRecord.payload.leaseUntil > now()) return { status: 'busy', processed: 0 };
    let state = stateValid(stateRecord?.payload) ? structuredClone(stateRecord.payload) : {
      schemaVersion: PORTFOLIO_PREPARATION_VERSION, universeId, cursor: 0, owner: null, leaseUntil: 0, failures: {}, completedCompanies: 0 };
    state.owner = randomUUID(); state.leaseUntil = stopAt + 30_000; state.updatedAt = new Date(now()).toISOString();
    const claimed = await put(TYPE, 'DEMO-STATE', state, POLICY.snapshotRetentionSeconds, { ...options, ifHash: stateRecord?.rawSha256 || 'absent' });
    if (!claimed?.stored) return { status: 'busy', processed: 0 };
    let stateHash = claimed.rawSha256, processed = 0;
    async function saveState(release = false) {
      if (signal.aborted || now() >= stopAt || state.leaseUntil <= now()) fail('PREPARATION_LEASE_LOST');
      state.updatedAt = new Date(now()).toISOString();
      if (release) { state.owner = null; state.leaseUntil = 0; }
      const saved = await put(TYPE, 'DEMO-STATE', state, POLICY.snapshotRetentionSeconds, { ...options, ifHash: stateHash });
      if (!saved?.stored) fail('PREPARATION_LEASE_LOST');
      stateHash = saved.rawSha256;
    }
    try {
      const records = await readMany(TYPE, companies.map(key), options);
      if (!Array.isArray(records) || records.length !== companies.length) fail('PREPARATION_CACHE_INCOMPLETE');
      const contexts = records.map((record, i) => contextValid(record?.payload, companies[i], now()) ? record.payload : null);
      state.completedCompanies = contexts.filter((value, i) => contextFresh(value, companies[i], now())).length;
      const startCursor = state.cursor;
      for (let offset = 0; offset < companies.length && processed < maxCompanies && stopAt - now() >= 12_000; offset++) {
        const index = (startCursor + offset) % companies.length, company = companies[index];
        state.cursor = (index + 1) % companies.length;
        if (contextFresh(contexts[index], company, now()) || state.failures[company.cik]?.nextAt > now()) continue;
        const checkedAt = new Date(now()).toISOString();
        // Leave time for acknowledged context publication and checkpointing.
        const companySignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(35_000, stopAt - now() - 8000)))]);
        try {
          let context = contexts[index]?.context;
          const warm = !context ? await warmContext(company.ticker) : null;
          const warmAge = now() - Date.parse(warm?.generatedAt);
          const warmTtl = warm?.status === 'ready' ? 6 * 3600_000 : warm?.status === 'no_matches' ? 3600_000 : 900_000;
          let sourceCheckedAt = checkedAt;
          if (isCompanyCftcCachedContext(warm, { ticker: company.ticker, asOf: null }) && warm.cik === company.cik && warmAge >= 0 && warmAge < warmTtl) {
            context = warm; sourceCheckedAt = warm.generatedAt;
          } else {
            const submissions = await readSubmissions(company, companySignal);
            if (!Array.isArray(submissions?.filings?.recent?.accessionNumber)) fail('SEC_SOURCE_INVALID');
            const latest = companyCftcAnnualFilings(submissions.filings.recent, company.cik, checkedAt.slice(0, 10))[0];
            if (!context || !latest || context.filing?.accession !== latest.accession || context.filing?.url !== latest.url) {
              context = await discover({ ticker: company.ticker, asOf: null }, { signal: companySignal, now: new Date(now()),
                lookupTicker: async () => ({ cik: company.cik, name: company.name }),
                loadSubmissions: (file, innerSignal) => file === `CIK${company.cik}.json` ? submissions : secResearchJson(`/submissions/${file}`, innerSignal) });
            }
          }
          const value = { schemaVersion: PORTFOLIO_PREPARATION_VERSION, universeId, cik: company.cik, checkedAt: sourceCheckedAt, context };
          if (!contextValid(value, company, now())) fail('COMPANY_CFTC_UNAVAILABLE');
          if (signal.aborted || state.leaseUntil <= now()) fail('PREPARATION_LEASE_LOST');
          const written = await put(TYPE, key(company), value, POLICY.contextRetentionSeconds,
            { ...options, ifHash: records[index]?.rawSha256 || 'absent' });
          if (!written?.stored) fail('PREPARATION_CONTEXT_CHANGED');
          contexts[index] = value; records[index] = { payload: value, rawSha256: written.rawSha256 };
          delete state.failures[company.cik];
        } catch (error) {
          if (signal.aborted) throw error;
          const attempts = Math.min(12, (state.failures[company.cik]?.attempts || 0) + 1);
          state.failures[company.cik] = { attempts, nextAt: now() + Math.min(6 * 3600_000, 30_000 * 2 ** attempts), code: code(error) };
        }
        processed++;
        state.completedCompanies = contexts.filter((value, i) => contextFresh(value, companies[i], now())).length;
        await saveState();
      }
      if (state.completedCompanies !== companies.length || stopAt - now() < 15_000) {
        await saveState(true);
        return { status: 'progress', processed, completedCompanies: state.completedCompanies, totalCompanies: 100,
          unavailableCompanies: Object.keys(state.failures).length };
      }
      const histories = {}, contextMap = new Map(contexts.map(entry => [entry.context.ticker, entry.context]));
      const result = await build({ companies, days: 90 }, { signal, now: new Date(now()), companyLimit: 100,
        loadContext: async ({ ticker }) => contextMap.get(ticker),
        loadHistory: async selection => {
          const value = trimHistory(await history({ ...selection, signal }), now());
          histories[marketKey(selection)] = value; return value;
        } });
      if (result.coverage?.checked !== 100 || result.coverage?.unavailable || result.coverage?.marketUnavailable
        || result.coverage?.invalidLinks || result.coverage?.limited) {
        await saveState(true); return { status: 'markets-pending', processed, completedCompanies: 100, coverage: result.coverage };
      }
      const completedAt = new Date(now()).toISOString();
      const snapshot = { schemaVersion: PORTFOLIO_PREPARATION_VERSION, universeId, checkedAt: completedAt,
        nextCheckAt: new Date(Date.parse(completedAt) + POLICY.resultCheckMs).toISOString(), contexts, histories };
      if (!snapshotValid(snapshot, now())) fail('PREPARATION_SNAPSHOT_INVALID');
      await saveState();
      // Capture expected hashes before publication. A competing newer publisher wins CAS;
      // a late acknowledgement cannot regress its current or previous snapshot.
      if (snapshotValid(current?.payload, now())) {
        const previous = await read(TYPE, 'DEMO-PREVIOUS', options);
        if (!previous || Date.parse(previous.payload?.checkedAt) < Date.parse(current.payload.checkedAt)) {
          await put(TYPE, 'DEMO-PREVIOUS', current.payload, POLICY.snapshotRetentionSeconds, {
            ...options, ifHash: previous?.rawSha256 || 'absent', expiresAt: current.expiresAt });
        }
      }
      const published = await put(TYPE, 'DEMO-CURRENT', snapshot, POLICY.snapshotRetentionSeconds,
        { ...options, ifHash: current?.rawSha256 || 'absent' });
      if (!published?.stored) fail('PREPARATION_PUBLICATION_CHANGED');
      state.publishedAt = completedAt;
      await saveState(true);
      return { status: 'prepared', processed, completedCompanies: 100, totalCompanies: 100,
        checkedAt: completedAt, rawBytes: bytes(snapshot), storedRecords: 103 };
    } catch (error) {
      // A timed-out mutation may already have committed. Never overwrite it with an older
      // cursor; retain the finite lease and let the next scheduler recover by CAS.
      return { status: 'deferred', code: code(error), processed, completedCompanies: state.completedCompanies || 0, totalCompanies: 100 };
    }
  }
  return { runPortfolioCftcPreparation, readPreparedPortfolioCftcChanges, readPreparedDemoCftcChanges, readPreparationProgress };
}
export const { runPortfolioCftcPreparation, readPreparedPortfolioCftcChanges, readPreparedDemoCftcChanges, readPreparationProgress } = createPortfolioCftcPreparation();
