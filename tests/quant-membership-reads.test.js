import test from 'node:test';
import assert from 'node:assert/strict';
import seed from '../src/data/quant-coverage.json' with { type: 'json' };
import { QUANT_COVERAGE_CACHE, readQuantMembership } from '../src/utils/quantCoverageServer.js';

const legacyCache = 'quant-coverage-v1';

test('valid current membership needs one cache read and never contacts legacy storage', async () => {
  const current = structuredClone(seed), calls = [];
  const read = async (type, id) => {
    calls.push([type, id]);
    if (type === legacyCache) throw new Error('Legacy storage must not be needed');
    return current;
  };
  assert.equal(await readQuantMembership({ read, production: true }), current);
  assert.deepEqual(calls, [[QUANT_COVERAGE_CACHE, 'membership']]);
});

test('missing or invalid current membership reads the preserved production fallback', async () => {
  const legacy = structuredClone(seed);
  for (const current of [null, { ...seed, rows: [] }]) {
    const calls = [];
    const read = async (type, id) => {
      calls.push([type, id]);
      return type === QUANT_COVERAGE_CACHE ? current : legacy;
    };
    assert.equal(await readQuantMembership({ read, production: true }), legacy);
    assert.deepEqual(calls, [[QUANT_COVERAGE_CACHE, 'membership'], [legacyCache, 'membership']]);
  }
});

test('nonproduction membership misses use the seed without reading production legacy data', async () => {
  for (const current of [null, { ...seed, rows: [] }]) {
    const calls = [];
    const read = async (type, id) => { calls.push([type, id]); return current; };
    assert.equal(await readQuantMembership({ read, production: false }), seed);
    assert.deepEqual(calls, [[QUANT_COVERAGE_CACHE, 'membership']]);
  }
});

test('invalid production cache candidates retain the checked-in seed fallback', async () => {
  const calls = [];
  const read = async (type, id) => { calls.push([type, id]); return { ...seed, rows: [] }; };
  assert.equal(await readQuantMembership({ read, production: true }), seed);
  assert.deepEqual(calls, [[QUANT_COVERAGE_CACHE, 'membership'], [legacyCache, 'membership']]);
});

test('cache read failures still reject without launching an additional fallback request', async () => {
  const unavailable = new Error('Cache unavailable'), calls = [];
  const read = async (type, id) => { calls.push([type, id]); throw unavailable; };
  await assert.rejects(readQuantMembership({ read, production: true }), error => error === unavailable);
  assert.deepEqual(calls, [[QUANT_COVERAGE_CACHE, 'membership']]);
});
