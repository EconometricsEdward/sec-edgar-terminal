import { createHash } from 'node:crypto';
import { getDataStoreMode, readDataset, beginDatasetWrite, publishDataset, revalidateDataset, releaseDatasetWrite, stableDataStoreJson } from './dataStore.js';
import { secFetch } from './secClient.js';
import { warmReserveGeneration, warmSetGeneration } from './warmCache.js';
import { SEC_COVERAGE_COHORT, getSecCoverageCompany } from './secCoverageUniverse.js';
import { isBroadSecCoverageEnabled } from './dataStoreDeployment.js';
import { loadSecCoverageRegistry, getActiveSecCoverageCompany, getAdmittedSecCoverageCompany,
  isActiveSecCoverageCik, isAdmittedSecCoverageCik } from './secCoverageRegistry.js';
import { normalizeSecCoverageCik, normalizeSecCoverageTicker } from './secCoverageMembership.js';

export const SEC_DOCUMENT_VERSION = 'sec-documents-v1';
export const SEC_DOCUMENT_MAX_BYTES = 24 * 1024 * 1024;
export const SEC_DOCUMENT_TTL_MS = 25 * 3600 * 1000;
const MAX_STALE_MS = 7 * 86400 * 1000;

// Deliberately small initial cohort, not a claim about measured popularity.
// Apple has a September year end, Microsoft a June year end, JPM is a bank,
// and ACME United is a smaller nonfinancial filer. Missing/revised facts use fixtures.
export const SEC_MIGRATION_COHORT = Object.freeze([
  { ticker: 'AAPL', cik: '0000320193' },
  { ticker: 'MSFT', cik: '0000789019' },
  { ticker: 'JPM', cik: '0000019617' },
  { ticker: 'ACU', cik: '0000002098' },
].map(Object.freeze));
const pilotCiks = new Set(SEC_MIGRATION_COHORT.map(({ cik }) => cik));
// Existing, independently verified XOM predecessor/joint-filer evidence.
// This extends source history without creating another universe constituent.
export const SEC_SUPPORTING_SOURCE_CIKS = Object.freeze(['0000034088']);
export const SEC_PREPARED_COHORT = Object.freeze([...SEC_COVERAGE_COHORT,
  ...SEC_MIGRATION_COHORT.filter(company => !getSecCoverageCompany(company.cik)),
]);
function pilotCompany(value) {
  const cik = normalizeSecCoverageCik(value), ticker = normalizeSecCoverageTicker(value);
  return SEC_MIGRATION_COHORT.find(company => company.cik === cik || company.ticker === ticker) || null;
}
export function getSecPreparedCompany(value) {
  return getAdmittedSecCoverageCompany(value) || pilotCompany(value);
}
export function getActiveSecPreparedCompany(value) {
  const active = getActiveSecCoverageCompany(value);
  if (active) return active;
  const pilot = pilotCompany(value);
  return !isBroadSecCoverageEnabled() || pilot?.ticker === 'ACU' ? pilot : null;
}
export function isSecPreparedReadEnabled(cik, env = process.env) {
  if (!isBroadSecCoverageEnabled(env)) return pilotCiks.has(cik);
  return cik === '0000002098' || isActiveSecCoverageCik(cik)
    || (SEC_SUPPORTING_SOURCE_CIKS.includes(cik) && isActiveSecCoverageCik('0002115436'));
}

export function secDocumentIdentity(path) {
  const submission = /^\/submissions\/CIK(\d{10})\.json$/.exec(path);
  const facts = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
  const cik = submission?.[1] || facts?.[1];
  if (!cik || Number(cik) === 0) return null;
  const resource = submission ? 'submissions' : 'companyfacts';
  return { cik, resource, path, sourceUrl: `https://data.sec.gov${path}`, key: `${SEC_DOCUMENT_VERSION}:CIK${cik}:${resource}`,
    covered: pilotCiks.has(cik) || isAdmittedSecCoverageCik(cik) || SEC_SUPPORTING_SOURCE_CIKS.includes(cik) };
}

export class PreparedSecUnavailableError extends Error {
  constructor(message = 'Prepared SEC data is not ready. Retry after the scheduled refresh.') {
    super(message);
    this.name = 'PreparedSecUnavailableError';
    this.status = 503;
    this.code = 'SEC_PREPARED_UNAVAILABLE';
  }
}

function validateDocument(payload, identity) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || String(payload.cik || '').replace(/^0+/, '') !== identity.cik.replace(/^0+/, '')) {
    throw new Error('SEC document identity failed validation.');
  }
  if (identity.resource === 'submissions' ? !payload.filings?.recent : !payload.facts) {
    throw new Error('SEC document contents failed validation.');
  }
  return payload;
}

