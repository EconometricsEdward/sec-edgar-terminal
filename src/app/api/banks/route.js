import { after } from 'next/server';
import { createBankApi } from '../../../utils/bank/api.js';
import { runBankWorker } from '../../../utils/bank/worker.js';
export const runtime='nodejs';
export const maxDuration=240;
const handlers=createBankApi({schedule:()=>after(async()=>{await runBankWorker().catch(()=>{});})});
export const GET=handlers.GET;
export const POST=handlers.POST;
