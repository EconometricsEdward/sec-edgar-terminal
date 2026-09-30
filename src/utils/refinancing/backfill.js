import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, releaseDatasetWrite } from '../dataStore.js';
import { readPreparedSecDocument, refreshSecDocument, PreparedSecUnavailableError,
  SEC_DOCUMENT_MAX_BYTES, preparedEnvelopeUsable, getSecPreparedCompany } from '../secDocumentStore.js';
import { loadSecCoverageRegistry } from '../secCoverageRegistry.js';
import { secFetch } from '../secClient.js';
import { extractRefinancingProfile, REFINANCING_VERSION } from './maturities.js';
import { compactRefinancingProfile, packRefinancingProfile, isRefinancingProfile, isRefinancingWall } from './projection.js';
import { advanceRefinancingWall, readRefinancingWall } from './server.js';

export const REFINANCING_BACKFILL_KEY = 'research-market-refinancing-backfill-v1:state';
export const REFINANCING_BACKFILL_LIMIT = 160;
export const REFINANCING_BACKFILL_SEED_LIMIT = 500;
const VERSION = 'refinancing-backfill-v1';
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const RETRY_MS = 30 * 60000;
const CIK = /^(?!0000000000)\d{10}$/;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const initialState = () => ({ version: VERSION, extractionVersion: REFINANCING_VERSION,
  cursor: '', nextCheckAt: null, failures: {}, buffered: [], updatedAt: null });
const failure = (message, code = 'INVALID_SOURCE', global = true) => Object.assign(new Error(message), { code, global });

/** Private bounded progress, not an issuer table or a public research response. */
export function validRefinancingBackfillState(state) {
  return Boolean(record(state) && state.version === VERSION && state.extractionVersion === REFINANCING_VERSION
    && typeof state.cursor === 'string' && (state.cursor === '' || /^[01]:\d{10}$/.test(state.cursor))
    && (state.nextCheckAt === null || timestamp(state.nextCheckAt))
    && (state.updatedAt === null || timestamp(state.updatedAt))
    && record(state.failures) && Object.keys(state.failures).length <= 5000
    && Object.entries(state.failures).every(([cik, entry]) => CIK.test(cik) && record(entry)
      && Number.isInteger(entry.count) && entry.count >= 1 && entry.count <= 16
      && timestamp(entry.retryAt) && typeof entry.code === 'string' && entry.code.length <= 100)
    && Array.isArray(state.buffered) && state.buffered.length <= REFINANCING_BACKFILL_SEED_LIMIT
    && new Set(state.buffered.map(row => row.cik)).size === state.buffered.length
    && state.buffered.every(row => record(row) && CIK.test(row.cik)
      && typeof row.ticker === 'string' && row.ticker.length <= 20 && typeof row.name === 'string' && row.name.length <= 300
      && typeof row.sic === 'string' && row.sic.length <= 8 && typeof row.sector === 'string' && row.sector.length <= 100
      && timestamp(row.refinancingSource?.fetchedAt) && timestamp(row.refinancingSource?.revalidatedAt)
      && timestamp(row.refinancingSource?.usableUntil)
      && Date.parse(row.refinancingSource.fetchedAt) <= Date.parse(row.refinancingSource.revalidatedAt)
      && Date.parse(row.refinancingSource.revalidatedAt) <= Date.parse(row.refinancingSource.usableUntil)
      && isRefinancingProfile(compactRefinancingProfile(row.refinancing), row.cik))
    && Buffer.byteLength(JSON.stringify(state)) <= MAX_STATE_BYTES);
}

function stateFrom(envelope, now) {
  if (!envelope) return initialState();
  if (!validRefinancingBackfillState(envelope.payload)
    || envelope.payload.updatedAt && Date.parse(envelope.payload.updatedAt) > now + 60000
    || envelope.payload.buffered.some(row => Date.parse(row.refinancingSource.revalidatedAt) > now + 60000))
    throw failure('Refinancing backfill progress failed validation.', 'INVALID_STATE');
  return structuredClone(envelope.payload);
}

/** Exactly one gated HTTP request when an admitted archive cannot supply facts.
 * Storage and identity errors never authorize a transport fallback. */
