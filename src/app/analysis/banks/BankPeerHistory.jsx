'use client';
import { useId } from 'react';
import dynamic from 'next/dynamic';
import { CAMELS_DIMENSIONS,PEER_BENCHMARKS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { formatBasisPoints,peerChange,previousPeerPeriod } from '../../../utils/bank/peerHistory.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';

const TrendChart=dynamic(()=>import('./BankTrendChart'),{ssr:false,loading:()=> <div className={styles.chartLoading}>Loading chart…</div>});
export default function BankPeerHistory({history,error,onRetry,metricKey,onMetricChange,period,sectionRef,bankName}){
  const selectId=useId();
  if(!history)return <section ref={sectionRef} tabIndex={-1} className={styles.peerHistory} aria-label="Metric history" aria-busy={!error}><h3>Metrics over time</h3><p role="status" className={styles.basis}>{error||'Loading the available reporting periods…'}</p>{error&&<button onClick={onRetry}>Retry history</button>}</section>;
  const metric=history.metrics.find(m=>m.key===metricKey)||history.metrics[0];
  const points=metric?.points||[],first=points[0],last=points.at(-1),prior=previousPeerPeriod(period);
  const quarterChange=peerChange(points,prior),windowChange=first?.period!==period?peerChange(points,first?.period):null;
  const ytd=/year.to.date/i.test(metric?.basis||'');
  return <section ref={sectionRef} tabIndex={-1} className={styles.peerHistory} aria-label="Metric history">
    <div className={styles.historyHeading}><div><span className={styles.chartEyebrow}>FOLLOW THE CHANGE</span><h3>{metric?.label||'Metrics over time'}</h3><p>{first?`${first.label} → ${quarterLabel(period)} · ${points.length} reporting ${points.length===1?'period':'periods'}`:'No historical snapshots available for this date.'}</p></div><div className={styles.historySelect}><label htmlFor={selectId}>Explore a metric</label><select id={selectId} value={metricKey} onChange={e=>onMetricChange(e.target.value)}>{CAMELS_DIMENSIONS.map(d=><optgroup key={d.key} label={d.label}>{PEER_BENCHMARKS.filter(m=>m.category===d.key).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>)}</select></div></div>
    {points.length>0&&<>
      <div className={styles.historyLegend}><span><i className={styles.bankLine}/>{bankName}</span><span><i className={styles.dashedSwatch}/>Peer-group median · {last.peerCount} / {history.cohort.length} reporting now</span><small>Ratios in % · Changes in bp</small></div>
      <TrendChart points={points} quarterly={false} unit="percent" label={`${metric.label}: ${bankName} versus peer-group median`} height={285} series={[{key:'value',label:bankName,color:'var(--bank-color)'},{key:'peerMedian',label:'Peer-group median',color:'var(--peer-color)',dash:'5 4'}]}/>
      <details className={styles.visualExplanation}><summary>Values &amp; changes</summary><div className={styles.historyComparison}>
        <div className={styles.historyComparisonHead} aria-hidden="true"><span>Series</span><span>{quarterLabel(period)}</span><span>Change vs {quarterLabel(prior)}</span><span>Change since {first.label}</span></div>
        <div className={styles.historyBankRow}><div><span className={styles.seriesScope}>Individual bank · solid line</span><strong>{bankName}</strong></div><div><small>{quarterLabel(period)}</small><strong>{last.notRequired?'N/A · CBLR':pct(last.value)}</strong></div><div><small>vs {quarterLabel(prior)}</small><strong>{formatBasisPoints(quarterChange)}</strong></div><div><small>since {first.label}</small><strong>{formatBasisPoints(windowChange)}</strong></div></div>
        <div className={styles.historyPeerRow}><div><span className={styles.seriesScope}>Group statistic · dashed line</span><strong>Peer-group median</strong><span className={styles.seriesCoverage}>{last.peerCount} of {history.cohort.length} peers reporting · Bank excluded</span></div><div><small>{quarterLabel(period)}</small><strong>{pct(last.peerMedian)}</strong></div><div><small>vs {quarterLabel(prior)}</small><strong>{formatBasisPoints(peerChange(points,prior,'peerMedian'))}</strong></div><div><small>since {first.label}</small><strong>{formatBasisPoints(first.period===period?null:peerChange(points,first.period,'peerMedian'))}</strong></div></div>
      </div></details>
      <details className={styles.visualExplanation}><summary>Definition &amp; methodology</summary><p className={styles.historyBasis}>{metric.basis}{ytd?' Changes compare the published YTD ratios; they do not isolate single-quarter performance. YTD restarts each calendar year.':''}</p>
      <p className={styles.historyMethod}>{history.cohort.length?`The same ${history.cohort.length} peers selected for ${quarterLabel(period)} are followed backward. Medians are unweighted and require five reported peers per date; valid counts can vary.`:'No matched peer group is available. Reported bank history is shown on its own.'} Missing values remain gaps. Changes describe direction, not improvement or deterioration.</p></details>
      <details className={styles.exactDetails}><summary>Quarterly figures &amp; source records <span>{points.length} {points.length===1?'period':'periods'} · Changes use unrounded values · 100 bp = 1 percentage point</span></summary>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${metric.label} history figures`}><table className={styles.comparison}><caption>{metric.label} · FDIC ratios · Bank changes compare adjacent reporting quarters</caption><thead><tr><th>Period</th><th>{bankName}<small>Individual bank</small></th><th>Bank change vs prior quarter</th><th>Peer-group median<small>Unweighted group statistic</small></th><th>Peer coverage</th>{metric.category==='capital'&&<th>Bank framework</th>}</tr></thead><tbody>{points.map((p,i)=><tr key={p.period}><th scope="row">{p.label}<small>{p.period}</small></th><td>{p.notRequired?'N/A · CBLR':pct(p.value)}</td><td>{formatBasisPoints(peerChange(points.slice(0,i+1),previousPeerPeriod(p.period)))}</td><td>{pct(p.peerMedian)}</td><td>{p.peerCount} of {history.cohort.length}</td>{metric.category==='capital'&&<td>{p.framework}</td>}</tr>)}</tbody></table></div>
        <div className={styles.historySources}><p>Risk-based capital is unavailable for CBLR electors at each historical date. Unavailable bank records are not replaced with predecessor banks. Selected-quarter values use the same source snapshot as peer matching; earlier quarters use their latest completed snapshots. Amendments and changes in reporting or corporate structure can affect comparisons.</p>{history.snapshots.map(s=><p key={s.id}><a href={s.source_url} target="_blank" rel="noreferrer">{quarterLabel(s.report_date)} · FDIC source ↗</a> · Retrieved {new Date(s.created_at).toLocaleString('en-US',{timeZone:'UTC'})} UTC · {s.model_version}</p>)}</div>
      </details>
    </>}
  </section>;
}
