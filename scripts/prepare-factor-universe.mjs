// Prepare the first market-wide snapshot during a production build, never as
// a side effect of visitor traffic. Daily cron owns subsequent refreshes.
import { warmCacheEnabled, warmGet } from '../src/utils/warmCache.js';
import { refreshUniverseSnapshot, isUniverseSnapshot } from '../src/utils/marketUniverseServer.js';
import { UNIVERSE_VERSION } from '../src/utils/marketUniverse.js';
if(process.env.VERCEL_ENV==='production'&&warmCacheEnabled()){
  const snapshots=await Promise.all(['ttm','annual'].map(b=>warmGet(UNIVERSE_VERSION,b)));
  if(snapshots.some(s=>!isUniverseSnapshot(s))){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),260000);
    try{console.log('[Factor Lab] Initial snapshot:',JSON.stringify(await refreshUniverseSnapshot({signal:controller.signal,deadline:Date.now()+285000})));}
    catch(error){console.warn('[Factor Lab] Initial price snapshot deferred to the daily job:',error.message);}
    finally{clearTimeout(timer);}
  }else console.log('[Factor Lab] Prepared snapshots already exist; daily schedule owns updates.');
}
