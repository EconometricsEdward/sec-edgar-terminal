import { BankDataError } from './errors.js';
import { limitedText } from './client.js';
export function isBankScopeEnvironment(env=process.env) {
  return env.VERCEL_ENV==='production' || (env.VERCEL_ENV==='preview' && env.VERCEL_GIT_COMMIT_REF==='feat/ffiec-bank-pilot');
}
export function createBankScopeStore({env=process.env,fetchImpl=fetch,identity=async()=>(await import('@vercel/oidc')).getVercelOidcToken()}={}) {
  return async(operation,payload={})=>{
    if(typeof window!=='undefined'||!isBankScopeEnvironment(env))throw new BankDataError('bank_service_unavailable');
    try {
      const r=await fetchImpl('https://vvkihuduqqnxqahhbphs.supabase.co/functions/v1/bankscope-gateway',{
        method:'POST',headers:{Authorization:`Bearer ${await identity()}`,'Content-Type':'application/json','x-region':'us-east-1'},
        body:JSON.stringify({operation,payload}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)});
      if(!r.ok)throw new BankDataError('database_failure');
      return JSON.parse(await limitedText(r));
    }catch(error){if(error instanceof BankDataError)throw error;throw new BankDataError('database_failure');}
  };
}
export const bankScopeStore=createBankScopeStore();
