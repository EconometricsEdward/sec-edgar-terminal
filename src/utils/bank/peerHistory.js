import { PEER_BENCHMARKS } from './peerMetrics.js';
import { quantile } from './peerModel.js';
import { quarterLabel } from './viewModel.js';

const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function previousPeerPeriod(period){
  const year=Number(period.slice(0,4)),quarter=Math.ceil(Number(period.slice(5,7))/3);
  return quarter===1?`${year-1}-12-31`:`${year}-${['03-31','06-30','09-30'][quarter-2]}`;
}
/** Ratios are already in percent: differences are basis points, never percent growth. */
export function peerChange(points,baseline,key='value'){
  const current=points.at(-1)?.[key],prior=points.find(p=>p.period===baseline)?.[key];
  return finite(current)&&finite(prior)?Number(((current-prior)*100).toPrecision(12)):null;
}
export function formatBasisPoints(value){
  if(!finite(value))return 'Unavailable';
  const magnitude=Math.abs(value),number=magnitude>0&&magnitude<.005?magnitude.toPrecision(2):magnitude.toLocaleString('en-US',{maximumFractionDigits:2});
  return `${value>0?'+':value<0?'−':''}${number} bp`;
}

/** Follow the selected-date cohort backward. Never rematch using historical outcomes. */
export function buildPeerHistory(source,analysis,period){
  const rssd=String(analysis.bank?.rssd||''),cohort=[...new Set(analysis.peers.map(p=>String(p.rssd)))].filter(id=>id!==rssd).slice(0,30);
  const reported=(source.periods||[]).filter(d=>/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(d)&&d<=period).sort();
  const periods=[];
  if(reported.length)for(let date=period;date>=reported[0]&&periods.length<4;date=previousPeerPeriod(date))periods.unshift(date);
  const snapshots=(source.snapshots||[]).filter(s=>periods.includes(s.report_date));
  const available=new Set(snapshots.map(s=>s.report_date));
  const rows=new Map((source.profiles||[]).filter(p=>available.has(p.period)).map(p=>[`${p.period}:${p.rssd}`,p]));
  const value=(p,m)=>!p||m.riskBased&&p.cblr!==false?null:finite(p.metrics?.[m.key])?p.metrics[m.key]:null;
  return {period,rssd,snapshotId:analysis.snapshot?.id||null,cohort,periods,snapshots,
    metrics:PEER_BENCHMARKS.map(m=>({...m,points:periods.map(date=>{
      const bank=rows.get(`${date}:${rssd}`),peers=cohort.map(id=>value(rows.get(`${date}:${id}`),m)).filter(finite).sort((a,b)=>a-b);
      return {period:date,label:quarterLabel(date),value:value(bank,m),peerMedian:peers.length>=5?quantile(peers,.5):null,peerCount:peers.length,
        notRequired:!!m.riskBased&&bank?.cblr===true,framework:bank?.cblr===true?'CBLR':bank?.cblr===false?'Risk-based':'Unverified',sourceAvailable:available.has(date)};
    })}))};
}
