import { after } from 'next/server';
import { createBankApi } from '../../../utils/bank/api.js';
import { runBankWorker } from '../../../utils/bank/worker.js';
import { bankScopeStore } from '../../../utils/bank/scopeStore.js';
import { getBankDirectory } from '../../../utils/bank/directoryStore.js';
import { getBankPublicRead, invalidateBankPublicRead } from '../../../utils/bank/publicReadStore.js';
export const runtime='nodejs';
export const maxDuration=240;
const handlers=createBankApi({
  store:async(operation,payload)=>{
    if(operation==='read')return getBankPublicRead(payload);
    if(operation==='search'&&!payload.query?.trim())return getBankDirectory();
    if(operation!=='request')return bankScopeStore(operation,payload);
    await invalidateBankPublicRead(payload.rssd).catch(()=>{});
    try{return await bankScopeStore(operation,payload);}
    finally{await invalidateBankPublicRead(payload.rssd).catch(()=>{});}
  },
  schedule:()=>after(async()=>{await runBankWorker().catch(()=>{});})
});
export const GET=handlers.GET;
export const POST=handlers.POST;
