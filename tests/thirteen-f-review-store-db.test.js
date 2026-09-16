import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const ns = 'production', cik = '0002012383', period = '2025-12-31', hash = 'A'.repeat(64);
const signatures = { enqueue: ['text','jsonb','text'], claim: ['text','uuid','integer'], work: ['text','jsonb','integer'],
  save: ['text','jsonb','integer','jsonb','jsonb','integer'], release: ['text','jsonb'], read: ['text','text','date','text','text','text','text','integer','integer'],
  result: ['text','text','date','text','text'], snapshot: ['text','text','date'], progress: ['text','text','date'], save_batch: ['text','jsonb','jsonb'] };
const holding = (i = 0) => ({ key: `${String(i + 1).padStart(9,'0')}|SECURITY|SH`, cusip: String(i + 1).padStart(9,'0'), issuer: `Company ${i}`,
  classTitle: 'COM', putCall: null, quantity: 10, quantityType: 'SH', valueUsd: 100, weightPct: 50 });
const report = (overrides = {}) => ({ manager: { cik, name: 'Fixture manager' }, selectedPeriod: period, observedAt: new Date().toISOString(),
  cache: { checkedAt: new Date().toISOString() }, coverage: { selectedPeriodComplete: true },
  portfolio: { cik, period, positionCount: 2, totalValueUsd: 200, complete: true, holdings: [holding(),holding(1)], filings: [] }, ...overrides });
const result = (h = holding(), status = 'unresolved') => ({ schemaVersion: 'edgar.13f-market-connections.v1', manager: { cik }, selectedPeriod: period,
  holding: h, status, observedAt: new Date().toISOString(), identity: { status: 'unresolved', cusip: h.cusip }, discovery: null });
const summary = (h = holding(), status = 'unresolved') => ({ holding: h, status, issuer: null, message: 'Fixture research status',
  checkedAt: new Date().toISOString(), markets: [], checked: false, partial: false, disclosureOnly: false, retryable: status === 'unavailable' });
const claimToken = c => ({ id: c.id, reportHash: c.reportHash, generation: c.generation, owner: c.owner, cycle: c.cycle });
async function role(db, name, fn) { await db.exec(`set role ${name}`); try { return await fn(); } finally { await db.exec('reset role'); } }
const call = (db, name, args) => role(db, 'service_role', async () => (await db.query(`select public.edgar_fund_review_${name}(${signatures[name].map((type,i)=>`$${i+1}::${type}`).join(',')}) value`, [ns,...args])).rows[0].value);
const read = (db, overrides = {}) => call(db, 'read', [cik,period,overrides.hash ?? null,overrides.market ?? null,overrides.status ?? null,overrides.query ?? null,overrides.offset ?? 0,overrides.limit ?? 25]);
const save = (db,c,ordinal,res = result(holding(ordinal-1)),sum = summary(holding(ordinal-1)),retry = 0) => call(db,'save',[claimToken(c),ordinal,res,sum,retry]);

