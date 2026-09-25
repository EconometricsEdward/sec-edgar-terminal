import { bankScopeStore } from './scopeStore.js';
import { buildPeerAnalysis } from './peerModel.js';
import { buildPeerHistory } from './peerHistory.js';

/** Shared per-instance promise bounds large database reads; no user-selected data is cached here. */
export function createPeerService({store=bankScopeStore,now=Date.now}={}){
  const cache=new Map();
  function universe(period){
    const hit=cache.get(period);if(hit&&hit.until>now())return hit.promise;
    // Only the four current report dates are useful. Bound arbitrary URL-driven keys too.
    if(cache.size>=4)cache.delete(cache.keys().next().value);
    const entry={until:now()+300000,promise:null};
    entry.promise=store('peer_universe',{period}).then(data=>{if(!data.snapshot)entry.until=now()+30000;return data;}).catch(error=>{cache.delete(period);throw error;});
    cache.set(period,entry);return entry.promise;
  }
  const analyze=async(rssd,period)=>{
    const [data,ubpr]=await Promise.all([universe(period),store('ubpr_read',{rssd,period})]);
    return {...buildPeerAnalysis(data,rssd),period,ubpr};
  };
  // History shares the coalesced universe but reads only this bank and its <=30 peers.
  // Separate requests let the current-quarter view remain usable if history fails.
  analyze.history=async(rssd,period)=>{
    const analysis=buildPeerAnalysis(await universe(period),rssd);
    if(!analysis.bank||!analysis.snapshot?.id)return buildPeerHistory({},analysis,period);
    const source=await store('peer_history',{rssd,period,snapshotId:analysis.snapshot.id,peers:analysis.peers.map(p=>p.rssd)});
    return buildPeerHistory(source,analysis,period);
  };
  return analyze;
}
export const getPeerAnalysis=createPeerService();
