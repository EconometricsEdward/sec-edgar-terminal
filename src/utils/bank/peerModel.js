import { PEER_BENCHMARKS } from './peerMetrics.js';
export { PEER_BENCHMARKS } from './peerMetrics.js';
export const PEER_MATCH_WEIGHTS = {size:.4,lending:.35,funding:.25};
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const full=values=>Array.isArray(values)&&values.every(finite);
export function hasPeerInputs(p){return !!p&&p.assets>0&&full(p.loanMix)&&p.loanMix.length===4&&finite(p.loanShare)&&full(p.funding)&&p.funding.length===3;}
export function peerDistance(a,b){
  if(!hasPeerInputs(a)||!hasPeerInputs(b))return null;
  const size=Math.min(1,Math.abs(Math.log2(b.assets/a.assets))/3);
  const mix=a.loanMix.reduce((n,v,i)=>n+Math.abs(v-b.loanMix[i]),0)/2;
  const lending=.75*mix+.25*Math.abs(a.loanShare-b.loanShare);
  const funding=a.funding.reduce((n,v,i)=>n+Math.abs(v-b.funding[i]),0)/3;
  return {score:.4*size+.35*lending+.25*funding,size,lending,funding,assetMultiple:b.assets/a.assets};
}
export function quantile(sorted,p){
  if(!sorted.length)return null;
  const x=(sorted.length-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(x-i);
}
/** Midrank treats equal values equally; the subject is excluded from its comparison cohort. */
export function peerDistribution(peers,key,value){
  const values=peers.map(p=>p.metrics?.[key]).filter(finite).sort((a,b)=>a-b);
  if(values.length<5)return {count:values.length,available:false,value:finite(value)?value:null};
  const percentile=finite(value)?100*(values.filter(n=>n<value).length+.5*values.filter(n=>n===value).length)/values.length:null;
  const q1=quantile(values,.25),median=quantile(values,.5),q3=quantile(values,.75);
  const min=Math.min(values[0],finite(value)?value:values[0]),max=Math.max(values.at(-1),finite(value)?value:values.at(-1));
  const pad=Math.max((max-min)*.08,.01),low=min-pad,high=max+pad,width=(high-low)/12;
  const bins=Array.from({length:12},(_,i)=>({low:low+i*width,high:low+(i+1)*width,count:0}));
  for(const n of values)bins[Math.min(11,Math.max(0,Math.floor((n-low)/width)))].count++;
  return {available:true,count:values.length,value:finite(value)?value:null,min:values[0],max:values.at(-1),q1,median,q3,percentile,bins,domain:[low,high]};
}
export function buildPeerAnalysis(universe,rssd){
  const profiles=universe.profiles||[],bank=profiles.find(p=>String(p.rssd)===String(rssd));
  const metadata={snapshot:universe.snapshot||null,universeCount:profiles.length,eligibleCount:profiles.filter(hasPeerInputs).length};
  if(!bank)return {...metadata,bank:null,status:profiles.length?'bank_not_covered':'preparing',peers:[],benchmarks:[]};
  if(!hasPeerInputs(bank))return {...metadata,bank,status:'insufficient_inputs',peers:[],benchmarks:PEER_BENCHMARKS.map(def=>({...def,...peerDistribution([],def.key,bank.metrics?.[def.key])}))};
  const candidates=profiles.filter(p=>p.rssd!==bank.rssd&&hasPeerInputs(p)).map(p=>({...p,match:peerDistance(bank,p)}));
  let assetBand=4;
  const inBand=n=>candidates.filter(p=>p.match.assetMultiple>=1/n&&p.match.assetMultiple<=n);
  if(inBand(4).length<10)assetBand=8;
  const peers=inBand(assetBand).sort((a,b)=>a.match.score-b.match.score||a.rssd-b.rssd).slice(0,30);
  return {...metadata,bank,status:peers.length>=5?'ready':'small_cohort',assetBand,peers,
    benchmarks:PEER_BENCHMARKS.map(def=>({...def,...peerDistribution(peers,def.key,bank.metrics?.[def.key]),notRequired:!!def.riskBased&&bank.cblr===true}))};
}
