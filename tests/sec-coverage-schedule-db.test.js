/** Exact scheduler migration in isolated Postgres WASM; no hosted access or network. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Public test material only. This harness never requests a deployed Vault secret.
const fixtureSecret = '8f'.repeat(32);
const secretName = 'edgar_sec_coverage_scheduler_v1';
const endpoint = 'https://secedgarterminal.com/api/cron/sec-coverage';
const purpose = 'edgar-sec-coverage-v2\nGET\n/api/cron/sec-coverage';
const authorizeSql = 'select public.edgar_authorize_coverage_schedule($1::text,$2::bigint,$3::uuid,$4::text) as allowed';

function signature(timestamp, nonce, { secret = fixtureSecret, messagePurpose = purpose } = {}) {
  return createHmac('sha256', secret).update(`${messagePurpose}\n${timestamp}\n${nonce}`).digest('hex');
}

async function asRole(db, role, action) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`set role ${role}`);
  try { return await action(); } finally { await db.exec('reset role'); }
}

const nowSeconds = async db => Number((await db.query('select floor(extract(epoch from clock_timestamp()))::bigint as timestamp')).rows[0].timestamp);
const authorize = (db, timestamp, nonce, sig = signature(timestamp, nonce), namespace = 'production') =>
  asRole(db, 'service_role', async () => (await db.query(authorizeSql, [namespace, timestamp, nonce, sig])).rows[0].allowed);
const nonceCount = async db => Number((await db.query('select count(*) as count from edgar_private.coverage_schedule_nonces')).rows[0].count);

async function makeDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema extensions;
      create extension pgcrypto with schema extensions;
      create schema vault;
      create table vault.decrypted_secrets (name text primary key, decrypted_secret text not null);
      revoke all on schema vault from public,anon,authenticated;
      revoke all on vault.decrypted_secrets from public,anon,authenticated;
      grant usage on schema public,extensions,vault to service_role;
      grant select on vault.decrypted_secrets to service_role;
      create schema cron;
      create table cron.job (
        jobid bigint primary key, jobname text unique not null, schedule text not null,
        command text not null, active boolean not null default false
      );
      insert into cron.job values (7,'edgar-sec-coverage-v1','*/5 * * * *','select 1',false);
      create function cron.alter_job(job_id bigint, schedule text default null, command text default null,
        database text default null, username text default null, active boolean default null)
      returns void language sql as $fixture$
        update cron.job set schedule=coalesce($2,cron.job.schedule),command=coalesce($3,cron.job.command),active=coalesce($6,cron.job.active)
        where jobid=$1;
      $fixture$;
      create schema net;
      create table net.fixture_requests (
        id bigint generated always as identity primary key, url text not null, params jsonb not null,
        headers jsonb not null, timeout_milliseconds integer not null
      );
      create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 1000)
      returns bigint language sql as $fixture$
        insert into net.fixture_requests(url,params,headers,timeout_milliseconds) values($1,$2,$3,$4) returning id;
      $fixture$;
    `);
    await db.query('insert into vault.decrypted_secrets(name,decrypted_secret) values($1,$2)', [secretName, fixtureSecret]);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).map(async name => ({
      name, sql: await readFile(new URL(name, directory), 'utf8'),
    })));
    const matching = migrations.filter(migration => /create(?: or replace)? function public\.edgar_authorize_coverage_schedule\s*\(/i.test(migration.sql));
    assert.equal(matching.length, 1, 'exactly one tracked signed-scheduler migration must be present');
    await db.exec(matching[0].sql);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

test('coverage scheduler uses restricted, time-bound, single-use HMAC authorization', async t => {
  const db = await makeDatabase();
  t.after(() => db.close());

  await t.test('authorization is SECURITY INVOKER and browser roles cannot invoke it or access nonces or Vault', async () => {
    const functions = (await db.query(`select p.oid,p.prosecdef,p.proconfig,p.provolatile from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='edgar_authorize_coverage_schedule'`)).rows;
    assert.equal(functions.length, 1);
    const fn = functions[0];
    assert.equal(fn.prosecdef, false);
    assert.equal(fn.provolatile, 'v', 'nonce consumption must remain a write');
    assert.ok(fn.proconfig.includes('search_path=""'));
    assert.equal((await db.query("select has_function_privilege('service_role',$1::oid,'EXECUTE') as allowed", [fn.oid])).rows[0].allowed, true);
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='edgar_private.coverage_schedule_nonces'::regclass")).rows[0].relrowsecurity, true);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') as allowed", [role, fn.oid])).rows[0].allowed, false);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        assert.equal((await db.query("select has_table_privilege($1,'edgar_private.coverage_schedule_nonces',$2) as allowed", [role, privilege])).rows[0].allowed, false);
      }
      const timestamp = await nowSeconds(db);
      const nonce = randomUUID();
      await asRole(db, role, async () => {
        await assert.rejects(db.query(authorizeSql, ['production', timestamp, nonce, signature(timestamp, nonce)]), { code: '42501' });
        await assert.rejects(db.query('select nonce from edgar_private.coverage_schedule_nonces'), { code: '42501' });
        await assert.rejects(db.query('select decrypted_secret from vault.decrypted_secrets'), { code: '42501' });
      });
    }
    for (const privilege of ['SELECT', 'INSERT', 'DELETE']) {
      assert.equal((await db.query("select has_table_privilege('service_role','edgar_private.coverage_schedule_nonces',$1) as allowed", [privilege])).rows[0].allowed, true);
    }
    for (const privilege of ['UPDATE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await db.query("select has_table_privilege('service_role','edgar_private.coverage_schedule_nonces',$1) as allowed", [privilege])).rows[0].allowed, false);
    }
  });

  await t.test('a correctly signed request succeeds once and records its issued time', async () => {
    const timestamp = await nowSeconds(db);
    const nonce = randomUUID();
    assert.equal(await authorize(db, timestamp, nonce), true);
    const row = (await db.query('select nonce,issued_at,consumed_at from edgar_private.coverage_schedule_nonces where nonce=$1::uuid', [nonce])).rows[0];
    assert.equal(row.nonce, nonce);
    assert.equal(new Date(row.issued_at).getTime(), timestamp * 1000);
    assert.ok(new Date(row.consumed_at).getTime() >= timestamp * 1000);
    assert.equal(await authorize(db, timestamp, nonce), false);
    assert.equal(await authorize(db, timestamp + 1, nonce), false, 'a new valid timestamp cannot reuse a consumed nonce');
  });

  await t.test('wrong secret, method, path, purpose, timestamp or nonce cannot authenticate or reserve the nonce', async () => {
    const timestamp = await nowSeconds(db);
    const nonce = randomUUID();
    const before = await nonceCount(db);
    for (const sig of [
      signature(timestamp, nonce, { secret: 'different public fixture' }),
      signature(timestamp, nonce, { messagePurpose: purpose.replace('\nGET\n', '\nPOST\n') }),
      signature(timestamp, nonce, { messagePurpose: purpose.replace('/api/cron/sec-coverage', '/api/cron/prewarm') }),
      signature(timestamp, nonce, { messagePurpose: purpose.replace('-v2', '-v1') }),
      signature(timestamp - 1, nonce),
      signature(timestamp, randomUUID()),
    ]) assert.equal(await authorize(db, timestamp, nonce, sig), false);
    assert.equal(await nonceCount(db), before, 'failed authentication cannot poison the replay ledger');
    assert.equal(await authorize(db, timestamp, nonce), true);
  });

  await t.test('malformed signatures, null inputs and unintended namespaces fail closed without writes', async () => {
    const timestamp = await nowSeconds(db);
    const nonce = randomUUID();
    const before = await nonceCount(db);
    for (const sig of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), signature(timestamp, nonce).toUpperCase(), ` ${signature(timestamp, nonce)}`, `${signature(timestamp, nonce)}\n`]) {
      assert.equal(await authorize(db, timestamp, nonce, sig), false);
    }
    assert.equal(await authorize(db, null, nonce, 'a'.repeat(64)), false);
    assert.equal(await authorize(db, timestamp, null, 'a'.repeat(64)), false);
    for (const namespace of [null, '', 'rehearsal', 'other', 'Production', 'production ']) {
      assert.equal(await authorize(db, timestamp, nonce, signature(timestamp, nonce), namespace), false);
    }
    assert.equal(await nonceCount(db), before);
  });

  await t.test('five-minute age and thirty-second future bounds reject expired and extreme timestamps', async () => {
    const timestamp = await nowSeconds(db);
    for (const candidate of [timestamp - 301, timestamp + 31, 0, -1, '9223372036854775807', '-9223372036854775808']) {
      const nonce = randomUUID();
      assert.equal(await authorize(db, candidate, nonce), false, `reject out-of-window timestamp ${candidate}`);
      assert.equal(Number((await db.query('select count(*) as count from edgar_private.coverage_schedule_nonces where nonce=$1::uuid', [nonce])).rows[0].count), 0);
    }
    assert.equal(await authorize(db, (await nowSeconds(db)) - 299, randomUUID()), true);
    assert.equal(await authorize(db, (await nowSeconds(db)) + 29, randomUUID()), true);
  });

  await t.test('multiple pending calls with the same nonce yield one winner', async () => {
    const timestamp = await nowSeconds(db);
    const nonce = randomUUID();
    const params = ['production', timestamp, nonce, signature(timestamp, nonce)];
    // PGlite serializes SQL on one backend. This covers queued duplicate delivery,
    // not a hosted multi-connection concurrency or load test.
    const results = await asRole(db, 'service_role', () => Promise.all(Array.from({ length: 12 }, () => db.query(authorizeSql, params))));
    assert.equal(results.filter(result => result.rows[0].allowed === true).length, 1);
    assert.equal(results.filter(result => result.rows[0].allowed === false).length, 11);
    assert.equal(Number((await db.query('select count(*) as count from edgar_private.coverage_schedule_nonces where nonce=$1::uuid', [nonce])).rows[0].count), 1);
  });

  await t.test('missing or unusable signing material fails closed without consuming a nonce', async () => {
    await db.query('delete from vault.decrypted_secrets where name=$1', [secretName]);
    try {
      const timestamp = await nowSeconds(db);
      const nonce = randomUUID();
      assert.equal(await authorize(db, timestamp, nonce), false);
      await db.query('insert into vault.decrypted_secrets values($1,$2)', [secretName, '']);
      assert.equal(await authorize(db, timestamp, nonce, signature(timestamp, nonce, { secret: '' })), false);
      assert.equal(Number((await db.query('select count(*) as count from edgar_private.coverage_schedule_nonces where nonce=$1::uuid', [nonce])).rows[0].count), 0);
    } finally {
      await db.query('insert into vault.decrypted_secrets values($1,$2) on conflict(name) do update set decrypted_secret=excluded.decrypted_secret', [secretName, fixtureSecret]);
    }
  });

  await t.test('authorized cleanup removes expired nonces while preserving recent replay protection', async () => {
    const expired = randomUUID();
    const recent = randomUUID();
    const timestamp = await nowSeconds(db);
    await db.query(`insert into edgar_private.coverage_schedule_nonces(nonce,issued_at,consumed_at)
      values($1::uuid,clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day')`, [expired]);
    assert.equal(await authorize(db, timestamp, recent), true);
    assert.equal(Number((await db.query('select count(*) as count from edgar_private.coverage_schedule_nonces where nonce=$1::uuid', [expired])).rows[0].count), 0);
    assert.equal(await authorize(db, timestamp, recent), false);
  });

  await t.test('scheduled command stays inactive and sends only endpoint-bound signatures, never the Vault credential', async () => {
    const jobs = (await db.query("select command,active,schedule from cron.job where jobname='edgar-sec-coverage-v1'")).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].active, false);
    assert.equal(jobs[0].schedule, '*/5 * * * *');
    assert.equal(jobs[0].command.includes(fixtureSecret), false);
    assert.equal((await db.query('select count(*)::integer as count from net.fixture_requests')).rows[0].count, 0, 'migration must not dispatch a request');
    await db.exec(jobs[0].command);
    const requests = (await db.query('select * from net.fixture_requests')).rows;
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, endpoint);
    assert.deepEqual(request.params, {});
    assert.ok(request.timeout_milliseconds > 0 && request.timeout_milliseconds <= 280000);
    assert.equal(JSON.stringify(request).includes(fixtureSecret), false);
    assert.equal(Object.keys(request.headers).some(key => key.toLowerCase() === 'authorization'), false);
    const normalized = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
    assert.deepEqual(Object.keys(normalized).sort(), ['x-edgar-schedule-nonce', 'x-edgar-schedule-signature', 'x-edgar-schedule-timestamp']);
    const timestamp = normalized['x-edgar-schedule-timestamp'];
    const nonce = normalized['x-edgar-schedule-nonce'];
    const sig = normalized['x-edgar-schedule-signature'];
    assert.match(timestamp, /^\d{10}$/);
    assert.match(nonce, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.match(sig, /^[a-f0-9]{64}$/);
    assert.equal(sig, signature(timestamp, nonce), 'Postgres HMAC matches independently computed Node HMAC');
    assert.equal(await authorize(db, timestamp, nonce, sig), true);
    assert.equal(await authorize(db, timestamp, nonce, sig), false);
  });
});
