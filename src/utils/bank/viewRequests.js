import { isBankReferenceResult } from './referenceResult.js';
import { isOrganizationResult, reusableOrganizationResult } from './organizationResult.js';

const PENDING = new Set(['queued', 'running', 'retry']);
const quarter = value => /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(value);
const identity = (value, rssd) => String(value) === String(rssd);
export const peerPreparationPending = data => PENDING.has(data?.ubpr?.status);

function valid(body, {kind,rssd,period,snapshotId,sourceHash,part}) {
  if (kind === 'organization') return isOrganizationResult(body,rssd,part);
  if (!body || body.period !== period) return false;
  if (kind === 'reference') return isBankReferenceResult(body,rssd,period);
  if (kind === 'peers') return (!body.bank || identity(body.bank.rssd,rssd)) && Array.isArray(body.peers) && body.peers.length <= 30 && Array.isArray(body.benchmarks) && Number.isInteger(body.universeCount) && Number.isInteger(body.eligibleCount);
  if (kind === 'history') return identity(body.rssd,rssd) && body.snapshotId === snapshotId && Array.isArray(body.cohort) && body.cohort.length <= 30 && !body.cohort.some(id=>identity(id,rssd)) && Array.isArray(body.periods) && body.periods.length <= 4 && Array.isArray(body.snapshots) && body.snapshots.length <= 4 && Array.isArray(body.metrics) && body.metrics.every(m=>Array.isArray(m.points) && m.points.length <= 4 && m.points.every(p=>quarter(p.period) && p.period <= period));
  return identity(body.rssd,rssd) && Array.isArray(body.periods) && body.periods.length <= 4 && body.periods.every(p=>quarter(p) && p <= period) && Array.isArray(body.missing) && Array.isArray(body.reports) && body.reports.length <= 4 && body.reports.every(r=>identity(r.rssd,rssd) && body.periods.includes(r.period) && /^[a-f0-9]{64}$/.test(r.hash) && r.values && r.facts && (r.period !== period || !sourceHash || r.hash === sourceHash));
}
function reusable(kind, body, {rssd,part}) {
  if (kind === 'organization') return reusableOrganizationResult(body,rssd,part);
  if (body.publicPeerCache?.stale || body.publicReadCache?.stale) return false;
  if (kind === 'peers') return !!body.snapshot?.id && body.status !== 'preparing';
  if (kind === 'reference') return body.ubpr.status === 'ready' && body.ubpr.report?.data?.stage === 'validated';
  if (kind === 'history') return body.metrics.some(m=>m.points.some(p=>p.sourceAvailable));
  return body.missing.length === 0 && body.reports.some(r=>r.period === body.period);
}
const abortError = () => new DOMException('The request was cancelled.', 'AbortError');
function receive(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(abortError());};
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    signal?.addEventListener('abort',abort,{once:true});
    promise.then(value=>{cleanup();if(!signal?.aborted)resolve(structuredClone(value));},error=>{cleanup();if(!signal?.aborted)reject(error);});
  });
}

/** Browser-session reuse for public views only. No storage persistence or stale fallback.
 * An in-flight read may finish after navigation so returning to a tab can reuse it;
 * subscriber cancellation still prevents updates to the departed view.
 */
export function createBankViewRequests({fetchImpl=globalThis.fetch,now=Date.now,ttlMs=30000,maxEntries=16,maxBytes=2*1024*1024,maxEntryBytes=512*1024,maxInFlight=8,timeoutMs=30000,organizationTimeoutMs=45000}={}) {
  const entries=new Map();let bytes=0,inFlight=0;
  const remove=key=>{const entry=entries.get(key);if(entry){bytes-=entry.bytes||0;entries.delete(key);}};
  return function load(options) {
    const {kind,rssd,period,snapshotId,sourceHash,part,signal,refresh=false}=options;
    if(signal?.aborted)return Promise.reject(abortError());
    if(!['peers','history','exposures','reference','organization'].includes(kind)||!/^\d{1,10}$/.test(String(rssd))
      ||(kind==='organization'?!['profile','network','sec'].includes(part):!quarter(period))||kind==='history'&&!snapshotId)return Promise.reject(new Error('Choose a bank and reporting quarter.'));
    const key=JSON.stringify([kind,String(rssd),kind==='organization'?part:period,kind==='history'?snapshotId:kind==='exposures'?sourceHash||'':null]);
    for(const [key,entry] of entries)if(!entry.pending&&entry.until<=now())remove(key);
    const hit=entries.get(key);
    if(hit?.pending || hit&&!refresh)return receive(hit.promise,signal);
    remove(key);
    if(inFlight>=maxInFlight)return Promise.reject(new Error('Several bank views are loading. Try again shortly.'));
    const endpoint=kind==='organization'?'organization':kind==='exposures'?'exposures':'peers';
    const query=new URLSearchParams(kind==='organization'?{rssd:String(rssd),part}:{rssd:String(rssd),period});
    if(kind==='history')query.set('history','1');
    if(kind==='reference')query.set('reference','1');
    const entry={pending:true,bytes:0,until:0,promise:null};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),kind==='organization'?organizationTimeoutMs:timeoutMs);
    inFlight++;
    entry.promise=(async()=>{
      const response=await fetchImpl(`/api/banks/${endpoint}?${query}`,{signal:controller.signal,cache:refresh?'no-cache':'default'});
      if(!response.ok)throw new Error(kind==='organization'?'Organization data could not be loaded. Please try again.':kind==='history'?'Historical metrics could not be loaded. Current-quarter benchmarks remain available.':kind==='exposures'?'Exposure details could not be loaded. Please try again.':kind==='reference'?'Official FFIEC references could not be loaded. Peer benchmarks remain available.':'Peer benchmarks could not be loaded. Please try again.');
      const body=await response.json();
      if(!valid(body,options))throw new Error(kind==='history'?'The source data refreshed. Retry to align the history with the latest benchmarks.':'The requested bank data could not be verified. Please try again.');
      const size=new TextEncoder().encode(JSON.stringify(body)).byteLength;
      entry.pending=false;
      if(!reusable(kind,body,options)||size>maxEntryBytes||size>maxBytes)remove(key);
      else {
        while(entries.size>maxEntries||bytes+size>maxBytes){const oldest=[...entries].find(([k,e])=>k!==key&&!e.pending);if(!oldest)break;remove(oldest[0]);}
        entry.bytes=size;bytes+=size;entry.until=now()+ttlMs;
      }
      return body;
    })().catch(error=>{remove(key);if(error.name==='AbortError')throw new Error('The bank data request timed out. Please try again.');throw error;}).finally(()=>{clearTimeout(timer);entry.pending=false;inFlight--;});
    entries.set(key,entry);
    return receive(entry.promise,signal);
  };
}
export const loadBankView = createBankViewRequests();