test('durable reviews enforce shared progress, exact report identity, fencing, retry and budgets', async t => {
  const db = new PGlite();
  await db.exec('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;grant usage on schema public to service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/20260916175154_shared_fund_market_reviews.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260916181554_fund_review_revision_conflicts.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260916183951_fund_review_prepared_snapshots.sql',import.meta.url),'utf8'));
  const reset = () => db.exec('truncate edgar_private.fund_review_jobs,edgar_private.fund_review_results,edgar_private.fund_review_daily_budget cascade');
  try {
    await t.test('private rows and RPCs reject browser roles', async () => {
      for (const r of ['anon','authenticated']) {
        await assert.rejects(role(db,r,()=>db.query('select * from edgar_private.fund_review_jobs')),/permission denied/);
        await assert.rejects(role(db,r,()=>db.query('select public.edgar_fund_review_claim($1,$2,90)',[ns,randomUUID()])),/permission denied/);
      }
    });
    await t.test('same report joins without reset and read enumerates every queued holding', async () => {
      await reset(); const r = report(); const job = await call(db,'enqueue',[r,hash]);
      assert.equal(job.total,2); assert.equal(job.joined,false);
      const c = await call(db,'claim',[randomUUID(),90]); assert.equal(c.reportHash,hash);
      assert.equal((await call(db,'work',[claimToken(c),12]))[0].ordinal,1);
      assert.equal(await save(db,c,1),true);
      const joined = await call(db,'enqueue',[r,hash]); assert.equal(joined.joined,true);assert.equal(joined.id,job.id);assert.equal(joined.reviewed,1);
      const readout = await read(db); assert.equal(readout.page.total,2);assert.equal(readout.coverage.reviewed,1);
      assert.equal(readout.rows[1].status,'unchecked');assert.equal(readout.rows[0].holding.key,holding().key);
      assert.equal((await read(db,{query:'company 1'})).rows.length,1);
      assert.equal((await call(db,'result',[cik,period,hash,holding().key])).holding.key,holding().key);
      assert.equal(await call(db,'release',[claimToken(c)]),true);
      assert.equal((await db.query('select reserved_seconds from edgar_private.fund_review_daily_budget')).rows[0].reserved_seconds,1);
      assert.equal(await call(db,'release',[claimToken(c)]),false,'release cannot refund twice');
    });
    await t.test('only one worker can claim; expired leases recover and fence old publications', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const old=await call(db,'claim',[randomUUID(),90]);
      assert.equal(await call(db,'claim',[randomUUID(),90]),null);
      await db.exec("update edgar_private.fund_review_jobs set lease_until=clock_timestamp()-interval '1 second'");
      const next=await call(db,'claim',[randomUUID(),90]);assert.ok(BigInt(next.generation)>BigInt(old.generation));
      assert.equal(await save(db,old,1),false);assert.equal(await save(db,next,1),true);
      assert.equal(await call(db,'release',[claimToken(old)]),false);
    });
    await t.test('different holdings and old report hashes cannot poison evidence', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      await assert.rejects(save(db,c,1,result(holding(1)),summary(holding(1))),/identity_mismatch/);
      const changed={...holding(),weightPct:99};await assert.rejects(save(db,c,1,result(changed),summary(changed)),/identity_mismatch/);
      await assert.rejects(read(db,{hash:'B'.repeat(64)}),{code:'PT409'});
      await assert.rejects(call(db,'result',[cik,period,'B'.repeat(64),holding().key]),{code:'PT409'});
      const r=report({cache:{checkedAt:new Date(Date.now()-10000).toISOString()}});
      await assert.rejects(call(db,'enqueue',[r,'B'.repeat(64)]),{code:'PT409'});
    });
    await t.test('amendment replaces frozen report and invalidates active worker', async () => {
      await reset();const r=report({cache:{checkedAt:new Date(Date.now()-5000).toISOString()}});await call(db,'enqueue',[r,hash]);
      const c=await call(db,'claim',[randomUUID(),90]);await save(db,c,1);
      const newer=await call(db,'enqueue',[report(),'B'.repeat(64)]);assert.equal(newer.reviewed,0);assert.equal(newer.cycle,2);
      assert.equal(await save(db,c,2),false);assert.equal((await read(db)).coverage.available,0);
    });
    await t.test('transient results retry three times, then complete with explicit gaps', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);
      for(let attempt=1;attempt<=3;attempt++) {
        const c=await call(db,'claim',[randomUUID(),90]);
        const rows=await call(db,'work',[claimToken(c),12]);assert.equal(rows[0].attempts,attempt-1);
        await save(db,c,1,result(holding(),'unavailable'),summary(holding(),'unavailable'),60);
        if(attempt===1)await save(db,c,2);
        await call(db,'release',[claimToken(c)]);
        if(attempt<3)await db.exec("update edgar_private.fund_review_jobs set next_attempt_at=clock_timestamp();update edgar_private.fund_review_results set next_attempt_at=clock_timestamp() where not terminal");
      }
      const value=await read(db);assert.equal(value.job.state,'complete_with_gaps');assert.equal(value.job.reviewed,2);
      assert.equal(value.rows[0].attempts,3);assert.equal(value.rows[0].terminal,true);
    });
    await t.test('new cycles retain prior successful evidence when refresh fails', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);let c=await call(db,'claim',[randomUUID(),90]);
      const good=result(holding(),'ready'), sum={...summary(holding(),'linked'),checked:true};
      await save(db,c,1,good,sum);await save(db,c,2);await call(db,'release',[claimToken(c)]);
      await db.exec("update edgar_private.fund_review_jobs set next_check_at=clock_timestamp()-interval '1 second'");
      c=await call(db,'claim',[randomUUID(),90]);assert.equal(c.cycle,2);
      await save(db,c,1,result(holding(),'unavailable'),summary(holding(),'unavailable'),60);
      const value=await read(db);assert.equal(value.rows[0].preservedPrevious,true);assert.equal(value.rows[0].stale,true);assert.equal(value.rows[0].checkedAt,sum.checkedAt);
      assert.deepEqual(await call(db,'result',[cik,period,hash,holding().key]),good);
    });
    await t.test('claim reservation and attempt caps are global and visible', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);
      await db.exec("insert into edgar_private.fund_review_daily_budget(namespace,day,reserved_seconds,attempts) values('production',(clock_timestamp() at time zone 'UTC')::date,14400,0)");
      assert.equal(await call(db,'claim',[randomUUID(),90]),null);assert.equal((await read(db)).job.status,'budget_paused');
      await db.exec('update edgar_private.fund_review_daily_budget set reserved_seconds=0,attempts=6000');
      assert.equal(await call(db,'claim',[randomUUID(),90]),null);
    });
    await t.test('work does not dispatch beyond the remaining daily attempt allowance', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      await db.exec('update edgar_private.fund_review_daily_budget set attempts=5999');
      const rows=await call(db,'work',[claimToken(c),12]);assert.equal(rows.length,1);
      await save(db,c,1);assert.equal((await call(db,'work',[claimToken(c),12])).length,0);
    });
    await t.test('market aggregates count distinct holdings and retain the full report denominator', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      const market={key:'tff:098662:leveraged-funds',family:'tff',contract:'098662',group:'leveraged-funds',label:'US Dollar',category:'currencies',groupLabel:'Leveraged funds',fit:'proxy',basisLimit:'Not measured economic exposure.'};
      const s={...summary(holding(),'linked'),checked:true,markets:[market]};
      const r=result(holding(),'ready');assert.equal(await save(db,c,1,r,s),true);
      assert.equal(await save(db,c,1,r,s),true,'identical publication retry is acknowledged without counting a second attempt');
      assert.equal((await db.query('select attempts from edgar_private.fund_review_daily_budget')).rows[0].attempts,1);
      const value=await read(db);assert.equal(value.markets.length,1);assert.equal(value.markets[0].holdingCount,1);assert.equal(value.markets[0].sharePct,50);
      assert.equal(value.coverage.linkedSharePct,50);assert.equal(value.coverage.checkedSharePct,50);
      assert.equal((await read(db,{market:market.key})).page.total,1);
      assert.equal((await read(db,{status:'unchecked'})).rows[0].key,holding(1).key);
      assert.equal((await read(db,{offset:1,limit:1})).rows.length,1);
      await assert.rejects(save(db,c,2,result(holding(1),'ready'),{...summary(holding(1),'linked'),markets:[market,market]}),/invalid_fund_review_summary/);
    });
    await t.test('payload ceiling pauses new evidence without evicting successful rows', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      const r=result();const s=summary();await save(db,c,1,r,s);
      await db.exec('update edgar_private.fund_review_jobs set result_bytes=536870912');
      assert.equal(await save(db,c,2),false);assert.equal((await read(db)).job.status,'capacity_paused');
      assert.deepEqual(await call(db,'result',[cik,period,hash,holding().key]),r);
      assert.equal((await read(db)).coverage.available,1);
    });
    await t.test('expiry during publication rolls back result, progress and daily attempt accounting', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      await db.exec(`create sequence edgar_private.fund_review_test_write;
        grant usage,select on sequence edgar_private.fund_review_test_write to service_role;
        create function edgar_private.fund_review_slow_write() returns trigger language plpgsql as $$
        begin perform nextval('edgar_private.fund_review_test_write');perform pg_sleep(0.5);return new;end $$;
        create trigger fund_review_test_slow before insert on edgar_private.fund_review_results for each row execute function edgar_private.fund_review_slow_write();`);
      await db.exec("update edgar_private.fund_review_jobs set lease_until=clock_timestamp()+interval '300 milliseconds'");
      await assert.rejects(save(db,c,1),{code:'40001'});
      assert.equal((await db.query('select is_called from edgar_private.fund_review_test_write')).rows[0].is_called,true);
      assert.equal((await read(db)).coverage.available,0);
      assert.equal((await db.query('select attempts from edgar_private.fund_review_daily_budget')).rows[0].attempts,0);
      await db.exec('drop trigger fund_review_test_slow on edgar_private.fund_review_results;drop function edgar_private.fund_review_slow_write();drop sequence edgar_private.fund_review_test_write');
    });
    await t.test('saved publication changes only on release and progress stays compact', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);
      const first=await call(db,'snapshot',[cik,null]);assert.equal(first.publicationVersion,'1');assert.equal(first.page.limit,50);assert.equal(first.coverage.available,0);
      const c=await call(db,'claim',[randomUUID(),90]);assert.equal(c.attemptsRemaining,6000);await save(db,c,1);
      const progress=await call(db,'progress',[cik,null]);assert.deepEqual(Object.keys(progress).sort(),['job','publicationVersion','publishedAt']);
      assert.equal(progress.job.reviewed,1);assert.equal(progress.publicationVersion,'1');
      assert.equal((await call(db,'snapshot',[cik,period])).coverage.available,0,'saved publication is unchanged until release');
      await call(db,'release',[claimToken(c)]);
      const published=await call(db,'snapshot',[cik,null]);assert.equal(published.publicationVersion,'2');assert.equal(published.coverage.available,1);
      assert.equal((await read(db)).publicationVersion,'2');assert.equal(published.job.denominatorUsd,200);assert.equal(published.report.complete,true);
      assert.deepEqual(published.reports,[{period,latestFiled:null}]);
    });
    await t.test('prepared snapshot and progress do not read frozen holdings or aggregate evidence', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);
      const columns=(await db.query("select attname from pg_attribute where attrelid='edgar_private.fund_review_jobs'::regclass and attnum>0 and not attisdropped and attname<>'report'")).rows.map(r=>r.attname);
      assert.ok(columns.every(c=>/^[a-z_]+$/.test(c)));
      await db.exec(`revoke select on edgar_private.fund_review_jobs,edgar_private.fund_review_results from service_role;grant select (${columns.join(',')}) on edgar_private.fund_review_jobs to service_role`);
      try {
        assert.equal((await call(db,'snapshot',[cik,null])).job.cik,cik);
        assert.equal((await call(db,'progress',[cik,period])).job.cik,cik);
        await assert.rejects(read(db),/permission denied/);
      } finally { await db.exec('grant select on edgar_private.fund_review_jobs,edgar_private.fund_review_results to service_role'); }
    });
    await t.test('latest snapshot selects the latest saved quarter and legacy jobs keep a read-only fallback', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);
      const newer=report();newer.selectedPeriod='2026-03-31';newer.portfolio.period=newer.selectedPeriod;
      await call(db,'enqueue',[newer,'B'.repeat(64)]);
      assert.equal((await call(db,'snapshot',[cik,null])).job.period,'2026-03-31');
      assert.equal((await call(db,'snapshot',[cik,period])).job.period,period);
      await db.exec('update edgar_private.fund_review_jobs set publication=null,publication_version=0,published_at=null');
      const fallback=await call(db,'snapshot',[cik,period]);assert.equal(fallback.rows.length,2);assert.equal(fallback.publicationVersion,'0');
      assert.equal((await db.query('select count(*)::integer n from edgar_private.fund_review_jobs where publication is not null')).rows[0].n,0,'fallback never writes');
      assert.equal(await call(db,'progress',['0000000001',null]),null);
    });
    await t.test('report amendments atomically replace the publication and increment its version', async () => {
      await reset();await call(db,'enqueue',[report({cache:{checkedAt:new Date(Date.now()-10000).toISOString()}}),hash]);
      const c=await call(db,'claim',[randomUUID(),90]);await save(db,c,1);await call(db,'release',[claimToken(c)]);
      const before=await call(db,'snapshot',[cik,null]);
      await call(db,'enqueue',[report(),'B'.repeat(64)]);const after=await call(db,'snapshot',[cik,null]);
      assert.equal(after.job.reportHash,'B'.repeat(64));assert.equal(after.coverage.available,0);assert.ok(BigInt(after.publicationVersion)>BigInt(before.publicationVersion));
    });
    await t.test('bounded work cursor skips deferred cold rows without losing their future eligibility', async () => {
      await reset();const r=report();r.portfolio.holdings=Array.from({length:120},(_,i)=>holding(i));r.portfolio.positionCount=120;r.portfolio.totalValueUsd=12000;
      await call(db,'enqueue',[r,hash]);const c=await call(db,'claim',[randomUUID(),90]);
      const work=after=>role(db,'service_role',async()=>(await db.query('select public.edgar_fund_review_work($1,$2::jsonb,100,$3::integer) value',[ns,claimToken(c),after])).rows[0].value);
      assert.equal((await work(0)).length,100);assert.equal((await work(100))[0].ordinal,101);assert.equal((await work(0))[0].ordinal,1);
      await assert.rejects(work(20001),/invalid_fund_review_work/);
    });
    await t.test('batch save is atomic, idempotent and retains the shared daily cap', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      const entries=[1,2].map(ordinal=>({ordinal,result:result(holding(ordinal-1)),summary:summary(holding(ordinal-1)),retrySeconds:0}));
      const bad=[entries[0],{...entries[1],result:result(holding())}];
      await assert.rejects(call(db,'save_batch',[claimToken(c),bad]),/identity_mismatch/);
      assert.equal((await read(db)).coverage.available,0);assert.equal((await db.query('select attempts from edgar_private.fund_review_daily_budget')).rows[0].attempts,0);
      await db.exec('update edgar_private.fund_review_daily_budget set attempts=5999');
      assert.equal(await call(db,'save_batch',[claimToken(c),entries]),false);assert.equal((await read(db)).coverage.available,0);
      assert.equal((await db.query('select attempts from edgar_private.fund_review_daily_budget')).rows[0].attempts,5999);
      await db.exec('update edgar_private.fund_review_daily_budget set attempts=0');
      assert.equal(await call(db,'save_batch',[claimToken(c),entries]),true);assert.equal(await call(db,'save_batch',[claimToken(c),entries]),true);
      assert.equal((await db.query('select attempts from edgar_private.fund_review_daily_budget')).rows[0].attempts,2);
      assert.equal((await read(db)).coverage.available,2);await call(db,'release',[claimToken(c)]);
      assert.equal((await call(db,'snapshot',[cik,null])).job.status,'complete');
      assert.equal(await call(db,'save_batch',[claimToken(c),entries]),false,'released lease cannot publish a batch');
    });
    await t.test('failed publication preserves the previous publication and saved checkpoints', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const first=await call(db,'snapshot',[cik,null]);
      const c=await call(db,'claim',[randomUUID(),90]);await save(db,c,1);
      await db.exec('alter table edgar_private.fund_review_jobs add constraint fixture_publication_guard check(publication_version<=1)');
      await assert.rejects(call(db,'release',[claimToken(c)]),/fixture_publication_guard/);
      const unchanged=await call(db,'snapshot',[cik,null]);assert.equal(unchanged.publicationVersion,first.publicationVersion);assert.equal(unchanged.coverage.available,0);
      assert.equal((await read(db)).coverage.available,1,'durable saved evidence survives failed publication');
      await db.exec('alter table edgar_private.fund_review_jobs drop constraint fixture_publication_guard');
      assert.equal(await call(db,'release',[claimToken(c)]),true);assert.equal((await call(db,'snapshot',[cik,null])).coverage.available,1);
    });
    await t.test('summary citations are optional, bounded and tied to the verified issuer', async () => {
      await reset();await call(db,'enqueue',[report(),hash]);const c=await call(db,'claim',[randomUUID(),90]);
      const src={accession:'0000000001-25-000001',form:'10-K',filed:'2025-12-30',reportDate:'2025-09-30',url:'https://www.sec.gov/Archives/edgar/data/1/000000000125000001/report.htm'};
      const sum={...summary(holding(),'linked'),issuer:{cik:'0000000001'},sources:[src]};
      await assert.rejects(save(db,c,1,result(),{...sum,sources:[{...src,url:src.url.replace('/data/1/','/data/2/')}]}),/invalid_fund_review_sources/);
      assert.equal(await save(db,c,1,result(),sum),true);await call(db,'release',[claimToken(c)]);
      assert.deepEqual((await call(db,'snapshot',[cik,null])).rows[0].sources,[src]);
    });
    await t.test('admission is finite and only inactive completed jobs can be evicted', async () => {
      await reset();
      for(let i=0;i<20;i++) { const r=report();r.manager.cik=String(i+1).padStart(10,'0');r.portfolio.cik=r.manager.cik;await call(db,'enqueue',[r,hash]); }
      await assert.rejects(call(db,'enqueue',[report(),hash]),{code:'54000'});
      await db.exec("update edgar_private.fund_review_jobs set state='complete',last_requested_at=clock_timestamp()-interval '31 days' where cik='0000000001'");
      await call(db,'enqueue',[report(),hash]);assert.equal((await db.query('select count(*)::integer n from edgar_private.fund_review_jobs')).rows[0].n,20);
    });
  } finally { await db.close(); }
});
