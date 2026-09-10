/** Pure, derived-only analytics for the Factor Lab coverage universe. */
import { MARKET_LENSES } from './marketCohorts.js';
import { priceLogReturns, alignReturnSeries, fitMarketModel, fitIndependentSectorModel, estimateFilingEvent } from './marketRegression.js';

export const UNIVERSE_VERSION = 'edgar.factor-universe.v1';
export const UNIVERSE_METHOD = 'factor-universe-1.1.0';
export const UNIVERSE_FRESH_MS = 25 * 3600_000;
export const UNIVERSE_GROUPS = MARKET_LENSES.map(c => ({ id: c.id, label: c.assetClass }));
export const UNIVERSE_PROXIES = { 'credit-banks':'XLF', 'private-capital':'XLF', 'real-estate':'XLRE', housing:'XHB', 'energy-commodities':'XLE', 'consumer-demand':'XLY', 'ai-infrastructure':'XLK', 'software-security':'XLK', 'transport-cyclicals':'XLI', insurance:'XLF', healthcare:'XLV', 'industrial-capex':'XLI', 'utilities-rates':'XLU' };
export { UNIVERSE_METRICS, finite, distribution } from './marketFundamentals.js';
import { UNIVERSE_METRICS, finite, distribution, computeFundamentalDiagnostics, normalizeChangeThreshold, FUNDAMENTAL_DEFINITIONS } from './marketFundamentals.js';
const average = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
export function uniqueIssuers(companies) {
  const seen=new Set(); return [...companies].sort((a,b)=>a.ticker.localeCompare(b.ticker)).filter(c=>{const id=String(c.cik||c.ticker).replace(/^0+/,'');if(seen.has(id))return false;seen.add(id);return true;});
}
export function financialIssuer(company) { const sic=Number(company.sic); return sic>=6000 && sic<=6799; }
const dates = values => {const sorted=values.filter(Boolean).sort();return { earliest:sorted[0]??null, latest:sorted.at(-1)??null };};
function safeModel(rows, minimum=126, lag=null) {try{return fitMarketModel(rows,{minObservations:minimum,hacLag:lag});}catch{return null;}}
function pearson(x,y) {
  if(x.length<3 || x.length!==y.length)return null;
  const mx=average(x),my=average(y);let xx=0,yy=0,xy=0;
  for(let i=0;i<x.length;i++){const a=x[i]-mx,b=y[i]-my;xx+=a*a;yy+=b*b;xy+=a*b;}
  return xx>1e-14 && yy>1e-14 ? Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy))) : null;
}
function ranks(values) {
  const sorted=values.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v), result=[];
  for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length && sorted[j].v===sorted[i].v)j++;for(let k=i;k<j;k++)result[sorted[k].i]=(i+j-1)/2+1;i=j;}return result;
}
export function spearman(pairs) {return pairs.length>=12 ? pearson(ranks(pairs.map(p=>p[0])),ranks(pairs.map(p=>p[1]))) : null;}

export function summarizeScope(rows) {
  const {breadth,simultaneous_weakening,cash_confirmation}=computeFundamentalDiagnostics(rows);
  const exposureRows=rows.filter(r=>r.exposure);
  const exposures=Object.fromEntries(['beta','downside_beta','sector_beta','r_squared','residual_volatility'].map(key=>[key,distribution(exposureRows.map(r=>r.exposure[key]))]));
  const map=rows.filter(r=>finite(r.metrics.revenueGrowth?.change)&&finite(r.event?.response_z));
  const associations=UNIVERSE_METRICS.slice(0,4).map(def=>{
    const pairs=rows.filter(r=>(def.population==='all'||!r.financial)&&finite(r.metrics[def.key]?.change)&&finite(r.event?.response_z));
    return {metric:def.key,label:def.label,observations:pairs.length,rho:spearman(pairs.map(r=>[r.metrics[def.key].change,r.event.response_z])),filing_dates:dates(pairs.map(r=>r.filed)),eligible_tickers:pairs.map(r=>r.ticker)};
  });
  return {companies:rows.length,breadth,simultaneous_weakening,cash_confirmation,exposure:{eligible:exposureRows.length,coverage:rows.length?exposureRows.length/rows.length:0,distributions:exposures},map:{metric:'revenueGrowth',eligible:map.length,opposite_signs:map.filter(r=>r.metrics.revenueGrowth.change*r.event.response_z<0).length},associations};
}

