// Prepare the first market-wide snapshot during a production build, never as
// a side effect of visitor traffic. Daily cron owns subsequent refreshes.
import { warmCacheEnabled, warmGet } from '../src/utils/warmCache.js';
import { refreshUniverseSnapshot, isUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { UNIVERSE_VERSION } from '../src/utils/marketUniverse.js';
import { readQuantAtlas, refreshQuantBatch, readQuantMembership, membershipId } from '../src/utils/quantCoverageServer.js';
import { QUANT_BATCHES } from '../src/utils/quantGroups.js';
if(process.env.VERCEL_ENV==='production'&&warmCacheEnabled()){
  // One-time migration uses the same bounded/checkpointed jobs as the daily
  // schedule. A failed deployment can resume without refetching completed work.
  const coverage=await readQuantMembership(), expanded=await readQuantAtlas();
  if(expanded?.coverage?.membership_id!==membershipId(coverage)){
    const migrationDeadline=Date.now()+25*60_000;
    for(let batch=0;batch<QUANT_BATCHES&&Date.now()<migrationDeadline-30000;batch++){
      const controller=new AbortController(),budget=Math.min(260000,migrationDeadline-Date.now()-10000),timer=setTimeout(()=>controller.abort(),budget);
      try{console.log('[Quant Lab] Coverage checkpoint:',JSON.stringify(await refreshQuantBatch(batch,{signal:controller.signal,deadline:Date.now()+budget})));}
      catch(error){console.warn('[Quant Lab] Coverage batch deferred:',batch,error.message);}
      finally{clearTimeout(timer);}
    }
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),260000);
    try{console.log('[Quant Lab] Expanded publication:',JSON.stringify(await refreshUniverseSnapshot({signal:controller.signal,deadline:Date.now()+285000})));}
    catch(error){console.warn('[Quant Lab] Expansion retained for scheduled completion:',error.message);}
    finally{clearTimeout(timer);}
  }
  const snapshots=await Promise.all(['ttm','annual'].map(b=>warmGet(UNIVERSE_VERSION,b)));
  if(snapshots.some(s=>!isUniverseSnapshot(s))){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),260000);
    try{console.log('[Factor Lab] Initial snapshot:',JSON.stringify(await refreshUniverseSnapshot({signal:controller.signal,deadline:Date.now()+285000})));}
    catch(error){console.warn('[Factor Lab] Initial price snapshot deferred to the daily job:',error.message);}
    finally{clearTimeout(timer);}
  }else console.log('[Factor Lab] Prepared snapshots already exist; daily schedule owns updates.');
}
