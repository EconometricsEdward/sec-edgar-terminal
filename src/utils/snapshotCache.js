import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { warmGet, warmSet } from './warmCache.js';

const CHUNK_SIZE = 400_000;
const MAX_BYTES = 32 * 1024 * 1024;
const FORMAT = 'gzip-chunks-v1';
const digest = value => createHash('sha256').update(value).digest('hex');

/** Immutable chunks first; the small manifest is the only publication switch. */
export async function writeSnapshot(type, id, value, ttl = 7 * 86400, { get: _get = warmGet, set = warmSet, signal, deadline = Infinity } = {}) {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length > MAX_BYTES) return false;
  const encoded = gzipSync(raw).toString('base64');
  const generation = randomUUID();
  const ids = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
    if(signal?.aborted||Date.now()>deadline-6000)return false;
    const chunkId = `${id}:${generation}:${ids.length}`;
    if (!await set(`${type}:chunks`, chunkId, encoded.slice(offset, offset + CHUNK_SIZE), ttl + 3600)) return false;
    ids.push(chunkId);
  }
  if(signal?.aborted||Date.now()>deadline-6000)return false;
  return set(type, id, { format: FORMAT, ids, bytes: raw.length, sha256: digest(raw) }, ttl);
}

/** A partial/corrupt generation is a miss, never a partial analytical result. */
export async function readSnapshot(type, id, { get = warmGet } = {}) {
  const manifest = await get(type, id);
  if (manifest?.format !== FORMAT) return manifest;
  if (!Array.isArray(manifest.ids) || !manifest.ids.length || manifest.ids.length > 100 || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_BYTES) return null;
  try {
    const chunks = [];
    for (let i = 0; i < manifest.ids.length; i += 4) {
      const part = await Promise.all(manifest.ids.slice(i, i + 4).map(key => get(`${type}:chunks`, key)));
      if (part.some(v => typeof v !== 'string' || v.length > CHUNK_SIZE)) return null;
      chunks.push(...part);
    }
    const raw = gunzipSync(Buffer.from(chunks.join(''), 'base64'), { maxOutputLength: MAX_BYTES });
    if (raw.length !== manifest.bytes || digest(raw) !== manifest.sha256) return null;
    return JSON.parse(raw.toString('utf8'));
  } catch { return null; }
}
