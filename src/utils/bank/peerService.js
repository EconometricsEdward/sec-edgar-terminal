import { bankScopeStore } from './scopeStore.js';
import { buildPeerAnalysis } from './peerModel.js';
import { buildPeerHistory } from './peerHistory.js';
import { isBankReferenceResult } from './referenceResult.js';
import { BankDataError } from './errors.js';
import { getBankPeerUniverse } from './peerUniverseStore.js';

/** Shared per-instance promise bounds large database reads; no user-selected data is cached here. */
export function createPeerService({store=bankScopeStore,now=Date.now,loadUniverse}={}){
  const cache=new Map();
  function universe(period){
    const hit=cache.get(period);if(hit&&hit.until>now())return hit.promise;
    // Only the four current report dates are useful. Bound arbitrary URL-driven keys too.
    if(cache.size>=4)cache.delete(cache.keys().next().value);
    const entry={until:now()+300000,promise:null};
    entry.promise=(loadUniverse?loadUniverse(period):store('peer_universe',{period})).then(data=>{
      if(!data.snapshot)entry.until=now()+30000;
      if(Number.isFinite(data.cacheExpiresAt))entry.until=Math.min(entry.until,data.cacheExpiresAt);
      return data;
    }).catch(error=>{if(cache.get(period)===entry)cache.delete(period);throw error;});
    cache.set(period,entry);return entry.promise;
  }
  const analyze=async(rssd,period)=>{
    const data=await universe(period);
    return {...buildPeerAnalysis(data,rssd),period,...(data.publicPeerCache?{publicPeerCache:data.publicPeerCache}:{})};
  };
  // Optional official-reference reads cannot delay or break peer matching.
  analyze.reference=async(rssd,period)=>{
    const result={rssd:Number(rssd),period,ubpr:await store('ubpr_read',{rssd,period})};
    if(!isBankReferenceResult(result,rssd,period))throw new BankDataError('database_failure');
    return result;
  };
  // History shares the coalesced universe but reads only this bank and its <=30 peers.
  // Separate requests let the current-quarter view remain usable if history fails.
  analyze.history=async(rssd,period)=>{
    const data=await universe(period),analysis=buildPeerAnalysis(data,rssd);
    const freshness=data.publicPeerCache?{publicPeerCache:data.publicPeerCache}:{};
    if(!analysis.bank||!analysis.snapshot?.id)return {...buildPeerHistory({},analysis,period),...freshness};
    const source=await store('peer_history',{rssd,period,snapshotId:analysis.snapshot.id,peers:analysis.peers.map(p=>p.rssd)});
    return {...buildPeerHistory(source,analysis,period),...freshness};
  };
  return analyze;
}
export const getPeerAnalysis=createPeerService({loadUniverse:getBankPeerUniverse});
