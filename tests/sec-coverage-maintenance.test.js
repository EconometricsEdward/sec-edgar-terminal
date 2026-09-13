import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { maintainSecCoverageMembership } from '../src/utils/secCoverageMaintenance.js';

const clock = Date.parse('2026-09-13T12:00:00Z');
const claim = { owner: '00000000-0000-4000-8000-000000000001', generation: 1 };
const issuers = ['0000000001', '0000000002', '0000000003'].map((cik, index) => ({ cik, ticker: `X${index}` }));
const active = { id: 'old', reference: { asOf: '2026-09-08' }, issuers };
const candidate = { id: 'new', reference: { asOf: '2026-09-10' }, issuers };
function fixture(overrides = {}) {
  const calls = [];
  const deps = { now: () => clock, begin: async () => claim,
    load: async options => { assert.equal(options.required, true); return { active, candidate }; },
    source: async () => { throw new Error('Unexpected download'); },
    stage: async () => { throw new Error('Unexpected staging'); },
    activate: async (_, id) => { assert.equal(id, candidate.id); return { activated: true, activeId: id, candidateId: null, neededCiks: [] }; },
    refresh: async cik => { calls.push(['refresh', cik]); return { status: 'prepared', cik }; },
    finish: async (lease, error) => { assert.deepEqual(lease, claim); calls.push(['finish', error]); return true; }, ...overrides };
  return { calls, run: () => maintainSecCoverageMembership({ deadline: clock + 125000 }, deps) };
}

test('not-due checks do not download, prepare, or release another worker lease', async () => {
  const { calls, run } = fixture({ begin: async () => null });
  assert.deepEqual(await run(), { status: 'not-due' });
  assert.deepEqual(calls, []);
});

test('ready candidate activates without repeating preparation', async () => {
  const { calls, run } = fixture();
  assert.equal((await run()).status, 'activated');
  assert.deepEqual(calls, [['finish', null]]);
});

test('candidate preparation is bounded to two stable CIKs and activation is rechecked', async () => {
  let checks = 0;
  const { calls, run } = fixture({ activate: async () => {
    checks++;
    return { activated: false, activeId: 'old', candidateId: 'new', neededCiks: checks === 1 ? issuers.map(row => row.cik) : ['0000000003'] };
  } });
  const result = await run();
  assert.equal(result.status, 'preparing'); assert.equal(result.remaining, 1); assert.equal(checks, 2);
  assert.deepEqual(calls, [['refresh', '0000000001'], ['refresh', '0000000002'], ['finish', null]]);
});

test('a failing issuer does not stop the other bounded preparation or expose exception text', async () => {
  const { calls, run } = fixture({
    activate: async () => ({ activated: false, activeId: 'old', candidateId: 'new', neededCiks: issuers.map(row => row.cik) }),
    refresh: async cik => { if (cik === '0000000001') throw new Error('Private response body'); return { status: 'prepared', cik }; },
  });
  const result = await run();
  assert.equal(result.activeId, 'old'); assert.equal(result.prepared.length, 2);
  assert.equal(result.prepared[0].code, 'membership_check_failed');
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.deepEqual(calls, [['finish', 'membership_check_failed']]);
});

test('unapproved or mismatched preparation identities cannot silently succeed', async () => {
  const { run } = fixture({ activate: async () => ({ activated: false, neededCiks: ['9999999999'] }) });
  assert.equal((await run()).code, 'membership_preparation_identity_invalid');
  const mismatch = fixture({ activate: async () => ({ activated: false, neededCiks: ['0000000001'], activeId: 'old' }),
    refresh: async () => ({ status: 'prepared', cik: '9999999999' }) });
  assert.equal((await mismatch.run()).prepared[0].code, 'membership_preparation_identity_invalid');
});

test('source evidence is hash verified and compressed before fenced staging', async () => {
  const bytes = Buffer.from('official CSV fixture');
  const sha = createHash('sha256').update(bytes).digest('hex');
  let staged = false;
  const { run } = fixture({ load: async () => ({ active, candidate: staged ? candidate : null }),
    source: async options => { assert.equal(options.previous, active); assert.equal(options.deadline, clock + 45000);
      return { candidate, sourceBytes: bytes, sourceSha256: sha }; },
    stage: async (lease, snapshot, evidence) => {
      assert.deepEqual(lease, claim); assert.equal(snapshot, candidate);
      assert.deepEqual(gunzipSync(Buffer.from(evidence.gzipBase64, 'base64')), bytes);
      assert.equal(evidence.rawSha256, sha); assert.equal(evidence.rawBytes, bytes.length); staged = true;
    } });
  assert.equal((await run()).status, 'activated'); assert.equal(staged, true);
});

test('expired candidates are replaced through fresh validation and failed source leaves active intact', async () => {
  let downloads = 0;
  const { calls, run } = fixture({ load: async () => ({ active, candidate: { ...candidate, reference: { asOf: '2026-08-01' } } }),
    source: async () => { downloads++; throw Object.assign(new Error('Untrusted'), { code: 'stale_source' }); } });
  assert.deepEqual(await run(), { status: 'failed', code: 'stale_source' });
  assert.equal(downloads, 1); assert.deepEqual(calls, [['finish', 'stale_source']]);
});

test('deadline and lease loss are explicit and bounded', async () => {
  let began = false;
  assert.equal((await maintainSecCoverageMembership({ deadline: clock + 1000 }, { now: () => clock,
    begin: async () => { began = true; } })).status, 'deferred');
  assert.equal(began, false);
  assert.equal((await fixture({ finish: async () => false }).run()).code, 'membership_lease_lost');
});

test('candidate expiry uses the same UTC date boundary as SQL', async () => {
  const boundary = { ...candidate, reference: { asOf: '2026-08-30' } };
  const { run } = fixture({ load: async () => ({ active, candidate: boundary }) });
  assert.equal((await run()).status, 'activated');
});

test('unsafe error code punctuation cannot prevent lease release', async () => {
  const { calls, run } = fixture({ load: async () => { throw Object.assign(new Error('Failure'), { code: 'upstream-error' }); } });
  assert.equal((await run()).code, 'membership_check_failed');
  assert.deepEqual(calls, [['finish', 'membership_check_failed']]);
});
