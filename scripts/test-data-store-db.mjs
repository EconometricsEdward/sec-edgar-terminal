#!/usr/bin/env node
/** Local SQL rehearsal; never reads application credentials or connects to a server. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";

const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const migration = await readFile(new URL("../supabase/migrations/20260913031639_edgar_staged_data_store.sql", import.meta.url), "utf8");
assert.ok(migration.trim().length > 100, "tracked migration must exist and contain SQL");
const namespace = "local-rehearsal";
const bucket = "edgar-durable-private";
const sourceFetchedAt = "2026-08-01T12:00:00.000Z";
const revalidatedAt = "2026-09-13T12:00:00.000Z";
const expiresAt = "2026-09-20T12:00:00.000Z";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const objects = new Map();
const checks = [];
let db;
let restored;

async function makeDatabase() {
  const local = new PGlite();
  await local.exec(`
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
  // This is the exact tracked migration, not a rewritten approximation.
  try { await local.exec(migration); } catch (error) { await local.close(); throw error; }
  return local;
}

async function asRole(local, role, action) {
  assert.ok(["anon", "authenticated", "service_role"].includes(role));
  await local.exec(`set role ${role}`);
  try { return await action(); } finally { await local.exec("reset role"); }
}

async function rpc(name, params, local = db) {
  const signatures = {
    edgar_begin_write: "text,text,text,uuid,integer",
    edgar_get_version: "text,text,text,text,text",
    edgar_publish: "text,text,text,jsonb,jsonb,boolean",
    edgar_revalidate: "text,text,text,jsonb,jsonb",
    edgar_enqueue_job: "text,text,text,text,jsonb,integer",
    edgar_claim_job: "text,text,uuid,integer,text",
    edgar_finish_job: "text,jsonb,text,jsonb,text,integer",
    edgar_checkpoint_job: "text,jsonb,jsonb,integer",
    edgar_export_manifests: "text,uuid,integer",
    edgar_retention_dry_run: "text,timestamptz,integer",
    edgar_store_status: "text",
    edgar_release_write: "text,text,text,jsonb",
    edgar_read_financial_metrics: "text,uuid",
    edgar_orphan_dry_run: "text,timestamptz,integer",
  };
  assert.ok(name in signatures, "RPC must be listed explicitly");
  const types = signatures[name].split(",");
  assert.equal(params.length, types.length);
  return asRole(local, "service_role", async () => {
    const result = await local.query(`select public.${name}(${types.map((type, index) => `$${index + 1}::${type}`).join(",")}) as value`, params);
    return result.rows[0].value;
  });
}

async function check(label, action) {
  await action();
  checks.push(label);
  console.log(`PASS ${label}`);
}

const claim = (dataset, key, local = db) => rpc("edgar_begin_write", [namespace, dataset, key, randomUUID(), 120], local);
const get = (dataset, key, pointer = "current", local = db) => rpc("edgar_get_version", [namespace, dataset, key, null, pointer], local);
const publish = (dataset, key, fence, record, good = true, local = db) => rpc("edgar_publish", [namespace, dataset, key, fence, record, good], local);

function recordFor(payload, extra = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    identityHash: sha(`schema-1:${bytes}`), contentHash: sha(bytes), schemaVersion: "1",
    payload, rawBytes: bytes.length, storedBytes: gzipSync(bytes).length,
    metadata: { fetchedAt: sourceFetchedAt, revalidatedAt: sourceFetchedAt, expiresAt, parserVersion: "fixture-1", calculationVersion: "fixture-1", entityId: "0000320193", reportPeriod: "2025-09-27" },
    ...extra,
  };
}

async function putObject(path, payload, local = db) {
  const raw = Buffer.from(JSON.stringify(payload));
  const compressed = gzipSync(raw);
  objects.set(path, compressed);
  await local.query("insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3) on conflict(bucket_id,name) do nothing", [bucket, path, { size: compressed.length }]);
  return { objectPath: path, contentHash: sha(raw), rawBytes: raw.length, storedBytes: compressed.length };
}

async function objectRecord(label, payload, local = db) {
  const stored = await putObject(`${namespace}/snapshots/${label}.json.gz`, payload, local);
  return recordFor(payload, { payload: null, ...stored });
}

async function expireWrite(dataset, key) {
  await db.query("update public.edgar_dataset_heads set lease_until=clock_timestamp()-interval '1 second' where namespace=$1 and dataset=$2 and resource_key=$3", [namespace, dataset, key]);
}

async function expectStale(action) {
  await assert.rejects(action, (error) => error.code === "40001" && /stale_generation/.test(error.message));
}

try {
  db = await makeDatabase();
  console.log(JSON.stringify({ engine: (await db.query("select version() as version")).rows[0].version, migration: "20260913031639_edgar_staged_data_store.sql", mode: "isolated local SQL; Storage metadata/bytes fixtures; no network", limitation: "PGlite PostgreSQL 18 differs from live Supabase PostgreSQL 17; serial interleavings do not establish multi-connection throughput or hosted gateway behavior" }));

  await check("unmodified migration creates private bucket, RLS and restricted RPC/table grants", async () => {
    const privateBucket = (await db.query("select public,file_size_limit,allowed_mime_types from storage.buckets where id=$1", [bucket])).rows[0];
    assert.equal(privateBucket.public, false);
    assert.equal(Number(privateBucket.file_size_limit), 6291456);
    assert.deepEqual(privateBucket.allowed_mime_types, ["application/gzip"]);
    const tables = (await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r' and relname like 'edgar_%'")).rows;
    assert.equal(tables.length, 5);
    assert.ok(tables.every((row) => row.relrowsecurity));
    for (const table of tables) {
      const mayDelete = (await db.query("select has_table_privilege('service_role',$1,'DELETE') as allowed", [`public.${table.relname}`])).rows[0].allowed;
      assert.equal(mayDelete, false, "runtime role has no destructive table grant");
    }
    const functions = (await db.query("select p.oid,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'edgar_%'")).rows;
    assert.equal(functions.length, 14);
    assert.ok(functions.every((row) => !row.prosecdef && row.proconfig.some((value) => value.startsWith("search_path="))));
    for (const role of ["anon", "authenticated"]) {
      for (const table of tables) {
        await asRole(db, role, () => assert.rejects(db.query(`select 1 from public.${table.relname} limit 1`), { code: "42501" }));
      }
      for (const fn of functions) {
        const allowed = (await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') as allowed", [role, fn.oid])).rows[0].allowed;
        assert.equal(allowed, false, `${role} cannot execute ${fn.proname}`);
      }
      await asRole(db, role, () => assert.rejects(db.query("select public.edgar_store_status($1)", [namespace]), { code: "42501" }));
    }
  });

  let original;
  await check("publication requires verified object metadata and fails atomically", async () => {
    const fence = await claim("cftc", "market");
    const missing = recordFor({ positions: 1 }, { payload: null, objectPath: `${namespace}/missing.gz` });
    await assert.rejects(publish("cftc", "market", fence, missing), /snapshot_object_missing/);
    assert.equal(await get("cftc", "market"), null);
    assert.equal(Number((await db.query("select count(*) as count from public.edgar_dataset_versions")).rows[0].count), 0);
    original = await publish("cftc", "market", fence, await objectRecord("market-v1", { positions: 1 }));
    assert.equal((await get("cftc", "market", "last-good")).id, original);
    const partialClaim = await claim("cftc", "market");
    const partialSource = { ...await putObject(`${namespace}/sources/interrupted.json.gz`, { source: "uploaded-before-failure" }), url: "https://www.cftc.gov/dea/newcot/f_disagg.txt", fetchedAt: sourceFetchedAt };
    const interrupted = recordFor({ positions: 2, interruption: true }, { payload: null, objectPath: `${namespace}/missing.gz`, source: partialSource });
    await assert.rejects(publish("cftc", "market", partialClaim, interrupted), /snapshot_object_missing/);
    assert.equal(Number((await db.query("select count(*) as count from public.edgar_source_assets")).rows[0].count), 0, "failed transaction must roll back source metadata too");
    assert.equal((await get("cftc", "market")).id, original);
    assert.equal((await get("cftc", "market", "last-good")).id, original);
    assert.equal(await rpc("edgar_release_write", [namespace, "cftc", "market", partialClaim]), true);
  });

  await check("duplicate claims, expired workers and older generations cannot publish", async () => {
    const publishedGeneration = (await get("cftc", "market")).generation;
    const older = await claim("cftc", "market");
    assert.equal((await get("cftc", "market")).generation, publishedGeneration, "in-flight claims do not change the visible publication generation");
    assert.equal(await claim("cftc", "market"), null);
    await expireWrite("cftc", "market");
    await expectStale(() => publish("cftc", "market", older, recordFor({ positions: 9 })));
    const newer = await claim("cftc", "market");
    assert.ok(newer.generation > older.generation);
    assert.equal(await rpc("edgar_release_write", [namespace, "cftc", "market", older]), false, "old worker cannot release newer lease");
    await expectStale(() => publish("cftc", "market", older, recordFor({ positions: 10 })));
    await expectStale(() => publish("cftc", "market", { owner: newer.owner }, recordFor({ positions: 11 })));
    await publish("cftc", "market", newer, await objectRecord("market-v2", { positions: 2 }), false);
    assert.equal((await get("cftc", "market", "last-good")).id, original);
    assert.equal((await get("cftc", "market", "rollback")).id, original);
    await expectStale(() => publish("cftc", "market", {}, recordFor({ positions: 12 })));
    await expectStale(() => publish("cftc", "market", newer, recordFor({ positions: 13 })));
  });

  await check("record byte, hash and prepared-payload constraints reject invalid writes without moving pointers", async () => {
    const baseline = await get("cftc", "market");
    const fence = await claim("cftc", "market");
    for (const invalid of [
      recordFor({ oversized: "payload" }, { rawBytes: 25165825 }),
      recordFor({ malformed: "hash" }, { contentHash: "unverified" }),
      recordFor({ oversized: "x".repeat(66000) }),
    ]) {
      await assert.rejects(publish("cftc", "market", fence, invalid), { code: "23514" });
      assert.equal((await get("cftc", "market")).id, baseline.id);
    }
    assert.equal(await rpc("edgar_release_write", [namespace, "cftc", "market", fence]), true);
  });

  await check("unchanged ingestion deduplicates, source revisions remain traceable, revalidation preserves age", async () => {
    const sourcePayload = { cik: 320193, facts: { "us-gaap": { Revenues: { units: { USD: [{ val: 391035000000, start: "2023-10-01", end: "2024-09-28", accn: "0000320193-25-000079", form: "10-K", filed: "2025-10-31", fy: 2025, fp: "FY" }] } } } } };
    const asset = { ...await putObject(`${namespace}/sources/sec-v1.json.gz`, sourcePayload), url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", fetchedAt: sourceFetchedAt, publishedAt: null };
    const snapshot = recordFor(sourcePayload, { source: asset });
    const first = await publish("sec", "companyfacts:320193", await claim("sec", "companyfacts:320193"), snapshot);
    const repeated = await publish("sec", "companyfacts:320193", await claim("sec", "companyfacts:320193"), { ...snapshot, metadata: { ...snapshot.metadata, fetchedAt: revalidatedAt, revalidatedAt } });
    assert.equal(repeated, first);
    assert.equal((await get("sec", "companyfacts:320193")).metadata.fetchedAt, sourceFetchedAt);
    const revalidationClaim = await claim("sec", "companyfacts:320193");
    assert.equal(await rpc("edgar_revalidate", [namespace, "sec", "companyfacts:320193", revalidationClaim, { revalidatedAt, expiresAt, fetchedAt: "2099-01-01T00:00:00Z" }]), true);
    const revalidated = await get("sec", "companyfacts:320193");
    assert.equal(revalidated.metadata.fetchedAt, sourceFetchedAt, "revalidation must not overwrite retrieval age");
    assert.equal(new Date(revalidated.revalidatedAt).toISOString(), revalidatedAt);
    assert.equal(new Date(revalidated.source.fetchedAt).toISOString(), sourceFetchedAt);
    assert.equal(revalidated.source.publishedAt, null, "unknown source publication time stays absent");
    assert.equal(await rpc("edgar_revalidate", [namespace, "sec", "companyfacts:320193", revalidationClaim, { revalidatedAt, expiresAt }]), false, "released claim cannot revalidate again");
    const revisedPayload = { ...sourcePayload, revision: true };
    const revisedAsset = { ...await putObject(`${namespace}/sources/sec-v2.json.gz`, revisedPayload), url: asset.url, fetchedAt: revalidatedAt, publishedAt: null };
    const revisedRecord = recordFor(revisedPayload, { source: revisedAsset });
    revisedRecord.metadata = { ...revisedRecord.metadata, fetchedAt: revalidatedAt, revalidatedAt };
    const revisedId = await publish("sec", "companyfacts:320193", await claim("sec", "companyfacts:320193"), revisedRecord);
    assert.notEqual(revisedId, first);
    assert.equal((await get("sec", "companyfacts:320193", "rollback")).id, first);
    assert.equal(Number((await db.query("select count(*) as count from public.edgar_source_assets where dataset='sec'")).rows[0].count), 2);
    assert.equal(Number((await db.query("select count(*) as count from public.edgar_dataset_versions where dataset='sec'")).rows[0].count), 2);
  });

  await check("financial observations preserve decimal precision, missingness and comparative period lineage", async () => {
    const financial = recordFor({ revenue: "9007199254740993.25", margin: null }, { observations: [
      { metric: "revenue", value: "9007199254740993.25", unit: "USD", periodStart: "2023-10-01", periodEnd: "2024-09-28", taxonomy: "us-gaap", concept: "RevenueFromContractWithCustomerExcludingAssessedTax", accession: "0000320193-25-000079", form: "10-K", filed: "2025-10-31", fiscalYear: 2025, fiscalPeriod: "FY", context: { periodType: "duration", comparativeObservation: true, scale: 1 } },
      { metric: "margin", value: null, unit: "ratio", context: { missingReason: "denominator_unavailable" } },
    ] });
    const id = await publish("financial", "company:320193", await claim("financial", "company:320193"), financial);
    const rows = (await db.query("select metric,value::text,period_start::text,period_end::text,fiscal_year,accession,context from public.edgar_financial_metrics where version_id=$1 order by ordinal", [id])).rows;
    assert.equal(rows[0].value, "9007199254740993.25");
    assert.equal(rows[0].period_end, "2024-09-28");
    assert.equal(rows[0].fiscal_year, 2025);
    assert.equal(rows[0].accession, "0000320193-25-000079");
    assert.equal(rows[1].value, null);
    assert.equal(rows[1].context.missingReason, "denominator_unavailable");
    const served = await rpc("edgar_read_financial_metrics", [namespace, id]);
    assert.equal(served[0].value, "9007199254740993.25", "JSON transport must preserve numeric precision");
    assert.equal(served[1].value, null);
  });

  await check("job enqueue/claim deduplication, checkpoint resume, retry delay and dead-letter limits", async () => {
    const enqueue = () => rpc("edgar_enqueue_job", [namespace, "sec", "cohort", "cohort:1", { next: 0 }, 3]);
    const id = await enqueue();
    assert.equal(await enqueue(), id);
    const jobClaim = () => rpc("edgar_claim_job", [namespace, "sec", randomUUID(), 120, "cohort:1"]);
    const first = await jobClaim();
    assert.equal(await jobClaim(), null);
    assert.equal(await rpc("edgar_checkpoint_job", [namespace, first, { next: 3 }, 120]), true);
    assert.deepEqual((await db.query("select state,checkpoint from public.edgar_ingestion_jobs where id=$1", [id])).rows[0], { state: "running", checkpoint: { next: 3 } });
    assert.equal(await rpc("edgar_finish_job", [namespace, first, "retry", { next: 5 }, "upstream_429", 60]), true);
    assert.equal(await jobClaim(), null, "Retry-After delay must prevent immediate claim");
    await db.query("update public.edgar_ingestion_jobs set available_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
    const second = await jobClaim();
    assert.deepEqual(second.checkpoint, { next: 5 });
    assert.equal(second.attempts, 2);
    assert.equal(await rpc("edgar_checkpoint_job", [namespace, first, { next: 99 }, 120]), false);
    assert.equal(await rpc("edgar_finish_job", [namespace, first, "done", { next: 99 }, null, 1]), false);
    await db.query("update public.edgar_ingestion_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [id]);
    assert.equal(await rpc("edgar_checkpoint_job", [namespace, second, { next: 99 }, 120]), false, "expired worker cannot renew itself or overwrite checkpoint");
    assert.equal(await rpc("edgar_finish_job", [namespace, second, "done", { next: 99 }, null, 1]), false);
    const third = await jobClaim();
    assert.equal(third.attempts, 3);
    assert.deepEqual(third.checkpoint, { next: 5 });
    assert.equal(await rpc("edgar_finish_job", [namespace, third, "retry", { next: 6 }, "upstream_unavailable", 1]), true);
    assert.equal((await db.query("select state from public.edgar_ingestion_jobs where id=$1", [id])).rows[0].state, "dead");
    assert.equal(await jobClaim(), null);

    const finalId = await rpc("edgar_enqueue_job", [namespace, "cftc", "release", "one-attempt", {}, 1]);
    await rpc("edgar_claim_job", [namespace, "cftc", randomUUID(), 120, "one-attempt"]);
    await db.query("update public.edgar_ingestion_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [finalId]);
    assert.equal(await rpc("edgar_claim_job", [namespace, "cftc", randomUUID(), 120, "one-attempt"]), null);
    assert.deepEqual((await db.query("select state,error_code from public.edgar_ingestion_jobs where id=$1", [finalId])).rows[0], { state: "dead", error_code: "lease_expired" });

    await rpc("edgar_enqueue_job", [namespace, "financial", "company:320193", "finish-success", {}, 2]);
    const success = await rpc("edgar_claim_job", [namespace, "financial", randomUUID(), 120, "finish-success"]);
    await assert.rejects(rpc("edgar_finish_job", [namespace, success, "unknown", {}, null, 1]), /invalid_job_status/);
    assert.equal(await rpc("edgar_finish_job", [namespace, success, "done", { next: 1 }, null, 1]), true);
    assert.equal(await rpc("edgar_claim_job", [namespace, "financial", randomUUID(), 120, "finish-success"]), null);
  });

  await check("retention is bounded dry-run and protects current, last-good, rollback, evidence and in-flight work", async () => {
    const retired = (await get("cftc", "market")).id;
    await publish("cftc", "market", await claim("cftc", "market"), await objectRecord("market-v3", { positions: 3 }), false);
    await publish("cftc", "market", await claim("cftc", "market"), await objectRecord("market-v4", { positions: 4 }), false);
    const before = (await rpc("edgar_store_status", [namespace])).versions;
    const retention = await rpc("edgar_retention_dry_run", [namespace, "2100-01-01T00:00:00Z", 1]);
    assert.equal(retention.dryRun, true);
    assert.equal(retention.deletionEnabled, false);
    assert.equal(retention.sourceEvidenceDeletion, false);
    assert.equal(retention.derivedSnapshotCandidates.length, 1);
    assert.equal(retention.derivedSnapshotCandidates[0].id, retired);
    assert.equal((await rpc("edgar_store_status", [namespace])).versions, before);
    const fence = await claim("cftc", "market");
    assert.equal((await rpc("edgar_retention_dry_run", [namespace, "2100-01-01T00:00:00Z", 100])).derivedSnapshotCandidates.length, 0);
    assert.equal(await rpc("edgar_revalidate", [namespace, "cftc", "market", fence, { revalidatedAt, expiresAt }]), true);
  });

  await check("orphan reconciliation has a grace period, reference checks and an in-flight safety fence", async () => {
    const path = `${namespace}/snapshots/unreferenced.json.gz`;
    await putObject(path, { orphan: true });
    assert.equal((await rpc("edgar_orphan_dry_run", [namespace, "2100-01-01T00:00:00Z", 100])).objects.length, 0, "recent interrupted uploads remain protected");
    await db.query("update storage.objects set created_at=clock_timestamp()-interval '2 days' where name=$1 or name in (select object_path from public.edgar_source_assets)", [path]);
    const candidates = await rpc("edgar_orphan_dry_run", [namespace, "2100-01-01T00:00:00Z", 1]);
    assert.equal(candidates.deletionEnabled, false);
    assert.equal(candidates.objects.length, 1);
    assert.equal(candidates.objects[0].name, path, "referenced source objects never become orphan candidates");
    const fence = await claim("cftc", "market");
    assert.equal((await rpc("edgar_orphan_dry_run", [namespace, "2100-01-01T00:00:00Z", 100])).objects.length, 0);
    assert.equal(await rpc("edgar_release_write", [namespace, "cftc", "market", fence]), true);
    assert.equal(Number((await db.query("select count(*) as count from storage.objects where name=$1", [path])).rows[0].count), 1, "dry-run never deletes bytes or metadata");
    const neighborPath = "localXrehearsal/snapshots/neighbor.json.gz";
    await putObject(neighborPath, { namespace: "different" });
    await db.query("update storage.objects set created_at=clock_timestamp()-interval '2 days' where name=$1", [neighborPath]);
    assert.equal((await rpc("edgar_orphan_dry_run", ["local_rehearsal", "2100-01-01T00:00:00Z", 100])).objects.length, 0, "underscore in namespace must be literal, not a LIKE wildcard");
  });

  await check("bounded portable manifest plus bytes restores locally with hashes, lineage and pointers intact", async () => {
    const manifest = await rpc("edgar_export_manifests", [namespace, null, 100]);
    assert.ok(manifest.length > 4 && manifest.length < 100);
    const firstPage = await rpc("edgar_export_manifests", [namespace, null, 1]);
    assert.equal(firstPage.length, 1);
    const secondPage = await rpc("edgar_export_manifests", [namespace, firstPage[0].id, 1]);
    assert.equal(secondPage.length, 1);
    assert.notEqual(firstPage[0].id, secondPage[0].id);
    const backup = { manifest, tables: {}, objects: {} };
    for (const table of ["edgar_source_assets", "edgar_dataset_versions", "edgar_financial_metrics", "edgar_dataset_heads"]) {
      const condition = table === "edgar_financial_metrics" ? "version_id in (select id from public.edgar_dataset_versions where namespace=$1)" : "namespace=$1";
      // A JSON backup must encode PostgreSQL numeric as text before JSON.parse.
      // A native pg_dump also preserves exact decimals without this conversion.
      const exportedRow = table === "edgar_financial_metrics" ? "to_jsonb(t)||jsonb_build_object('value',t.value::text)" : "to_jsonb(t)";
      backup.tables[table] = (await db.query(`select ${exportedRow} as row from public.${table} t where ${condition} limit 100`, [namespace])).rows.map(({ row }) => row);
    }
    for (const item of manifest) {
      for (const [path, hash] of [[item.object_path, item.content_hash], [item.source_object_path, item.source_content_hash]]) {
        if (!path) continue;
        const bytes = objects.get(path);
        assert.ok(bytes, `backup contains object ${path}`);
        assert.equal(sha(gunzipSync(bytes)), hash);
        backup.objects[path] = bytes.toString("base64");
      }
    }
    const portable = JSON.parse(JSON.stringify(backup));
    restored = await makeDatabase();
    for (const [path, encoded] of Object.entries(portable.objects)) {
      const bytes = Buffer.from(encoded, "base64");
      await restored.query("insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)", [bucket, path, { size: bytes.length }]);
    }
    for (const [table, rows] of Object.entries(portable.tables)) {
      await restored.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table},$1::jsonb)`, [rows]);
    }
    assert.deepEqual(await rpc("edgar_export_manifests", [namespace, null, 100], restored), manifest);
    assert.deepEqual(await get("sec", "companyfacts:320193", "current", restored), await get("sec", "companyfacts:320193"));
    assert.deepEqual(await get("cftc", "market", "last-good", restored), await get("cftc", "market", "last-good"));
    const precise = (await restored.query("select value::text from public.edgar_financial_metrics where metric='revenue'")).rows[0].value;
    assert.equal(precise, "9007199254740993.25");
    console.log(JSON.stringify({ portableManifestRecords: manifest.length, restoredSourceObjects: Object.keys(portable.objects).length, exportBytes: Buffer.byteLength(JSON.stringify(portable)), storedObjectBytes: Object.values(portable.objects).reduce((sum, value) => sum + Buffer.from(value, "base64").length, 0) }));
  });

  console.log(JSON.stringify({ passed: checks.length, failed: 0, status: await rpc("edgar_store_status", [namespace]), hostedSupabaseRoundTrip: "not tested", productionChanged: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: checks.length, failed: 1, code: error.code || error.name, message: error.message }));
  process.exitCode = 1;
} finally {
  if (restored) await restored.close();
  if (db) await db.close();
}
