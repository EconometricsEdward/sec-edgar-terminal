import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/internal/data-migration/route.js';
import { SEC_COVERAGE_UNIVERSE } from '../src/utils/secCoverageUniverse.js';
import { secCoverageFingerprint } from '../src/utils/secCoverageMembership.js';

const secret = 'test-only-protected-status-credential';
const settings = { CRON_SECRET: secret, VERCEL_ENV: 'production', SUPABASE_URL: 'https://vvkihuduqqnxqahhbphs.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_fixture_only', EDGAR_DATASTORE_SEC: 'supabase', EDGAR_DATASTORE_FINANCIAL: 'supabase', EDGAR_DATASTORE_BROAD_COVERAGE: '1' };
function configure(t) {
  const original = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const request = (query = '', authorized = true) => new Request(`https://secedgarterminal.com/api/internal/data-migration${query}`, {
  headers: authorized ? { authorization: `Bearer ${secret}` } : {},
});

test('protected status rejects unauthenticated and arbitrary requests before reading membership or metrics', async t => {
  configure(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network must not be requested'); });
  for (const query of ['', '?financial=AAPL']) {
    const response = await GET(request(query, false));
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  assert.equal((await GET(request('?rawEvidence=1'))).status, 400);
  assert.equal(calls, 0);
});

test('protected status aggregates independent reads and exposes bounded membership health without raw evidence or issuer dumps', async t => {
  configure(t);
  const now = new Date().toISOString();
  const active = structuredClone(SEC_COVERAGE_UNIVERSE);
  const departed = structuredClone(active.issuers[0]);
  active.issuers[0] = { ...departed, cik: '0001999999', ticker: 'FIXTURE', aliases: ['FIXTURE'], name: 'Status test issuer' };
  active.securities = active.issuers.flatMap(row => row.aliases.map(ticker => ({ ticker, cik: row.cik })));
  active.membershipFingerprint = secCoverageFingerprint(active.issuers);
  active.id = `sec-coverage-v1:ivv:${active.reference.asOf}:${active.membershipFingerprint.slice(0, 16)}`;
  active.sourceSnapshot.path = 'raw-evidence-must-not-appear.csv';
  const registry = { schema: 1, active, candidate: null, retained: [departed],
    sourceEvidence: 'raw-evidence-must-not-appear',
    control: { nextCheckAt: now, lastCheckedAt: now, lastError: 'SOURCE_THROTTLED', errorCount: 1, preparationCursor: 5,
      leaseUntil: null, unexpectedCredential: 'control-secret-must-not-appear' } };
  const operations = { latest: { schema: 1, observedAt: now, coverageGroups: [{ prepared: 100, fresh: 98, stale: 2 }],
    work: { todayJobs: 32, pending: 0 }, cycles: [] }, history: [] };
  const calls = []; let concurrent = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const operation = url.split('/').at(-1); calls.push({ operation, params: JSON.parse(options.body) });
    concurrent++; peak = Math.max(peak, concurrent);
    await new Promise(resolve => setTimeout(resolve, 2)); concurrent--;
    if (operation === 'edgar_coverage_registry') return Response.json(registry);
    if (operation === 'edgar_coverage_operations') return Response.json(operations);
    if (operation === 'edgar_get_version') return Response.json(null);
    return Response.json({ status: 'fixture' });
  });
  const response = await GET(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const text = await response.text(); const payload = JSON.parse(text);
  assert.equal(payload.membership.active.id, active.id);
  assert.equal(payload.membership.active.issuerCount, 500);
  assert.equal(payload.membership.active.securityCount, 503);
  assert.equal(payload.membership.retainedCount, 1);
  assert.equal(payload.membership.control.lastError, 'SOURCE_THROTTLED');
  assert.equal(payload.membership.control.preparationCursor, 5);
  assert.deepEqual(payload.operations, operations);
  assert.equal(payload.operationsSummary.status, 'watch');
  assert.equal(payload.operationsSummary.capacity.status, 'unmeasured');
  assert.deepEqual(payload.alerts, { health: 'stored', notifications: 'unconfigured' });
  assert.doesNotMatch(text, /raw-evidence-must-not-appear|control-secret-must-not-appear|Status test issuer|sb_secret/);
  assert.equal(calls.length, 6); assert.ok(peak >= 4, 'independent status reads should overlap');
  assert.ok(calls.every(call => call.operation !== 'edgar_capture_coverage_operations'), 'reading status never writes a sample');
  const financial = await GET(request('?financial=FIXTURE&basis=annual'));
  assert.equal(financial.status, 404);
  assert.match(calls.at(-1).params.p_key, /CIK0001999999:annual:latest$/);
});
