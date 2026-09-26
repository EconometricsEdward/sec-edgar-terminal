import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPeerLandscape,peerVisualValue,peerChartDomain } from '../src/utils/bank/peerVisualModel.js';
import { PEER_BENCHMARKS } from '../src/utils/bank/peerMetrics.js';

const bank={rssd:1,name:'Selected',cblr:false,metrics:{roa:20,nim:25,cet1:12}};
const peers=Array.from({length:6},(_,i)=>({rssd:i+2,name:'Peer '+i,cblr:false,metrics:{roa:i,nim:i*2,cet1:i+10}}));
test('map medians use the same joint reporting cohort, excluding the bank and duplicate identities',()=>{
  const result=buildPeerLandscape(bank,[...peers,bank,{...peers[0],rssd:String(peers[0].rssd)},{rssd:9,metrics:{roa:500}}],'roa','nim');
  assert.equal(result.points.length,6);assert.equal(result.peerCount,7);
  assert.equal(result.xMedian,2.5);assert.equal(result.yMedian,5);
  assert.equal(result.selected.x,20);assert.ok(result.xDomain[1]>20);
});
test('map omits incomplete and non-applicable values without converting missing data to zero',()=>{
  const result=buildPeerLandscape({...bank,cblr:true},peers.map((p,i)=>i<2?{...p,cblr:i===0?true:null}:p),'cet1','roa');
  assert.equal(result.selected,null);assert.equal(result.points.length,4);
  assert.equal(result.xMedian,null);assert.equal(result.yMedian,null);
  assert.equal(peerVisualValue({metrics:{roa:0}},PEER_BENCHMARKS[0]),0);
  assert.equal(peerVisualValue({metrics:{roa:NaN}},PEER_BENCHMARKS[0]),null);
});
test('chart domains preserve negative, zero and tiny values with nonzero plot ranges',()=>{
  for(const values of [[],[0,0],[-.001,-.001],[null,undefined],[2,2],[-20,3]]){
    const [low,high]=peerChartDomain(values);assert.ok(Number.isFinite(low)&&high>low);
    for(const value of values.filter(v=>typeof v==='number'))assert.ok(value>low&&value<high);
  }
});