export function preparedEnvelopeUsable(envelope, now = Date.now()) {
  const metadata = envelope?.metadata || {};
  const expires = Date.parse(metadata.expiresAt || '');
  const fetched = Date.parse(metadata.fetchedAt || '');
  const revalidated = Date.parse(metadata.revalidatedAt || metadata.fetchedAt || '');
  return Boolean(envelope?.payload && [expires, fetched, revalidated].every(Number.isFinite)
    && fetched <= revalidated && revalidated <= now + 60000 && expires >= revalidated && now <= expires + MAX_STALE_MS);
}

export function preparedDataHeaders(envelope, source = 'supabase') {
  const metadata = envelope.metadata || {};
  const stale = Boolean(envelope.stale || Date.parse(metadata.expiresAt || '') < Date.now());
  return {
    'X-Cache-Source': source,
    'X-Data-Stale': String(stale),
    ...(metadata.fetchedAt ? { 'X-Data-Fetched-At': metadata.fetchedAt } : {}),
    ...(metadata.revalidatedAt ? { 'X-Data-Revalidated-At': metadata.revalidatedAt } : {}),
    ...(stale ? { Warning: '110 - "Serving previously validated SEC data"' } : {}),
  };
}

// Do not let edge stale-if-error extend a labeled last-good response beyond the
// origin's age bound, or keep a fresh label after its validation has expired.
export function preparedCacheControl(envelope, { maxAge = 60, sharedMaxAge = 300, now = Date.now() } = {}) {
  const expires = Date.parse(envelope.metadata.expiresAt);
  const stale = expires <= now;
  const remaining = Math.max(0, Math.floor(((stale ? expires + MAX_STALE_MS : expires) - now) / 1000));
  return `public, max-age=${Math.min(maxAge, remaining)}, s-maxage=${Math.min(stale ? 60 : sharedMaxAge, remaining)}`;
}

/** A cohort miss/outage never calls SEC from an ordinary prepared-data read. */
export async function readPreparedSecDocument(path, {
  mode = getDataStoreMode('sec'), read = readDataset, now = Date.now(), allowStale = true,
  readEnabled = isSecPreparedReadEnabled, loadRegistry = loadSecCoverageRegistry,
} = {}) {
  if (mode !== 'supabase') return null;
  await loadRegistry();
  const identity = secDocumentIdentity(path);
  if (!identity?.covered || !readEnabled(identity.cik)) return null;
  let envelope;
  try { envelope = await read('sec', identity.key, { allowStale: true }); }
  catch { throw new PreparedSecUnavailableError('Prepared SEC storage is temporarily unavailable.'); }
  if (!preparedEnvelopeUsable(envelope, now)) throw new PreparedSecUnavailableError();
  if (!allowStale && Date.parse(envelope.metadata.expiresAt) <= now) throw new PreparedSecUnavailableError('Prepared SEC research input requires revalidation.');
  try { validateDocument(envelope.payload, identity); } catch { throw new PreparedSecUnavailableError('Prepared SEC data failed identity validation.'); }
  return envelope;
}

const sampled = new Map();
/** Only like-for-like source documents are compared. No public-request writes. */
export async function sampleSecShadow(path, legacyPayload, {
  mode = getDataStoreMode('sec'), read = readDataset, now = Date.now(), report = (event) => console.info('[dataStore.shadow]', JSON.stringify(event)),
} = {}) {
  const identity = secDocumentIdentity(path);
  if (mode !== 'shadow' || !identity?.covered || now - (sampled.get(identity.key) || 0) < 300_000) return null;
  sampled.set(identity.key, now);
  try {
    const stored = await read('sec', identity.key, { allowStale: true });
    const status = !stored ? 'not-prepared'
      : stableDataStoreJson(stored.payload) === stableDataStoreJson(legacyPayload) ? 'identical' : 'different-source-version';
    report({ dataset: 'sec', key: identity.key, status });
    return status;
  } catch { report({ dataset: 'sec', key: identity.key, status: 'storage-unavailable' }); return 'storage-unavailable'; }
}

