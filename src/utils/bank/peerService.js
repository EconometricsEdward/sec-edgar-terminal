import { bankScopeStore } from './scopeStore.js';
import { buildPeerAnalysis } from './peerModel.js';

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
  return async(rssd,period)=>{
    const [data,ubpr]=await Promise.all([universe(period),store('ubpr_read',{rssd,period})]);
    return {...buildPeerAnalysis(data,rssd),period,ubpr};
  };
}
export const getPeerAnalysis=createPeerService();
