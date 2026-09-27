import { after } from 'next/server';
import { createBankApi } from '../../../utils/bank/api.js';
import { runBankWorker } from '../../../utils/bank/worker.js';
import { bankScopeStore } from '../../../utils/bank/scopeStore.js';
import { getBankDirectory } from '../../../utils/bank/directoryStore.js';
export const runtime='nodejs';
export const maxDuration=240;
const handlers=createBankApi({
  store:(operation,payload)=>operation==='search'&&!payload.query?.trim()?getBankDirectory():bankScopeStore(operation,payload),
  schedule:()=>after(async()=>{await runBankWorker().catch(()=>{});})
});
export const GET=handlers.GET;
export const POST=handlers.POST;
