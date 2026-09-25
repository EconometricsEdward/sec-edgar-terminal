import { randomUUID,createHash } from 'node:crypto';
import { fetchPeerUniverse } from './peerSource.js';
import { decodeFacsimile } from './parser.js';
import { apiDate } from './identity.js';
import { safeBankError } from './errors.js';

export async function refreshPeerUniverse({store,owned,periods,now=Date.now,fetchUniverse=fetchPeerUniverse}) {
  const state=await store('peer_status');
  const period=periods.find(p=>!state.snapshots?.some(s=>s.report_date===p&&now()-Date.parse(s.completed_at)<86400000));
  if(!period)return 0;
  const data=await fetchUniverse(period),snapshotId=randomUUID();
  await owned('peer_start',{...data,rows:undefined,snapshotId,count:data.rows.length});
  for(let i=0;i<data.rows.length;i+=500)await owned('peer_batch',{snapshotId,rows:data.rows.slice(i,i+500)});
  await owned('peer_complete',{snapshotId});
  return data.rows.length;
}

export async function prepareUbpr({owned,request,deadline,now=Date.now,maxReports=4}) {
  let stored=0;
  for(let i=0;i<maxReports&&now()<deadline-35000;i++) {
    const job=await owned('ubpr_claim');if(!job)break;
    try {
      const rawXbrl=decodeFacsimile(await request('RetrieveUBPRXBRLFacsimile',{
        reportingPeriodEndDate:apiDate(job.report_date),fiIdType:'ID_RSSD',fiId:String(job.id_rssd)}));
      await owned('ubpr_save',{rssd:job.id_rssd,period:job.report_date,rawXbrl,sha256:createHash('sha256').update(rawXbrl).digest('hex'),
        retrievedAt:new Date(now()).toISOString(),data:{stage:'source_retained'},complete:true});
      stored++;
    } catch(error) {
      const safe=safeBankError(error);await owned('ubpr_error',{rssd:job.id_rssd,period:job.report_date,code:safe.code,retryAt:safe.retryAt});
      if(['quota_exhausted','upstream_cooldown','hourly_budget','daily_budget','authentication_failure'].includes(safe.code))throw error;
    }
  }
  return stored;
}
