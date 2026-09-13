import { timingSafeEqual } from 'node:crypto';

/** Administrative operations are never a public refresh queue. */
export function authorizeDataMigration(request, secret = process.env.CRON_SECRET) {
  if (!secret || secret.length < 16) return false;
  const supplied = Buffer.from(request.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function parseMigrationOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['action', 'maxCompanies'].includes(key))
    || value.action !== 'refresh-sec') throw new Error('Use action refresh-sec and optional maxCompanies (1 or 2).');
  const maxCompanies = value.maxCompanies ?? 1;
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 2) throw new Error('maxCompanies must be 1 or 2.');
  return { action: value.action, maxCompanies };
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
