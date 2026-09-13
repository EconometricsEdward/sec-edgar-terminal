/** Exact-migration SQL checks in an isolated local database; no hosted access. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';

const namespace = 'batch-test';
const fetchedAt = '2026-09-01T12:00:00.000Z';
const expiresAt = '2026-10-01T12:00:00.000Z';
const batchFunctions = ['edgar_get_manifests', 'edgar_get_compact_batch'];
const coordinationFunctions = ['edgar_claim_job_prefix', 'edgar_yield_job', 'edgar_enqueue_coverage_jobs'];
const statusFunctions = ['edgar_coverage_status'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function asRole(db, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  try { return await action(); } finally { await db.exec('reset role'); }
}

async function rpc(db, name, params) {
  const typesByFunction = {
    edgar_begin_write: ['text', 'text', 'text', 'uuid', 'integer'],
    edgar_publish: ['text', 'text', 'text', 'jsonb', 'jsonb', 'boolean'],
    edgar_revalidate: ['text', 'text', 'text', 'jsonb', 'jsonb'],
    edgar_get_version: ['text', 'text', 'text', 'text', 'text'],
    edgar_get_manifests: ['text', 'text', 'text[]'],
    edgar_get_compact_batch: ['text', 'text', 'text[]'],
    edgar_enqueue_job: ['text', 'text', 'text', 'text', 'jsonb', 'integer'],
    edgar_claim_job_prefix: ['text', 'text', 'uuid', 'text', 'integer'],
    edgar_yield_job: ['text', 'jsonb', 'jsonb', 'integer'],
    edgar_finish_job: ['text', 'jsonb', 'text', 'jsonb', 'text', 'integer'],
    edgar_coverage_status: ['text'],
    edgar_enqueue_coverage_jobs: ['text', 'text', 'text', 'integer[]'],
  };
  assert.ok(Object.hasOwn(typesByFunction, name));
  const types = typesByFunction[name];
  assert.equal(params.length, types.length);
  return asRole(db, 'service_role', async () => {
    const result = await db.query(`select public.${name}(${types.map((type, i) => `$${i + 1}::${type}`).join(',')}) as value`, params);
    return result.rows[0].value;
  });
}

function recordFor(payload, extra = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  return {
    identityHash: sha(`batch-fixture-1:${raw}`), contentHash: sha(raw), schemaVersion: '1',
    payload, rawBytes: raw.length, storedBytes: gzipSync(raw).length,
    metadata: { fetchedAt, revalidatedAt: fetchedAt, expiresAt, parserVersion: 'fixture-1', calculationVersion: 'fixture-1', entityId: '0000320193', reportPeriod: '2025-09-27' },
    ...extra,
  };
}

async function claim(db, dataset, key, ns = namespace) {
  return rpc(db, 'edgar_begin_write', [ns, dataset, key, randomUUID(), 120]);
}

async function publish(db, dataset, key, record, ns = namespace) {
  const fence = await claim(db, dataset, key, ns);
  return rpc(db, 'edgar_publish', [ns, dataset, key, fence, record, true]);
}

const get = (db, dataset, key, ns = namespace) => rpc(db, 'edgar_get_version', [ns, dataset, key, null, 'current']);
const batch = (db, name, keys, dataset = 'financial', ns = namespace) => rpc(db, name, [ns, dataset, keys]);
const enqueue = (db, ns, key, dataset = 'sec', maxAttempts = 2) => rpc(db, 'edgar_enqueue_job', [ns, dataset, key, key, { next: 0 }, maxAttempts]);
const claimPrefix = (db, ns, prefix = 'sec-coverage-v1:', dataset = 'sec') => rpc(db, 'edgar_claim_job_prefix', [ns, dataset, randomUUID(), prefix, 120]);
const makeReady = (db, id) => db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
const expireLease = (db, id) => db.query("update public.edgar_ingestion_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [id]);

async function makeDatabase() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema storage;
      create table storage.buckets (
        id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[]
      );
      create table storage.objects (
        id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
        name text not null, metadata jsonb default '{}', created_at timestamptz not null default now(), unique(bucket_id,name)
      );
      alter table storage.objects enable row level security;
      grant usage on schema public,storage to service_role;
      grant select,insert,update on storage.objects,storage.buckets to service_role;
    `);
    const migrationsDirectory = new URL('../supabase/migrations/', import.meta.url);
    const migrations = await Promise.all((await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort().map(async name => ({ name, sql: await readFile(new URL(name, migrationsDirectory), 'utf8') })));
    const base = migrations.find(migration => migration.name === '20260913031639_edgar_staged_data_store.sql');
    const additions = migrations.filter(migration => /create(?: or replace)? function public\.edgar_get_manifests\(/i.test(migration.sql));
    const stableOrders = migrations.filter(migration => migration.name.endsWith('_edgar_coverage_stable_order.sql'));
    assert.ok(base, 'original tracked migration must be present');
    assert.equal(additions.length, 1, 'exactly one tracked batch-read migration must be present');
    assert.equal(stableOrders.length, 1, 'exactly one tracked stable-order migration must be present');
    assert.ok(stableOrders[0].sql.trim().length > 100, 'tracked stable-order migration must contain SQL');
    await db.exec(base.sql);
    await db.exec(additions[0].sql);
    // Apply the exact ordering fix without activating unrelated cron migrations.
    await db.exec(stableOrders[0].sql);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

test('batch SQL serves ordered, bounded, isolated current publications under restricted grants', async t => {
  const db = await makeDatabase();
  t.after(() => db.close());
  const a = recordFor({ value: 10.25, missingMetric: null });
  const b = recordFor({ value: '9007199254740993.25', periodEnd: '2025-09-27' });
  await publish(db, 'financial', 'a', a);
  await publish(db, 'financial', 'b', b);
  await publish(db, 'financial', 'a', recordFor({ value: 777 }), 'other-namespace');
  await publish(db, 'cftc', 'a', recordFor({ value: 888 }));
  const sourceRecord = recordFor({ cik: 320193, facts: { 'us-gaap': {} } });
  const sourcePath = `${namespace}/sec/source/${sourceRecord.contentHash}.json.gz`;
  await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['edgar-durable-private', sourcePath, { size: sourceRecord.storedBytes }]);
  await publish(db, 'sec', 'companyfacts:a', {
    ...sourceRecord, payload: null, objectPath: sourcePath,
    source: { objectPath: sourcePath, contentHash: sourceRecord.contentHash, rawBytes: sourceRecord.rawBytes, storedBytes: sourceRecord.storedBytes,
      url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json', fetchedAt, publishedAt: null },
  });

  await t.test('new functions are invoker-only with empty search_path and no browser-role grant', async () => {
    const rows = (await db.query(`select p.oid,p.proname,p.prosecdef,p.proconfig,p.provolatile
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[])`, [[...batchFunctions, ...coordinationFunctions, ...statusFunctions]])).rows;
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.prosecdef, false);
      if ([...batchFunctions, ...statusFunctions].includes(row.proname)) assert.equal(row.provolatile, 's', 'read functions must use one statement snapshot');
      assert.ok(row.proconfig.includes('search_path=""'));
      assert.equal((await db.query("select has_function_privilege('service_role',$1::oid,'EXECUTE') as allowed", [row.oid])).rows[0].allowed, true);
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') as allowed", [role, row.oid])).rows[0].allowed, false);
        if (batchFunctions.includes(row.proname)) await asRole(db, role, () => assert.rejects(db.query(`select public.${row.proname}($1,$2,$3::text[])`, [namespace, 'financial', ['a']]), { code: '42501' }));
        if (statusFunctions.includes(row.proname)) await asRole(db, role, () => assert.rejects(db.query(`select public.${row.proname}($1)`, [namespace]), { code: '42501' }));
      }
    }
  });

  await t.test('compact batches preserve duplicate and missing positions and exact integrity metadata', async () => {
    const values = await batch(db, 'edgar_get_compact_batch', ['b', 'missing', 'a', 'b']);
    assert.deepEqual(values, [await get(db, 'financial', 'b'), null, await get(db, 'financial', 'a'), await get(db, 'financial', 'b')]);
    assert.equal(values[0].contentHash, b.contentHash);
    assert.equal(values[0].rawBytes, b.rawBytes);
    assert.equal(values[0].payload.value, '9007199254740993.25');
    assert.equal(values[2].payload.missingMetric, null);
  });

  await t.test('manifests omit prepared payloads and retain source object identity without downloading it', async () => {
    const manifests = await batch(db, 'edgar_get_manifests', ['b', 'missing', 'a', 'b']);
    assert.equal(manifests.length, 4);
    assert.equal(manifests[0].id, (await get(db, 'financial', 'b')).id);
    assert.equal(manifests[1], null);
    assert.equal(manifests[2].id, (await get(db, 'financial', 'a')).id);
    assert.deepEqual(manifests[0], manifests[3]);
    assert.ok(manifests.filter(Boolean).every(value => !Object.hasOwn(value, 'payload')));
    const [manifest] = await batch(db, 'edgar_get_manifests', ['companyfacts:a'], 'sec');
    assert.equal(manifest.contentHash, sourceRecord.contentHash);
    assert.equal(manifest.objectPath, sourcePath);
    assert.equal(manifest.rawBytes, sourceRecord.rawBytes);
    assert.equal(manifest.storedBytes, sourceRecord.storedBytes);
    assert.equal(new Date(manifest.metadata.fetchedAt).toISOString(), fetchedAt);
    assert.equal(Object.hasOwn(manifest, 'source'), false, 'unbounded source URLs are excluded from manifests');
    assert.deepEqual(await batch(db, 'edgar_get_compact_batch', ['companyfacts:a', 'missing'], 'sec'), [null, null]);
  });

  await t.test('both readers scope the same key by namespace and dataset', async () => {
    for (const name of batchFunctions) {
      assert.equal((await batch(db, name, ['a']))[0].id, (await get(db, 'financial', 'a')).id);
      assert.equal((await batch(db, name, ['a'], 'financial', 'other-namespace'))[0].id, (await get(db, 'financial', 'a', 'other-namespace')).id);
      assert.equal((await batch(db, name, ['a'], 'cftc'))[0].id, (await get(db, 'cftc', 'a')).id);
      assert.deepEqual(await batch(db, name, ['a'], 'sec'), [null]);
      assert.deepEqual(await batch(db, name, ['a'], 'financial', 'missing-namespace'), [null]);
    }
  });

  await t.test('empty and maximum batches work while over-limit batches fail', async () => {
    for (const [name, maximum] of [['edgar_get_manifests', 100], ['edgar_get_compact_batch', 5]]) {
      assert.deepEqual(await batch(db, name, []), []);
      const maximumRows = await batch(db, name, Array(maximum).fill('a'));
      assert.equal(maximumRows.length, maximum);
      assert.ok(maximumRows.every(row => row.id === maximumRows[0].id));
      for (const keys of [Array(maximum + 1).fill('a'), null, [''], [null], ['x'.repeat(513)], [['a'], ['b']]]) {
        await assert.rejects(batch(db, name, keys), { code: '22023' });
      }
      assert.deepEqual(await batch(db, name, ['x'.repeat(512)]), [null], 'maximum key length is valid');
      for (const invalidNamespace of [null, '', 'bad.namespace', 'x'.repeat(49)]) {
        await assert.rejects(batch(db, name, ['a'], 'financial', invalidNamespace), { code: '22023' });
      }
      for (const invalidDataset of [null, '', 'other']) await assert.rejects(batch(db, name, ['a'], invalidDataset), { code: '22023' });
    }
  });

  await t.test('new claims do not change visible generations and unpublished keys remain missing', async () => {
    const prior = await get(db, 'financial', 'a');
    const fence = await claim(db, 'financial', 'a');
    await claim(db, 'financial', 'unpublished');
    assert.ok(fence.generation > prior.generation);
    for (const name of batchFunctions) {
      const values = await batch(db, name, ['a', 'unpublished']);
      assert.equal(values[0].id, prior.id);
      assert.equal(values[0].generation, prior.generation);
      assert.equal(values[1], null);
    }
    const revised = recordFor({ value: 11.5 });
    await rpc(db, 'edgar_publish', [namespace, 'financial', 'a', fence, revised, true]);
    for (const name of batchFunctions) {
      const values = await batch(db, name, ['a', 'b']);
      assert.notEqual(values[0].id, prior.id);
      assert.equal(values[0].generation, fence.generation);
      assert.equal(values[1].id, (await get(db, 'financial', 'b')).id);
    }
  });

  await t.test('revalidation overlays freshness while retaining original retrieval and content identity', async () => {
    const prior = await get(db, 'financial', 'b');
    const fence = await claim(db, 'financial', 'b');
    const revalidatedAt = '2026-09-13T12:00:00.000Z';
    const nextExpiry = '2026-10-13T12:00:00.000Z';
    await rpc(db, 'edgar_revalidate', [namespace, 'financial', 'b', fence, { revalidatedAt, expiresAt: nextExpiry, etag: 'revalidated-b', fetchedAt: '2099-01-01T00:00:00Z' }]);
    for (const name of batchFunctions) {
      const [value] = await batch(db, name, ['b']);
      assert.equal(value.id, prior.id);
      assert.equal(value.contentHash, prior.contentHash);
      assert.equal(new Date(value.metadata.fetchedAt).toISOString(), fetchedAt);
      assert.equal(new Date(value.metadata.revalidatedAt).toISOString(), revalidatedAt);
      assert.equal(new Date(value.expiresAt).toISOString(), nextExpiry);
      assert.equal(new Date(value.revalidatedAt).toISOString(), revalidatedAt);
    }
  });

  await t.test('manifest metadata stays bounded even when full metadata contains large source details', async () => {
    const record = recordFor({ value: 30 });
    record.metadata = { ...record.metadata, sourceReferences: 'x'.repeat(30000), parserVersion: 'p'.repeat(500), documentContentHash: 'a'.repeat(64) };
    await publish(db, 'financial', 'large-metadata', record);
    const [manifest] = await batch(db, 'edgar_get_manifests', ['large-metadata']);
    assert.equal(manifest.metadata.documentContentHash, 'a'.repeat(64));
    assert.equal(manifest.metadata.parserVersion.length, 128);
    assert.equal(Object.hasOwn(manifest.metadata, 'sourceReferences'), false);
    assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < 3000);
    const [compact] = await batch(db, 'edgar_get_compact_batch', ['large-metadata']);
    assert.equal(compact.metadata.sourceReferences.length, 30000, 'full compact evidence is retained for explicit payload reads');
  });

  await t.test('prefix claims isolate namespaces, datasets and the two approved job families', async () => {
    const ns = 'prefix-test';
    const coverageId = await enqueue(db, ns, 'sec-coverage-v1:2026-09-13');
    const cohortId = await enqueue(db, ns, 'sec-financial-cohort-v1:2026-09-13');
    const unrelatedId = await enqueue(db, ns, 'sec-coverage-v1x:2026-09-13');
    const otherNamespaceId = await enqueue(db, 'other-prefix-test', 'sec-coverage-v1:2026-09-13');
    const otherDatasetId = await enqueue(db, ns, 'sec-coverage-v1:2026-09-13', 'cftc');
    assert.equal((await claimPrefix(db, ns)).id, coverageId);
    assert.equal(await claimPrefix(db, ns), null, 'active ownership and unrelated prefixes cannot be stolen');
    assert.equal((await claimPrefix(db, ns, 'sec-financial-cohort-v1:')).id, cohortId);
    const untouched = (await db.query('select id,state,attempts from public.edgar_ingestion_jobs where id=any($1::uuid[])', [[unrelatedId, otherNamespaceId, otherDatasetId]])).rows;
    assert.equal(untouched.length, 3);
    assert.ok(untouched.every(row => row.state === 'queued' && row.attempts === 0));
    for (const prefix of [null, '', 'sec-', 'sec-coverage-v1', 'sec-coverage-v1:%', '%']) await assert.rejects(claimPrefix(db, ns, prefix), { code: '22023' });
    await assert.rejects(claimPrefix(db, ns, 'sec-coverage-v1:', 'cftc'), { code: '22023' });
  });

  await t.test('twelve successful continuations preserve progress without consuming the two-failure budget', async () => {
    const ns = 'continuation-test';
    const id = await enqueue(db, ns, 'sec-coverage-v1:2026-09-13');
    let generation = 0;
    for (let cursor = 0; cursor < 12; cursor++) {
      const fence = await claimPrefix(db, ns);
      assert.equal(fence.id, id);
      assert.equal(fence.attempts, 1);
      assert.equal(fence.checkpoint.next, cursor);
      assert.ok(fence.generation > generation);
      generation = fence.generation;
      assert.equal(await rpc(db, 'edgar_yield_job', [ns, fence, { next: cursor + 1 }, 1]), true);
      assert.equal(await claimPrefix(db, ns), null, 'continuation respects its delay');
      assert.equal(await rpc(db, 'edgar_yield_job', [ns, fence, { next: 999 }, 1]), false, 'released owner cannot overwrite progress');
      await makeReady(db, id);
    }
    const finalClaim = await claimPrefix(db, ns);
    assert.equal(finalClaim.checkpoint.next, 12);
    assert.equal(await rpc(db, 'edgar_finish_job', [ns, finalClaim, 'done', { next: 12 }, null, 1]), true);
    assert.equal(await claimPrefix(db, ns), null);
    assert.equal((await db.query('select state from public.edgar_ingestion_jobs where id=$1', [id])).rows[0].state, 'done');
  });

  await t.test('stale and expired owners cannot yield and successful continuations preserve earlier failures', async () => {
    const ns = 'yield-fencing-test';
    const id = await enqueue(db, ns, 'sec-coverage-v1:2026-09-13');
    const first = await claimPrefix(db, ns);
    await expireLease(db, id);
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, first, { next: 99 }, 1]), false, 'expired owner cannot erase a failed attempt');
    const second = await claimPrefix(db, ns);
    assert.equal(second.attempts, 2);
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, first, { next: 99 }, 1]), false, 'old generation cannot release current ownership');
    assert.equal(await rpc(db, 'edgar_yield_job', ['other-namespace', second, { next: 99 }, 1]), false);
    for (const checkpoint of [null, [], { padding: 'x'.repeat(16400) }]) await assert.rejects(rpc(db, 'edgar_yield_job', [ns, second, checkpoint, 1]), { code: '22023' });
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, second, { next: 1 }, 1]), true);
    const pending = (await db.query('select attempts,checkpoint from public.edgar_ingestion_jobs where id=$1', [id])).rows[0];
    assert.equal(pending.attempts, 1, 'only the successful attempt is released; the earlier expired attempt remains');
    assert.deepEqual(pending.checkpoint, { next: 1 });
    await makeReady(db, id);
    const third = await claimPrefix(db, ns);
    assert.equal(third.attempts, 2);
    assert.equal(await rpc(db, 'edgar_finish_job', [ns, third, 'retry', { next: 1 }, 'upstream_503', 1]), true);
    await makeReady(db, id);
    assert.equal(await claimPrefix(db, ns), null, 'two real failures exhaust the budget');
    assert.equal((await db.query('select state from public.edgar_ingestion_jobs where id=$1', [id])).rows[0].state, 'dead');
  });

  await t.test('coverage status counts current source and research families with freshness and current bytes', async () => {
    const ns = 'coverage-status-test';
    const currentRecords = [
      { dataset: 'sec', key: 'sec-documents-v1:CIK0000320193:companyfacts', family: 'sec-document', basis: 'companyfacts', fresh: true },
      { dataset: 'sec', key: 'sec-documents-v1:CIK0000789019:companyfacts', family: 'sec-document', basis: 'companyfacts', fresh: false },
      { dataset: 'sec', key: 'sec-documents-v1:CIK0000320193:submissions', family: 'sec-document', basis: 'submissions', fresh: false, noExpiry: true },
      { dataset: 'financial', key: 'financial-analysis-v1:CIK0000320193:annual', family: 'analysis', basis: 'annual', fresh: true },
      { dataset: 'financial', key: 'financial-analysis-v1:CIK0000789019:annual', family: 'analysis', basis: 'annual', fresh: false },
      { dataset: 'financial', key: 'financial-analysis-v1:CIK0000320193:quarter', family: 'analysis', basis: 'quarter', fresh: true },
      { dataset: 'financial', key: 'research-compare-v1:CIK0000320193', family: 'compare', basis: 'all', fresh: true },
      { dataset: 'financial', key: 'research-portfolio-v1:CIK0000320193', family: 'portfolio', basis: 'all', fresh: true },
      { dataset: 'financial', key: 'research-market-overview-v1:latest', family: 'market-overview', basis: 'all', fresh: true },
      { dataset: 'financial', key: 'research-company-v1:CIK0000320193', family: 'company-summary', basis: 'all', fresh: true },
      { dataset: 'financial', key: 'other-research-v1:one', family: 'other', basis: 'all', fresh: true },
    ];
    // A retained older version must not inflate current coverage or current bytes.
    await publish(db, 'financial', currentRecords[3].key, recordFor({ retired: 'x'.repeat(8000) }), ns);
    const expected = new Map();
    for (const [index, item] of currentRecords.entries()) {
      const record = recordFor({ label: `private-payload-marker-${index}`, value: index });
      record.metadata = { ...record.metadata, expiresAt: item.noExpiry ? null : item.fresh ? '2099-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z',
        ...(item.basis === 'all' || item.dataset === 'sec' ? {} : { basis: item.basis }), sourceReferences: 'private-source-marker' };
      await publish(db, item.dataset, item.key, record, ns);
      const groupKey = `${item.dataset}:${item.family}:${item.basis}`;
      const group = expected.get(groupKey) || { prepared: 0, fresh: 0, stale: 0, current_raw_bytes: 0, current_stored_bytes: 0 };
      group.prepared++;
      group[item.fresh ? 'fresh' : 'stale']++;
      group.current_raw_bytes += record.rawBytes;
      group.current_stored_bytes += record.storedBytes;
      expected.set(groupKey, group);
    }
    await claim(db, 'financial', currentRecords[3].key, ns);
    await claim(db, 'financial', 'financial-analysis-v1:CIK0000019617:annual', ns);
    await publish(db, 'cftc', 'market', recordFor({ excluded: 'private-cftc-marker' }), ns);
    await publish(db, 'financial', currentRecords[3].key, recordFor({ excluded: 'private-other-namespace-marker' }), 'coverage-status-other');
    const status = await rpc(db, 'edgar_coverage_status', [ns]);
    assert.equal(status.coverageGroups.length, expected.size);
    for (const group of status.coverageGroups) {
      const key = `${group.dataset}:${group.family}:${group.basis}`;
      assert.ok(expected.has(key), `unexpected coverage group ${key}`);
      for (const field of ['prepared', 'fresh', 'stale', 'current_raw_bytes', 'current_stored_bytes']) assert.equal(group[field], expected.get(key)[field], `${key} ${field}`);
      assert.equal(group.prepared, group.fresh + group.stale);
      assert.equal(new Date(group.earliest_revalidated_at).toISOString(), fetchedAt);
      assert.equal(new Date(group.latest_revalidated_at).toISOString(), fetchedAt);
      for (const forbidden of ['metadata', 'payload', 'source', 'resource_key', 'objectPath']) assert.equal(Object.hasOwn(group, forbidden), false);
    }
    assert.ok(!JSON.stringify(status).includes('private-'), 'aggregate status must omit source and payload contents');
    assert.deepEqual((await rpc(db, 'edgar_coverage_status', ['coverage-status-empty'])).coverageGroups, []);
  });

  await t.test('coverage job status excludes legacy jobs, other sources and other namespaces', async () => {
    const ns = 'coverage-jobs-status';
    const runningId = await enqueue(db, ns, 'sec-coverage-v1:running');
    assert.equal((await claimPrefix(db, ns)).id, runningId);
    await enqueue(db, ns, 'sec-coverage-v1:done');
    const completed = await claimPrefix(db, ns);
    await rpc(db, 'edgar_finish_job', [ns, completed, 'done', { next: 500 }, null, 1]);
    await enqueue(db, ns, 'sec-coverage-v1:retry');
    const retry = await claimPrefix(db, ns);
    await rpc(db, 'edgar_finish_job', [ns, retry, 'retry', { next: 5 }, 'upstream_503', 60]);
    await enqueue(db, ns, 'sec-coverage-v1:queued');
    await enqueue(db, ns, 'sec-financial-cohort-v1:legacy');
    await enqueue(db, ns, 'sec-coverage-v1x:unrelated');
    await enqueue(db, ns, 'sec-coverage-v1:cftc', 'cftc');
    await enqueue(db, 'coverage-jobs-other', 'sec-coverage-v1:other');
    const status = await rpc(db, 'edgar_coverage_status', [ns]);
    assert.deepEqual(status.coverageJobs, { running: 1, done: 1, retry: 1, queued: 1 });
    const createdAt = (await db.query('select created_at from public.edgar_ingestion_jobs where id=$1', [runningId])).rows[0].created_at;
    assert.equal(new Date(status.oldestCoverageWork).toISOString(), new Date(createdAt).toISOString());
    assert.ok(Number.isFinite(Date.parse(status.observedAt)));
    const empty = await rpc(db, 'edgar_coverage_status', ['coverage-jobs-empty']);
    assert.deepEqual(empty.coverageJobs, {});
    assert.equal(empty.oldestCoverageWork, null);
  });

  await t.test('coverage status normalizes arbitrary basis strings and excludes mismatched current pointers', async () => {
    const ns = 'coverage-bounded-status';
    for (const label of ['a', 'b']) {
      const record = recordFor({ value: label });
      record.metadata.basis = label.repeat(16000);
      await publish(db, 'financial', `financial-analysis-v1:${label}`, record, ns);
      await publish(db, 'sec', `sec-documents-v1:${label}:${label.repeat(200)}`, recordFor({ value: label }), ns);
    }
    const foreign = await publish(db, 'financial', 'financial-analysis-v1:corrupt', recordFor({ value: 'foreign' }), 'coverage-bounded-other');
    await publish(db, 'financial', 'financial-analysis-v1:corrupt', recordFor({ value: 'local' }), ns);
    await db.query('update public.edgar_dataset_heads set current_version=$1 where namespace=$2 and resource_key=$3', [foreign, ns, 'financial-analysis-v1:corrupt']);
    const status = await rpc(db, 'edgar_coverage_status', [ns]);
    assert.deepEqual(status.coverageGroups.map(group => ({ dataset: group.dataset, family: group.family, basis: group.basis, prepared: group.prepared })), [
      { dataset: 'financial', family: 'analysis', basis: 'all', prepared: 2 },
      { dataset: 'sec', family: 'sec-document', basis: 'other', prepared: 2 },
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(status)) < 5000, 'unexpected basis values cannot expand the status response');
  });

  await t.test('coverage enqueue creates 32 stable shard jobs without resetting checkpoints or completed work', async () => {
    const ns = 'coverage-enqueue-test';
    const cycle = '2026-09-13';
    const version = '0123456789abcdef';
    const first = await rpc(db, 'edgar_enqueue_coverage_jobs', [ns, cycle, version, null]);
    assert.equal(first.length, 32);
    assert.deepEqual(first.map(job => job.shard), Array.from({ length: 32 }, (_, index) => index));
    assert.equal(new Set(first.map(job => job.id)).size, 32);
    for (const job of first) assert.equal(job.jobKey, `sec-coverage-v1:${cycle}:${String(job.shard).padStart(2, '0')}:${version}`);
    const resumable = await claimPrefix(db, ns);
    assert.equal(resumable.checkpoint.cursor, 0);
    assert.equal(resumable.checkpoint.universeVersion, version);
    assert.equal(resumable.checkpoint.cycle, cycle);
    const checkpoint = { ...resumable.checkpoint, cursor: 7, succeeded: 6, workCount: 7, retries: [{ cik: '0000320193' }] };
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, resumable, checkpoint, 60]), true);
    const completed = await claimPrefix(db, ns);
    assert.notEqual(completed.id, resumable.id);
    assert.equal(await rpc(db, 'edgar_finish_job', [ns, completed, 'done', { ...completed.checkpoint, cursor: 16 }, null, 1]), true);
    const selectedRows = () => db.query('select id,state,checkpoint,attempts,generation,available_at from public.edgar_ingestion_jobs where id=any($1::uuid[]) order by id', [[resumable.id, completed.id]]);
    const before = (await selectedRows()).rows;
    assert.deepEqual(await rpc(db, 'edgar_enqueue_coverage_jobs', [ns, cycle, version, null]), first);
    assert.deepEqual((await selectedRows()).rows, before, 'idempotent enqueue preserves existing status and checkpoint');
    assert.equal(Number((await db.query('select count(*) as count from public.edgar_ingestion_jobs where namespace=$1', [ns])).rows[0].count), 32);
    const subset = await rpc(db, 'edgar_enqueue_coverage_jobs', [ns, cycle, version, [17]]);
    assert.deepEqual(subset, [first[17]]);
    const isolated = await rpc(db, 'edgar_enqueue_coverage_jobs', ['coverage-enqueue-other', cycle, version, [17]]);
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0].shard, 17);
    assert.notEqual(isolated[0].id, first[17].id);
    assert.equal(Number((await db.query('select count(*) as count from public.edgar_ingestion_jobs where namespace=$1', ['coverage-enqueue-other'])).rows[0].count), 1);
  });

  await t.test('coverage enqueue rejects invalid calendar dates, versions and shard lists before creating jobs', async () => {
    const ns = 'coverage-enqueue-invalid';
    const cycle = '2026-09-13';
    const version = '0123456789abcdef';
    for (const date of [null, '', '2026-9-13', '2026-02-30', '2026-13-01', '2026-09-13T00:00:00Z']) {
      await assert.rejects(rpc(db, 'edgar_enqueue_coverage_jobs', [ns, date, version, null]), error => error.code.startsWith('22'));
    }
    for (const invalidVersion of [null, '', 'abc', 'A'.repeat(16), 'g'.repeat(16), 'a'.repeat(17)]) {
      await assert.rejects(rpc(db, 'edgar_enqueue_coverage_jobs', [ns, cycle, invalidVersion, null]), { code: '22023' });
    }
    for (const shards of [[], [null], [-1], [32], [1, 1], [[0], [1]], Array.from({ length: 33 }, (_, index) => index)]) {
      await assert.rejects(rpc(db, 'edgar_enqueue_coverage_jobs', [ns, cycle, version, shards]), { code: '22023' });
    }
    assert.equal(Number((await db.query('select count(*) as count from public.edgar_ingestion_jobs where namespace=$1', [ns])).rows[0].count), 0);
  });

  await t.test('coverage claims finish an eligible shard in stable order despite reverse UUIDs and later yield timestamps', async () => {
    const ns = 'stable-shard-order';
    const shardZeroId = 'ffffffff-ffff-4fff-bfff-fffffffffff0';
    const shardOneId = '00000000-0000-4000-8000-000000000101';
    const key = shard => `sec-coverage-v1:2026-09-13:${shard}:0123456789abcdef`;
    const zero = await enqueue(db, ns, key('00'));
    const one = await enqueue(db, ns, key('01'));
    await db.query("update public.edgar_ingestion_jobs set id=$1,available_at='2000-01-01T00:00:00Z' where id=$2", [shardZeroId, zero]);
    await db.query("update public.edgar_ingestion_jobs set id=$1,available_at='2000-01-01T00:00:00Z' where id=$2", [shardOneId, one]);
    const otherNamespaceId = await enqueue(db, 'stable-shard-other', 'sec-coverage-v1:1999-01-01:00:0123456789abcdef');
    const otherDatasetId = await enqueue(db, ns, 'sec-coverage-v1:1999-01-01:00:0123456789abcdef', 'cftc');
    const first = await claimPrefix(db, ns);
    assert.equal(first.id, shardZeroId, 'shard00 precedes the smaller shard01 UUID when availability timestamps tie');
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, first, { next: 7 }, 1]), true);
    await db.query("update public.edgar_ingestion_jobs set available_at='2000-01-02T00:00:00Z' where id=$1", [shardZeroId]);
    const continued = await claimPrefix(db, ns);
    assert.equal(continued.id, shardZeroId, 'an eligible continuation precedes the next shard even with a later available_at');
    assert.deepEqual(continued.checkpoint, { next: 7 });
    assert.ok(continued.generation > first.generation);
    assert.equal(continued.attempts, 1, 'a successful yield preserves the failure budget');
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, first, { next: 999 }, 1]), false, 'stable ordering retains generation fencing');
    assert.equal(await rpc(db, 'edgar_yield_job', [ns, continued, { next: 8 }, 60]), true);
    const following = await claimPrefix(db, ns);
    assert.equal(following.id, shardOneId, 'a future cooldown keeps shard00 ineligible while shard01 can advance');
    const untouched = (await db.query('select state,attempts from public.edgar_ingestion_jobs where id=any($1::uuid[])', [[otherNamespaceId, otherDatasetId]])).rows;
    assert.equal(untouched.length, 2);
    assert.ok(untouched.every(row => row.state === 'queued' && row.attempts === 0));
  });

  await t.test('coverage ordering selects the oldest eligible cycle before a newer cycle with a lower shard number', async () => {
    const ns = 'stable-cycle-order';
    const earlier = await enqueue(db, ns, 'sec-coverage-v1:2026-09-12:31:0123456789abcdef');
    const later = await enqueue(db, ns, 'sec-coverage-v1:2026-09-13:00:0123456789abcdef');
    await db.query("update public.edgar_ingestion_jobs set available_at='2000-01-02T00:00:00Z' where id=$1", [earlier]);
    await db.query("update public.edgar_ingestion_jobs set available_at='2000-01-01T00:00:00Z' where id=$1", [later]);
    const claimed = await claimPrefix(db, ns);
    assert.equal(claimed.id, earlier, 'cycle date precedes shard number and availability ordering for eligible work');
    assert.equal(await rpc(db, 'edgar_finish_job', [ns, claimed, 'done', { next: 16 }, null, 1]), true);
    assert.equal((await claimPrefix(db, ns)).id, later);
  });

  await t.test('legacy cohort claims retain availability ordering and UUID tie breaking', async () => {
    const ns = 'legacy-claim-order';
    const jobs = [
      { key: 'sec-financial-cohort-v1:a', id: 'ffffffff-ffff-4fff-bfff-ffffffffffe1', available: '2000-01-02T00:00:00Z' },
      { key: 'sec-financial-cohort-v1:b', id: '00000000-0000-4000-8000-000000000103', available: '2000-01-02T00:00:00Z' },
      { key: 'sec-financial-cohort-v1:z', id: '00000000-0000-4000-8000-000000000104', available: '2000-01-01T00:00:00Z' },
    ];
    for (const job of jobs) {
      const id = await enqueue(db, ns, job.key);
      await db.query('update public.edgar_ingestion_jobs set id=$1,available_at=$2::timestamptz where id=$3', [job.id, job.available, id]);
    }
    const first = await claimPrefix(db, ns, 'sec-financial-cohort-v1:');
    assert.equal(first.id, jobs[2].id, 'the oldest available legacy job wins despite its later key and larger UUID');
    assert.equal(await rpc(db, 'edgar_finish_job', [ns, first, 'done', { next: 4 }, null, 1]), true);
    const second = await claimPrefix(db, ns, 'sec-financial-cohort-v1:');
    assert.equal(second.id, jobs[1].id, 'tied legacy timestamps use UUID order instead of lexical job keys');
  });
});
