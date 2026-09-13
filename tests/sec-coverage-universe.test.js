import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import seed from '../src/data/quant-coverage.json' with { type: 'json' };
import { SEC_COVERAGE_UNIVERSE, SEC_COVERAGE_COHORT, getSecCoverageCompany } from '../src/utils/secCoverageUniverse.js';
import { buildSecCoverageUniverse, validateSecCoverageUniverse, secCoverageFingerprint, compareSecCoverageUniverses } from '../src/utils/secCoverageMembership.js';

const now = Date.parse('2026-09-13T12:00:00Z');
const sourceSha256 = 'a'.repeat(64);
const build = membership => buildSecCoverageUniverse(membership, { sourceSha256, now });

test('dated reference preserves all 503 securities and deduplicates 500 SEC issuers', async () => {
  assert.equal(SEC_COVERAGE_COHORT.length, 500);
  assert.equal(SEC_COVERAGE_UNIVERSE.securityCount, 503);
  assert.equal(new Set(SEC_COVERAGE_COHORT.map(row => row.cik)).size, 500);
  assert.equal(SEC_COVERAGE_COHORT.some(row => row.ticker === 'ACU'), false);
  assert.equal(SEC_COVERAGE_UNIVERSE.reference.fund, 'IVV');
  assert.equal(SEC_COVERAGE_UNIVERSE.reference.asOf, '2026-09-08');
  const bytes = await readFile(new URL('../src/data/quant-coverage.json', import.meta.url));
  assert.equal(SEC_COVERAGE_UNIVERSE.sourceSnapshot.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(build(seed).issuers, SEC_COVERAGE_COHORT);
  assert.equal(Object.isFrozen(SEC_COVERAGE_COHORT[0].aliases), true);
});

test('share classes and ticker formatting resolve the same canonical issuer without merging securities', () => {
  assert.equal(getSecCoverageCompany('GOOG'), getSecCoverageCompany('GOOGL'));
  assert.equal(getSecCoverageCompany('FOX'), getSecCoverageCompany('FOXA'));
  assert.equal(getSecCoverageCompany('NWS'), getSecCoverageCompany('NWSA'));
  assert.equal(getSecCoverageCompany('BRK.B'), getSecCoverageCompany('BRK-B'));
  assert.equal(getSecCoverageCompany(' brk b '), getSecCoverageCompany('BRK-B'));
  assert.equal(getSecCoverageCompany(320193), getSecCoverageCompany('AAPL'));
  assert.equal(getSecCoverageCompany('0000320193'), getSecCoverageCompany('AAPL'));
  assert.equal(getSecCoverageCompany('GOOG').ticker, 'GOOGL');
  assert.equal(SEC_COVERAGE_UNIVERSE.securities.filter(row => row.cik === getSecCoverageCompany('GOOG').cik).length, 2);
  for (const input of ['UNKNOWN', '0', '-1', '1e4', '../../AAPL', {}, null]) assert.equal(getSecCoverageCompany(input), null);
});

test('publication rejects incomplete, ambiguous, invalid, or wrongly attributed membership', () => {
  let changed = structuredClone(seed);
  changed.rows = changed.rows.filter(row => row.fund !== 'IVV' || row.ticker.startsWith('A'));
  assert.throws(() => build(changed), /security count|incomplete/);
  changed = structuredClone(seed);
  changed.rows.find(row => row.ticker === 'AAPL').aliases.push('GOOG');
  changed.sources.find(row => row.fund === 'IVV').securities++;
  assert.throws(() => build(changed), /ambiguous|duplicated/);
  changed = structuredClone(seed);
  changed.rows.find(row => row.ticker === 'AAPL').cik = '0000000000';
  assert.throws(() => build(changed), /identity/);
  changed = structuredClone(seed);
  changed.sources.find(row => row.fund === 'IVV').url = 'https://example.test/holdings';
  assert.throws(() => build(changed), /source/);
  changed = structuredClone(seed);
  changed.rows.find(row => row.ticker === 'GOOGL').aliases.pop();
  assert.throws(() => build(changed), /security count/);
});

test('fingerprints change when a share-class mapping changes, independent of row order', () => {
  assert.equal(secCoverageFingerprint([...SEC_COVERAGE_COHORT].reverse()), SEC_COVERAGE_UNIVERSE.membershipFingerprint);
  const changed = structuredClone(SEC_COVERAGE_UNIVERSE);
  changed.issuers.find(row => row.ticker === 'GOOGL').aliases = ['GOOGL'];
  assert.notEqual(secCoverageFingerprint(changed.issuers), SEC_COVERAGE_UNIVERSE.membershipFingerprint);
  assert.throws(() => validateSecCoverageUniverse(changed, { now }), /mapping|share class/);
  const tampered = structuredClone(SEC_COVERAGE_UNIVERSE);
  tampered.issuers[0].name = 'Another issuer';
  assert.throws(() => validateSecCoverageUniverse(tampered, { now }), /fingerprint/);
});

test('new snapshots require fresh dates while archived last-good membership remains readable', () => {
  const future = Date.parse('2026-12-01');
  assert.equal(validateSecCoverageUniverse(SEC_COVERAGE_UNIVERSE, { now: future }), SEC_COVERAGE_UNIVERSE);
  assert.throws(() => buildSecCoverageUniverse(seed, { sourceSha256, now: future }), /stale/);
  const changed = structuredClone(seed);
  changed.checked_at = '2026-09-20T00:00:00Z';
  assert.throws(() => build(changed), /dates/);
  assert.deepEqual(compareSecCoverageUniverses(SEC_COVERAGE_UNIVERSE, build(seed), { now }), { added: [], removed: [], changed: false });
});

test('review compares by CIK and rejects implausible membership turnover', () => {
  const changed = structuredClone(seed);
  let n = 0;
  for (const row of changed.rows) {
    if (row.fund === 'IVV' && n++ < 26) row.cik = String(9000000000 + n);
  }
  const next = build(changed);
  assert.throws(() => compareSecCoverageUniverses(SEC_COVERAGE_UNIVERSE, next, { now }), /turnover/);
  const one = structuredClone(seed);
  const row = one.rows.find(entry => entry.fund === 'IVV');
  const removedCik = row.cik;
  row.cik = '9000000001';
  const result = compareSecCoverageUniverses(SEC_COVERAGE_UNIVERSE, build(one), { now });
  assert.equal(result.added[0].cik, '9000000001');
  assert.equal(result.removed[0].cik, removedCik);
  assert.equal(result.changed, true);
});
