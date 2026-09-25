import { createHmac } from 'node:crypto';
import { bankScopeStore } from './scopeStore.js';
import { bankRssd,bankSelection } from './catalog.js';
import { BankDataError,safeBankError } from './errors.js';
import { BANK_METRICS } from './metrics.js';
import { checkRateLimit,getClientIp,rateLimitedResponse } from '../rateLimit.js';
const PRIVATE={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const PUBLIC={...PRIVATE,'Cache-Control':'public, max-age=0, s-maxage=30, stale-while-revalidate=60'};
const messages={institution_not_found:'No bank with that RSSD is in the available FFIEC directory.',invalid_bank:'Choose a valid bank RSSD.',
  invalid_selection:'Choose one to four FFIEC banks.',invalid_query:'Use a bank name, RSSD, or FDIC certificate.',
  queue_full:'Bank preparation is busy. Please try again shortly.',request_limit:'Please wait before preparing more banks.',
  cross_origin:'Request bank research from this site.',invalid_request:'The bank request is not valid.'};
function fail(error){const safe=safeBankError(error);return Response.json({code:safe.code,error:messages[safe.code]||'Bank research is temporarily unavailable. Please try again.',retryAt:safe.retryAt},
  {status:error instanceof BankDataError?error.status:503,headers:{...PRIVATE,...(safe.retryAt?{'Retry-After':String(Math.max(1,Math.ceil((Date.parse(safe.retryAt)-Date.now())/1000)))}:{})}});}
export function parseBankRead(request) {
  const p=new URL(request.url).searchParams;
  if([...p.keys()].some(k=>!['q','rssds'].includes(k)||p.getAll(k).length!==1)||p.has('q')&&p.has('rssds'))throw new BankDataError('invalid_query',{status:400});
  if(p.has('rssds'))return {operation:'read',payload:{rssds:bankSelection(p.get('rssds'))}};
  const q=(p.get('q')||'').trim();if(q.length>100||/[\x00-\x1f]/.test(q)||q.length===1)throw new BankDataError('invalid_query',{status:400});
  return {operation:'search',payload:{query:q}};
}
export function createBankApi({store=bankScopeStore,rateLimit=checkRateLimit,schedule=()=>{},env=process.env}={}) {
  async function gate(request,write=false){const limit=await rateLimit({key:`rl:bankscope:${write?'prepare':'read'}:${getClientIp(request)}`,windowMs:60000,max:write?8:90});return limit.allowed?null:rateLimitedResponse(limit);}
  return {
    async GET(request){try{
      const selected=parseBankRead(request),blocked=await gate(request);if(blocked)return blocked;
      const data=await store(selected.operation,selected.payload);
      const pending=data?.jobs?.some(j=>['queued','running','retry'].includes(j.status));
      return Response.json(data,{headers:pending?{...PUBLIC,'Cache-Control':'public, max-age=0, s-maxage=3'}:PUBLIC});
    }catch(error){return fail(error);}},
    async POST(request){try{
      const origin=request.headers.get('origin');
      if(request.headers.get('sec-fetch-site')==='cross-site'||origin&&origin!==new URL(request.url).origin)throw new BankDataError('cross_origin',{status:403});
      if(new URL(request.url).search||!request.headers.get('content-type')?.startsWith('application/json')||Number(request.headers.get('content-length'))>1024)throw new BankDataError('invalid_request',{status:400});
      const reader=request.body?.getReader();if(!reader)throw new BankDataError('invalid_request',{status:400});
      const chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1024)throw new BankDataError('invalid_request',{status:413});chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new BankDataError('invalid_request',{status:400});}
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='rssd'))throw new BankDataError('invalid_request',{status:400});
      const rssd=bankRssd(body.rssd),blocked=await gate(request,true);if(blocked)return blocked;
      if(!env.CRON_SECRET)throw new BankDataError('bank_service_unavailable');
      const clientHash=createHmac('sha256',env.CRON_SECRET).update(getClientIp(request)).digest('hex');
      const result=await store('request',{rssd,clientHash});
      if(result.code)throw new BankDataError(result.code,{status:result.code==='institution_not_found'?404:429,retryAt:result.retryAt});
      if(result.queued>0)schedule();
      return Response.json(result,{status:202,headers:PRIVATE});
    }catch(error){return fail(error);}},
    async SOURCE(request){try{
      const p=new URL(request.url).searchParams;
      if([...p.keys()].some(k=>!['rssd','period','hash','metric'].includes(k)||p.getAll(k).length!==1)
        ||!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(p.get('period')||'')||! /^[a-f0-9]{64}$/.test(p.get('hash')||''))throw new BankDataError('invalid_request',{status:400});
      const rssd=bankRssd(p.get('rssd')),metric=p.get('metric');
      if(metric&&!BANK_METRICS.some(m=>m.key===metric))throw new BankDataError('invalid_request',{status:400});
      const blocked=await gate(request);if(blocked)return blocked;
      const data=await store(metric?'lineage':'source',{rssd,period:p.get('period'),hash:p.get('hash'),...(metric?{metric}:{})});
      if(!data)return Response.json({error:'This source version is unavailable.'},{status:404,headers:PRIVATE});
      if(metric)return Response.json(data,{headers:{...PUBLIC,'Cache-Control':'public, max-age=300, s-maxage=86400'}});
      return new Response(data.rawXbrl,{headers:{...PUBLIC,'Content-Type':'application/xml; charset=utf-8',
        'Content-Disposition':`attachment; filename="FFIEC_${rssd}_${p.get('period')}.xml"`,'Content-Security-Policy':"default-src 'none'; sandbox",'X-Robots-Tag':'noindex'}});
    }catch(error){return fail(error);}},
  };
}
