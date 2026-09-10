import { warmGet, warmSet, warmCacheEnabled, warmAcquireLease, warmReleaseLease } from './warmCache.js';
import { MARKET_VERSION } from './marketResearch.js';
import { isMarketAtlas } from './marketResearchValidation.js';
import { loadPriceSeries, warmYahooSeries } from './priceDataServer.js';
import { buildUniverseSnapshot, uniqueIssuers, UNIVERSE_VERSION, UNIVERSE_METHOD, UNIVERSE_FRESH_MS, UNIVERSE_PROXIES, upgradeUniverseSnapshot } from './marketUniverse.js';

const RETAIN_SECONDS=7*86400;
const pending=new Map();
export function isUniverseSnapshot(value) {
  return value?.schema_version===UNIVERSE_VERSION && [UNIVERSE_METHOD,'factor-universe-1.0.0'].includes(value?.methodology_version) && ['ttm','annual'].includes(value.basis) && Array.isArray(value.rows) && value.rows.length>0 && value.scopes?.all?.companies===value.rows.length && Number.isFinite(Date.parse(value.sec_snapshot_at)) && Number.isFinite(Date.parse(value.generated_at));
}
async function cachedAtlas() {
  const values=await Promise.all([warmGet(MARKET_VERSION,'atlas'),warmGet(MARKET_VERSION,'atlas-last-good')]);
  return values.find(v=>isMarketAtlas(v,MARKET_VERSION)&&Date.now()-Date.parse(v.generatedAt)>=0&&Date.now()-Date.parse(v.generatedAt)<RETAIN_SECONDS*1000)||null;
}
/** Public reads never invoke SEC/provider loaders or a full-universe refresh. */
export async function readUniverseSnapshot(basis='ttm') {
  const primary=await warmGet(UNIVERSE_VERSION,basis);
  const cached=isUniverseSnapshot(primary)?primary:await warmGet(UNIVERSE_VERSION,`${basis}-last-good`);
  if(isUniverseSnapshot(cached)&&cached.basis===basis){
    const age=Date.now()-Date.parse(cached.generated_at),secAge=Date.now()-Date.parse(cached.sec_snapshot_at);
    if(age>=0&&age<RETAIN_SECONDS*1000&&secAge>=0&&secAge<RETAIN_SECONDS*1000){
      const stale=cached.status==='stale'||cached.cache_status==='stale'||age>UNIVERSE_FRESH_MS||secAge>UNIVERSE_FRESH_MS||cached.sec_stale;
      return {...upgradeUniverseSnapshot(cached),status:stale?'stale':cached.status,sec_stale:secAge>UNIVERSE_FRESH_MS||cached.sec_stale,cache_status:stale?'stale':'prepared'};
    }
  }
  if(pending.has(basis))return pending.get(basis);
  const task=(async()=>{
    const atlas=await cachedAtlas();
    if(!atlas)throw Object.assign(new Error('The scheduled SEC universe snapshot is unavailable. Please retry later.'),{status:503,code:'UNIVERSE_SNAPSHOT_UNAVAILABLE'});
    return {...buildUniverseSnapshot(atlas,{}, {basis}),cache_status:'sec_only',price_status:'The scheduled price snapshot is not available yet. SEC breadth remains available.'};
  })();
  pending.set(basis,task);try{return await task;}finally{pending.delete(basis);}
}
function retainedHistory(previous,next) {
  const history=Array.isArray(previous?.history)?previous.history:[];
  const scope=next.scopes.all;
  const point={observed_at:next.generated_at,sec_snapshot_at:next.sec_snapshot_at,issuers:next.rows.map(r=>r.cik),breadth:scope.breadth.slice(0,4).map(m=>({metric:m.key,higher:m.higher,eligible:m.eligible,median_change:m.change.median})),co_movement:scope.co_movement.current?.mean??null};
  return [...history.filter(p=>p.sec_snapshot_at!==point.sec_snapshot_at),point].slice(-30);
}
/** Never replace a materially fuller, still-fresh result with a partial price refresh. */
export function chooseUniversePublication(previous,next,now=Date.now()) {
  const age=now-Date.parse(previous?.generated_at);
  if(isUniverseSnapshot(previous)&&age>=0&&age<RETAIN_SECONDS*1000&&previous.scopes.all.exposure.eligible>0&&next.scopes.all.exposure.eligible<previous.scopes.all.exposure.eligible*.95){
    return {...upgradeUniverseSnapshot(previous),status:'stale',cache_status:'stale',refresh_warning:'The latest price refresh had lower coverage. The prior completed snapshot is retained with its original dates.'};
  }
  return {...next,history:retainedHistory(previous,next)};
}
export async function refreshUniverseSnapshot({signal,deadline=Date.now()+275000}={}) {
  if(!warmCacheEnabled())throw Object.assign(new Error('Shared snapshot storage is unavailable.'),{status:503});
  const lease=await warmAcquireLease(UNIVERSE_VERSION,'refresh',295000);
  if(!lease)return {skipped:'A universe refresh is already running.'};
  try{
    const atlas=await cachedAtlas();if(!atlas)throw new Error('The SEC atlas must be prepared by the scheduled SEC job first.');
    const tickers=[...new Set(['SPY',...Object.values(UNIVERSE_PROXIES),...uniqueIssuers(atlas.companies).map(c=>c.ticker)])];
    const now=new Date(),fromIso=new Date(now.getTime()-10*365*86400000).toISOString().slice(0,10),series={},failures=[];
    // Cached or refreshed once per ticker. This separate daily job has its own
    // budget and shares the existing provider gate with ordinary price traffic.
    const queue=[...tickers];
    await Promise.all(Array.from({length:3},async()=>{
      while(queue.length&&Date.now()<deadline-25000&&!signal?.aborted){
        const ticker=queue.shift();
        try{
          const envelope=await warmGet('stock-raw-yahoo',ticker);
          let result=null;
          if(envelope&&now.getTime()-Date.parse(envelope.retrievedAt)<12*3600000){
            try{result=warmYahooSeries(envelope,new Date(now.getTime()-3*365*86400000).toISOString().slice(0,10));}catch{/* short or legacy cache */}
          }
          if(!result)result=await loadPriceSeries({ticker,fromIso,now,signal,forceRefresh:true,allowUnverifiedFallback:false});
          if(result.priceBasis!=='adjusted_close')throw new Error('Fully adjusted prices unavailable.');
          series[ticker]={provider:result.provider,priceBasis:result.priceBasis,retrievedAt:result.retrievedAt,prices:result.prices.filter(p=>p.date>=new Date(now.getTime()-3*365*86400000).toISOString().slice(0,10)).map(p=>({date:p.date,adjustedClose:p.adjustedClose}))};
        }catch(error){failures.push({ticker,reason:error.message});}
      }
    }));
    const outcomes=[];
    for(const basis of ['ttm','annual']){
      if(Date.now()>deadline-3000)break;
      const previous=(await warmGet(UNIVERSE_VERSION,`${basis}-last-good`))||await warmGet(UNIVERSE_VERSION,basis);
      const next=buildUniverseSnapshot(atlas,series,{basis,now:new Date()});
      next.refresh={requested:tickers.length,loaded:Object.keys(series).length,skipped:queue.length,failed:failures.length};
      const publication=chooseUniversePublication(previous,next);
      const stored=await warmSet(UNIVERSE_VERSION,basis,publication,RETAIN_SECONDS);
      if(!stored)throw new Error(`Could not persist ${basis} universe snapshot.`);
      if(publication.status==='ready')await warmSet(UNIVERSE_VERSION,`${basis}-last-good`,publication,RETAIN_SECONDS);
      outcomes.push({basis,status:publication.status,issuers:publication.rows.length,price_models:publication.scopes.all.exposure.eligible,map:publication.scopes.all.map.eligible});
    }
    return {outcomes,prices:Object.keys(series).length,skipped:queue.length,failures:failures.slice(0,10)};
  }finally{await warmReleaseLease(UNIVERSE_VERSION,'refresh',lease);}
}
