import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyExposureLoader, discoverCompanyExposures } from '../src/utils/companyExposureServer.js';

const started = Date.parse('2026-09-15T12:00:00Z'), cik = '0000320193';
const text = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
async function prepare(issuerCik = cik, time = started) {
  let snapshot;
  const result = await discoverCompanyExposures({ cik: issuerCik }, {
    now: new Date(time),
    loadSubmissions: async () => ({ cik: issuerCik, name: 'Verified Company', filings: { recent: {
      accessionNumber: ['0000950170-26-000001'], form: ['10-K'], filingDate: ['2026-02-01'],
      reportDate: ['2025-12-31'], primaryDocument: ['annual.htm'],
    }, files: [] } }),
    loadFilingText: async () => ({ text }),
    onSnapshot: value => { snapshot = value; },
  });
  return { result, snapshot };
}

test('exact CIK callers share one source restore and reuse its derived evidence in process', async () => {
  const { snapshot } = await prepare();
  let reads = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const load = createCompanyExposureLoader({ now: () => started + 1000,
    read: async (_type, key) => { reads++; assert.equal(key, `cik:${cik}:latest`); await gate; return snapshot; },
    discover: async () => { assert.fail('Fresh verified sources must not be downloaded again.'); },
  });
  const cancelled = new AbortController();
  const first = load({ cik }, { signal: cancelled.signal });
  const second = load({ cik: '320193' });
  cancelled.abort();
  await assert.rejects(first, { code: 'COMPANY_EXPOSURE_TIMEOUT' });
  finish();
  const restored = await second;
  assert.equal(reads, 1); assert.equal(restored.cik, cik);
  assert.equal(restored.checkedAt, snapshot.checkedAt);
  assert.equal(restored.sources[0].retrievedAt, snapshot.sources[0].retrievedAt);
  assert.strictEqual(await load({ cik }), restored);
  assert.equal(reads, 1);
});

test('derived evidence expires at the original manifest check without extending near-expired sources', async () => {
  const { snapshot } = await prepare();
  let clock = started + 6 * 3600 * 1000 - 50, reads = 0, discoveries = 0;
  const writes = [];
  const load = createCompanyExposureLoader({ now: () => clock,
    read: async () => { reads++; return snapshot; },
    discover: async (selection, options) => {
      discoveries++;
      const fresh = await prepare(selection.cik, options.now.getTime());
      clock += 3000; options.onSnapshot(fresh.snapshot); return fresh.result;
    },
    write: async (...args) => { writes.push(args); },
  });
  const original = await load({ cik });
  clock += 100;
  const fresh = await load({ cik });
  assert.equal(reads, 2); assert.equal(discoveries, 1);
  assert.notEqual(fresh.checkedAt, original.checkedAt);
  assert.equal(writes[0][3], 6 * 3600 - 3);
  assert.strictEqual(await load({ cik }), fresh);
});

test('another issuer or historical cutoff cannot reuse the cached CIK evidence', async () => {
  const { snapshot } = await prepare();
  const calls = [];
  const load = createCompanyExposureLoader({ now: () => started + 1000,
    read: async (_type, key) => { calls.push(key); return snapshot; },
    discover: async selection => ({ status: 'unavailable', ...selection }),
  });
  assert.equal((await load({ cik })).status, 'ready');
  assert.equal((await load({ cik: '0000000099' })).status, 'unavailable');
  assert.equal((await load({ cik, asOf: '2026-08-01' })).status, 'unavailable');
  assert.deepEqual(calls, [`cik:${cik}:latest`, 'cik:0000000099:latest', `cik:${cik}:2026-08-01`]);
});

test('partial and unavailable discoveries remain retryable and are never retained or persisted', async () => {
  for (const status of ['partial', 'unavailable']) {
    let discoveries = 0;
    const load = createCompanyExposureLoader({ now: () => started,
      read: async () => null,
      discover: async (_selection, options) => {
        discoveries++; options.onSnapshot({});
        return { status, retryable: true, coverage: { searchComplete: false } };
      },
      write: async () => { assert.fail('Incomplete evidence cannot enter shared storage.'); },
    });
    await load({ cik }); await load({ cik });
    assert.equal(discoveries, 2);
  }
});

test('the local byte limit evicts derived evidence without evicting its shared source', async () => {
  const prepared = await prepare(), other = await prepare('0000000099');
  const snapshots = new Map([[`cik:${cik}:latest`, prepared.snapshot], ['cik:0000000099:latest', other.snapshot]]);
  const reads = [];
  const load = createCompanyExposureLoader({ now: () => started,
    cacheBytes: Buffer.byteLength(JSON.stringify(prepared.result)) + 100,
    read: async (_type, key) => { reads.push(key); return snapshots.get(key); },
    discover: async () => { assert.fail('The shared source should still be reusable.'); },
  });
  await load({ cik }); await load({ cik: '0000000099' }); await load({ cik });
  assert.deepEqual(reads, [`cik:${cik}:latest`, 'cik:0000000099:latest', `cik:${cik}:latest`]);
});

test('an already-cancelled request starts no shared cache or SEC work', async () => {
  const controller = new AbortController(); controller.abort();
  const load = createCompanyExposureLoader({ now: () => started,
    read: async () => { assert.fail('Cancelled request must not start cache work.'); },
  });
  await assert.rejects(load({ cik }, { signal: controller.signal }), { code: 'COMPANY_EXPOSURE_TIMEOUT' });
});
