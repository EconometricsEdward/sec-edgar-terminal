'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadBankView } from '../../utils/bank/viewRequests.js';
import { formatPeerPercent as pct } from '../../utils/bank/peerMetrics.js';
import { riskBankPeerView, riskBankPeerMetric, riskBankPeerSourceUrl } from './riskBankPeers.js';
import s from './RiskBankPeers.module.css';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const sourceDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : 'Unavailable';

function PeerPlot({ metric, bankName, selectedPeer, inspect }: { metric: any; bankName: string; selectedPeer: string; inspect: (rssd: string) => void }) {
  if (!metric.available) return <p className={s.empty}>{metric.count} reporting peers · At least 5 are needed for a median and range.</p>;
  const [low, high] = metric.domain;
  const x = (value: number) => 30 + (value - low) / (high - low) * 560;
  return <><svg className={s.plot} viewBox="0 0 620 135" role="group" aria-label={`${metric.label}. ${bankName}: ${pct(metric.value)}. Peer median ${pct(metric.median)}. Middle 50% ${pct(metric.q1)} to ${pct(metric.q3)}. Inspect peer dots by keyboard or pointer.`}>
    <line x1="30" x2="590" y1="68" y2="68" stroke="var(--r-line)" strokeWidth="2"/>
    <rect x={x(metric.q1)} y="58" width={Math.max(2, x(metric.q3) - x(metric.q1))} height="20" rx="5" fill="var(--peer-color)" opacity=".3"/>
    <path d={`M ${x(metric.median)} 59 l 9 9 l -9 9 l -9 -9 Z`} fill="var(--peer-color)"><title>Peer median: {pct(metric.median)}</title></path>
    {finite(metric.value) && <g><line x1={x(metric.value)} x2={x(metric.value)} y1="32" y2="83" stroke="var(--bank-color)" strokeWidth="2"/><circle cx={x(metric.value)} cy="32" r="7" fill="var(--bank-color)" stroke="var(--r-panel)" strokeWidth="2"><title>{bankName}: {pct(metric.value)}</title></circle></g>}
    {metric.peers.map((peer: any, index: number) => <g key={peer.rssd} className={s.dot} tabIndex={0} role="button" aria-label={`Inspect ${peer.name}: ${pct(peer.value)}`} data-selected={selectedPeer === String(peer.rssd) || undefined} onFocus={() => inspect(String(peer.rssd))} onPointerEnter={() => inspect(String(peer.rssd))} onClick={() => inspect(String(peer.rssd))} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspect(String(peer.rssd)); } }}>
      <circle cx={x(peer.value)} cy={103 + index % 3 * 9} r="5.5"><title>{peer.name}: {pct(peer.value)}</title></circle>
    </g>)}
  </svg><div className={s.axis} aria-hidden="true"><span>{pct(low)}</span><span>{pct(high)}</span></div></>;
}

