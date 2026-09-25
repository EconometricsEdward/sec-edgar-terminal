import { notFound,redirect } from 'next/navigation';
import { isBankPreview } from '../../utils/bank/errors.js';
import { bankScopeStore } from '../../utils/bank/scopeStore.js';
import { runBankWorker } from '../../utils/bank/worker.js';
import styles from './pilot.module.css';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=240;
export const metadata={title:'BankScope preparation',robots:{index:false,follow:false}};
async function prepare(){'use server';if(!isBankPreview())notFound();await runBankWorker({maintain:true,maxFilings:8});redirect('/bank-pilot');}
export default async function BankOperations(){
  if(!isBankPreview())notFound();
  let state,error;try{state=await bankScopeStore('status');}catch{error='BankScope storage is unavailable.';}
  return <div className={styles.page}><h1>BankScope preparation</h1><p>Protected preview controls</p>
    <p><a href="/analysis/banks">Open BankScope</a></p>{error?<p role="alert">{error}</p>:<>
      <p>{state.bankCount} banks · {state.reportCount} filings · {state.requestCount} FFIEC requests</p>
      <p>{state.queued} queued filings · {state.running?'Worker active':'Worker idle'}</p>
      <p>Periods: {state.periods.join(', ')}</p><pre>{JSON.stringify({directory:state.directoryPeriods,result:state.lastRunResult,error:state.lastError,cooldown:state.cooldownUntil},null,2)}</pre>
      <form action={prepare}><button disabled={state.running}>Refresh directory and prepare next batch</button></form></>}
  </div>;
}
