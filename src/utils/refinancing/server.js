import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, releaseDatasetWrite } from '../dataStore.js';
import { preparedEnvelopeUsable } from '../secDocumentStore.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { REFINANCING_VERSION } from './maturities.js';
import { buildRefinancingWall, buildRefinancingCompany, mergeRefinancingWall, isRefinancingWall, REFINANCING_WALL_VERSION,
  REFINANCING_RETENTION_MS, REFINANCING_FRESH_MS, REFINANCING_MAX_BYTES } from './projection.js';

export const REFINANCING_WALL_KEY = 'research-market-refinancing-v1:latest';
export const REFINANCING_CACHE_TAG = 'market-refinancing-v1';
const MAX_CACHE_BYTES = 1800000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Next's shared cache has a smaller entry ceiling than the prepared object
 * store. Compress before caching rather than dropping issuers or evidence. */
export function encodeRefinancingCache(value) {
  if (!isRefinancingWall(value)) throw new Error('Invalid refinancing cache payload.');
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > REFINANCING_MAX_BYTES) throw new Error('Refinancing payload exceeds the decoded limit.');
  const entry = { version: REFINANCING_WALL_VERSION, rawBytes: raw.length,
    sha256: digest(raw), gzip: gzipSync(raw, { level: 6 }).toString('base64') };
  if (Buffer.byteLength(JSON.stringify(entry)) > MAX_CACHE_BYTES) throw new Error('Refinancing payload exceeds the shared cache limit.');
  return entry;
}

export function decodeRefinancingCache(entry, now = Date.now()) {
  if (!entry || entry.version !== REFINANCING_WALL_VERSION || !Number.isInteger(entry.rawBytes)
    || entry.rawBytes < 1 || entry.rawBytes > REFINANCING_MAX_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
    || typeof entry.gzip !== 'string' || entry.gzip.length > MAX_CACHE_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.gzip))
    throw new Error('Invalid refinancing cache envelope.');
  const raw = gunzipSync(Buffer.from(entry.gzip, 'base64'), { maxOutputLength: REFINANCING_MAX_BYTES });
  if (raw.length !== entry.rawBytes || digest(raw) !== entry.sha256) throw new Error('Refinancing cache integrity check failed.');
  const value = retainedRefinancingWall(JSON.parse(raw.toString('utf8')), now);
  if (!value) throw new Error('Refinancing cache is unavailable or outside its retention window.');
  return value;
}

export function retainedRefinancingWall(value, now = Date.now()) {
  if (!isRefinancingWall(value)) return null;
  const age = now - Date.parse(value.sourceSnapshotAt), generatedAge = now - Date.parse(value.generatedAt);
  if (age < 0 || age >= REFINANCING_RETENTION_MS || generatedAge < 0 || generatedAge >= REFINANCING_RETENTION_MS) return null;
  return { ...value, cache: { status: age >= REFINANCING_FRESH_MS ? 'stale' : 'fresh', source: 'supabase-prepared',
    checkedAt: value.sourceSnapshotAt } };
}

const publicationHash = value => digest(Buffer.from(JSON.stringify({
  membershipId: value.membershipId, sourceSnapshotAt: value.sourceSnapshotAt,
  companies: value.companies, coverage: value.coverage, sectors: value.sectors,
})));

async function publishValue(value, claim, publish) {
  const fetchedAt = value.companies.map(company => company.factsRetrievedAt).sort()[0] || value.sourceSnapshotAt;
  await publish({ dataset: 'financial', key: REFINANCING_WALL_KEY, claim, payload: value, returnEnvelope: false,
    metadata: { sourceId: 'sec-edgar', sourceUrl: 'https://data.sec.gov/submissions/', fetchedAt,
      // Publication time describes this projection. Individual company clocks
      // and sourceSnapshotAt remain unchanged by a partial update.
      revalidatedAt: value.generatedAt,
      expiresAt: new Date(Math.min(Date.parse(value.generatedAt) + REFINANCING_FRESH_MS,
        Date.parse(value.sourceSnapshotAt) + REFINANCING_RETENTION_MS)).toISOString(),
      parserVersion: REFINANCING_VERSION, calculationVersion: REFINANCING_WALL_VERSION,
      view: REFINANCING_WALL_VERSION, coverage: value.coverage.coveredCompanies },
    identityInputs: { version: value.version, extractionVersion: REFINANCING_VERSION,
      generatedAt: value.generatedAt, membership: value.membershipId,
      contentHash: publicationHash(value) } });
}

