/** Exact migration against PostgreSQL in PGlite. Queued calls below test atomic
 * CAS semantics on one backend, not hosted multi-session lock contention. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';

const namespace = 'production';
const signatures = {
  edgar_cache_get: ['text', 'text', 'text', 'text[]'],
  edgar_cache_put: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'integer', 'integer', 'text', 'timestamptz'],
  edgar_cache_maintenance: ['text', 'text', 'uuid', 'jsonb'],
  edgar_cache_prune: ['text', 'integer'],
  edgar_cache_status: ['text'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function payload(value, level = 6) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const gzip = gzipSync(raw, { level });
  return { raw, gzip, base64: gzip.toString('base64'), rawSha256: sha(raw), gzipSha256: sha(gzip) };
}
async function asRole(db, role, fn) {
  assert.ok(['service_role', 'anon', 'authenticated'].includes(role));
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const call = async (db, name, args) => asRole(db, 'service_role', async () =>
  (await db.query(`select public.${name}(${signatures[name].map((type, index) => `$${index + 1}::${type}`).join(',')}) value`, args)).rows[0].value);
const putArgs = (family, id, data, options = {}) => [options.namespace ?? namespace, family, options.type ?? 'company', id,
  data.base64, data.rawSha256, data.gzipSha256, options.rawBytes ?? data.raw.length, options.ttl ?? 300, options.ifHash ?? null, options.expiresAt ?? null];
const put = (db, family, id, data, options) => call(db, 'edgar_cache_put', putArgs(family, id, data, options));
const get = (db, family, ids, type = 'company') => call(db, 'edgar_cache_get', [namespace, family, type, ids]);
const maintenance = (db, action, owner = null, state = null) => call(db, 'edgar_cache_maintenance', [namespace, action, owner, state]);
const status = db => call(db, 'edgar_cache_status', [namespace]);
const prune = (db, limit = 1000) => call(db, 'edgar_cache_prune', [namespace, limit]);
const rows = async (db, family) => (await db.query('select cache_id,raw_sha256,gzip_sha256,stored_bytes,written_at,expires_at,accessed_at from edgar_private.cache_entries where family=$1 order by cache_id', [family])).rows;
async function assertAccounting(db) {
  const results = (await db.query(`select f.family,f.used_bytes,f.used_rows,coalesce(sum(e.stored_bytes),0)::bigint actual_bytes,count(e.cache_id)::integer actual_rows
    from edgar_private.cache_families f left join edgar_private.cache_entries e using(namespace,family)
    group by f.namespace,f.family order by f.family`)).rows;
  for (const result of results) {
    assert.equal(result.used_bytes, result.actual_bytes, `${result.family} bytes`);
    assert.equal(result.used_rows, result.actual_rows, `${result.family} rows`);
  }
}
async function expire(db, family, id) {
  await db.query("update edgar_private.cache_entries set written_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where family=$1 and cache_id=$2", [family, id]);
}
async function database() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      grant usage on schema public to service_role;
      create schema cron;create table cron.job(jobname text primary key,schedule text,command text,active boolean default true);
      create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$
      begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command;return 1;end $$;
      create table public.edgar_dataset_versions(id text primary key,payload text);
      insert into public.edgar_dataset_versions values('canonical-keep','evidence');
      create table public.edgar_dataset_heads(id text primary key);insert into public.edgar_dataset_heads values('head-keep');
      create schema storage;create table storage.objects(id text primary key);insert into storage.objects values('source-keep');`);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(name => name.endsWith('_edgar_disposable_cache.sql'));
    assert.equal(files.length, 1);
    await db.exec(await readFile(new URL(files[0], directory), 'utf8'));
    return db;
  } catch (error) { await db.close(); throw error; }
}

test('private disposable cache exact SQL: security, budgets, expiry, replacement and maintenance', async t => {
  const db = await database();
  t.after(() => db.close());
  const originalPolicies = (await db.query('select * from edgar_private.cache_families order by family')).rows;
  async function reset() {
    await db.exec('delete from edgar_private.cache_entries');
    for (const policy of originalPolicies) await db.query(`update edgar_private.cache_families
      set max_bytes=$2,max_rows=$3,used_bytes=0,used_rows=0,puts=0,deduplicated_puts=0,expired_rows=0,evicted_rows=0 where family=$1`,
    [policy.family, policy.max_bytes, policy.max_rows]);
  }

  await t.test('production-only invoker RPCs and private RLS tables deny browser roles', async () => {
    const functions = (await db.query("select oid,proname,prosecdef,proconfig from pg_proc where proname=any($1::text[])", [Object.keys(signatures)])).rows;
    assert.equal(functions.length, 5);
    for (const fn of functions) {
      assert.equal(fn.prosecdef, false); assert.ok(fn.proconfig.includes('search_path=""'));
      assert.equal((await db.query("select has_function_privilege('service_role',$1::oid,'EXECUTE') allowed", [fn.oid])).rows[0].allowed, true);
      for (const role of ['anon', 'authenticated']) assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [role, fn.oid])).rows[0].allowed, false);
    }
    for (const table of ['cache_families', 'cache_entries', 'cache_maintenance_control']) {
      assert.equal((await db.query("select relrowsecurity from pg_class where oid=$1::regclass", [`edgar_private.${table}`])).rows[0].relrowsecurity, true);
      for (const role of ['anon', 'authenticated']) await assert.rejects(asRole(db, role, () => db.query(`select * from edgar_private.${table}`)), { code: '42501' });
    }
    for (const role of ['anon', 'authenticated']) await assert.rejects(asRole(db, role, () => db.query("select public.edgar_cache_status('production')")), { code: '42501' });
    for (const ns of [null, '', 'preview', 'Production']) {
      await assert.rejects(call(db, 'edgar_cache_status', [ns]), /invalid_cache_status/);
      await assert.rejects(call(db, 'edgar_cache_get', [ns, 'research', 'company', ['AAPL']]), /invalid_cache_get/);
      await assert.rejects(call(db, 'edgar_cache_maintenance', [ns, 'read', null, null]), /invalid_cache_maintenance/);
      await assert.rejects(call(db, 'edgar_cache_prune', [ns, 1]), /invalid_cache_prune/);
    }
    await assert.rejects(asRole(db, 'service_role', () => db.exec("update edgar_private.cache_families set max_bytes=max_bytes+1")), { code: '42501' });
    await assert.rejects(asRole(db, 'service_role', () => db.exec("delete from edgar_private.cache_families")), { code: '42501' });
  });

  await t.test('six fixed family payload caps total 512 MiB and TTL maxima are enforced', async () => {
    await reset();
    assert.equal(originalPolicies.reduce((sum, policy) => sum + policy.max_bytes, 0), 512 * 1024 * 1024);
    assert.deepEqual(Object.fromEntries(originalPolicies.map(p => [p.family, p.max_ttl_seconds])), {
      checkpoint: 1209600, document: 2592000, history: 7776000, reference: 7776000, research: 90000, snapshot: 604800,
    });
    for (const policy of originalPolicies) {
      assert.ok(policy.max_rows <= 10000);
      const data = payload({ family: policy.family });
      assert.equal((await put(db, policy.family, 'ttl', data, { ttl: policy.max_ttl_seconds })).stored, true);
      await assert.rejects(put(db, policy.family, 'invalid', data, { ttl: policy.max_ttl_seconds + 1 }), /invalid_cache_policy/);
    }
    await assertAccounting(db);
  });

  await t.test('ordered batches preserve duplicate positions and expired or missing records return null', async () => {
    await reset(); const data = payload({ ticker: 'ZZZZ', cik: '0001999999' });
    await put(db, 'research', 'ZZZZ', data); await put(db, 'research', 'expired', data);
    await expire(db, 'research', 'expired');
    const result = await get(db, 'research', ['missing', 'ZZZZ', 'expired', 'ZZZZ']);
    assert.equal(result.length, 4); assert.equal(result[0], null); assert.equal(result[2], null); assert.deepEqual(result[1], result[3]);
    assert.equal(result[1].id, 'ZZZZ'); assert.equal(result[1].rawSha256, data.rawSha256);
    assert.equal(result[1].gzipSha256, data.gzipSha256); assert.equal(result[1].rawBytes, data.raw.length);
    assert.equal(result[1].storedBytes, data.gzip.length);
    assert.deepEqual(gunzipSync(Buffer.from(result[1].gzipBase64, 'base64')), data.raw);
    assert.ok(Date.parse(result[1].expiresAt) > Date.parse(result[1].writtenAt));
    assert.equal((await rows(db, 'research')).length, 2, 'expiry read does not delete evidence or rewrite quotas');
  });

  await t.test('invalid identifiers, arrays, hashes, sizes, TTLs and checksums cannot mutate cache state', async () => {
    await reset(); const data = payload({ test: true });
    for (const ids of [null, [], Array(26).fill('id'), [null], [''], ['a\nb'], ['x'.repeat(1201)], [['a'], ['b']]]) {
      await assert.rejects(get(db, 'research', ids), /invalid_cache_get/);
    }
    for (const type of ['', 'bad/type', 'x'.repeat(121), null]) await assert.rejects(get(db, 'research', ['id'], type), /invalid_cache_get/);
    for (const [index, value] of [[0, 'preview'], [1, 'unknown'], [2, 'bad/type'], [3, ''], [4, '!bad'], [5, 'f'.repeat(63)], [6, '0'.repeat(64)], [7, 0], [7, 33554433], [8, 0], [9, 'bad']]) {
      const args = putArgs('research', 'id', data); args[index] = value; await assert.rejects(call(db, 'edgar_cache_put', args));
    }
    await assert.rejects(put(db, 'research', 'too-large', payload(randomBytes(6291456))), /invalid_cache_put|invalid_cache_payload/);
    assert.equal((await status(db)).rows, 0);
    await assertAccounting(db);
  });

  await t.test('one key is atomically replaced with exact accounting and identical raw content retains its compressed bytes', async () => {
    await reset(); const one = payload({ ticker: 'AAPL', text: 'a'.repeat(2048) }, 0);
    const compactSame = payload(JSON.parse(one.raw), 9); const two = payload({ ticker: 'AAPL', revision: 2 });
    await put(db, 'research', 'AAPL', one);
    const before = (await rows(db, 'research'))[0];
    assert.notEqual(one.gzipSha256, compactSame.gzipSha256);
    const result = await put(db, 'research', 'AAPL', compactSame, { ttl: 1000 });
    assert.equal(result.reason, 'unchanged');
    const after = (await rows(db, 'research'))[0];
    assert.equal(after.gzip_sha256, before.gzip_sha256); assert.equal(after.stored_bytes, one.gzip.length);
    assert.deepEqual(after.written_at, before.written_at); assert.ok(after.expires_at > before.expires_at);
    await assert.rejects(put(db, 'research', 'AAPL', compactSame, { rawBytes: compactSame.raw.length + 1 }), /cache_raw_metadata_mismatch/);
    assert.equal((await put(db, 'research', 'AAPL', two)).stored, true);
    assert.equal((await rows(db, 'research')).length, 1);
    assert.equal((await rows(db, 'research'))[0].stored_bytes, two.gzip.length);
    await assertAccounting(db);
  });

  await t.test('CAS distinguishes live from expired and one queued writer wins each expected hash', async () => {
    await reset(); const first = payload({ n: 1 }); const second = payload({ n: 2 });
    assert.equal((await put(db, 'research', 'cas', first, { ifHash: 'absent' })).stored, true);
    assert.deepEqual(await put(db, 'research', 'cas', second, { ifHash: 'absent' }), { stored: false, reason: 'compare_failed' });
    assert.equal((await put(db, 'research', 'cas', second, { ifHash: '0'.repeat(64) })).stored, false);
    const queued = await asRole(db, 'service_role', () => Promise.all(Array.from({ length: 8 }, (_, n) =>
      db.query(`select public.edgar_cache_put(${signatures.edgar_cache_put.map((type, index) => `$${index + 1}::${type}`).join(',')}) value`,
        putArgs('research', 'cas', payload({ n: n + 10 }), { ifHash: first.rawSha256 })))));
    assert.equal(queued.filter(result => result.rows[0].value.stored).length, 1);
    await expire(db, 'research', 'cas');
    assert.equal((await put(db, 'research', 'cas', second, { ifHash: first.rawSha256 })).stored, false);
    assert.equal((await put(db, 'research', 'cas', second, { ifHash: 'absent' })).stored, true);
    await assertAccounting(db);
  });

  await t.test('absolute migration expiry cannot extend remaining Redis retention or revive an expired copy', async () => {
    await reset(); const data = payload({ imported: true });
    const cap = new Date(Date.now() + 60000).toISOString();
    const result = await put(db, 'research', 'imported', data, { ttl: 300, expiresAt: cap });
    assert.equal(result.stored, true); assert.equal(Date.parse(result.expiresAt), Date.parse(cap));
    const prior = await get(db, 'research', ['imported']);
    assert.deepEqual(await put(db, 'research', 'imported', data, { expiresAt: '2020-01-01T00:00:00Z' }), { stored: false, reason: 'expired' });
    assert.deepEqual(await get(db, 'research', ['imported']), prior);
    assert.deepEqual(await put(db, 'research', 'already-expired', data, { expiresAt: '2020-01-01T00:00:00Z' }), { stored: false, reason: 'expired' });
    assert.equal((await get(db, 'research', ['already-expired']))[0], null);
    await assertAccounting(db);
  });

  await t.test('protected global families reject pressure without evicting a live key, but can reclaim expired entries', async () => {
    await reset(); const data = payload({ saved: true });
    for (const family of ['snapshot', 'checkpoint', 'reference', 'history']) {
      await db.query('update edgar_private.cache_families set max_rows=1 where family=$1', [family]);
      await put(db, family, 'existing', data);
      assert.deepEqual(await put(db, family, 'new', data), { stored: false, reason: 'quota_full' });
      assert.equal((await get(db, family, ['existing']))[0].id, 'existing');
      await expire(db, family, 'existing');
      assert.equal((await put(db, family, 'new', data)).stored, true);
      assert.deepEqual((await rows(db, family)).map(row => row.cache_id), ['new']);
    }
    await assertAccounting(db);
  });

  await t.test('research/document LRU prefers expired records, excludes replacement key and touches at most hourly', async () => {
    await reset(); const data = payload({ saved: true });
    for (const family of ['research', 'document']) {
      await db.query('update edgar_private.cache_families set max_rows=2 where family=$1', [family]);
      await put(db, family, 'older', data); await put(db, family, 'recent', data);
      await db.query("update edgar_private.cache_entries set accessed_at=clock_timestamp()-interval '2 hours' where family=$1 and cache_id='older'", [family]);
      await get(db, family, ['older']); const touched = (await rows(db, family)).find(row => row.cache_id === 'older').accessed_at;
      await get(db, family, ['older']); assert.deepEqual((await rows(db, family)).find(row => row.cache_id === 'older').accessed_at, touched);
      await put(db, family, 'third', data);
      assert.deepEqual((await rows(db, family)).map(row => row.cache_id), ['older', 'third']);
      await expire(db, family, 'older'); await get(db, family, ['third']);
      await put(db, family, 'fourth', data);
      assert.deepEqual((await rows(db, family)).map(row => row.cache_id), ['fourth', 'third']);
      await put(db, family, 'third', payload({ replacement: true }));
      assert.deepEqual((await rows(db, family)).map(row => row.cache_id), ['fourth', 'third']);
    }
    await assertAccounting(db);
  });

  await t.test('oversized payloads reject before eviction and a replacement failing its budget retains the previous value', async () => {
    await reset(); const data = payload({ saved: true });
    await db.query('update edgar_private.cache_families set max_bytes=$1 where family=$2', [data.gzip.length, 'research']);
    await put(db, 'research', 'saved', data);
    const larger = payload(randomBytes(1024));
    assert.equal((await put(db, 'research', 'other', larger)).stored, false);
    assert.equal((await put(db, 'research', 'saved', larger)).stored, false);
    assert.equal((await get(db, 'research', ['saved']))[0].rawSha256, data.rawSha256);
    await assertAccounting(db);
  });

  await t.test('at most 128 planned victims per put and rejection makes no partial live eviction', async () => {
    await reset(); const small = payload({ n: 1 });
    // Exact SQL fixture keeps quota accounting aligned while avoiding 130 setup round trips.
    await db.query(`insert into edgar_private.cache_entries(namespace,family,cache_type,cache_id,payload_gzip,raw_sha256,gzip_sha256,raw_bytes,written_at,expires_at,accessed_at)
      select 'production','research','company',n::text,decode($1,'base64'),$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()
      from generate_series(1,130) n`, [small.base64, small.rawSha256, small.gzipSha256, small.raw.length]);
    const cap = small.gzip.length * 130;
    await db.query("update edgar_private.cache_families set used_rows=130,used_bytes=$1,max_bytes=$1 where family='research'", [cap]);
    // Store method zero adds 23 gzip framing bytes, making the needed reclaim deterministic.
    const incoming = payload(randomBytes(cap - 23), 0);
    assert.equal(incoming.gzip.length, cap);
    assert.deepEqual(await put(db, 'research', 'large', incoming), { stored: false, reason: 'quota_full' });
    assert.equal((await rows(db, 'research')).length, 130);
    await assertAccounting(db);
  });

  await t.test('batch response size is bounded while individual large entries remain readable', async () => {
    await reset(); const large = payload(randomBytes(4 * 1024 * 1024));
    await put(db, 'document', 'large', large);
    await assert.rejects(get(db, 'document', ['large', 'large']), /cache_response_too_large/);
    const result = await get(db, 'document', ['large']);
    assert.equal(result[0].gzipSha256, large.gzipSha256);
    assert.equal(result[0].storedBytes, large.gzip.length);
    await assertAccounting(db);
  });

  await t.test('maintenance starts in inventory and only DB owner can change mode or its drain timestamp', async () => {
    const initial = await maintenance(db, 'read');
    assert.equal(initial.mode, 'inventory'); assert.deepEqual(initial.state, {}); assert.equal(initial.leaseUntil, null);
    assert.ok(Number.isFinite(Date.parse(initial.modeChangedAt)));
    for (const assignment of ["mode='migrate'", 'mode_changed_at=clock_timestamp()', "mode='migrate',mode_changed_at=clock_timestamp()"])
      await assert.rejects(asRole(db, 'service_role', () => db.exec(`update edgar_private.cache_maintenance_control set ${assignment}`)), { code: '42501' });
    await assert.rejects(asRole(db, 'service_role', () => db.exec('delete from edgar_private.cache_maintenance_control')), { code: '42501' });
    await db.exec("update edgar_private.cache_maintenance_control set mode='migrate',mode_changed_at=clock_timestamp()");
    assert.equal((await maintenance(db, 'read')).mode, 'migrate');
    for (const state of [null, [], '"text"', { oversized: 'a'.repeat(65536) }]) await assert.rejects(maintenance(db, 'save', randomUUID(), state), /invalid_cache_maintenance/);
    await assert.rejects(maintenance(db, 'claim', null), /invalid_cache_maintenance/);
    await assert.rejects(maintenance(db, 'claim', '00000000-0000-0000-0000-000000000000'), /invalid_cache_maintenance/);
  });

  await t.test('maintenance lease cannot renew itself and stale owners cannot overwrite a successor checkpoint', async () => {
    const owner = randomUUID(); const claim = await maintenance(db, 'claim', owner);
    assert.equal(claim.owner, owner); assert.equal(claim.mode, 'migrate'); assert.ok(Date.parse(claim.leaseUntil) > Date.now());
    assert.equal((await db.query("select extract(epoch from lease_until-updated_at)::int seconds from edgar_private.cache_maintenance_control")).rows[0].seconds, 45);
    assert.equal(await maintenance(db, 'claim', owner), null);
    assert.equal(await maintenance(db, 'claim', randomUUID()), null);
    assert.deepEqual(await maintenance(db, 'save', randomUUID(), { invalid: true }), { saved: false });
    assert.deepEqual(await maintenance(db, 'save', owner, { schema: 1, cursor: '123' }), { saved: true });
    assert.deepEqual((await maintenance(db, 'read')).state, { schema: 1, cursor: '123' });
    assert.equal((await maintenance(db, 'read')).leaseUntil, null);
    const expired = await maintenance(db, 'claim', randomUUID());
    await db.exec("update edgar_private.cache_maintenance_control set lease_until=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await maintenance(db, 'save', expired.owner, { invalid: true }), { saved: false });
    const next = await maintenance(db, 'claim', randomUUID());
    assert.deepEqual(await maintenance(db, 'save', expired.owner, { invalid: true }), { saved: false });
    assert.deepEqual(await maintenance(db, 'save', next.owner, { schema: 1, cursor: '456' }), { saved: true });
  });

  await t.test('bounded daily pruning removes only expired cache rows and preserves canonical archive fixtures', async () => {
    await reset(); const data = payload({ retained: true });
    for (const family of ['research', 'document', 'history']) {
      await put(db, family, 'old', data); await put(db, family, 'fresh', data); await expire(db, family, 'old');
    }
    assert.deepEqual(await prune(db, 2), { removed: 2, reclaimedBytes: data.gzip.length * 2, limit: 2 });
    assert.equal((await prune(db)).removed, 1); assert.equal((await prune(db)).removed, 0);
    for (const family of ['research', 'document', 'history']) assert.deepEqual((await rows(db, family)).map(row => row.cache_id), ['fresh']);
    for (const limit of [null, 0, 1001]) await assert.rejects(prune(db, limit), /invalid_cache_prune/);
    const scheduled = (await db.query("select * from cron.job where jobname='edgar-disposable-cache-expiry-v1'")).rows[0];
    assert.equal(scheduled.schedule, '37 3 * * *'); assert.equal(scheduled.command, "select public.edgar_cache_prune('production',1000);");
    for (const table of ['public.edgar_dataset_versions', 'public.edgar_dataset_heads', 'storage.objects'])
      assert.equal((await db.query(`select count(*)::integer n from ${table}`)).rows[0].n, 1);
    const snapshot = await status(db);
    assert.equal(snapshot.maxPayloadBytes, 536870912); assert.equal(snapshot.rows, 3);
    assert.equal(snapshot.payloadBytes, data.gzip.length * 3); assert.equal(snapshot.families.length, 6);
    assert.equal(JSON.stringify(snapshot).includes('gzipBase64'), false);
    await assertAccounting(db);
  });
});