export default function RiskBankPeers({ rssd, period, bankName }: { rssd: string; period: string; bankName: string }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<any>(null), [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0), [metricKey, setMetricKey] = useState('leverage'), [selectedPeer, setSelectedPeer] = useState('');
  const binding = `${rssd}:${period}`;
  const view = result ? riskBankPeerView(result, rssd, period) : null;
  const error = failure?.key === binding ? failure.message : '';
  useEffect(() => {
    if (!open || !rssd || !period) return;
    const controller = new AbortController();
    loadBankView({ kind: 'peers', rssd, period, signal: controller.signal, refresh: retry > 0 }).then(data => {
      if (!riskBankPeerView(data, rssd, period)) throw new Error('The peer publication does not match this bank and quarter. Retry to read a verified publication.');
      if (!controller.signal.aborted) { setResult(data); setFailure(null); }
    }).catch(cause => {
      if (!controller.signal.aborted && cause.name !== 'AbortError') setFailure({ key: binding, message: cause.message });
    });
    return () => controller.abort();
  }, [open, rssd, period, binding, retry]);
  const metric = view ? riskBankPeerMetric(view.metrics, metricKey) : null;
  const inspected = metric?.peers.find((peer: any) => String(peer.rssd) === selectedPeer);
  const peerUrl = `/analysis/banks/${rssd}?view=compare&period=${encodeURIComponent(period)}&panel=benchmarks&lens=peers`;
  const sourceUrl = riskBankPeerSourceUrl(view?.snapshot);
  function refresh() { setResult(null); setFailure(null); setRetry(value => value + 1); }
  return <details className={s.drawer} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary><strong>Matched bank peers</strong><span>FDIC · {period || 'Select a quarter'}</span></summary>
    {open && <div className={s.panel}>
      {!view && !error && <p className={s.state} role="status">Reading the prepared peer group for {bankName}…</p>}
      {error && <p className={s.state} role="alert">{error}<button className={s.button} onClick={refresh}>Retry peers</button></p>}
      {view && !view.bank && <p className={s.empty}>No prepared FDIC peer record for RSSD {rssd} in {period}. Choose another quarter or open the full bank workspace.</p>}
      {view?.bank && <>
        <div className={s.context}><div><strong>{view.bank.name}</strong><p>Selected legal bank · RSSD {rssd} · {period}</p></div><div><strong>{view.peers.length} matched banks</strong><p>FDIC · Bank excluded · Unweighted medians</p></div></div>
        {view.publicPeerCache?.stale && <p className={s.notice}>Retained peer publication · Last checked {sourceDate(view.publicPeerCache.checkedAt)}. Reporting quarter remains {period}.</p>}
        {view.assetBand === 8 && <p className={s.notice}>Expanded size range · Peers have ⅛–8× this bank’s assets.</p>}
        <div className={s.tools} aria-label="Bank peer metric">{view.metrics.map((item: any) => <button key={item.key} type="button" aria-pressed={item.key === metric?.key} onClick={() => { setMetricKey(item.key); setSelectedPeer(''); }}>{item.label}</button>)}</div>
        {metric && <article className={s.spotlight} aria-label={`${metric.label} peer comparison`}>
          <h4>{metric.label}</h4>
          <div className={s.values}><div><span>Selected bank · FDIC</span><strong className={s.bankValue}>{metric.notRequired ? 'N/A · CBLR' : metric.frameworkUnverified ? 'Unverified' : pct(metric.value)}</strong></div><div><span>Peer median</span><strong className={s.peerValue}>{metric.available ? pct(metric.median) : 'Unavailable'}</strong></div><div><span>Middle 50% of peers</span><strong>{metric.available ? `${pct(metric.q1)}–${pct(metric.q3)}` : 'Unavailable'}</strong></div></div>
          <PeerPlot metric={metric} bankName={view.bank.name} selectedPeer={inspected ? selectedPeer : ''} inspect={setSelectedPeer}/>
          <div className={s.legend}><span><i/>Selected bank</span><span><i className={s.diamond}/>Peer median</span><span><i className={s.band}/>Middle 50%</span><span><i/>Peer banks</span></div>
          <div className={s.inspect} aria-live="polite">{inspected ? <><strong>{inspected.name} · {pct(inspected.value)}</strong><Link prefetch={false} href={`/analysis/banks/${inspected.rssd}?view=compare&period=${encodeURIComponent(period)}`}>Inspect bank ↗</Link></> : <span>{metric.available ? 'Hover or focus a peer dot to inspect its value.' : 'Matching inputs or reporting coverage are incomplete.'}</span>}</div>
          <p className={s.caption}>{metric.count} / {view.peers.length} peers reporting · Ratios in % · Each chart uses its own scale</p>
          {(metric.notRequired || metric.frameworkUnverified) && <p className={s.caption}>{metric.notRequired ? 'Risk-based capital ratios are not required under CBLR.' : 'Risk-based capital is withheld because this bank’s regulatory framework is unverified.'}</p>}
          <details className={s.details}><summary>Definition &amp; individual peer values</summary><p>{metric.basis} FDIC field: {metric.field}.</p><div className={s.table}><table><thead><tr><th>Legal bank</th><th>RSSD</th><th>{metric.label}</th></tr></thead><tbody><tr><th scope="row">{view.bank.name} · Selected bank</th><td>{rssd}</td><td>{metric.notRequired ? 'N/A · CBLR' : pct(metric.value)}</td></tr>{view.peers.map((peer: any) => { const point = metric.peers.find((row: any) => row.rssd === peer.rssd); return <tr key={peer.rssd}><th scope="row">{peer.name}</th><td>{peer.rssd}</td><td>{metric.riskBased && peer.cblr === true ? 'N/A · CBLR' : pct(point?.value ?? null)}</td></tr>; })}</tbody></table></div></details>
        </article>}
        <details className={s.details}><summary>Peer matching &amp; source dates</summary><p>Size 40% · Lending 35% · Funding 25%. Up to 30 banks within {view.assetBand === 8 ? '⅛–8×' : '¼–4×'} asset size. Matching excludes performance outcomes. Each metric needs at least 5 valid peers. Quartiles use linear interpolation; no outlier trimming.</p><p>These are FDIC-based BankScope matched peers, separate from the FFIEC measures above and SEC holding-company figures. Definitions and reporting amendments can differ. They are not official UBPR peer statistics or supervisory ratings.</p><p>Reporting quarter {period} · Retrieved {sourceDate(view.snapshot.created_at)} · Published {sourceDate(view.snapshot.completed_at)} · {view.universeCount.toLocaleString('en-US')} quarterly records · {view.eligibleCount.toLocaleString('en-US')} eligible matching profiles.</p></details>
      </>}
      <div className={s.links}><Link prefetch={false} href={peerUrl}>Full bank peer analysis ↗</Link>{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">FDIC quarterly source ↗</a>}</div>
    </div>}
  </details>;
}
