import { bankRssd } from './catalog.js';
import { getPeerAnalysis } from './peerService.js';
import { isBankReferenceResult } from './referenceResult.js';
import { checkRateLimit,getClientIp,rateLimitedResponse } from '../rateLimit.js';
const headers={'Cache-Control':'public, max-age=0, s-maxage=30, stale-while-revalidate=60','X-Content-Type-Options':'nosniff'};
export function createPeerApi({analyze=getPeerAnalysis,history=getPeerAnalysis.history,reference=getPeerAnalysis.reference,rateLimit=checkRateLimit}={}){
  return async function GET(request){
    let rssd,period,withHistory,withReference;
    try{const p=new URL(request.url).searchParams;
      if([...p.keys()].some(k=>!['rssd','period','history','reference'].includes(k)||p.getAll(k).length!==1)||!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(p.get('period')||'')||p.has('history')&&p.get('history')!=='1'||p.has('reference')&&p.get('reference')!=='1'||p.has('history')&&p.has('reference'))throw Error();
      rssd=bankRssd(p.get('rssd'));period=p.get('period');withHistory=p.get('history')==='1';withReference=p.get('reference')==='1';
    }catch{return Response.json({error:'Choose a bank and a valid reporting quarter.'},{status:400,headers:{'Cache-Control':'private, no-store'}});}
    try{
      const limit=await rateLimit({key:`rl:bankscope:peers:${getClientIp(request)}`,windowMs:60000,max:60});if(!limit.allowed)return rateLimitedResponse(limit);
      const data=await (withReference?reference:withHistory?history:analyze)(rssd,period);
      if(withReference&&!isBankReferenceResult(data,rssd,period))throw Error();
      const referenceReady=withReference&&data.ubpr.status==='ready'&&data.ubpr.report?.data?.stage==='validated';
      return Response.json(data,{headers:withReference&&!referenceReady||data.publicPeerCache?.stale?{...headers,'Cache-Control':'private, no-store'}:headers});
    }catch{return Response.json({error:withReference?'Official FFIEC references are temporarily unavailable. Peer benchmarks remain available.':'Peer benchmarks are temporarily unavailable. Try again shortly.'},{status:503,headers:{'Cache-Control':'private, no-store'}});}
  };
}
