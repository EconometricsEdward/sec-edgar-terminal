import { randomUUID,createHash } from 'node:crypto';
import { fetchPeerUniverse,PEER_MODEL_VERSION } from './peerSource.js';
import { decodeFacsimile } from './parser.js';
import { apiDate } from './identity.js';
import { BankDataError,safeBankError } from './errors.js';
import { parseUbprXbrl } from './ubpr.js';

export async function refreshPeerUniverse({store,owned,periods,now=Date.now,deadline=now()+180000,fetchUniverse=fetchPeerUniverse}) {
  // Leave one gateway timeout for the worker's finally/finish operation in
  // addition to the next operation's budget. Partial snapshots stay unpublished.
  const requireTime=(operationMs=25000)=>{
    if(now()+operationMs+25000>deadline)throw new BankDataError('worker_deadline');
  };
  requireTime();
  const state=await store('peer_status');
  const period=periods.find(p=>!state.snapshots?.some(s=>s.report_date===p&&s.model_version===PEER_MODEL_VERSION&&now()-Date.parse(s.completed_at)<86400000));
  if(!period)return 0;
  requireTime(35000);
  const data=await fetchUniverse(period),snapshotId=randomUUID();
  requireTime();
  await owned('peer_start',{...data,rows:undefined,snapshotId,count:data.rows.length});
  for(let i=0;i<data.rows.length;i+=500){
    requireTime();
    await owned('peer_batch',{snapshotId,rows:data.rows.slice(i,i+500)});
  }
  requireTime();
  await owned('peer_complete',{snapshotId});
  return data.rows.length;
}

export async function prepareUbpr({store,owned,request,deadline,now=Date.now,maxReports=4}) {
  let stored=0;
  for(let i=0;i<maxReports&&now()<deadline-35000;i++) {
    const job=await owned('ubpr_claim');if(!job)break;
    try {
      const saved=await store('ubpr_source',{rssd:job.id_rssd,period:job.report_date});
      const reusable=saved&&now()-Date.parse(saved.retrievedAt)<7*86400000;
      const rawXbrl=reusable?saved.rawXbrl:decodeFacsimile(await request('RetrieveUBPRXBRLFacsimile',{
        reportingPeriodEndDate:apiDate(job.report_date),fiIdType:'ID_RSSD',fiId:String(job.id_rssd)}));
      const source={rssd:job.id_rssd,period:job.report_date,rawXbrl,sha256:createHash('sha256').update(rawXbrl).digest('hex'),retrievedAt:reusable?saved.retrievedAt:new Date(now()).toISOString()};
      if(!reusable)await owned('ubpr_save',{...source,data:{stage:'source_retained'},complete:false});
      await owned('ubpr_save',{...source,data:parseUbprXbrl(rawXbrl,{rssd:job.id_rssd,period:job.report_date}),complete:true});
      stored++;
    } catch(error) {
      const safe=safeBankError(error);await owned('ubpr_error',{rssd:job.id_rssd,period:job.report_date,code:safe.code,retryAt:safe.retryAt});
      if(['quota_exhausted','upstream_cooldown','hourly_budget','daily_budget','authentication_failure'].includes(safe.code))throw error;
    }
  }
  return stored;
}
