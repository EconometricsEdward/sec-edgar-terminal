import { createHash, timingSafeEqual } from 'node:crypto';
import { MIGRATION_BOOTSTRAP } from './dataStoreDeployment.js';

/** Administrative operations are never a public refresh queue. */
export function authorizeDataMigration(request, secret = process.env.CRON_SECRET, {
  env = process.env, bootstrap = MIGRATION_BOOTSTRAP, now = Date.now(),
} = {}) {
  const authorization = request.headers.get('authorization') || '';
  if (typeof secret === 'string' && secret.length >= 16) {
    const supplied = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${secret}`);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  // This short-lived operator credential authorizes this endpoint only. Neither
  // its plaintext nor a privileged database credential is bundled or returned.
  const expiresAt = Date.parse(bootstrap?.expiresAt);
  if (env.VERCEL_ENV !== 'production' || !Number.isFinite(now)
    || !Number.isFinite(expiresAt) || now >= expiresAt
    || !/^[a-f0-9]{64}$/.test(bootstrap?.sha256 || '')) return false;
  const token = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(authorization)?.[1];
  if (!token) return false;
  return timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(bootstrap.sha256, 'hex'));
}

export function parseMigrationOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['action', 'maxCompanies'].includes(key))) throw new Error('Unsupported operation.');
  if (value.action === 'refresh-cftc') {
    if (Object.keys(value).length !== 1) throw new Error('refresh-cftc accepts no additional arguments.');
    return { action: 'refresh-cftc' };
  }
  if (value.action !== 'refresh-sec') throw new Error('Use refresh-sec or refresh-cftc.');
  const maxCompanies = value.maxCompanies ?? 1;
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 2) throw new Error('maxCompanies must be 1 or 2.');
  return { action: value.action, maxCompanies };
}

/** Dataset switches remain independent for bounded operator refreshes. */
export function migrationOperationEnabled(operation, getMode) {
  const datasets = operation.action === 'refresh-cftc' ? ['cftc']
    : operation.action === 'refresh-sec' ? ['sec', 'financial'] : [];
  return datasets.length > 0 && datasets.every(dataset => getMode(dataset) !== 'off');
}

export async function readMigrationOperation(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing operation.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new Error('Operation body exceeds limit.'); }
      chunks.push(Buffer.from(value));
    }
    return parseMigrationOperation(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
  } finally { reader.releaseLock(); }
}

export function migrationRetrySeconds(error, attempts = 1, now = Date.now()) {
  const raw = error?.retryAfter;
  const seconds = raw && /^\d+$/.test(String(raw)) ? Number(raw)
    : raw && Number.isFinite(Date.parse(raw)) ? Math.ceil((Date.parse(raw) - now) / 1000) : 0;
  // Retry-After is a lower bound; never shorten a provider cooldown.
  return Math.max(1, seconds, Math.min(3600, 15 * (2 ** Math.min(8, attempts))) + Math.floor(Math.random() * 10));
}
