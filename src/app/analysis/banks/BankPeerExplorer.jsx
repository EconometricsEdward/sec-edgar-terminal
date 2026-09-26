'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { CAMELS_DIMENSIONS,PEER_BENCHMARKS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { buildPeerLandscape } from '../../../utils/bank/peerVisualModel.js';
import { MetricVisual,ComparisonLegend } from './BankMetricVisuals';
import styles from './banks.module.css';

const Landscape=dynamic(()=>import('./BankPeerLandscape'),{ssr:false,loading:()=> <div className={styles.chartLoading}>Loading peer landscape…</div>});
const presets=[{label:'Credit & capital',x:'noncurrent',y:'leverage'},{label:'Earnings',x:'nim',y:'roa'},{label:'Funding',x:'loansDeposits',y:'cash'}];
export function PeerMetricOptions(){return CAMELS_DIMENSIONS.map(d=><optgroup key={d.key} label={d.label}>{PEER_BENCHMARKS.filter(m=>m.category===d.key).map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</optgroup>);}

export default function BankPeerExplorer({data,history,metricKey,onMetricChange,onHistory,onCompare}){
  const [axes,setAxes]=useState({x:'noncurrent',y:'leverage'}),[selectedId,setSelectedId]=useState('');
  const xMetric=PEER_BENCHMARKS.find(m=>m.key===axes.x),yMetric=PEER_BENCHMARKS.find(m=>m.key===axes.y);
  const model=buildPeerLandscape(data.bank,data.peers,axes.x,axes.y);
  const selected=model.points.find(p=>p.rssd===selectedId);
  const metric=data.benchmarks.find(m=>m.key===metricKey)||data.benchmarks[0];
  const trend=history?.metrics.find(m=>m.key===metric.key);
  return <section className={styles.peerExplorer} aria-label="Peer Explorer">
    <div className={styles.explorerWorkspace}>
      <section className={styles.landscapePanel} aria-label="Peer landscape">
        <header className={styles.visualSectionHeader}><div><span className={styles.chartEyebrow}>EXPLORE THE RELATIONSHIPS</span><h3>Peer landscape</h3></div><span className={styles.coverageTag}>{model.points.length} / {model.peerCount} peers plotted</span></header>
        <div className={styles.landscapePresets} role="group" aria-label="Peer map presets">{presets.map(p=><button key={p.label} aria-pressed={axes.x===p.x&&axes.y===p.y} onClick={()=>{setAxes({x:p.x,y:p.y});setSelectedId('');}}>{p.label}</button>)}</div>
        <div className={styles.landscapeAxes}><label>Horizontal · %<select aria-label="Peer map horizontal metric" value={axes.x} onChange={e=>{setAxes({...axes,x:e.target.value});setSelectedId('');}}><PeerMetricOptions/></select></label><label>Vertical · %<select aria-label="Peer map vertical metric" value={axes.y} onChange={e=>{setAxes({...axes,y:e.target.value});setSelectedId('');}}><PeerMetricOptions/></select></label></div>
        <Landscape model={model} xMetric={xMetric} yMetric={yMetric} bank={data.bank} selectedId={selectedId} onSelect={setSelectedId}/>
        <div className={styles.landscapeLegend}><span><i className={styles.bankDot}/>{data.bank.name}{!model.selected?' · Not plotted':''}</span><span><i className={styles.peerDot}/>Individual peers</span></div>
        <div className={styles.mapMedianValues}><span>Plotted-peer medians <small>n = {model.points.length}</small></span><b>X {pct(model.xMedian)}</b><b>Y {pct(model.yMedian)}</b></div>
        <div className={styles.inspectPeer}><label><span className={styles.srOnly}>Inspect a plotted peer</span><select aria-label="Inspect a plotted peer" value={selected?.rssd||''} onChange={e=>setSelectedId(e.target.value)}><option value="">Select a point or inspect a peer…</option>{model.points.map(p=><option value={p.rssd} key={p.rssd}>{p.name}</option>)}</select></label>{selected&&<button onClick={()=>onCompare([selected.rssd])}>Compare bank ↗</button>}</div>
        {selected&&<div className={styles.inspectedPeer} role="status"><strong>{selected.name}</strong><span>{xMetric.label} <b>{pct(selected.x)}</b></span><span>{yMetric.label} <b>{pct(selected.y)}</b></span></div>}
        <details className={styles.visualExplanation}><summary>How to read the map</summary><p>Each point is one legal bank. Cyan identifies {data.bank.name}. Lavender points are matched peers; dashed crosshairs are the unweighted medians of only those peers reporting both selected axes. The selected bank is excluded. At least five plotted peers are required for medians. Banks missing either measure are omitted, and overlapping points can be selected from the list.</p><p>{xMetric.label}: {xMetric.basis}</p><p>{yMetric.label}: {yMetric.basis}</p><p>Positions are financial comparisons, not ratings. {!model.selected?'The selected bank has an unavailable or non-applicable axis value. ':''}{data.assetBand===8?'The matching range was expanded to ⅛–8× this bank’s assets.':''}</p></details>
      </section>
      <section className={styles.spotlightPanel} aria-label="Metric spotlight"><header className={styles.visualSectionHeader}><div><span className={styles.chartEyebrow}>ZOOM INTO A METRIC</span><h3>Metric spotlight</h3></div></header><label className={styles.spotlightSelect}><span className={styles.srOnly}>Spotlight metric</span><select aria-label="Spotlight metric" value={metric.key} onChange={e=>onMetricChange(e.target.value)}><PeerMetricOptions/></select></label><ComparisonLegend/><MetricVisual metric={metric} trend={trend} bank={data.bank} peerCount={data.peers.length} onExplore={onHistory}/></section>
    </div>
    <div className={styles.quickMetrics} role="group" aria-label="Quick metric selection">{data.benchmarks.filter(m=>m.core).map(m=><button key={m.key} aria-pressed={metric.key===m.key} onClick={()=>onMetricChange(m.key)}><span>{m.label}</span><strong>{pct(m.value)}</strong><small>Peer median {m.available?pct(m.median):'unavailable'}</small></button>)}</div>
  </section>;
}
