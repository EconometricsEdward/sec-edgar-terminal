'use client';
import { useId } from 'react';
import dynamic from 'next/dynamic';
import { CAMELS_DIMENSIONS,PEER_BENCHMARKS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { formatBasisPoints,peerChange,previousPeerPeriod } from '../../../utils/bank/peerHistory.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';

const TrendChart=dynamic(()=>import('./BankTrendChart'),{ssr:false,loading:()=> <div className={styles.chartPlaceholder}>Loading chart…</div>});
const finite=n=>typeof n==='number'&&Number.isFinite(n);

export function MetricHistoryMini({metric,onOpen,baseline='prior'}){
  if(!metric?.points?.length)return null;
  const points=metric.points,first=points[0],last=points.at(-1);
  const from=baseline==='first'?first.period:previousPeerPeriod(last.period);
  const change=from===last.period?null:peerChange(points,from);
  const values=points.map(p=>p.value).filter(finite),min=Math.min(...values),max=Math.max(...values);
  const padding=Math.max((max-min)*.2,Math.abs(max)*.015,.001);
  const x=i=>points.length===1?64:8+i/(points.length-1)*112,y=n=>31-(n-min+padding)/(max-min+2*padding)*26;
  return <button type="button" className={styles.metricMini} onClick={onOpen} aria-label={`Explore ${metric.label} history. ${change==null?'Change unavailable':`${formatBasisPoints(change)} ${baseline==='first'?'since':'versus'} ${quarterLabel(from)}`}.`}>
    <svg viewBox="0 0 128 38" aria-hidden="true">
      <line x1="8" x2="120" y1="33" y2="33" stroke="#34485f" strokeDasharray="2 4"/>
      {points.map((p,i)=>finite(p.value)&&<g key={p.period}>
        {i>0&&finite(points[i-1].value)&&<line x1={x(i-1)} y1={y(points[i-1].value)} x2={x(i)} y2={y(p.value)} stroke="currentColor" strokeWidth="2"/>}
        <circle cx={x(i)} cy={y(p.value)} r={i===points.length-1?3.3:2.5} fill="currentColor"/>
      </g>)}
      {!values.length&&<text x="64" y="22" textAnchor="middle" fill="#9fb3cd" fontSize="10">No reported values</text>}
    </svg>
    <span><strong>{change==null?'—':formatBasisPoints(change)}</strong><small>{from===last.period?'One available period':`${baseline==='first'?'since':'vs'} ${quarterLabel(from)}`}</small></span>
    <span className={styles.miniArrow} aria-hidden="true">↗</span>
  </button>;
}

export default function BankPeerHistory({history,error,onRetry,metricKey,onMetricChange,period,sectionRef}){
  const selectId=useId();
  if(!history)return <section ref={sectionRef} className={styles.peerHistory} aria-label="Metric history" aria-busy={!error}><h3>Metrics over time</h3><p role="status" className={styles.basis}>{error||'Loading the available reporting periods…'}</p>{error&&<button onClick={onRetry}>Retry history</button>}</section>;
  const metric=history.metrics.find(m=>m.key===metricKey)||history.metrics[0];
  const points=metric?.points||[],first=points[0],last=points.at(-1),prior=previousPeerPeriod(period);
  const quarterChange=peerChange(points,prior),windowChange=first?.period!==period?peerChange(points,first?.period):null;
  const ytd=/year.to.date/i.test(metric?.basis||'');
  return <section ref={sectionRef} className={styles.peerHistory} style={{'--accent':metric?.color}} aria-label="Metric history">
    <div className={styles.historyHeading}><div><span className={styles.chartEyebrow}>FOLLOW THE CHANGE</span><h3>Metrics over time</h3><p>{first?`${first.label} → ${quarterLabel(period)} · ${points.length} reporting ${points.length===1?'period':'periods'}`:'No historical snapshots available for this date.'}</p></div><div className={styles.historySelect}><label htmlFor={selectId}>Explore a metric</label><select id={selectId} value={metricKey} onChange={e=>onMetricChange(e.target.value)}>{CAMELS_DIMENSIONS.map(d=><optgroup key={d.key} label={d.label}>{PEER_BENCHMARKS.filter(m=>m.category===d.key).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}</select></div></div>
    {points.length>0&&<>
      <h4 className={styles.historyMetricName}>{metric.label}</h4>
      <div className={styles.historyStats}>
        <div><span>{quarterLabel(period)} · This bank</span><strong>{last.notRequired?'N/A · CBLR':pct(last.value)}</strong><small>Peer median {pct(last.peerMedian)} · n={last.peerCount}</small></div>
        <div><span>Change vs {quarterLabel(prior)}</span><strong>{formatBasisPoints(quarterChange)}</strong><small>Peer median {formatBasisPoints(peerChange(points,prior,'peerMedian'))}</small></div>
        <div><span>Change since {first.label}</span><strong>{formatBasisPoints(windowChange)}</strong><small>{first.period===period?'A second period is needed':`Peer median ${formatBasisPoints(peerChange(points,first.period,'peerMedian'))}`}</small></div>
      </div>
      <div className={styles.historyLegend}><span><i style={{background:metric.color}}/>This bank</span><span><i className={styles.dashedSwatch}/>Fixed-cohort peer median</span><small>Ratios in % · 100 bp = 1 percentage point</small></div>
      <TrendChart points={points} quarterly={false} unit="percent" label={metric.label} height={265} series={[{key:'value',label:'This bank',color:metric.color},{key:'peerMedian',label:'Fixed-cohort peer median',color:'#a2b4cf',dash:'5 4'}]}/>
      <p className={styles.historyBasis}>{metric.basis}{ytd?' Changes compare the published YTD ratios; they do not isolate single-quarter performance. YTD restarts each calendar year.':''}</p>
      <p className={styles.historyMethod}>{history.cohort.length?`The same ${history.cohort.length} peers selected for ${quarterLabel(period)} are followed backward. Medians are unweighted and require five reported peers per date; valid counts can vary.`:'No matched peer group is available. Reported bank history is shown on its own.'} Missing values remain gaps. Changes describe direction, not improvement or deterioration.</p>
      <details className={styles.exactDetails}><summary>Exact history &amp; source records <span>{points.length} periods · Changes in basis points</span></summary>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${metric.label} history figures`}><table className={styles.comparison}><caption>{metric.label} · FDIC ratios · Bank changes compare adjacent reporting quarters</caption><thead><tr><th>Period</th><th>This bank</th><th>Change vs prior quarter</th><th>Peer median</th><th>Reported peers</th>{metric.category==='capital'&&<th>Bank framework</th>}</tr></thead><tbody>{points.map((p,i)=><tr key={p.period}><th scope="row">{p.label}<small>{p.period}</small></th><td>{p.notRequired?'N/A · CBLR':pct(p.value)}</td><td>{formatBasisPoints(peerChange(points.slice(0,i+1),previousPeerPeriod(p.period)))}</td><td>{pct(p.peerMedian)}</td><td>{p.peerCount} / {history.cohort.length}</td>{metric.category==='capital'&&<td>{p.framework}</td>}</tr>)}</tbody></table></div>
        <div className={styles.historySources}><p>Risk-based capital is unavailable for CBLR electors at each historical date. Unavailable bank records are not replaced with predecessor banks. Selected-quarter values use the same source snapshot as peer matching; earlier quarters use their latest completed snapshots. Amendments and changes in reporting or corporate structure can affect comparisons.</p>{history.snapshots.map(s=><p key={s.id}><a href={s.source_url} target="_blank" rel="noreferrer">{quarterLabel(s.report_date)} · FDIC source ↗</a> · Retrieved {new Date(s.created_at).toLocaleString('en-US',{timeZone:'UTC'})} UTC · {s.model_version}</p>)}</div>
      </details>
    </>}
  </section>;
}
