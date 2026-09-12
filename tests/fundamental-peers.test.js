import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRobustPeerZ, compareFundamentalPeer, MIN_FUNDAMENTAL_PEERS } from '../src/utils/fundamentalPeers.js';

const row=(ticker,cik,group,change)=>({ticker,cik,group,metrics:{operatingMargin:{current:10+change,prior:10,change}}});

test('robust peer context is leave-one-issuer-out and retains its SEC inputs',()=>{
  const focus=row('FOCUS','0000000042','sector-tech',10);
  const duplicate=row('OTHER-CLASS','42','sector-tech',-100);
  const peers=Array.from({length:MIN_FUNDAMENTAL_PEERS},(_,index)=>row(`P${index}`,String(100+index),'sector-tech',index+1));
  const result=compareFundamentalPeer(focus,[focus,duplicate,...peers,row('BANK','900','sector-finance',100)],'operatingMargin');
  assert.equal(result.available,true);
  assert.equal(result.distribution.count,MIN_FUNDAMENTAL_PEERS);
  assert.equal(result.distribution.median,4.5);
  assert.deepEqual([result.current,result.prior,result.change_percentage_points],[20,10,10]);
  assert.match(result.methodology,/Leave-one-issuer-out/);
});

test('peer normalization uses MAD, then IQR, then sample deviation without imputing',()=>{
  const mad=calculateRobustPeerZ({value:9,peerValues:[1,2,3,4,5,6,7,8]});
  assert.equal(mad.available,true);assert.equal(mad.distribution.scaleMethod,'median_absolute_deviation');
  const iqr=calculateRobustPeerZ({value:2,peerValues:[0,0,0,0,0,1,2,3]});
  assert.equal(iqr.distribution.scaleMethod,'interquartile_range');
  const sd=calculateRobustPeerZ({value:2,peerValues:[0,0,0,0,0,0,0,10]});
  assert.equal(sd.distribution.scaleMethod,'sample_standard_deviation');
  const missing=calculateRobustPeerZ({value:null,peerValues:Array(8).fill(1)});
  assert.equal(missing.available,false);assert.equal(missing.z,null);
});

test('constant and short peer sets remain unavailable with their true counts',()=>{
  const short=calculateRobustPeerZ({value:2,peerValues:[0,1]});
  assert.equal(short.available,false);assert.equal(short.distribution.count,2);assert.match(short.reason,/At least 8/);
  const constant=calculateRobustPeerZ({value:2,peerValues:Array(8).fill(1)});
  assert.equal(constant.available,false);assert.match(constant.reason,/no usable dispersion/);
});
