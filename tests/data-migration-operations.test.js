import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorizeDataMigration, parseMigrationOperation, readMigrationOperation, migrationRetrySeconds, migrationOperationEnabled } from '../src/utils/dataMigrationOperations.js';
import { POST } from '../src/app/api/internal/data-migration/route.js';

const authorizationRequest = token => new Request('http://localhost/api/internal/data-migration', { headers: { authorization: token } });

test('migration operations deny missing, mismatched, and weak authorization', () => {
  const secret = 'test-only-operational-secret';
  const request = token => new Request('http://localhost/api/internal/data-migration', { headers: { authorization: token } });
  assert.equal(authorizeDataMigration(request('')), false);
  assert.equal(authorizeDataMigration(request('Bearer incorrect'), secret), false);
  assert.equal(authorizeDataMigration(request('Bearer short'), 'short'), false);
  assert.equal(authorizeDataMigration(request(`Bearer ${secret}`), secret), true);
});

test('temporary operator credential is production-only and expires at the exact deadline', () => {
  const token = 'test-only-bootstrap-token-with-adequate-length';
  const bootstrap = { sha256: createHash('sha256').update(token).digest('hex'), expiresAt: '2026-09-13T09:00:00Z' };
  const expiresAt = Date.parse(bootstrap.expiresAt);
  const request = authorizationRequest(`Bearer ${token}`);
  const production = { env: { VERCEL_ENV: 'production' }, bootstrap, now: expiresAt - 1 };
  assert.equal(authorizeDataMigration(request, undefined, production), true);
  for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }]) {
    assert.equal(authorizeDataMigration(request, undefined, { ...production, env }), false);
  }
  for (const now of [expiresAt, expiresAt + 1, NaN]) {
    assert.equal(authorizeDataMigration(request, undefined, { ...production, now }), false);
  }
  assert.equal(authorizeDataMigration(authorizationRequest(`Bearer ${token}x`), undefined, production), false);
  assert.equal(authorizeDataMigration(authorizationRequest(`Bearer ${token} extra`), undefined, production), false);
  assert.equal(authorizeDataMigration(authorizationRequest(`Basic ${token}`), undefined, production), false);
});

test('malformed or removed bootstrap configuration denies access without affecting CRON_SECRET', () => {
  const token = 'test-only-bootstrap-token-with-adequate-length';
  const request = authorizationRequest(`Bearer ${token}`);
  const validHash = createHash('sha256').update(token).digest('hex');
  const options = { env: { VERCEL_ENV: 'production' }, now: Date.parse('2026-09-13T08:00:00Z') };
  for (const bootstrap of [null, {}, { sha256: validHash, expiresAt: 'invalid' },
    { sha256: validHash.slice(1), expiresAt: '2026-09-13T09:00:00Z' },
    { sha256: 'g'.repeat(64), expiresAt: '2026-09-13T09:00:00Z' },
    { sha256: '', expiresAt: '2026-09-13T09:00:00Z' }]) {
    assert.equal(authorizeDataMigration(request, undefined, { ...options, bootstrap }), false);
  }
  assert.equal(authorizeDataMigration(request, token, { ...options, bootstrap: null, env: { VERCEL_ENV: 'preview' } }), true);
});

test('operator cannot submit arbitrary datasets, URLs, cursors, or unbounded work', () => {
  for (const value of [null, [], { action: 'refresh-sec', cursor: 99 }, { action: 'delete' }, { action: 'refresh-sec', maxCompanies: 3 }, { action: 'refresh-sec', maxCompanies: 0 },
    { action: 'refresh-cftc', maxCompanies: 1 }, { action: 'refresh-cftc', url: 'https://example.test' }, { action: 'refresh-cftc', family: 'tff' }]) {
    assert.throws(() => parseMigrationOperation(value));
  }
  assert.deepEqual(parseMigrationOperation({ action: 'refresh-sec' }), { action: 'refresh-sec', maxCompanies: 1 });
  assert.deepEqual(parseMigrationOperation({ action: 'refresh-sec', maxCompanies: 2 }), { action: 'refresh-sec', maxCompanies: 2 });
  assert.deepEqual(parseMigrationOperation({ action: 'refresh-cftc' }), { action: 'refresh-cftc' });
});

test('CFTC and SEC financial operator work respect their independent dataset switches', () => {
  const cftcOnly = dataset => dataset === 'cftc' ? 'shadow' : 'off';
  const secOnly = dataset => dataset === 'cftc' ? 'off' : 'supabase';
  assert.equal(migrationOperationEnabled({ action: 'refresh-cftc' }, cftcOnly), true);
  assert.equal(migrationOperationEnabled({ action: 'refresh-sec' }, cftcOnly), false);
  assert.equal(migrationOperationEnabled({ action: 'refresh-cftc' }, secOnly), false);
  assert.equal(migrationOperationEnabled({ action: 'refresh-sec' }, secOnly), true);
  assert.equal(migrationOperationEnabled({ action: 'refresh-sec' }, dataset => dataset === 'financial' ? 'off' : 'shadow'), false);
  assert.equal(migrationOperationEnabled({ action: 'delete' }, () => 'supabase'), false);
});

test('operator route rejects malformed work and honors explicit dataset shutdown before dispatch', async () => {
  const settings = { CRON_SECRET: 'test-only-operation-route-secret', VERCEL_ENV: 'production',
    EDGAR_DATASTORE_CFTC: 'off', EDGAR_DATASTORE_SEC: 'off', EDGAR_DATASTORE_FINANCIAL: 'off' };
  const original = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    const invoke = body => POST(new Request('http://localhost/api/internal/data-migration', {
      method: 'POST', headers: { authorization: `Bearer ${settings.CRON_SECRET}` }, body: JSON.stringify(body),
    }));
    const malformed = await invoke({ action: 'refresh-cftc', maxCompanies: 2 });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('cache-control'), 'private, no-store');
    for (const action of ['refresh-sec', 'refresh-cftc']) {
      const response = await invoke({ action });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.status, 'disabled');
      assert.match(body.reason, action === 'refresh-cftc' ? /CFTC/ : /SEC and financial/);
    }
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('job retry preserves long provider Retry-After and adds bounded exponential backoff', () => {
  assert.equal(migrationRetrySeconds({ retryAfter: '7200' }, 2), 7200);
  assert.equal(migrationRetrySeconds({ retryAfter: 'Thu, 01 Jan 2026 02:00:00 GMT' }, 2, Date.parse('2026-01-01T00:00:00Z')), 7200);
  assert.ok(migrationRetrySeconds({}, 2) >= 60);
  assert.ok(migrationRetrySeconds({}, 2) < 70);
});

test('operation body is bounded even with no Content-Length', async () => {
  await assert.rejects(() => readMigrationOperation(new Request('http://localhost/', { method: 'POST', body: 'x'.repeat(1025) })), /exceeds/);
  assert.deepEqual(await readMigrationOperation(new Request('http://localhost/', { method: 'POST', body: '{"action":"refresh-sec"}' })), { action: 'refresh-sec', maxCompanies: 1 });
  assert.deepEqual(await readMigrationOperation(new Request('http://localhost/', { method: 'POST', body: '{"action":"refresh-cftc"}' })), { action: 'refresh-cftc' });
});
