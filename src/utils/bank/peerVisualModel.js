import { PEER_BENCHMARKS } from './peerMetrics.js';
import { quantile } from './peerModel.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function peerVisualValue(bank,metric){
  if(!metric||metric.riskBased&&bank?.cblr!==false)return null;
  const value=bank?.metrics?.[metric.key];
  return finite(value)?value:null;
}
export function peerChartDomain(values){
  const reported=values.filter(finite);
  if(!reported.length)return [0,1];
  const low=Math.min(...reported),high=Math.max(...reported);
  const padding=Math.max((high-low)*.14,Math.max(Math.abs(low),Math.abs(high))*.025,.001);
  return [low-padding,high+padding];
}
/** Both map medians use only peers reporting BOTH axes; the selected bank is excluded. */
export function buildPeerLandscape(bank,peers,xKey,yKey){
  const xMetric=PEER_BENCHMARKS.find(m=>m.key===xKey),yMetric=PEER_BENCHMARKS.find(m=>m.key===yKey);
  const point=p=>({rssd:String(p.rssd),name:p.name,x:peerVisualValue(p,xMetric),y:peerVisualValue(p,yMetric)});
  const seen=new Set([String(bank?.rssd)]);
  const eligible=peers.filter(p=>{const id=String(p.rssd);if(seen.has(id))return false;seen.add(id);return true;});
  const points=eligible.map(point).filter(p=>finite(p.x)&&finite(p.y));
  const subject=bank?point(bank):null;
  const selected=subject&&finite(subject.x)&&finite(subject.y)?subject:null;
  const median=key=>points.length>=5?quantile(points.map(p=>p[key]).sort((a,b)=>a-b),.5):null;
  return {points,selected,xMedian:median('x'),yMedian:median('y'),peerCount:eligible.length,
    xDomain:peerChartDomain([...points.map(p=>p.x),selected?.x]),yDomain:peerChartDomain([...points.map(p=>p.y),selected?.y])};
}