export async function loadRefinancingBackfillFacts(company, { signal, prepared = readPreparedSecDocument,
  refresh = refreshSecDocument, fetchSec = secFetch, now = Date.now } = {}) {
  const path = `/api/xbrl/companyfacts/CIK${company.cik}.json`;
  let envelope, refreshedSource = false;
  try { envelope = await prepared(path, { allowStale: true, requireRegistry: true, readEnabled: () => true }); }
  catch (error) {
    if (!(error instanceof PreparedSecUnavailableError) || !['missing', 'expired'].includes(error.sourceState)) throw error;
    const refreshed = await refresh(path, { signal, minRecheckAgeMs: 20 * 3600000 });
    if (!refreshed?.envelope) throw failure('Prepared companyfacts refresh is busy.', 'SOURCE_BUSY', false);
    envelope = refreshed.envelope;
    refreshedSource = refreshed.status !== 'current';
  }
  if (envelope) {
    if (!preparedEnvelopeUsable(envelope, now()) || Number(envelope.payload?.cik) !== Number(company.cik)
      || !record(envelope.payload?.facts)) throw failure('Archived companyfacts failed validation.');
    return { ...envelope, origin: refreshedSource ? 'archive-refresh' : 'archive' };
  }
  const response = await fetchSec(`https://data.sec.gov${path}`, { signal, timeoutMs: 12000, retries: 0,
    maxBytes: SEC_DOCUMENT_MAX_BYTES, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(failure(`Companyfacts returned HTTP ${response.status}.`, `SEC_HTTP_${response.status}`,
      [403, 429].includes(response.status) || response.status >= 500), { status: response.status });
  }
  const payload = await response.json();
  if (!record(payload) || Number(payload.cik) !== Number(company.cik) || !record(payload.facts))
    throw failure('Downloaded companyfacts failed identity validation.');
  const fetchedAt = new Date(now()).toISOString();
  return { payload, origin: 'download', metadata: { fetchedAt, revalidatedAt: fetchedAt } };
}

function haltFor(error) {
  return error.global === true || error instanceof PreparedSecUnavailableError
    || /(?:REGISTRY|RATE_GATE|COORDINATION|COOLDOWN|BUDGET|USER_AGENT|SEC_REQUEST_FAILED|INVALID_SOURCE)/.test(error.code || '')
    || [403, 429].includes(error.status) || error.status >= 500 || error.name === 'DataStoreError';
}

/** Resumable scheduled enrichment of the exact prepared Market universe.
 * No visitors, atlas reads, submissions, checkpoint scans, or per-issuer writes. */
export async function runRefinancingBackfill({ signal, deadline = Date.now() + 240000,
  limit = REFINANCING_BACKFILL_LIMIT } = {}, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  write = publishDataset, release = releaseDatasetWrite, wallRead = readRefinancingWall,
  loadRegistry = loadSecCoverageRegistry, admitted = getSecPreparedCompany,
  source = loadRefinancingBackfillFacts, extract = extractRefinancingProfile,
  advance = advanceRefinancingWall, now = Date.now,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > REFINANCING_BACKFILL_SEED_LIMIT)
    throw new Error('Unbounded refinancing backfill limit.');
  if (mode !== 'supabase') return { status: 'skipped', reason: 'disabled' };
  const stopAt = Math.min(deadline, now() + 240000);
  if (signal?.aborted || now() >= stopAt - 60000) return { status: 'skipped', reason: 'deadline' };
  // A caught-up/cooling worker needs only this small read, not the large view.
  const prior = stateFrom(await read('financial', REFINANCING_BACKFILL_KEY, { allowStale: true }), now());
  if (prior.nextCheckAt && Date.parse(prior.nextCheckAt) > now()) return { status: 'skipped', reason: 'not-due' };
  const claim = await begin('financial', REFINANCING_BACKFILL_KEY, { leaseSeconds: 300 });
  if (!claim) return { status: 'skipped', reason: 'busy' };
  let state, publishedState = false;
  const result = { status: 'completed', attempted: 0, extracted: 0, archiveReads: 0, archiveRefreshes: 0, downloads: 0,
    admitted: 0, coveredCompanies: null, pendingCompanies: null, failed: 0, errors: [] };
  try {
    // Another invocation could have finished between the initial read/claim.
    state = stateFrom(await read('financial', REFINANCING_BACKFILL_KEY, { allowStale: true }), now());
    if (state.nextCheckAt && Date.parse(state.nextCheckAt) > now()) return { status: 'skipped', reason: 'not-due' };
    const wall = await wallRead();
    if (!isRefinancingWall(wall)) throw failure('Prepared Market membership failed validation.', 'INVALID_UNIVERSE');
    const members = new Map(wall.companies.map(company => [company.cik, company]));
    state.buffered = state.buffered.filter(company => members.has(company.cik) && !members.get(company.cik).profile
      && Date.parse(company.refinancingSource.usableUntil) >= now()
      && (!compactRefinancingProfile(company.refinancing).asOf
        || now() - Date.parse(compactRefinancingProfile(company.refinancing).asOf) <= 550 * 86400000));
    state.failures = Object.fromEntries(Object.entries(state.failures).filter(([cik]) => members.has(cik) && !members.get(cik).profile));
    result.coveredCompanies = wall.coverage.coveredCompanies;
    result.pendingCompanies = wall.coverage.pendingCompanies;
    let halted = false;
    // Buffered successful work gets an exclusive flush run. A broken publisher
    // cannot cause another source batch or an unbounded private queue.
    if (!state.buffered.length && wall.coverage.pendingCompanies) {
      await loadRegistry({ required: true });
      const pending = wall.companies.filter(company => !company.profile)
        .map(company => ({ company, key: `${admitted(company.cik) ? '0' : '1'}:${company.cik}` }))
        .sort((a, b) => a.key.localeCompare(b.key));
      const ordered = [...pending.filter(row => row.key > state.cursor), ...pending.filter(row => row.key <= state.cursor)];
      const queue = ordered.filter(({ company }) => !state.failures[company.cik]
        || Date.parse(state.failures[company.cik].retryAt) <= now()).slice(0, limit);
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (queue.length && !halted && !signal?.aborted && now() < stopAt - 60000) {
          const { company, key } = queue.shift();
          state.cursor = key; result.attempted++;
          try {
            const facts = await source(company, { signal, now });
            if (facts.origin === 'archive') result.archiveReads++;
            else if (facts.origin === 'archive-refresh') result.archiveRefreshes++;
            else result.downloads++;
            const profile = extract(facts.payload, { cik: company.cik, ticker: company.ticker, name: company.name,
              sic: company.sic, sector: company.sector, asOf: new Date(now()).toISOString().slice(0, 10) });
            if (!isRefinancingProfile(profile, company.cik)) throw failure('Maturity extraction failed validation.');
            state.buffered.push({ cik: company.cik, ticker: company.ticker, name: company.name, sic: company.sic,
              sector: company.sector, refinancing: packRefinancingProfile(profile),
              refinancingSource: { fetchedAt: facts.metadata.fetchedAt,
                revalidatedAt: facts.metadata.revalidatedAt || facts.metadata.fetchedAt,
                usableUntil: new Date(facts.metadata.expiresAt ? Date.parse(facts.metadata.expiresAt) + 7 * 86400000
                  : now() + 7 * 86400000).toISOString() } });
            delete state.failures[company.cik]; result.extracted++;
          } catch (error) {
            result.failed++;
            const count = Math.min(16, (state.failures[company.cik]?.count || 0) + 1);
            state.failures[company.cik] = { count, code: String(error.code || error.name || 'SOURCE_ERROR').slice(0, 100),
              retryAt: new Date(now() + Math.min(86400000, RETRY_MS * 2 ** (count - 1))).toISOString() };
            if (result.errors.length < 5) result.errors.push({ ticker: company.ticker, reason: String(error.message).slice(0, 200) });
            if (haltFor(error)) halted = true;
          }
        }
      }));
    }
    if (state.buffered.length && !signal?.aborted && now() < stopAt - 35000) {
      try {
        const publication = await advance(state.buffered, { signal, deadline: stopAt - 15000 });
        if (['published', 'unchanged'].includes(publication.status)) {
          const completed = new Set(publication.completedCiks || []);
          state.buffered = state.buffered.filter(company => !completed.has(company.cik));
          result.admitted = completed.size;
          result.coveredCompanies = publication.coveredCompanies;
          result.pendingCompanies = publication.pendingCompanies;
        } else result.status = 'deferred';
      } catch (error) {
        result.status = 'deferred';
        result.errors.push({ reason: `Publication deferred: ${String(error.message).slice(0, 180)}` });
      }
    }
    const retryTimes = Object.values(state.failures).map(entry => Date.parse(entry.retryAt));
    const next = halted ? now() + RETRY_MS : !result.pendingCompanies && !state.buffered.length ? now() + 6 * 3600000
      : !state.buffered.length && result.pendingCompanies === retryTimes.length && retryTimes.length ? Math.min(...retryTimes) : now();
    state.nextCheckAt = new Date(next).toISOString();
  } catch (error) {
    // No source fallback on storage/registry faults. Preserve progress and defer.
    if (!state) throw error;
    result.status = 'deferred';
    result.errors.push({ reason: String(error.message).slice(0, 200) });
    state.nextCheckAt = new Date(now() + RETRY_MS).toISOString();
  } finally {
    try {
      if (state) {
        state.updatedAt = new Date(now()).toISOString();
        if (!validRefinancingBackfillState(state)) throw new Error('Refinancing backfill state exceeded validation bounds.');
        await write({ dataset: 'financial', key: REFINANCING_BACKFILL_KEY, claim, payload: state, returnEnvelope: false,
          metadata: { sourceId: 'sec-edgar', fetchedAt: state.updatedAt, revalidatedAt: state.updatedAt,
            expiresAt: new Date(now() + 30 * 86400000).toISOString(), parserVersion: REFINANCING_VERSION,
            calculationVersion: VERSION }, identityInputs: state });
        publishedState = true;
      }
    } finally { if (!publishedState) await release('financial', REFINANCING_BACKFILL_KEY, claim); }
  }
  return { ...result, buffered: state.buffered.length };
}
