import { randomUUID,createHash } from 'node:crypto';
import { createFfiecClient } from './client.js';
import { latestPeriods,apiDate } from './identity.js';
import { normalizeBankPanel,SCOPE_MAPPING_VERSION } from './catalog.js';
import { decodeFacsimile,parseCallXbrl } from './parser.js';
import { normalizeBankReport } from './normalization.js';
import { safeBankError } from './errors.js';
import { bankScopeStore } from './scopeStore.js';

/** One durable, fenced worker. Reader GET routes never import or invoke this. */
export async function runBankWorker({store=bankScopeStore,env=process.env,maintain=false,maxFilings=4,now=Date.now,clientFactory=createFfiecClient}={}) {
  const owner=randomUUID(),begin=await store('begin',{owner});
  if(!begin.allowed)return {status:begin.code,retryAt:begin.retryAt};
  const owned=(op,payload={})=>store(op,{...payload,owner}),result={status:'ready',stored:0,reused:0,directory:0};
  const deadline=now()+180000;
  let client;
  const request=(method,params)=>{
    client ||= clientFactory({env,gate:{reserve:method=>owned('reserve',{method}),cooldown:(retryAt,code)=>owned('cooldown',{retryAt,code})}});
    return client.request(method,params);
  };
  try {
    let state=await store('status');
    if(maintain) {
      if(!state.catalog?.checkedAt || now()-Date.parse(state.catalog.checkedAt)>86400000) {
        const periods=latestPeriods(await request('RetrieveReportingPeriods'),new Date(now()));
        await owned('periods',{periods});state={...state,periods};
      }
      for(const period of state.periods||[]) {
        if(now()>deadline-60000){result.status='more_available';return result;}
        const prior=state.directoryPeriods?.find(p=>p.report_date===period);
        if(prior&&now()-Date.parse(prior.checked_at)<86400000)continue;
        const panel=await request('RetrievePanelOfReporters',{reportingPeriodEndDate:apiDate(period)});
        const submissions=await request('RetrieveFilersSubmissionDateTime',{reportingPeriodEndDate:apiDate(period),lastUpdateDateTime:apiDate(period)});
        const banks=normalizeBankPanel(panel,period,submissions,new Date(now()).toISOString());
        // Keep each transaction well below the database's eight-second limit.
        // A period is marked refreshed only after every chunk has been accepted.
        for(let offset=0;offset<banks.length;offset+=500) {
          if(now()>deadline-25000){result.status='more_available';return result;}
          await owned('catalog',{period,banks:banks.slice(offset,offset+500),reporterCount:banks.length,complete:offset+500>=banks.length});
        }
        result.directory++;
      }
    }
    for(let i=0;i<Math.min(8,maxFilings)&&now()<deadline-35000;i++) {
      const job=await owned('claim');if(!job)break;
      try {
        const saved=await store('source',{rssd:job.id_rssd,period:job.report_date,submission:job.desired_submission});
        const xml=saved?.rawXbrl||decodeFacsimile(await request('RetrieveFacsimile',{
          reportingPeriodEndDate:apiDate(job.report_date),fiIdType:'ID_RSSD',fiId:String(job.id_rssd),facsimileFormat:'XBRL'}));
        const retrievedAt=saved?.retrievedAt||new Date(now()).toISOString();
        const base={jobId:job.id,rssd:job.id_rssd,reportDate:job.report_date,form:job.form,submissionDate:job.desired_submission,
          retrievedAt,rawXbrl:xml,sha256:createHash('sha256').update(xml).digest('hex'),parserVersion:SCOPE_MAPPING_VERSION};
        if(!saved)await owned('publish',{...base,metrics:[],validation:{passed:false,checks:[]},metadata:{format:'XBRL',stage:'source_retained'}});
        const parsed=parseCallXbrl(xml,{rssd:job.id_rssd,reportDate:job.report_date});
        const {metrics,validation,capitalFramework}=normalizeBankReport(parsed,{form:job.form,ingestedAt:retrievedAt});
        await owned('publish',{...base,metrics,validation,metadata:{format:'XBRL',schemaReferences:parsed.schemaReferences,
          factCount:parsed.factCount,capitalFramework,sourceCheckedAt:new Date(now()).toISOString(),submissionTimezone:'Not supplied by FFIEC',versionBasis:'Source SHA-256 and reported submission timestamp'}});
        result.stored++;if(saved)result.reused++;
      }catch(error){
        const safe=safeBankError(error);const transient=['network_api_failure','quota_exhausted','upstream_cooldown','hourly_budget','daily_budget','authentication_failure','database_failure'].includes(safe.code);
        const retryAt=safe.retryAt||(safe.code==='authentication_failure'?new Date(now()+3600000).toISOString():null);
        await owned('job_error',{jobId:job.id,code:safe.code,retryable:transient,retryAt});
        if(transient){
          if(retryAt)await owned('cooldown',{retryAt,code:safe.code});
          result.status='deferred';result.code=safe.code;break;
        }
        result.review=(result.review||0)+1;
      }
    }
    return result;
  }catch(error){const safe=safeBankError(error);result.status='deferred';result.code=safe.code;
    if(safe.retryAt||safe.code==='authentication_failure')await owned('cooldown',{code:safe.code,retryAt:safe.retryAt||new Date(now()+3600000).toISOString()}).catch(()=>{});
    return result;
  }finally{await owned('finish',{code:result.code||null,result}).catch(()=>{});}
}
