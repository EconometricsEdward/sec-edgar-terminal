import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFundamentalDiagnostics, pairedGroupVariance, UNIVERSE_METRICS } from '../src/utils/marketFundamentals.js';
import { upgradeUniverseSnapshot, UNIVERSE_METHOD, universeMarkdown } from '../src/utils/marketUniverse.js';
import { isUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { DEFAULT_MARKET_VIEW, parseMarketView, marketViewQuery } from '../src/utils/marketResearch.js';

const row=(i,change=1,group='a')=>({ticker:`T${i}`,cik:String(i+1),group,financial:false,filed:'2026-08-01',fiscal_end:'2026-06-30',prior_fiscal_end:'2025-06-30',metrics:Object.fromEntries(UNIVERSE_METRICS.map(m=>[m.key,{prior:i,current:i+change,change}]))});
test('absolute diagnostics detect a universal decline even when ranks and dispersion are unchanged',()=>{
  const up=computeFundamentalDiagnostics(Array.from({length:10},(_,i)=>row(i,2))).breadth[0];
  const down=computeFundamentalDiagnostics(Array.from({length:10},(_,i)=>row(i,-2))).breadth[0];
  assert.equal(up.balance_pct,100);assert.equal(down.balance_pct,-100);
  assert.equal(up.change.median,2);assert.equal(down.change.median,-2);
  assert.equal(up.paired_iqr_change,0);assert.equal(down.paired_iqr_change,0);
});
test('symmetric bands retain neutral issuers and leave raw magnitude and dispersion unchanged',()=>{
  const rows=[-1,-.5,-.2,0,.2,.5,1].map((x,i)=>row(i,x));
  const raw=computeFundamentalDiagnostics(rows),band=computeFundamentalDiagnostics(rows,.5);
  assert.deepEqual([band.breadth[0].higher,band.breadth[0].lower,band.breadth[0].unchanged,band.breadth[0].eligible],[1,1,5,7]);
  assert.equal(band.breadth[0].balance_pct,0);
  for(let i=0;i<6;i++)for(const key of ['change','current','prior','paired_iqr_change','variance'])assert.deepEqual(raw.breadth[i][key],band.breadth[i][key]);
});
test('cash confirmation has a common complete-case operating sample and includes neutral cells',()=>{
  const rows=[row(0,1),row(1,1),row(2,-1),row(3,0),row(4,9),row(5,9)];
  rows[1].metrics.freeCashFlowMargin.change=-1;
  rows[2].metrics.freeCashFlowMargin.change=1;
  rows[4].metrics.freeCashFlowMargin.change=null;
  rows[5].financial=true;
  const c=computeFundamentalDiagnostics(rows).cash_confirmation;
  assert.deepEqual([c.population,c.eligible,c.missing,c.growth_higher,c.cash_higher,c.both_higher,c.confirmation_pct],[5,4,1,2,2,1,50]);
  assert.equal(c.cells.reduce((n,x)=>n+x.count,0),4);
  assert.equal(new Set(c.cells.flatMap(x=>x.tickers)).size,4);
  assert.deepEqual(c.cells.find(x=>x.growth==='higher'&&x.cash==='lower').tickers,['T1']);
  assert.equal(computeFundamentalDiagnostics([row(0,0)]).cash_confirmation.confirmation_pct,null);
  assert.equal(computeFundamentalDiagnostics([]).cash_confirmation.higher_share_gap,null);
});
test('population variance partitions exactly with fixed groups and excludes unpaired outliers',()=>{
  const rows=[row(0,1,'a'),row(1,1,'a'),row(2,1,'b'),row(3,1,'b'),row(4,1,'b')];
  [-2,2,8,12].forEach((prior,i)=>{rows[i].metrics.operatingMargin={prior,current:[-1,1,9,11][i]};});
  rows[4].metrics.operatingMargin={prior:100000,current:null};
  const d=pairedGroupVariance(rows,'operatingMargin');
  assert.equal(d.eligible,4);assert.equal(d.groups,2);
  assert.deepEqual([d.prior.total,d.prior.within,d.prior.between],[29,4,25]);
  assert.deepEqual([d.current.total,d.current.within,d.current.between],[26,1,25]);
  assert.deepEqual(d.change,{total:-3,within:-3,between:0});
  for(const period of [d.current,d.prior])assert.equal(period.total,period.within+period.between);
  const flat=[row(0,0),row(1,0)];flat.forEach(r=>r.metrics.netMargin={prior:1,current:1});
  const zero=pairedGroupVariance(flat,'netMargin');assert.equal(zero.current.within_share,null);assert.equal(zero.current.between_share,null);
});
test('v2 additive upgrades preserve SEC source clocks and rows while refusing legacy mixed snapshots',()=>{
  const rows=Array.from({length:10},(_,i)=>row(i));
  const prior={schema_version:'edgar.factor-universe.v2',methodology_version:UNIVERSE_METHOD,diagnostics_version:'fundamental-diagnostics-2.0.0',basis:'ttm',generated_at:'2026-09-09T05:00:00Z',sec_snapshot_at:'2026-09-09T04:00:00Z',status:'ready',rows,scopes:{all:{id:'all',label:'All',companies:10}},history:[{sec_snapshot_at:'2026-09-08T04:00:00Z'}],limitations:[],links:{methodology:'/market/factors',api:'/api/v2/factor-universe'}};
  assert.equal(isUniverseSnapshot(prior),true);
  const original=JSON.stringify(prior),next=upgradeUniverseSnapshot(prior);
  assert.equal(next.methodology_version,UNIVERSE_METHOD);assert.equal(JSON.stringify(prior),original);
  for(const key of ['generated_at','sec_snapshot_at','rows','history'])assert.strictEqual(next[key],prior[key]);
  assert.equal(next.scopes.all.cash_confirmation.eligible,10);
  assert.throws(()=>upgradeUniverseSnapshot({...prior,schema_version:'edgar.factor-universe.v1'}),/cannot be upgraded/);
  const note=universeMarkdown(next,'all',1);assert.match(note,/Direction threshold: ±1 percentage points/);assert.match(note,/SEC Fundamental Lab/);
});
test('legacy factors views migrate to Fundamental Lab while preserving SEC metric settings',()=>{
  const view={...DEFAULT_MARKET_VIEW,tab:'fundamentals',metric:'freeCashFlowMargin',quantThreshold:.5};
  assert.deepEqual(parseMarketView(marketViewQuery(view)),view);
  assert.equal(parseMarketView('tab=factors').tab,'fundamentals');
  assert.equal(parseMarketView('tab=factors').quantThreshold,0);
  assert.equal(parseMarketView('tab=factors&cutoff=-1').quantThreshold,0);
});
