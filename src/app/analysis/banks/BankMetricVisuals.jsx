'use client';
import { formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { peerChange,previousPeerPeriod,formatBasisPoints } from '../../../utils/bank/peerHistory.js';
import { peerChartDomain } from '../../../utils/bank/peerVisualModel.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function ComparisonLegend(){return <div className={styles.visualScopeLegend}><span><i className={styles.bankDot}/>Selected bank</span><span><i className={styles.peerDiamond}/>Peer-group median</span></div>;}

export function DistributionPlot({metric:m,bankName}){
  if(!m.available)return <div className={styles.chartUnavailable}>{m.count} reporting peers<br/><small>Distribution needs at least 5</small></div>;
  const scale=n=>18+(n-m.domain[0])/(m.domain[1]-m.domain[0])*284;
  const tallest=Math.max(1,...m.bins.map(b=>b.count));
  return <svg className={styles.metricDistribution} viewBox="0 0 320 148" role="img" aria-label={`${m.label}. ${bankName}: ${m.notRequired?'not required under CBLR':pct(m.value)}. Peer median ${pct(m.median)}. Middle 50% ${pct(m.q1)} to ${pct(m.q3)}. ${m.count} reporting peers.`}>
    <line x1="18" x2="302" y1="104" y2="104" stroke="#34455a"/>
    <text x="18" y="13" fill="#8eabc5" fontSize="9">{tallest} banks at tallest bar</text>
    {m.bins.map((bin,i)=><rect key={i} x={scale(bin.low)+2} y={104-bin.count/tallest*70} width={284/m.bins.length-4} height={bin.count/tallest*70} rx="3" fill="var(--peer-color)" opacity=".4"><title>{pct(bin.low)}–{pct(bin.high)}: {bin.count} peers</title></rect>)}
    <rect x={scale(m.q1)} y="115" width={Math.max(2,scale(m.q3)-scale(m.q1))} height="6" rx="3" fill="var(--peer-color)" opacity=".3"/>
    <line x1={scale(m.median)} x2={scale(m.median)} y1="30" y2="118" stroke="var(--peer-color)" strokeDasharray="4 4"/>
    <path d={`M ${scale(m.median)} 112 l 6 6 l -6 6 l -6 -6 Z`} fill="var(--peer-color)"/>
    {finite(m.value)&&<g><line x1={scale(m.value)} x2={scale(m.value)} y1="25" y2="106" stroke="var(--bank-color)" strokeWidth="2"/><circle cx={scale(m.value)} cy="25" r="5" fill="var(--bank-color)" stroke="#0b1019" strokeWidth="2"/></g>}
    <text x="18" y="142" fill="#91aac8" fontSize="10">{pct(m.domain[0])}</text><text x="302" y="142" fill="#91aac8" textAnchor="end" fontSize="10">{pct(m.domain[1])}</text>
  </svg>;
}

export function MetricSpark({metric,onOpen,baseline='prior'}){
  const points=metric?.points||[];
  if(!points.length)return <button className={styles.sparkExplore} onClick={onOpen}>Open metric history ↗</button>;
  const [low,high]=peerChartDomain(points.flatMap(p=>[p.value,p.peerMedian]));
  const x=i=>points.length===1?160:15+i/(points.length-1)*290,y=v=>70-(v-low)/(high-low)*58;
  const from=baseline==='first'?points[0].period:previousPeerPeriod(points.at(-1).period);
  const delta=key=>from===points.at(-1).period?null:peerChange(points,from,key);
  return <button className={styles.sparkExplore} onClick={onOpen} aria-label={`Explore ${metric.label} history`}>
    <svg viewBox="0 0 320 103" aria-hidden="true">
      {[24,48,72].map(v=><line key={v} x1="15" x2="305" y1={v} y2={v} stroke="#273c51" strokeDasharray="2 5"/>)}
      {['peerMedian','value'].map(key=>points.map((p,i)=>finite(p[key])&&<g key={key+p.period} style={{color:key==='value'?'var(--bank-color)':'var(--peer-color)'}}>
        {i>0&&finite(points[i-1][key])&&<line x1={x(i-1)} y1={y(points[i-1][key])} x2={x(i)} y2={y(p[key])} stroke="currentColor" strokeWidth={key==='value'?2.5:2} strokeDasharray={key==='peerMedian'?'5 4':undefined}/>}
        <circle cx={x(i)} cy={y(p[key])} r="3.5" fill="currentColor" stroke="#0b1019" strokeWidth="1.5"/><title>{p.label}: {pct(p[key])}</title>
      </g>))}
      {points.map((p,i)=><text key={p.period} x={x(i)} y="97" textAnchor={i===0&&points.length>1?'start':i===points.length-1&&points.length>1?'end':'middle'} fill="#91aac8" fontSize="10">{p.label}</text>)}
    </svg>
    <span className={styles.sparkChanges}><span>Bank <b>{formatBasisPoints(delta('value'))}</b></span><span>Median <b>{formatBasisPoints(delta('peerMedian'))}</b></span></span>
    <span className={styles.sparkPeriod}>{points.length===1?'One available period':`${baseline==='first'?'Since':'vs'} ${quarterLabel(from)}`} <i>Explore ↗</i></span>
  </button>;
}

export function MetricVisual({metric:m,trend,bank,peerCount,onExplore,baseline='prior'}){
  const notRequired=m.notRequired||bank.cblr===true&&m.riskBased;
  return <article className={styles.metricVisual} aria-label={m.label}>
    <div className={styles.metricVisualTitle}><h4>{m.label}</h4><span title="Selected bank percentile among reported peers; numeric position, not a rating">{m.percentile==null?'—':`P${Math.round(m.percentile)}`}</span></div>
    <div className={styles.visualValuePair}><div><span>Selected bank</span><strong>{notRequired?'N/A · CBLR':pct(m.value)}</strong></div><div><span>Peer median</span><strong>{m.available?pct(m.median):'Unavailable'}</strong></div></div>
    <div className={styles.visualCoverage}><span>{m.count} / {peerCount} peers reporting</span><span>{finite(m.value)&&m.available?formatBasisPoints((m.value-m.median)*100)+' vs median':notRequired?'Ratio not required':'Bank value unavailable'}</span></div>
    <DistributionPlot metric={{...m,notRequired}} bankName={bank.name}/>
    <MetricSpark metric={trend} onOpen={()=>onExplore(m.key)} baseline={baseline}/>
    <details className={styles.visualExplanation}><summary>Definition &amp; chart guide</summary><p>{m.basis}</p><p>FDIC {m.field}. Cyan is {bank.name}; lavender bars count individual peers, the diamond marks their unweighted median, and the band marks the middle 50%. P0–P100 describes numeric position, not quality. Each chart uses its own scale.</p><p>History follows the same selected-quarter peer group. Dashed lavender is its median. Changes use unrounded ratios and are in basis points (100 bp = 1 percentage point). Missing values remain gaps.</p></details>
  </article>;
}
