'use client';
import { formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { formatBasisPoints } from '../../../utils/bank/peerHistory.js';
import { MetricHistoryMini } from './BankPeerHistory';
import styles from './banks.module.css';

const BANK_COLOR='var(--bank-color)';
const PEER_COLOR='var(--peer-color)';

export function PeerLegend(){
  return <div className={styles.peerVisualLegend} aria-label="Comparison chart legend">
    <span><i className={styles.bankDot}/>Selected bank</span>
    <span><i className={styles.peerDiamond}/>Peer-group median</span>
    <span><i className={styles.peerBand}/>Middle 50% of peers</span>
    <small>Each metric has its own scale · Numeric position, not a rating</small>
  </div>;
}

export default function BankMetricRows({metrics,historyByKey,bankName,peerCount,onHistory,baseline='prior',density=false}){
  return <div className={styles.metricRows}>
    <div className={styles.metricRowHead} aria-hidden="true"><span>Metric</span><span>Selected bank</span><span>Group median</span><span>Bank vs peers</span><span>History · bank &amp; group</span></div>
    {metrics.filter(Boolean).map(m=><article className={styles.metricRow} key={m.key} aria-label={m.label}>
      <div className={styles.metricLabel}><button onClick={()=>onHistory(m.key)} aria-label={`Explore ${m.label} history`}>{m.label} <span aria-hidden="true">↗</span></button><details className={styles.metricDefinition}><summary>Definition</summary><p>{m.basis}</p><p>FDIC {m.field}</p></details></div>
      <div className={styles.bankMetricValue}><span className={styles.mobileMetricLabel}>Selected bank</span><strong>{m.notRequired?'N/A · CBLR':pct(m.value)}</strong><small>{m.notRequired?'Risk-based ratio not required':m.value!=null&&m.available?`${formatBasisPoints((m.value-m.median)*100)} vs median`:'Individual bank'}</small></div>
      <div className={styles.peerMetricValue}><span className={styles.mobileMetricLabel}>Group median</span><strong>{m.available?pct(m.median):'Unavailable'}</strong><small>{m.count} of {peerCount} peers reporting</small></div>
      <PeerPosition metric={m} bankName={bankName} density={density}/>
      <MetricHistoryMini metric={historyByKey.get(m.key)} bankName={bankName} baseline={baseline} onOpen={()=>onHistory(m.key)}/>
    </article>)}
  </div>;
}

function PeerPosition({metric:m,bankName,density}){
  if(!m.available)return <p className={styles.positionUnavailable}>At least 5 reported peers needed for a distribution.</p>;
  const values=[m.q1,m.q3,m.value].filter(v=>v!=null),low=Math.min(...values),high=Math.max(...values);
  const padding=Math.max((high-low)*.16,Math.abs(high)*.02,.01);
  const domain=density?m.domain:[low-padding,high+padding];
  const scale=n=>10+(n-domain[0])/(domain[1]-domain[0])*160;
  const tallest=density?Math.max(1,...m.bins.map(b=>b.count)):1;
  const median=scale(m.median),bank=m.value==null?null:scale(m.value);
  return <div className={styles.peerPosition}>
    <svg viewBox="0 0 180 56" role="img" aria-label={`${m.label}. ${bankName}: ${m.notRequired?'not required under CBLR':pct(m.value)}. Peer-group median ${pct(m.median)} from ${m.count} banks. Middle 50%: ${pct(m.q1)} to ${pct(m.q3)}.`}>
      {density&&m.bins.map((b,i)=><rect key={i} x={scale(b.low)+.5} y={34-b.count/tallest*26} width={Math.max(1,160/m.bins.length-1)} height={b.count/tallest*26} fill={PEER_COLOR} opacity=".24"><title>{pct(b.low)} to {pct(b.high)}: {b.count} peers</title></rect>)}
      <line x1="10" x2="170" y1="34" y2="34" stroke="#364257"/>
      <rect x={scale(m.q1)} y="30" width={Math.max(2,scale(m.q3)-scale(m.q1))} height="8" rx="4" fill={PEER_COLOR} opacity=".35"/>
      <path d={`M ${median} 28 l 6 6 l -6 6 l -6 -6 Z`} fill={PEER_COLOR} stroke="#0b1019" strokeWidth="1.5"/>
      {bank!=null&&<><line x1={bank} x2={bank} y1="14" y2="31" stroke={BANK_COLOR}/><circle cx={bank} cy="14" r="4.5" fill={BANK_COLOR}/></>}
      <text x="10" y="53" fill="#99aec6" fontSize="9">{pct(domain[0])}</text><text x="170" y="53" textAnchor="end" fill="#99aec6" fontSize="9">{pct(domain[1])}</text>
    </svg>
    <small>{m.percentile==null?'Bank position unavailable':`Bank at P${Math.round(m.percentile)} · ${m.count} reported peers`}</small>
  </div>;
}