/** One bounded immutable public projection; called only by the Quant publisher. */
export async function publishRefinancingWall(atlas, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  publish = publishDataset, release = releaseDatasetWrite, now = Date.now,
} = {}) {
  let value = buildRefinancingWall(atlas);
  if (!isRefinancingWall(value) || Buffer.byteLength(JSON.stringify(value)) > REFINANCING_MAX_BYTES)
    throw new Error('Refinancing snapshot failed validation or exceeded its size bound.');
  if (mode === 'off') return value;
  const claim = await begin('financial', REFINANCING_WALL_KEY, { leaseSeconds: 120 });
  if (!claim) throw new Error('Refinancing publication is already running.');
  try {
    const previous = await read('financial', REFINANCING_WALL_KEY, { allowStale: true });
    const retained = retainedRefinancingWall(previous?.payload, now());
    if (retained && retained.sourceSnapshotAt > value.sourceSnapshotAt) {
      await release('financial', REFINANCING_WALL_KEY, claim);
      return retained;
    }
    // The full atlas may have been captured before a shard published newer
    // issuer evidence. Merge it under the same lease instead of rolling back.
    if (retained) value = mergeRefinancingWall(value, retained.companies,
      value.generatedAt > retained.generatedAt ? value.generatedAt : retained.generatedAt);
    if (retained && publicationHash(retained) === publicationHash(value)) {
      await release('financial', REFINANCING_WALL_KEY, claim);
      return retained;
    }
    if (!isRefinancingWall(value) || Buffer.byteLength(JSON.stringify(value)) > REFINANCING_MAX_BYTES)
      throw new Error('Merged refinancing snapshot failed validation.');
    await publishValue(value, claim, publish);
    return value;
  } catch (error) { await release('financial', REFINANCING_WALL_KEY, claim); throw error; }
}

/** At most one small batch of already computed issuer results per cron run.
 * Read/merge/publish share the dataset lease with the full atlas publisher. */
export async function advanceRefinancingWall(companies, {
  mode = getDataStoreMode('financial'), read = readDataset, begin = beginDatasetWrite,
  publish = publishDataset, release = releaseDatasetWrite, now = Date.now,
  signal, deadline = Infinity,
} = {}) {
  if (!Array.isArray(companies) || companies.length > 500) throw new Error('Unbounded refinancing publication batch.');
  if (!companies.length || mode === 'off') return { status: 'skipped', reason: 'no-updates' };
  if (signal?.aborted || now() >= deadline - 20000) return { status: 'skipped', reason: 'deadline' };
  const updates = companies.map(buildRefinancingCompany);
  const claim = await begin('financial', REFINANCING_WALL_KEY, { leaseSeconds: 120 });
  if (!claim) return { status: 'skipped', reason: 'busy' };
  try {
    // Reading after acquisition prevents a late shard from discarding another
    // shard's just-published changes. No atlas/checkpoint/SEC reads occur here.
    const previous = await read('financial', REFINANCING_WALL_KEY, { allowStale: true });
    const retained = retainedRefinancingWall(previous?.payload, now());
    if (!retained || signal?.aborted || now() >= deadline - 10000) {
      await release('financial', REFINANCING_WALL_KEY, claim);
      return { status: 'skipped', reason: retained ? 'deadline' : 'snapshot-unavailable' };
    }
    const value = mergeRefinancingWall(retained, updates, new Date(now()).toISOString());
    const ids = new Set(updates.map(company => company.cik));
    const summary = { checkedCompanies: value.coverage.checkedCompanies, coveredCompanies: value.coverage.coveredCompanies,
      pendingCompanies: value.coverage.pendingCompanies,
      completedCiks: value.companies.filter(company => ids.has(company.cik) && company.profile).map(company => company.cik) };
    if (value === retained) {
      await release('financial', REFINANCING_WALL_KEY, claim);
      return { status: 'unchanged', ...summary };
    }
    if (!isRefinancingWall(value) || Buffer.byteLength(JSON.stringify(value)) > REFINANCING_MAX_BYTES)
      throw new Error('Incremental refinancing snapshot failed validation.');
    await publishValue(value, claim, publish);
    return { status: 'published', ...summary };
  } catch (error) { await release('financial', REFINANCING_WALL_KEY, claim); throw error; }
}

/** Cache-only public read. Missing data never starts SEC requests, extraction,
 * a universe scan, publication, or a retry loop. Next/CDN caches sit above it. */
export async function readRefinancingWall({ mode = getDataStoreMode('financial'), read = readDataset, now = Date.now } = {}) {
  if (mode !== 'supabase') throw Object.assign(new Error('The prepared refinancing snapshot is not available.'), { status: 503 });
  const envelope = await read('financial', REFINANCING_WALL_KEY, { allowStale: true });
  const value = preparedEnvelopeUsable(envelope, now()) ? retainedRefinancingWall(envelope.payload, now()) : null;
  if (!value || Buffer.byteLength(JSON.stringify(value)) > REFINANCING_MAX_BYTES)
    throw Object.assign(new Error('The prepared refinancing snapshot is temporarily unavailable.'), { status: 503 });
  return value;
}