/** Fixed issuer set and exact 126 benchmark intervals; windows are adjacent, nonoverlapping 63-session periods. */
export function computeCoMovement(rows, returnMaps, benchmark) {
  const window=benchmark.slice(-126);
  const starts=Array.from({length:10},(_,i)=>i*7);
  const valid=rows.filter(r=>{
    const map=returnMaps.get(r.ticker);
    if(!map||window.length!==126||!window.every(o=>map.has(o.key)))return false;
    const values=window.map(o=>map.get(o.key));
    return starts.every(start=>{const slice=values.slice(start,start+63);return finite(pearson(slice,slice));});
  });
  const coverage=rows.length?valid.length/rows.length:0;
  const base={issuers:valid.length,population:rows.length,coverage,eligible_tickers:valid.map(r=>r.ticker),sessions:126,pairs:valid.length*(valid.length-1)/2,prior_start:window[0]?.startDate??null,prior_end:window[62]?.endDate??null,current_start:window[63]?.startDate??null,current_end:window.at(-1)?.endDate??null};
  if(valid.length<8||coverage<.6||window.length<126)return {...base,available:false,reason:'Requires at least 8 issuers and 60% of this scope with complete, varying returns on the same 126 SPY intervals.',prior:null,current:null,change:null,rolling:[]};
  const vectors=valid.map(r=>window.map(o=>returnMaps.get(r.ticker).get(o.key)));
  const fixedPairs=[];
  for(let i=0;i<vectors.length;i++)for(let j=i+1;j<vectors.length;j++){
    const correlations=starts.map(start=>pearson(vectors[i].slice(start,start+63),vectors[j].slice(start,start+63)));
    if(correlations.every(finite))fixedPairs.push(correlations);
  }
  const pairAverage=start=>({mean:average(fixedPairs.map(values=>values[starts.indexOf(start)])),pairs:fixedPairs.length});
  const prior=pairAverage(0),current=pairAverage(63),rolling=[];
  for(let start=0;start<=63;start+=7)rolling.push({through:window[start+62].endDate,...pairAverage(start)});
  return {...base,pairs:fixedPairs.length,possible_pairs:base.pairs,available:finite(current.mean)&&finite(prior.mean),prior,current,change:finite(current.mean)&&finite(prior.mean)?current.mean-prior.mean:null,rolling};
}
function makeExposure(asset,market,sector,benchmarkWindow) {
  const keys=new Set(benchmarkWindow.map(r=>r.key));
  const pairs=alignReturnSeries({asset,market}).filter(r=>keys.has(r.key));
  if(benchmarkWindow.length<252||pairs.length<240||pairs.at(-1)?.endDate!==benchmarkWindow.at(-1)?.endDate)return null;
  const model=safeModel(pairs,240);if(!model)return null;
  const down=pairs.filter(r=>r.market<0),downModel=safeModel(down,30,0);
  const triples=alignReturnSeries({asset,market,sector}).filter(r=>keys.has(r.key));
  const sectorModel=triples.length>=240&&triples.at(-1)?.endDate===benchmarkWindow.at(-1)?.endDate?fitIndependentSectorModel(triples,{minObservations:240}):null;
  return {beta:model.beta,beta_interval:model.betaConfidenceInterval95,downside_beta:downModel?.beta??null,downside_observations:downModel?.observations??0,sector_beta:sectorModel?.independentSectorBeta??null,sector_observations:sectorModel?.observations??0,r_squared:model.rSquared,residual_volatility:model.residualVolatilityAnnualized,observations:model.observations,coverage:pairs.length/252,through:pairs.at(-1).endDate,start:pairs[0].startDate,requested_start:benchmarkWindow[0].startDate};
}
const pct=value=>finite(value)?`${value.toFixed(1)}%`:'unavailable';
export function universeBrief(scope,coMovement) {
  const growth=scope.breadth[0],cash=scope.cash_confirmation,margin=scope.breadth[1],notes=[],band=scope.threshold||0;
  const bandNote=band?` Direction counts require a change beyond ±${band} percentage points.`:'';
  if(growth.eligible>=8 && growth.eligible>=growth.population_count*.6)notes.push(`${growth.higher} of ${growth.eligible} companies (${pct(growth.higher_pct)}) reported faster revenue growth. The net direction balance is ${growth.balance_pct.toFixed(1)} percentage points; the median acceleration is ${growth.change.median.toFixed(2)} percentage points.${bandNote}`);
  else notes.push('Comparable revenue-growth coverage is too limited for a broad conclusion. Available observations and missing counts are shown below.');
  if(cash?.eligible>=8&&cash.coverage>=.6)notes.push(`On the same ${cash.eligible} operating businesses, revenue growth accelerated at ${cash.growth_higher} and free cash flow margin rose at ${cash.cash_higher}. ${cash.growth_higher?`${cash.both_higher} of the ${cash.growth_higher} faster-growth businesses also had higher cash margins.`:'No business exceeds the selected growth band, so conditional cash confirmation is unavailable.'} This compares cash after capital expenditure, so investment can explain a decline.`);
  if(margin.eligible>=8&&margin.eligible>=margin.population_count*.6)notes.push(`Operating-margin outcomes are ${Math.abs(margin.paired_iqr_change)<.005?'approximately as dispersed as':margin.paired_iqr_change>0?'more dispersed than':'less dispersed than'} their comparable prior periods: the middle-50% range is ${margin.current.iqr.toFixed(2)} versus ${margin.prior.iqr.toFixed(2)} percentage points across the same ${margin.eligible} companies. This measures differences in outcomes, separately from their direction.`);
  if(coMovement?.available)notes.push(`Average company-pair correlation is ${coMovement.current.mean.toFixed(2)}, versus ${coMovement.prior.mean.toFixed(2)} in the preceding 63-session window, using the same ${coMovement.issuers} companies. ${Math.abs(coMovement.change)<.0001?'Co-movement was approximately unchanged.':coMovement.change>0?'Returns moved more closely together.':'Returns moved less closely together.'}`);
  return notes;
}

