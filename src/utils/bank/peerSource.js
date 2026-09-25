import { createHash } from 'node:crypto';
import { BankDataError } from './errors.js';
import { limitedText } from './client.js';

export const FDIC_FINANCIALS = 'https://api.fdic.gov/banks/financials';
export const PEER_FIELDS = ['CERT','NAME','RSSDID','REPDTE','ASSET','LNLSGR','LNRE','LNCI','LNCON','DEP','DEPDOM','DEPNI','BRO','ROA','ROE','NIMY','RBC1AAJ','NCLNLSR','NTLNLSR'];
export const PEER_MODEL_VERSION = 'bankscope-peers-1';
export function fdicSourceUrl(period, rssd) {
  const params = new URLSearchParams({ filters: `REPDTE:${period.replaceAll('-','')}${rssd ? ` AND RSSDID:${rssd}` : ''}`, fields: PEER_FIELDS.join(','), sort_by:'CERT', sort_order:'ASC', limit:'10000', format:'json' });
  return `${FDIC_FINANCIALS}?${params}`;
}
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const share = (n,d) => number(n) !== null && n >= 0 && number(d) !== null && d > 0 && n <= d * 1.005 ? Math.min(1,n/d) : null;

/** Amounts remain in source USD thousands; percentages remain percentage values. Missing is never zero. */
export function normalizePeerRecord(raw, period) {
  if (!raw || String(raw.REPDTE) !== period.replaceAll('-','') || !Number.isSafeInteger(raw.RSSDID) || raw.RSSDID <= 0 || !Number.isSafeInteger(raw.CERT) || raw.CERT <= 0 || !(number(raw.ASSET) > 0)) return null;
  const lending = [raw.LNRE,raw.LNCI,raw.LNCON].map(n=>share(n,raw.LNLSGR));
  const total = lending.reduce((s,n)=>s+(n??0),0);
  const loanMix = lending.every(n=>n!==null) && total <= 1.005 ? [...lending,Math.max(0,1-total)] : null;
  const funding = [share(raw.DEP,raw.ASSET),share(raw.DEPNI,raw.DEPDOM),share(raw.BRO,raw.DEPDOM)];
  return { rssd:raw.RSSDID,cert:raw.CERT,assets:raw.ASSET,loanMix,loanShare:share(raw.LNLSGR,raw.ASSET),funding,
    metrics:{roa:number(raw.ROA),roe:number(raw.ROE),nim:number(raw.NIMY),leverage:number(raw.RBC1AAJ),noncurrent:number(raw.NCLNLSR),chargeoffs:number(raw.NTLNLSR)} };
}
export async function fetchPeerUniverse(period,{fetchImpl=fetch}={}) {
  if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period)) throw new BankDataError('invalid_period');
  const url=fdicSourceUrl(period);
  let response;
  try { response=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(35000)}); } catch { throw new BankDataError('peer_source_unavailable'); }
  if(!response.ok)throw new BankDataError('peer_source_unavailable');
  const text=await limitedText(response,8*1024*1024);
  let data;try{data=JSON.parse(text);}catch{throw new BankDataError('peer_source_invalid');}
  const total=data.meta?.total;
  // A partial or empty source must never replace the last complete universe.
  if(!Number.isInteger(total)||total<1000||total>10000||data.data?.length!==total||!data.meta?.index?.name)throw new BankDataError('peer_source_incomplete');
  const seen=new Set(),rows=[];
  for(const item of data.data){const raw=item.data,profile=normalizePeerRecord(raw,period);
    if(String(raw?.REPDTE)!==period.replaceAll('-',''))throw new BankDataError('peer_source_period_mismatch');
    if(!profile)continue;
    if(seen.has(profile.rssd))throw new BankDataError('peer_source_duplicate');
    seen.add(profile.rssd);rows.push({profile,raw});
  }
  if(rows.length<1000)throw new BankDataError('peer_source_incomplete');
  return {period,url,total,rows,sha256:createHash('sha256').update(text).digest('hex'),sourceIndex:data.meta.index.name,sourceUpdatedAt:data.meta.index.createTimestamp||null,modelVersion:PEER_MODEL_VERSION};
}