async function boundedResponseBytes(response) {
  if (Number(response.headers.get('content-length') || 0) > SEC_DOCUMENT_MAX_BYTES) throw new Error('SEC document exceeds migration size limit.');
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.text());
    if (bytes.length > SEC_DOCUMENT_MAX_BYTES) throw new Error('SEC document exceeds migration size limit.');
    return bytes;
  }
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SEC_DOCUMENT_MAX_BYTES) { await reader.cancel(); throw new Error('SEC document exceeds migration size limit.'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

/** Operator/job only. Lease precedes transport, which retains the global gate. */
export async function refreshSecDocument(path, {
  signal, mode = getDataStoreMode('sec'), read = readDataset,
  begin = beginDatasetWrite, publish = publishDataset, revalidate = revalidateDataset,
  release = releaseDatasetWrite, reserveLegacy = warmReserveGeneration, legacyWrite = warmSetGeneration,
  fetchSec = secFetch, now = () => Date.now(), minRecheckAgeMs = 0,
  loadRegistry = loadSecCoverageRegistry,
} = {}) {
  if (mode !== 'off') await loadRegistry({ required: true });
  const identity = secDocumentIdentity(path);
  if (!identity?.covered) throw new Error('SEC migration refresh is limited to the documented cohort and primary JSON resources.');
  if (mode === 'off') return { status: 'off', identity };
  const claim = await begin('sec', identity.key, { leaseSeconds: 120 });
  if (!claim) return { status: 'busy', identity };
  try {
  // Keep the verified pilot rollback mirrors. The broad archive belongs in
  // Storage; copying every multi-megabyte document into Redis defeats its role.
  const mirrors = pilotCiks.has(identity.cik) ? [['research-sec-v1', path, 300], ...(identity.resource === 'submissions' ? [['submissions-cik', identity.cik, 25 * 3600]] : [])] : [];
  for (const [type] of mirrors) await reserveLegacy(type, identity.key, claim.generation, claim);
  const mirror = async (payload) => {
    const results = [];
    for (const [type, key, ttl] of mirrors) results.push({ type, stored: await legacyWrite(type, key, payload, ttl, { ...claim, fenceId: identity.key }) });
    return results;
  };
  const previous = await read('sec', identity.key, { allowStale: true });
  if (Number.isFinite(minRecheckAgeMs) && minRecheckAgeMs > 0 && minRecheckAgeMs <= 20 * 3600000
    && preparedEnvelopeUsable(previous, now()) && Date.parse(previous.metadata.expiresAt) > now()
    && now() - Date.parse(previous.metadata.revalidatedAt || previous.metadata.fetchedAt) < minRecheckAgeMs) {
    await release('sec', identity.key, claim);
    return { status: 'current', identity, envelope: previous, rollback: [] };
  }
  const headers = { Accept: 'application/json' };
  if (previous?.metadata?.etag) headers['If-None-Match'] = previous.metadata.etag;
  if (previous?.metadata?.lastModified) headers['If-Modified-Since'] = previous.metadata.lastModified;
  const response = await fetchSec(identity.sourceUrl, { headers, signal, timeoutMs: 12000, retries: 0, cache: 'no-store' });
  const revalidatedAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + SEC_DOCUMENT_TTL_MS).toISOString();
  const validators = { etag: response.headers.get('etag') || (response.status === 304 ? previous?.metadata?.etag : null) || null,
    lastModified: response.headers.get('last-modified') || (response.status === 304 ? previous?.metadata?.lastModified : null) || null };
  if (response.status === 304) {
    if (!previous) throw new Error('SEC returned 304 without preserved source evidence.');
    if (await revalidate('sec', identity.key, { claim, revalidatedAt, expiresAt, ...validators }) !== true) throw new Error('SEC revalidation lost its publication claim.');
    return { status: 'unchanged', identity, rollback: await mirror(previous.payload), envelope: { ...previous, stale: false, metadata: { ...previous.metadata, revalidatedAt, expiresAt, ...validators } } };
  }
  if (!response.ok) {
    const error = new Error(`SEC document refresh returned HTTP ${response.status}.`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  }
  const bytes = await boundedResponseBytes(response);
  const payload = validateDocument(JSON.parse(bytes.toString('utf8')), identity);
  const documentContentHash = createHash('sha256').update(bytes).digest('hex');
  if (previous?.metadata?.documentContentHash === documentContentHash) {
    if (await revalidate('sec', identity.key, { claim, revalidatedAt, expiresAt, ...validators }) !== true) throw new Error('SEC revalidation lost its publication claim.');
    return { status: 'unchanged', identity, rollback: await mirror(previous.payload), envelope: { ...previous, stale: false, metadata: { ...previous.metadata, revalidatedAt, expiresAt, ...validators } } };
  }
  const metadata = {
    sourceId: 'sec-edgar', sourceUrl: identity.sourceUrl, entityId: identity.cik,
    resource: identity.resource, parserVersion: SEC_DOCUMENT_VERSION,
    fetchedAt: revalidatedAt, revalidatedAt, expiresAt,
    // SEC does not provide a publication time for the whole companyfacts file.
    publishedAt: null, documentContentHash, ...validators,
  };
  const envelope = await publish({ dataset: 'sec', key: identity.key, claim, payload, metadata,
    source: { bytes, url: identity.sourceUrl, fetchedAt: revalidatedAt, contentType: 'application/json' }, kind: 'source-document' });
  return { status: 'updated', identity, envelope, rollback: await mirror(payload) };
  } catch (error) {
    await release('sec', identity.key, claim).catch(() => false);
    throw error;
  }
}
