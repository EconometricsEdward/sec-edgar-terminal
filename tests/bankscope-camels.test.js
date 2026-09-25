import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePeerRecord,PEER_MODEL_VERSION } from '../src/utils/bank/peerSource.js';
import { buildPeerAnalysis } from '../src/utils/bank/peerModel.js';
import { formatPeerPercent } from '../src/utils/bank/peerMetrics.js';
import { cblrReference,regulatoryContext } from '../src/utils/bank/regulatoryContext.js';
import { refreshPeerUniverse } from '../src/utils/bank/peerWorker.js';
import { bankHref,bankPageOptions } from '../src/utils/bank/viewModel.js';
const period='2026-06-30';
const sources=JSON.parse(await readFile(new URL('./fixtures/fdic-camels-2026-06-30.json',import.meta.url),'utf8'));
const source=rssd=>sources.find(r=>r.RSSDID===rssd);

test('tiny charge-off rates preserve the sign of net recoveries instead of displaying negative zero',()=>{
  assert.equal(formatPeerPercent(-0.001247586699478197),'-0.0012%');
  assert.equal(formatPeerPercent(0),'0.00%');assert.equal(formatPeerPercent(null),'Unavailable');
  assert.equal(formatPeerPercent(12.431),'12.43%');
});

test('expanded real FDIC records retain percentage units and identify CBLR without using bank size',()=>{
  const wells=normalizePeerRecord(source(451965),period),alliance=normalizePeerRecord(source(493741),period),community=normalizePeerRecord(source(3165357),period);
  assert.equal(wells.metrics.cet1,12.06);
  assert.ok(Math.abs(wells.metrics.loansDeposits-63.81632890618304)<1e-9);
  assert.ok(Math.abs(wells.metrics.reserveCoverage-133.76286181363594)<1e-9);
  assert.ok(Math.abs(wells.metrics.operatingExpense-2.282486037622294)<1e-9);
  assert.equal(alliance.cblr,true);assert.equal(alliance.metrics.totalCapital,null);assert.equal(alliance.metrics.cet1,null);
  assert.equal(source(493741).RBCRWAJ,0); // Published placeholder, not a real zero-capital ratio.
  assert.equal(community.cblr,false);assert.equal(community.metrics.cet1,9.85);
  assert.equal(regulatoryContext(community,period).framework,'risk_based'); // < $1bn does not imply CBLR.
  const unknown=normalizePeerRecord({...source(493741),CBLRIND:null},period);
  assert.equal(regulatoryContext(unknown,period).framework,'unknown');
  assert.equal(regulatoryContext(unknown,period).rows.length,0);
  assert.equal(unknown.metrics.totalCapital,null);
});
test('calculated peer metrics preserve real zeros, negatives and >100% values without filling missing denominators',()=>{
  const raw={...source(451965),BRO:0,NONIIR:-1,LNLSGR:200,DEP:100,NCLNLS:0,LNATRES:5};
  const p=normalizePeerRecord(raw,period);
  assert.equal(p.metrics.brokered,0);assert.equal(p.metrics.feeIncome,-1);assert.equal(p.metrics.loansDeposits,200);
  assert.equal(p.metrics.reserveCoverage,null);
  for(const DEP of [null,0,-1,'100'])assert.equal(normalizePeerRecord({...raw,DEP},period).metrics.loansDeposits,null);
  assert.equal(normalizePeerRecord({...raw,LNATRES:null,NCLNLS:2},period).metrics.reserveCoverage,null);
  assert.equal(normalizePeerRecord({...raw,LNATRES:0,NCLNLS:2},period).metrics.reserveCoverage,0);
});
test('capital distributions exclude CBLR placeholders while retaining reported risk-based peer counts',()=>{
  const bank=normalizePeerRecord(source(493741),period),risk=normalizePeerRecord(source(3165357),period);
  const profiles=[bank,...Array.from({length:6},(_,i)=>({...risk,rssd:100+i,assets:bank.assets})),...Array.from({length:6},(_,i)=>({...bank,rssd:200+i}))];
  const result=buildPeerAnalysis({profiles},bank.rssd),capital=result.benchmarks.find(b=>b.key==='totalCapital');
  assert.equal(result.benchmarks.length,24);assert.equal(capital.count,6);assert.equal(capital.notRequired,true);
  assert.equal(capital.value,null);assert.equal(capital.percentile,null);assert.ok(capital.median>0);
  assert.equal(result.benchmarks.find(b=>b.key==='leverage').count,12);
});
test('CBLR references follow the report date and preserve the strictly-greater test',()=>{
  assert.deepEqual(cblrReference('2026-06-30'),{threshold:9,graceQuarters:2,graceFloor:8});
  assert.deepEqual(cblrReference('2026-09-30'),{threshold:8,graceQuarters:4,graceFloor:7});
  assert.equal(cblrReference('2021-12-31'),null);assert.equal(cblrReference('2026-07-01'),null);
  const context=regulatoryContext({cblr:true,metrics:{leverage:9}},period);
  assert.equal(context.rows.length,1);assert.equal(context.rows[0].position,'at');assert.equal(context.rows[0].strict,true);
  assert.equal(context.rows[0].gapBps,0);
  assert.equal(regulatoryContext({cblr:true,metrics:{leverage:9}},'2026-09-30').rows[0].gapBps,100);
});
test('risk-based references keep minimum, base buffer and PCA tests distinct without assigning compliance',()=>{
  const c=regulatoryContext({cblr:false,metrics:{cet1:6.5,tier1:8,totalCapital:10,leverage:5}},period);
  assert.deepEqual(c.rows.map(r=>[r.minimum,r.buffer??null,r.pca]),[[4.5,7,6.5],[6,8.5,8],[8,10.5,10],[4,null,5]]);
  assert.equal(c.rows[0].gapBps,200);assert.equal('compliant' in c,false);assert.equal('rating' in c,false);
  assert.equal(regulatoryContext({cblr:false,metrics:{}},period).rows[0].gapBps,null);
  assert.equal(regulatoryContext({cblr:false,metrics:{cet1:0}},period).rows[0].position,'below');
});
test('a new metric version refreshes fresh snapshots and publishes only after all batches succeed',async()=>{
  const calls=[],now=()=>Date.parse('2026-09-25T20:00:00Z');let version='bankscope-peers-1';
  const options={periods:[period],now,store:async()=>({snapshots:[{report_date:period,model_version:version,completed_at:new Date(now()).toISOString()}]}),
    fetchUniverse:async()=>({period,rows:Array.from({length:1001},()=>({profile:{},raw:{}})),modelVersion:PEER_MODEL_VERSION}),owned:async(op,p)=>calls.push([op,p])};
  assert.equal(await refreshPeerUniverse(options),1001);assert.deepEqual(calls.map(c=>c[0]),['peer_start','peer_batch','peer_batch','peer_batch','peer_complete']);
  version=PEER_MODEL_VERSION;calls.length=0;assert.equal(await refreshPeerUniverse(options),0);assert.equal(calls.length,0);
  version='old';await assert.rejects(()=>refreshPeerUniverse({...options,owned:async op=>{if(op==='peer_batch')throw Error('write failed');assert.notEqual(op,'peer_complete');}}));
});
test('CAMELS and metric category links survive reload and discard unknown categories',()=>{
  const path=bankHref(451965,{view:'compare',panel:'benchmarks',period,lens:'camels',category:'capital'});
  const parsed=bankPageOptions('451965',Object.fromEntries(new URL(path,'https://example.test').searchParams));
  assert.equal(parsed.lens,'camels');assert.equal(parsed.category,'capital');assert.equal(parsed.period,period);
  assert.equal(bankPageOptions('1',{category:'invalid',lens:'invalid'}).category,'core');
  assert.doesNotMatch(bankHref(1,{view:'overview',lens:'camels',category:'capital'}),/lens|category/);
});