/** Upgrade additive diagnostics from immutable cached issuer rows; preserve every source clock and price model. */
export function upgradeUniverseSnapshot(snapshot) {
  if(snapshot.methodology_version===UNIVERSE_METHOD&&snapshot.scopes?.all?.cash_confirmation&&snapshot.scopes.all.breadth?.[0]?.variance)return snapshot;
  const scopes=Object.fromEntries(Object.entries(snapshot.scopes).map(([id,scope])=>{
    const rows=id==='all'?snapshot.rows:snapshot.rows.filter(r=>r.group===id);
    const enriched={...scope,...computeFundamentalDiagnostics(rows)};
    return [id,{...enriched,brief:universeBrief(enriched,scope.co_movement)}];
  }));
  return {...snapshot,methodology_version:UNIVERSE_METHOD,diagnostics_version:'absolute-diagnostics-1.1.0',fundamental_definitions:FUNDAMENTAL_DEFINITIONS,scopes};
}

export function buildUniverseSnapshot(atlas, series={}, {basis='ttm',now=new Date()}={}) {
  const companies=uniqueIssuers(atlas.companies||[]), usable={};
  for(const [ticker,s] of Object.entries(series)){
    const age=now.getTime()-Date.parse(s?.retrievedAt);
    if(s?.provider==='yahoo_finance'&&s?.priceBasis==='adjusted_close'&&age>=0&&age<=UNIVERSE_FRESH_MS&&Array.isArray(s.prices))usable[ticker]={...s,prices:s.prices.filter(p=>p.date<now.toISOString().slice(0,10))};
  }
  const returnMaps=new Map(),returns={};
  for(const [ticker,s] of Object.entries(usable)){try{returns[ticker]=priceLogReturns(s.prices).returns;returnMaps.set(ticker,new Map(returns[ticker].map(r=>[r.key,r.value])));}catch{/* excluded conflicting histories */}}
  const benchmark=returns.SPY?.length && now.getTime()-Date.parse(returns.SPY.at(-1).endDate)<7*86400000 ? returns.SPY : [],window=benchmark.slice(-252),rows=[];
  for(const company of companies){
    const comparison=company.filingComparisons?.[basis];
    const valid=comparison?.pointInTime===true&&comparison.gapDays>=350&&comparison.gapDays<=380;
    const group=company.cohorts?.[0]||'unclassified',proxy=UNIVERSE_PROXIES[group]||'XLI';
    const metrics=Object.fromEntries(UNIVERSE_METRICS.map(({key,population})=>{
      const supported=population==='all'||!financialIssuer(company);
      const current=valid&&supported?comparison.current?.metrics?.[key]:null,prior=valid&&supported?comparison.prior?.metrics?.[key]:null;
      return [key,{current:finite(current)?current:null,prior:finite(prior)?prior:null,change:finite(current)&&finite(prior)?current-prior:null,unavailable_reason:!supported?'ISSUER_TYPE_EXCLUDED':!valid?'NO_COMPARABLE_PERIOD':!finite(current)||!finite(prior)?'MISSING_FILING_INPUT':null}];
    }));
    let exposure=null,event=null;
    if(returns[company.ticker]&&benchmark.length){try{exposure=makeExposure(returns[company.ticker],benchmark,returns[proxy]||[],window);}catch{/* diagnostics unavailable */}}
    if(usable[company.ticker]&&usable.SPY&&usable[proxy]&&comparison?.current?.filed){
      try{const result=estimateFilingEvent({assetPrices:usable[company.ticker].prices,marketPrices:usable.SPY.prices,sectorPrices:usable[proxy].prices,filedDate:comparison.current.filed,acceptedAt:comparison.cutoff?.acceptedAt});const e=result?.windows?.['20'];if(e)event={return:e.cumulativeAbnormalReturn,response_z:e.standardizedResponse,through:e.through,first_session:result.eventIntervalEnd,timing:result.timingQuality};}catch{/* incomplete event */}
    }
    rows.push({ticker:company.ticker,cik:company.cik,name:company.name,group,cohorts:company.cohorts,financial:financialIssuer(company),metrics,exposure,sector_proxy:proxy,price_source:usable[company.ticker]?{provider:usable[company.ticker].provider,price_basis:usable[company.ticker].priceBasis,retrieved_at:usable[company.ticker].retrievedAt,through:usable[company.ticker].prices.at(-1)?.date??null}:null,source_accessions:[...new Set([...(comparison?.current?.factorSourceAccessions||[]),...(comparison?.prior?.factorSourceAccessions||[])])],event,filed:comparison?.current?.filed??null,fiscal_end:comparison?.current?.end??null,prior_fiscal_end:comparison?.prior?.end??null,accession:comparison?.current?.accession??null,source:comparison?.current?.accession?`https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/${comparison.current.accession.replaceAll('-','')}/`:null});
  }
  const scopes={};
  for(const group of [{id:'all',label:'All covered issuers'},...UNIVERSE_GROUPS]){
    const selected=group.id==='all'?rows:rows.filter(r=>r.group===group.id);const summary=summarizeScope(selected),co_movement=computeCoMovement(selected,returnMaps,benchmark);
    scopes[group.id]={...group,...summary,co_movement,brief:universeBrief(summary,co_movement)};
  }
  const age=now.getTime()-Date.parse(atlas.generatedAt),secStale=atlas.cache?.status==='stale'||!finite(age)||age<0||age>UNIVERSE_FRESH_MS;
  return {schema_version:UNIVERSE_VERSION,methodology_version:UNIVERSE_METHOD,diagnostics_version:'absolute-diagnostics-1.1.0',fundamental_definitions:FUNDAMENTAL_DEFINITIONS,generated_at:now.toISOString(),sec_snapshot_at:atlas.generatedAt,sec_stale:secStale,price_through:benchmark.at(-1)?.endDate??null,basis,status:secStale?'stale':scopes.all.exposure.coverage>=.8?'ready':'partial',universe:{requested:atlas.requested,issuers:rows.length,share_classes_excluded:(atlas.companies?.length||0)-rows.length,grouping:'One primary research group per issuer: first membership in the published research-cohort order. These are curated groups, not official industry sectors.'},price_sample:{benchmark:'SPY',sessions:252,minimum_matched:240,adjustment:'Fully adjusted Yahoo histories only',minimum_coverage_for_brief:.8},scopes,rows,history:[],limitations:['Coverage is the current EDGAR Terminal research universe, not the whole US market; there are no market-cap weights.','Comparisons use the same issuer’s current and comparable prior-year values as known at the current filing cutoff, including eligible revised comparatives. Fiscal ends differ.','Primary research groups are mutually exclusive for aggregates. Company drilldown peer scores use the original overlapping cohorts and are separate from absolute market breadth.','Changes in ratios use percentage points. Missing values are excluded, never counted as unchanged. Financial issuers (SIC 6000–6799) are excluded from operating-margin, free-cash-flow-margin and cash/assets breadth.','Filing response windows differ by issuer and can include other news. Characteristic associations are descriptive cross-sections, not causal tests, forecasts or factor-return backtests.','Pairwise correlation describes return co-movement on a fixed complete sample. It does not quantify a particular portfolio’s diversification benefit.'],links:{methodology:'https://secedgarterminal.com/market/factors',schema:'https://secedgarterminal.com/schemas/factor-universe-v1.schema.json',api:`https://secedgarterminal.com/api/v1/factor-universe?basis=${basis}`}};
}

