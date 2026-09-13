/** Exact canonical + disposable + fencing migrations in PostgreSQL/PGlite.
 * Queued calls use one backend and are not a hosted concurrency benchmark. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';

const ns = 'production';
const cftcType = 'edgar.cftc-positioning.v1:production';
const signatures = {
  edgar_begin_write: ['text', 'text', 'text', 'uuid', 'integer'],
  edgar_release_write: ['text', 'text', 'text', 'jsonb'],
  edgar_publish: ['text', 'text', 'text', 'jsonb', 'jsonb', 'boolean'],
  edgar_revalidate: ['text', 'text', 'text', 'jsonb', 'jsonb'],
  edgar_reserve_cache_generation: ['text', 'text', 'text', 'jsonb'],
  edgar_cache_put: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'integer', 'integer', 'text', 'timestamptz'],
  edgar_cache_put_fenced: ['text', 'text', 'text', 'jsonb', 'text', 'text', 'text', 'text', 'text', 'text', 'integer', 'integer', 'text', 'timestamptz'],
  edgar_cache_get: ['text', 'text', 'text', 'text[]'],
  edgar_cache_status: ['text'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const token = claim => ({ generation: claim.generation, owner: claim.owner });
function data(value = { revision: 1 }) {
  const raw = Buffer.from(JSON.stringify(value)); const gzip = gzipSync(raw);
  return { raw, gzip, rawHash: sha(raw), gzipHash: sha(gzip), base64: gzip.toString('base64'), value };
}
async function role(db, name, fn) {
  assert.ok(['service_role', 'anon', 'authenticated'].includes(name));
  await db.exec(`set role ${name}`); try { return await fn(); } finally { await db.exec('reset role'); }
}
const query = (db, name, args) => db.query(`select public.${name}(${signatures[name].map((type, i) => `$${i + 1}::${type}`).join(',')}) value`, args);
const rpc = (db, name, args) => role(db, 'service_role', async () => (await query(db, name, args)).rows[0].value);
const begin = (db, key, dataset = 'cftc') => rpc(db, 'edgar_begin_write', [ns, dataset, key, randomUUID(), 120]);
const reserve = (db, claim) => rpc(db, 'edgar_reserve_cache_generation', [ns, claim.dataset, claim.key, token(claim)]);
const release = (db, claim) => rpc(db, 'edgar_release_write', [ns, claim.dataset, claim.key, token(claim)]);
const get = (db, id, { family = 'history', type = cftcType } = {}) => rpc(db, 'edgar_cache_get', [ns, family, type, [id]]);
function args(id, payload, { family = 'history', type = cftcType, ttl = 300, ifHash = null, expiresAt = null } = {}) {
  return [family, type, id, payload.base64, payload.rawHash, payload.gzipHash, payload.raw.length, ttl, ifHash, expiresAt];
}
const put = (db, id, payload, options) => rpc(db, 'edgar_cache_put', [ns, ...args(id, payload, options)]);
const fenced = (db, claim, id, payload, options) => rpc(db, 'edgar_cache_put_fenced', [ns, claim.dataset, claim.key, token(claim), ...args(id, payload, options)]);
const head = async (db, claim) => (await db.query('select * from public.edgar_dataset_heads where namespace=$1 and dataset=$2 and resource_key=$3', [ns, claim.dataset, claim.key])).rows[0];
const guards = async db => (await db.query('select family,cache_type,cache_id,raw_sha256,cache_guard from edgar_private.cache_entries order by family,cache_type,cache_id')).rows;
const accounting = async db => (await db.query('select family,used_bytes,used_rows,puts,deduplicated_puts,evicted_rows,expired_rows from edgar_private.cache_families order by family')).rows;
async function publish(db, claim, payload = data()) {
  const observed = new Date().toISOString();
  return rpc(db, 'edgar_publish', [ns, claim.dataset, claim.key, token(claim), {
    identityHash: payload.rawHash, contentHash: payload.rawHash, schemaVersion: '1', payload: payload.value,
    rawBytes: payload.raw.length, storedBytes: payload.raw.length,
    metadata: { fetchedAt: observed, revalidatedAt: observed, expiresAt: new Date(Date.now() + 90000).toISOString() },
  }, true]);
}
async function database() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,created_at timestamptz default now(),unique(bucket_id,name));
      grant usage on schema storage,public to service_role;grant select on storage.objects to service_role;
      create schema cron;create table cron.job(jobname text primary key,schedule text,command text,active boolean default true);
      create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$
      begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command;return 1;end $$;`);
    const directory = new URL('../supabase/migrations/', import.meta.url); const files = await readdir(directory);
    for (const suffix of ['20260913031639_edgar_staged_data_store.sql', '_edgar_disposable_cache.sql', '_edgar_fenced_disposable_cache.sql']) {
      const matches = files.filter(name => name.endsWith(suffix)); assert.equal(matches.length, 1);
      await db.exec(await readFile(new URL(matches[0], directory), 'utf8'));
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}

test('fenced disposable cache preserves canonical claim ordering and blocks unfenced overwrites', async t => {
  const db = await database(); t.after(() => db.close());
  async function reset() {
    await db.exec(`delete from edgar_private.cache_entries;
      update edgar_private.cache_families set used_bytes=0,used_rows=0,puts=0,deduplicated_puts=0,evicted_rows=0,expired_rows=0;
      update public.edgar_dataset_heads set owner=null,lease_until=null,cache_claim=null;`);
  }

  await t.test('wrappers and private helpers are invoker-only and denied to browser roles', async () => {
    const functions = (await db.query(`select p.oid,p.proname,n.nspname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.proname in('edgar_reserve_cache_generation','edgar_cache_put','edgar_cache_put_fenced','cache_put_payload','cache_claim_valid','cache_fence_target')`)).rows;
    assert.equal(functions.length, 6);
    for (const fn of functions) {
      assert.equal(fn.prosecdef, false); assert.ok(fn.proconfig.includes('search_path=""'));
      assert.equal(fn.nspname, fn.proname.startsWith('edgar_') ? 'public' : 'edgar_private');
      for (const browserRole of ['anon', 'authenticated']) assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') allowed", [browserRole, fn.oid])).rows[0].allowed, false);
    }
    assert.equal(functions.filter(fn => fn.proname === 'edgar_cache_put').length, 1, 'no ambiguous public overload remains');
    for (const name of ['anon', 'authenticated']) await assert.rejects(role(db, name, () => db.query('select cache_claim from public.edgar_dataset_heads')), { code: '42501' });
    const initial = await begin(db, 'markets:tff:latest');
    for (const claim of [null, {}, { ...token(initial), injected: true }, { generation: 0, owner: initial.owner }, { generation: '9223372036854775808', owner: initial.owner }, { generation: 1, owner: '00000000-0000-0000-0000-000000000000' }])
      await assert.rejects(rpc(db, 'edgar_reserve_cache_generation', [ns, 'cftc', initial.key, claim]), /invalid_cache_claim/);
    for (const namespace of [null, '', 'preview']) await assert.rejects(rpc(db, 'edgar_reserve_cache_generation', [namespace, 'cftc', initial.key, token(initial)]), /invalid_cache_claim/);
  });

  await t.test('reserve captures only the current canonical owner and never extends its original lease', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest');
    assert.equal(await reserve(db, { ...claim, owner: randomUUID() }), false);
    assert.equal(await reserve(db, { ...claim, generation: claim.generation + 1 }), false);
    assert.equal(await reserve(db, claim), true);
    const captured = (await head(db, claim)).cache_claim;
    assert.equal(captured.generation, String(claim.generation)); assert.equal(captured.owner, claim.owner);
    assert.equal(Date.parse(captured.expiresAt), Date.parse(claim.expiresAt));
    assert.equal(await reserve(db, claim), true); assert.deepEqual((await head(db, claim)).cache_claim, captured);
    await assert.rejects(fenced(db, { ...claim, owner: randomUUID() }, 'MARKETS:TFF:LATEST', data()), { code: '40001' });
  });

  await t.test('unreserved writers fail and valid CFTC publications can write primary, last-good and raw caches', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest');
    await assert.rejects(fenced(db, claim, 'MARKETS:TFF:LATEST', data()), { code: '40001' });
    await reserve(db, claim);
    for (const id of ['MARKETS:TFF:LATEST', 'MARKETS-LAST-GOOD:TFF:LATEST', 'RAW-HISTORY:TFF:098662:2026-09-08', 'RAW-HISTORY:TFF:12345+:2026-09-08']) {
      assert.equal((await fenced(db, claim, id, data({ id }))).stored, true);
      assert.equal((await get(db, id))[0].id, id);
    }
    const stored = await guards(db); assert.equal(stored.length, 4);
    for (const row of stored) assert.deepEqual(row.cache_guard, { dataset: claim.dataset, key: claim.key });
  });

  await t.test('publish and revalidate clear active ownership while captured original claim still permits mirrors', async () => {
    await reset(); const key = 'sec-documents-v1:CIK0000320193:submissions'; const options = { family: 'research', type: 'submissions-cik' };
    const claim = await begin(db, key, 'sec'); await reserve(db, claim); await publish(db, claim, data({ cik: 320193 }));
    assert.equal((await head(db, claim)).owner, null); assert.equal((await head(db, claim)).lease_until, null);
    assert.equal((await fenced(db, claim, '0000320193', data({ cik: 320193 }), options)).stored, true);
    const next = await begin(db, key, 'sec'); await reserve(db, next);
    const observed = new Date().toISOString();
    assert.equal(await rpc(db, 'edgar_revalidate', [ns, 'sec', key, token(next), { revalidatedAt: observed, expiresAt: new Date(Date.now() + 60000).toISOString() }]), true);
    assert.equal((await head(db, next)).owner, null);
    assert.equal((await fenced(db, next, '0000320193', data({ cik: 320193 }), options)).stored, true);
    assert.equal(await reserve(db, next), false, 'capture must happen before publication clears active ownership');
  });

  await t.test('a new canonical generation invalidates an older worker before the newer cache reservation', async () => {
    await reset(); const old = await begin(db, 'markets:tff:latest'); await reserve(db, old); await publish(db, old);
    assert.equal((await fenced(db, old, 'MARKETS:TFF:LATEST', data({ n: 1 }))).stored, true);
    const next = await begin(db, old.key); assert.ok(next.generation > old.generation);
    const prior = await get(db, 'MARKETS:TFF:LATEST'); const usage = await accounting(db);
    await assert.rejects(fenced(db, old, 'MARKETS:TFF:LATEST', data({ n: 2 })), { code: '40001' });
    await assert.rejects(fenced(db, next, 'MARKETS:TFF:LATEST', data({ n: 2 })), { code: '40001' });
    assert.deepEqual(await get(db, 'MARKETS:TFF:LATEST'), prior); assert.deepEqual(await accounting(db), usage);
    await reserve(db, next); assert.equal((await fenced(db, next, 'MARKETS:TFF:LATEST', data({ n: 3 }))).stored, true);
    await assert.rejects(fenced(db, old, 'MARKETS:TFF:LATEST', data({ n: 4 })), { code: '40001' });
  });

  await t.test('ordinary writes including CAS and migration absent writes cannot overwrite guarded rows, even expired', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest'); await reserve(db, claim);
    const payload = data(); await fenced(db, claim, 'MARKETS:TFF:LATEST', payload);
    for (const options of [{}, { ifHash: payload.rawHash }, { ifHash: 'absent' }])
      assert.deepEqual(await put(db, 'MARKETS:TFF:LATEST', data({ malicious: true }), options), { stored: false, reason: 'fenced' });
    await db.exec("update edgar_private.cache_entries set written_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second'");
    assert.deepEqual(await put(db, 'MARKETS:TFF:LATEST', data({ malicious: true }), { ifHash: 'absent' }), { stored: false, reason: 'fenced' });
    assert.equal((await guards(db))[0].raw_sha256, payload.rawHash);
    // No special GUC grants permission to call the payload helper through public RPC.
    await db.exec("set edgar.cache_fence_bypass='true'");
    assert.deepEqual(await put(db, 'MARKETS:TFF:LATEST', data({ malicious: true })), { stored: false, reason: 'fenced' });
    await db.exec('reset edgar.cache_fence_bypass');
  });

  await t.test('fenced adoption of an existing unguarded record is atomic, and unsuccessful CAS does not mark another row', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest'); await reserve(db, claim); const payload = data();
    await put(db, 'MARKETS:TFF:LATEST', payload);
    assert.equal((await guards(db))[0].cache_guard, null);
    assert.equal((await fenced(db, claim, 'MARKETS:TFF:LATEST', payload)).reason, 'unchanged');
    assert.deepEqual((await guards(db))[0].cache_guard, { dataset: 'cftc', key: claim.key });
    await put(db, 'MARKETS-LAST-GOOD:TFF:LATEST', payload);
    assert.deepEqual(await fenced(db, claim, 'MARKETS-LAST-GOOD:TFF:LATEST', data({ n: 2 }), { ifHash: 'absent' }), { stored: false, reason: 'compare_failed' });
    assert.equal((await guards(db)).find(row => row.cache_id.includes('LAST-GOOD')).cache_guard, null);
  });

  await t.test('destination binding rejects unrelated family, code, date, company, financial basis and nonpilot mirrors', async () => {
    await reset();
    const market = await begin(db, 'markets:tff:2026-09-08'); await reserve(db, market);
    for (const [id, options] of [['MARKETS:DISAGGREGATED:2026-09-08'], ['RAW-HISTORY:TFF:098662:2026-09-01'], ['MARKETS:TFF:LATEST'], ['MARKETS:TFF:2026-09-08', { family: 'research' }]])
      await assert.rejects(fenced(db, market, id, data(), options), /invalid_cache_fence_target/);
    const history = await begin(db, 'history:tff:098662:leveraged-funds:2026-09-08:1y'); await reserve(db, history);
    for (const id of ['RAW-HISTORY:TFF:098663:2026-09-08', 'HISTORY:TFF:098662:DEALER:2026-09-08:1Y'])
      await assert.rejects(fenced(db, history, id, data()), /invalid_cache_fence_target/);
    const sec = await begin(db, 'sec-documents-v1:CIK0000320193:companyfacts', 'sec'); await reserve(db, sec);
    await assert.rejects(fenced(db, sec, '0000320193', data(), { family: 'research', type: 'submissions-cik' }), /invalid_cache_fence_target/);
    await assert.rejects(fenced(db, sec, '/API/XBRL/COMPANYFACTS/CIK0000789019.JSON', data(), { family: 'research', type: 'research-sec-v1' }), /invalid_cache_fence_target/);
    const financial = await begin(db, 'financial-analysis-v1:analysis-v1.4:context-v3:CIK0000320193:annual:latest', 'financial'); await reserve(db, financial);
    for (const id of ['ANALYSIS-V1.4:CONTEXT-V3:MSFT:ANNUAL:', 'ANALYSIS-V1.4:CONTEXT-V3:AAPL:QUARTER:'])
      await assert.rejects(fenced(db, financial, id, data(), { family: 'research', type: 'analysis-research' }), /invalid_cache_fence_target/);
    const outside = await begin(db, 'sec-documents-v1:CIK0001018724:submissions', 'sec');
    await assert.rejects(reserve(db, outside), /invalid_cache_claim/);
    await assert.rejects(fenced(db, outside, '0001018724', data(), { family: 'research', type: 'submissions-cik' }), /invalid_cache_fence_target/);
  });

  await t.test('all existing pilot mirror mappings survive publication without broadening canonical resource scope', async () => {
    await reset();
    const targets = [
      ['sec', 'sec-documents-v1:CIK0000320193:submissions', 'research-sec-v1', '/SUBMISSIONS/CIK0000320193.JSON'],
      ['sec', 'sec-documents-v1:CIK0000789019:companyfacts', 'research-sec-v1', '/API/XBRL/COMPANYFACTS/CIK0000789019.JSON'],
      ['financial', 'financial-analysis-v1:analysis-v1.4:context-v3:CIK0000019617:quarter:latest', 'analysis-research', 'ANALYSIS-V1.4:CONTEXT-V3:JPM:QUARTER:'],
      ['financial', 'research-compare-v1:compare-v2:context-v3:CIK0000002098:ttm:latest', 'research-serving-v1'],
      ['financial', 'research-portfolio-v1:analysis-v1.4:context-v3:CIK0000320193:ytd:latest', 'research-serving-v1'],
    ];
    for (const [dataset, key, type, id = key.toUpperCase()] of targets) {
      const claim = await begin(db, key, dataset); await reserve(db, claim); await publish(db, claim);
      assert.equal((await fenced(db, claim, id, data(), { family: 'research', type })).stored, true);
    }
  });

  await t.test('independently valid CFTC parent claims may update the same validated raw-history destination', async () => {
    await reset(); const market = await begin(db, 'markets:tff:latest'); await reserve(db, market);
    const history = await begin(db, 'history:tff:098662:leveraged-funds:2026-09-08:1y'); await reserve(db, history);
    const id = 'RAW-HISTORY:TFF:098662:2026-09-08';
    assert.equal((await fenced(db, market, id, data({ n: 1 }))).stored, true);
    assert.equal((await fenced(db, history, id, data({ n: 2 }))).stored, true);
    assert.deepEqual((await guards(db))[0].cache_guard, { dataset: 'cftc', key: history.key });
    assert.deepEqual(await put(db, id, data()), { stored: false, reason: 'fenced' });
  });

  await t.test('expiry before write rejects and expiry during payload write rolls back bytes, guards and quota changes', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest'); await reserve(db, claim);
    const payload = data(); await put(db, 'MARKETS:TFF:LATEST', payload);
    await db.query("update public.edgar_dataset_heads set cache_claim=jsonb_set(cache_claim,'{expiresAt}',to_jsonb(clock_timestamp()-interval '1 second')) where namespace=$1 and dataset=$2 and resource_key=$3", [ns, claim.dataset, claim.key]);
    await assert.rejects(fenced(db, claim, 'MARKETS:TFF:LATEST', data({ n: 2 })), { code: '40001' });
    await reserve(db, claim);
    const before = await guards(db); const counters = await accounting(db);
    // Local-only SQL fixture causes a deterministic expiry after the helper has
    // replaced bytes. The final 40001 must roll back the entire function call.
    await db.exec(`create sequence edgar_private.test_write_attempt;
      grant usage,select on sequence edgar_private.test_write_attempt to service_role;
      create function edgar_private.test_slow_cache_write() returns trigger language plpgsql as $$
      begin perform nextval('edgar_private.test_write_attempt');perform pg_sleep(0.6);return new;end $$;
      create trigger test_slow_cache_write before insert or update of payload_gzip on edgar_private.cache_entries
      for each row execute function edgar_private.test_slow_cache_write();`);
    await db.query("update public.edgar_dataset_heads set cache_claim=jsonb_set(cache_claim,'{expiresAt}',to_jsonb(clock_timestamp()+interval '500 milliseconds')) where namespace=$1 and dataset=$2 and resource_key=$3", [ns, claim.dataset, claim.key]);
    await assert.rejects(fenced(db, claim, 'MARKETS:TFF:LATEST', data({ n: 3 })), { code: '40001' });
    assert.equal((await db.query('select is_called from edgar_private.test_write_attempt')).rows[0].is_called, true,
      'nontransactional fixture sequence proves the payload helper ran before the rollback');
    await db.exec('drop trigger test_slow_cache_write on edgar_private.cache_entries;drop function edgar_private.test_slow_cache_write();drop sequence edgar_private.test_write_attempt');
    assert.deepEqual(await guards(db), before); assert.deepEqual(await accounting(db), counters);
    assert.equal((await get(db, 'MARKETS:TFF:LATEST'))[0].rawSha256, payload.rawHash);
  });

  await t.test('absolute expiry and family quotas stay unchanged under fencing', async () => {
    await reset(); const claim = await begin(db, 'markets:tff:latest'); await reserve(db, claim); const payload = data();
    const cap = new Date(Date.now() + 30000).toISOString();
    const result = await fenced(db, claim, 'MARKETS:TFF:LATEST', payload, { expiresAt: cap });
    assert.equal(Date.parse(result.expiresAt), Date.parse(cap));
    assert.deepEqual(await fenced(db, claim, 'MARKETS-LAST-GOOD:TFF:LATEST', payload, { expiresAt: '2020-01-01T00:00:00Z' }), { stored: false, reason: 'expired' });
    await assert.rejects(fenced(db, claim, 'MARKETS:TFF:LATEST', payload, { ttl: 7776001 }), /invalid_cache_policy/);
    const status = await rpc(db, 'edgar_cache_status', [ns]); assert.equal(status.maxPayloadBytes, 536870912);
    assert.equal(status.rows, 1); assert.equal(status.payloadBytes, payload.gzip.length);
  });

  await t.test('queued stale, ordinary and valid writers cannot cross a captured canonical generation', async () => {
    await reset(); const old = await begin(db, 'markets:tff:latest'); await reserve(db, old); await release(db, old);
    const next = await begin(db, old.key); await reserve(db, next); await fenced(db, next, 'MARKETS:TFF:LATEST', data({ n: 1 }));
    const results = await role(db, 'service_role', () => Promise.allSettled([
      query(db, 'edgar_cache_put_fenced', [ns, old.dataset, old.key, token(old), ...args('MARKETS:TFF:LATEST', data({ n: 2 }))]),
      query(db, 'edgar_cache_put', [ns, ...args('MARKETS:TFF:LATEST', data({ n: 3 }))]),
      query(db, 'edgar_cache_put_fenced', [ns, next.dataset, next.key, token(next), ...args('MARKETS:TFF:LATEST', data({ n: 4 }))]),
    ]));
    assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.code, '40001');
    assert.equal(results[1].value.rows[0].value.reason, 'fenced'); assert.equal(results[2].value.rows[0].value.stored, true);
    assert.equal((await get(db, 'MARKETS:TFF:LATEST'))[0].rawSha256, data({ n: 4 }).rawHash);
  });
});
