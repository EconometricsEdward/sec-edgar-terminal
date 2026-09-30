import { bankRssd } from './catalog.js';
import { getPeerAnalysis } from './peerService.js';
import { isBankReferenceResult } from './referenceResult.js';
import { createBankApiReadCache, bankApiRefresh } from './apiReadCache.js';
import { checkRateLimit,getClientIp,rateLimitedResponse } from '../rateLimit.js';
const headers={'Cache-Control':'public, max-age=0, s-maxage=30, stale-while-revalidate=60','X-Content-Type-Options':'nosniff'};
function reusable(data, kind, rssd, period) {
  if (!data || data.error || data.period !== period || data.publicPeerCache?.stale) return false;
  if (kind === 'reference') return isBankReferenceResult(data,rssd,period) && data.ubpr.status === 'ready' && data.ubpr.report?.data?.stage === 'validated';
  if (kind === 'history') return String(data.rssd) === String(rssd) && !!data.snapshotId
    && Array.isArray(data.snapshots) && data.snapshots.length <= 4 && Array.isArray(data.metrics)
    && data.metrics.some(metric => metric.points?.some(point => point.sourceAvailable));
  return !!data.snapshot?.id && data.status !== 'preparing' && (!data.bank || String(data.bank.rssd) === String(rssd))
    && Array.isArray(data.peers) && data.peers.length <= 30 && Array.isArray(data.benchmarks)
    && Number.isInteger(data.universeCount) && Number.isInteger(data.eligibleCount);
}
export function createPeerApi({analyze=getPeerAnalysis,history=getPeerAnalysis.history,reference=getPeerAnalysis.reference,rateLimit=checkRateLimit,now=Date.now,readCache=createBankApiReadCache({now})}={}){
  return async function GET(request){
    let rssd,period,withHistory,withReference;
    try{const p=new URL(request.url).searchParams;
      if([...p.keys()].some(k=>!['rssd','period','history','reference'].includes(k)||p.getAll(k).length!==1)||!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(p.get('period')||'')||p.has('history')&&p.get('history')!=='1'||p.has('reference')&&p.get('reference')!=='1'||p.has('history')&&p.has('reference'))throw Error();
      rssd=bankRssd(p.get('rssd'));period=p.get('period');withHistory=p.get('history')==='1';withReference=p.get('reference')==='1';
    }catch{return Response.json({error:'Choose a bank and a valid reporting quarter.'},{status:400,headers:{'Cache-Control':'private, no-store'}});}
    try{
      const limit=await rateLimit({key:`rl:bankscope:peers:${getClientIp(request)}`,windowMs:60000,max:60});if(!limit.allowed)return rateLimitedResponse(limit);
      const kind=withReference?'reference':withHistory?'history':'peers';
      const {data,ageMs}=await readCache(JSON.stringify([kind,rssd,period]),async()=>{
        const data=await (withReference?reference:withHistory?history:analyze)(rssd,period);
        if(withReference&&!isBankReferenceResult(data,rssd,period))throw Error();
        return data;
      },{refresh:bankApiRefresh(request),reusable:data=>reusable(data,kind,rssd,period),
        lifetime:data=>data.publicPeerCache?Date.parse(data.publicPeerCache.checkedAt)+300000-now():30000});
      // Reusing a response must not restart its existing CDN freshness budget.
      const control=reusable(data,kind,rssd,period)?`public, max-age=0, s-maxage=${Math.max(0,30-Math.ceil(ageMs/1000))}, stale-while-revalidate=60`:'private, no-store';
      return Response.json(data,{headers:{...headers,'Cache-Control':control}});
    }catch{return Response.json({error:withReference?'Official FFIEC references are temporarily unavailable. Peer benchmarks remain available.':'Peer benchmarks are temporarily unavailable. Try again shortly.'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
  };
}
