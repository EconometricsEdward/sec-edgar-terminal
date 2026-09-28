import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20260928145801_postgrest_schema_cache_timeout.sql', import.meta.url), 'utf8');
const roles = async db => (await db.query(`select oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,
  rolcanlogin,rolreplication,rolconnlimit,rolbypassrls,rolconfig from pg_roles
  where rolname in ('authenticator','service_role','anon','authenticated') order by rolname`)).rows;
const timeout = row => row.rolconfig?.find(value => value.startsWith('statement_timeout='));
const withoutTimeout = rows => rows.map(row => ({ ...row,
  rolconfig: (row.rolconfig || []).filter(value => !value.startsWith('statement_timeout=')).sort() }));

async function database() {
  const db = new PGlite();
  await db.exec(`create role authenticator login noinherit; create role service_role nologin bypassrls;
    create role anon nologin; create role authenticated nologin;
    grant service_role,anon,authenticated to authenticator;
    alter role authenticator set statement_timeout='8s';
    alter role authenticator set search_path='public';
    alter role service_role set search_path='public';
    alter role anon set statement_timeout='3s';
    alter role authenticated set statement_timeout='8s';
    create table public.timeout_privilege_fixture(id integer);
    grant select,insert on public.timeout_privilege_fixture to service_role;`);
  return db;
}

test('schema maintenance gets thirty seconds while API timeouts, role attributes and grants remain bounded', async t => {
  const db = await database(); t.after(() => db.close());
  const before = await roles(db);
  const membership = (await db.query('select * from pg_auth_members order by roleid,member')).rows;
  const acl = (await db.query("select relacl from pg_class where oid='public.timeout_privilege_fixture'::regclass")).rows;
  await db.exec(migration);
  const after = await roles(db);
  assert.deepEqual(withoutTimeout(after), withoutTimeout(before));
  assert.equal(timeout(after.find(row => row.rolname === 'authenticator')), 'statement_timeout=30s');
  assert.equal(timeout(after.find(row => row.rolname === 'service_role')), 'statement_timeout=8s');
  for (const name of ['anon', 'authenticated']) assert.deepEqual(after.find(row => row.rolname === name), before.find(row => row.rolname === name));
  assert.deepEqual((await db.query('select * from pg_auth_members order by roleid,member')).rows, membership);
  assert.deepEqual((await db.query("select relacl from pg_class where oid='public.timeout_privilege_fixture'::regclass")).rows, acl);
  await db.exec(migration);
  assert.deepEqual(await roles(db), after);
});

test('an unexpected timeout policy is rejected before changing either role', async t => {
  const db = await database(); t.after(() => db.close());
  await db.exec("alter role service_role set statement_timeout='4s'");
  const before = await roles(db);
  await assert.rejects(db.exec(migration), /postgrest_timeout_policy_changed/);
  assert.deepEqual(await roles(db), before);
});

test('plain PostgreSQL without the hosted PostgREST roles needs no configuration change', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(migration);
  assert.deepEqual(await roles(db), []);
});
