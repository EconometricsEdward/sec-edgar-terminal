import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { warmGet, warmSet, warmLegacyGet, warmLegacyGetEnvelope } from './warmCache.js';
import { cacheGet, cachePut, disposableCacheEnabled } from './disposableCache.js';

const CHUNK_SIZE = 400_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TTL = 7 * 86400;
const FORMAT = 'gzip-chunks-v1';
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const digest = value => createHash('sha256').update(value).digest('hex');

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return null;
    const raw = Buffer.from(serialized);
    return raw.length > 0 && raw.length <= MAX_BYTES ? raw : null;
  } catch { return null; }
}

function snapshotEnvelopeUsable(envelope, now) {
  if (!envelope || !HASH.test(envelope.rawSha256 || '') || !(Date.parse(envelope.expiresAt) > now)
    || envelope.payload?.format === FORMAT) return false;
  const raw = jsonBytes(envelope.payload);
  return Boolean(raw && digest(raw) === envelope.rawSha256
    && (envelope.rawBytes === undefined || envelope.rawBytes === raw.length));
}

function publicationTime(value) {
  const timestamp = value?.generatedAt ?? value?.generated_at;
  return typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
}

/**
 * Production stores one complete compressed row. CAS prevents concurrent
 * writers from replacing an intervening publication. Cache failure leaves the
 * prior snapshot intact and never starts another Redis chunk generation.
 */
export async function writeSnapshot(type, id, value, ttl = MAX_TTL, {
  set = warmSet, signal, deadline = Infinity,
  cacheEnabled = disposableCacheEnabled(), cacheRead = cacheGet, cacheWrite = cachePut,
  now = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL || signal?.aborted || now() > deadline - 6000) return false;
  const raw = jsonBytes(value);
  if (!raw) return false;
  if (cacheEnabled) {
    try {
      const current = await cacheRead(type, id, { signal, deadline });
      if (current && !snapshotEnvelopeUsable(current, now())) return false;
      // A late scheduler must not roll the visible observation date backward.
      if (current && publicationTime(current.payload) > publicationTime(value)) return false;
      if (signal?.aborted || now() > deadline - 6000) return false;
      const result = await cacheWrite(type, id, value, ttl, {
        ifHash: current?.rawSha256 || 'absent', signal, deadline,
      });
      return result?.stored === true;
    } catch { return false; }
  }

  // Local/legacy compatibility uses content-addressed compressed chunks.
  // Republishing identical content reuses keys. The fixed chunk lifetime is
  // longer than every permitted manifest lifetime, so a shorter publication
  // cannot shorten the life of chunks still referenced by another reader.
  const encoded = gzipSync(raw).toString('base64');
  const generation = digest(encoded);
  const ids = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
    if (signal?.aborted || now() > deadline - 6000) return false;
    const chunkId = `${id}:${generation}:${ids.length}`;
    if (!await set(`${type}:chunks`, chunkId, encoded.slice(offset, offset + CHUNK_SIZE), MAX_TTL + 3600)) return false;
    ids.push(chunkId);
  }
  if (signal?.aborted || now() > deadline - 6000) return false;
  return set(type, id, { format: FORMAT, ids, bytes: raw.length, sha256: digest(raw) }, ttl);
}

function validManifest(manifest, id) {
  if (!Array.isArray(manifest.ids) || !manifest.ids.length || manifest.ids.length > 100
    || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_BYTES
    || !HASH.test(manifest.sha256 || '')) return false;
  const first = manifest.ids[0];
  if (typeof first !== 'string' || !first.startsWith(`${id}:`) || !first.endsWith(':0')) return false;
  const generation = first.slice(id.length + 1, -2);
  return GENERATION.test(generation) && manifest.ids.every((key, index) => key === `${id}:${generation}:${index}`);
}

/**
 * A legacy read may still serve a complete validated snapshot when TTL
 * inspection is unavailable. Only reads with TTL evidence for every component
 * receive an expiresAt and can be imported into the replacement cache.
 */
export async function readLegacySnapshot(type, id, {
  get = warmLegacyGet, getEnvelope = null, now = () => Date.now(),
} = {}) {
  let expiresAt = Infinity, hasExpiry = typeof getEnvelope === 'function';
  const read = async (namespace, key) => {
    if (getEnvelope) {
      try {
        const envelope = await getEnvelope(namespace, key);
        const expiry = Number(envelope?.observedAt) + Number(envelope?.ttlMs);
        if (envelope && Number.isFinite(expiry) && envelope.ttlMs > 0) {
          expiresAt = Math.min(expiresAt, expiry);
          return envelope.payload;
        }
      } catch { /* A failed TTL inspection does not invalidate a legacy read. */ }
      hasExpiry = false;
    }
    return get(namespace, key);
  };
  try {
    const manifest = await read(type, id);
    if (manifest == null) return null;
    let payload = manifest, raw;
    if (manifest?.format === FORMAT) {
      if (!validManifest(manifest, id)) return null;
      const chunks = [];
      for (let i = 0; i < manifest.ids.length; i += 4) {
        const part = await Promise.all(manifest.ids.slice(i, i + 4).map(key => read(`${type}:chunks`, key)));
        if (part.some(value => typeof value !== 'string' || !value.length || value.length > CHUNK_SIZE)) return null;
        chunks.push(...part);
      }
      raw = gunzipSync(Buffer.from(chunks.join(''), 'base64'), { maxOutputLength: MAX_BYTES });
      if (raw.length !== manifest.bytes || digest(raw) !== manifest.sha256) return null;
      payload = JSON.parse(raw.toString('utf8'));
    } else {
      raw = jsonBytes(payload);
      if (!raw) return null;
    }
    // Reject a generation whose known lifetime ended while chunks were read.
    if (hasExpiry && expiresAt <= now()) return null;
    return { payload, rawSha256: digest(raw), expiresAt: hasExpiry && Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null };
  } catch { return null; }
}

/** A partial/corrupt generation is a miss, never a partial analytical result. */
export async function readSnapshot(type, id, {
  get = warmGet, cacheEnabled = disposableCacheEnabled(), cacheRead = cacheGet, cacheWrite = cachePut,
  legacyGet = warmLegacyGet, legacyEnvelope = warmLegacyGetEnvelope, now = () => Date.now(),
} = {}) {
  if (!cacheEnabled) return (await readLegacySnapshot(type, id, { get, now }))?.payload ?? null;
  try {
    const current = await cacheRead(type, id);
    if (snapshotEnvelopeUsable(current, now())) return current.payload;
  } catch { /* A validated legacy snapshot remains a migration fallback. */ }
  const legacy = await readLegacySnapshot(type, id, { get: legacyGet, getEnvelope: legacyEnvelope, now });
  if (!legacy) {
    // Migration can publish the complete row after our initial miss and retire
    // Redis chunks while this reader is assembling their old manifest. Check
    // the atomic replacement once before reporting a missing snapshot.
    try {
      const replacement = await cacheRead(type, id);
      if (snapshotEnvelopeUsable(replacement, now())) return replacement.payload;
    } catch { /* Both cache paths are unavailable. */ }
    return null;
  }
  const ttl = Math.min(MAX_TTL, Math.floor((Date.parse(legacy.expiresAt) - now()) / 1000));
  if (Number.isSafeInteger(ttl) && ttl > 0) {
    try { await cacheWrite(type, id, legacy.payload, ttl, { ifHash: 'absent', expiresAt: legacy.expiresAt }); }
    catch { /* Read availability does not depend on copying a cache entry. */ }
  }
  return legacy.payload;
}
