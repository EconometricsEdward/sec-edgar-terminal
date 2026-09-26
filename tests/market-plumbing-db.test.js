import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import funding from '../src/data/market-research/funding.json' with {type:'json'};
test('private research SQL enforces roles, atomic publication, lease fencing and revision replacement',async()=>{
  const db=new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/migrations/20260926062833_market_funding_derivatives.sql',import.meta.url),'utf8'));
    const rpc=async(op,p={})=>(await db.query('select public.market_research_operation($1,$2::jsonb) result',[op,JSON.stringify(p)])).rows[0].result;
    for(const role of ['anon','authenticated']) { await db.exec(`set role ${role}`);await assert.rejects(rpc('read',{kind:'funding'}),/permission denied/);await assert.rejects(db.query('select * from market_research.sources'),/permission denied/);await db.exec('reset role'); }
    await db.exec('set role service_role');
    await assert.rejects(rpc('begin',{}),/invalid_owner/);
    const claim=await rpc('begin',{owner:'cab74669-2fd6-4f8c-8edc-c3d318c462c2'});assert.equal(claim.allowed,true);
    assert.equal((await rpc('begin',{owner:'cab74669-2fd6-4f8c-8edc-c3d318c462c3'})).allowed,false);
    const snapshot=structuredClone(funding); snapshot.generatedAt=new Date().toISOString();
    // Source archives are fixture bytes here; production uses SHA-256 verified captures.
    const archives=snapshot.sources.map(s=>({...s,gzip:'H4sIAAAAAAAAAwMAAAAAAAAAAAA='}));
    await assert.rejects(rpc('publish',{...claim,generation:0,snapshot,archives}),/lease_lost/);
    assert.equal((await rpc('publish',{...claim,snapshot,archives})).published,true);
    assert.equal((await rpc('read',{kind:'funding'})).snapshot.rates.length,744);
    const invalid=structuredClone(snapshot);invalid.rates[0].date='2099-01-01';
    await assert.rejects(rpc('publish',{...claim,snapshot:invalid,archives}),/future_observation/);
    assert.equal((await rpc('read',{kind:'funding'})).snapshot.rates[0].date,snapshot.rates[0].date);
    const revised={...snapshot,rates:snapshot.rates.slice(-3)};
    await rpc('publish',{...claim,snapshot:revised,archives:[]});
    assert.equal((await db.query("select count(*) n from market_research.observations where identity <> 'treasury_fails'")).rows[0].n,3);
    await rpc('finish',{...claim,result:{funding:'updated'}});
    await assert.rejects(rpc('publish',{...claim,snapshot,archives}),/lease_lost/);
    assert.equal((await rpc('begin',{owner:claim.owner})).allowed,false);
  } finally { await db.close(); }
});