export function universeMarkdown(snapshot,group='all',selectedThreshold=0) {
  const base=snapshot.scopes[group]||snapshot.scopes.all,threshold=normalizeChangeThreshold(selectedThreshold);
  const rows=base.id==='all'?snapshot.rows:snapshot.rows.filter(r=>r.group===base.id);
  const scope={...base,...computeFundamentalDiagnostics(rows,threshold)};
  const brief=universeBrief(scope,scope.co_movement),cash=scope.cash_confirmation;
  return [`# Quant Lab — ${scope.label}`,`SEC snapshot: ${snapshot.sec_snapshot_at} | Price through: ${snapshot.price_through||'unavailable'} | Basis: ${snapshot.basis} | Status: ${snapshot.status}`,`Methodology: ${UNIVERSE_METHOD}`,`Direction threshold: ${threshold===0?'all measured changes':`outside ±${threshold} percentage points`}. Magnitude and dispersion retain all paired observations.`,`Coverage: ${scope.companies} issuers; ${scope.exposure.eligible} eligible price models.`,'',...brief.map(s=>`- ${s}`),'','## Separate fundamental diagnostics','| Metric | Higher / eligible | Lower | Neutral | Net balance | Median change | Change in IQR |','|---|---:|---:|---:|---:|---:|---:|',...scope.breadth.map(m=>`| ${m.label} | ${m.higher} / ${m.eligible} | ${m.lower} | ${m.unchanged} | ${finite(m.balance_pct)?m.balance_pct.toFixed(3):'unavailable'} | ${finite(m.change.median)?m.change.median.toFixed(3):'unavailable'} | ${finite(m.paired_iqr_change)?m.paired_iqr_change.toFixed(3):'unavailable'} |`),'','Net balance, median changes and changes in spread use percentage points. Revenue-growth dispersion uses growth-rate levels; their changes measure acceleration.','',`## Matched growth and cash margins`,`${cash.eligible} of ${cash.population} operating issuers have both comparisons; ${cash.missing} missing.`,...cash.cells.map(c=>`- Growth ${c.growth} / cash margin ${c.cash}: ${c.count} issuers.`),'','## Interpretation limits',...snapshot.limitations.map(s=>`- ${s}`),'',`Sources and full definitions: ${snapshot.links.methodology}`,`Reproducible derived data (default threshold): ${snapshot.links.api}`].join('\n');
}
