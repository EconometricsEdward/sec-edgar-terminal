'use client';

import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { matchesRiskPeerResponse } from '../../utils/riskPeerResponse.js';
import s from './RiskPeerBenchmarks.module.css';

type Report = { end: string; filed: string | null; form: string | null; accession: string | null };
type Peer = { ticker: string; cik: string; name: string; value: number; report: Report; sourceUrl: string | null };
type Subject = Omit<Peer, 'value' | 'report'> & { sic: string; report: Report | null };
type Metric = {
  id: string; label: string; format: 'pct' | 'ratio'; formula: string; value: number | null;
  median: number | null; q1: number | null; q3: number | null; min: number | null; max: number | null;
  percentile: number | null; count: number; available: boolean; reason: string | null; peers: Peer[];
  plottedCount?: number;
};
type Response = {
  version: 'risk-peers-v1'; ticker: string; basis: string; groupMode: string; generatedAt: string; stale: boolean;
  status: 'ready' | 'uncovered' | 'insufficient'; subject: Subject | null;
  group: { id: string; label: string; method: string; candidates: number; eligible: number; dateWindowDays: number; minPeers: number };
  metrics: Metric[]; exclusions: Record<string, number>; limitations: string[];
};
type Load = { key: string; status: 'loading' | 'ready' | 'error'; result?: Response; error?: string };
type PlotPeer = Peer & { subject?: boolean };
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const format = (n: number | null | undefined, unit: Metric['format']) => finite(n)
  ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit === 'pct' ? '%' : '×'}` : '—';
const ordinal = (n: number | null) => {
  if (!finite(n)) return '—';
  const rounded = Math.round(n), last = rounded % 10, tens = rounded % 100;
  return `${rounded}${tens >= 11 && tens <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
};

function Distribution({ metric, subject, basis }: { metric: Metric; subject: Subject & { report: Report }; basis: string }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const helpId = useId();
  const subjectPoint: PlotPeer | null = finite(metric.value) ? { ...subject, value: metric.value, subject: true } : null;
  const peers: PlotPeer[] = metric.peers.filter(peer => finite(peer.value) && peer.ticker !== subject.ticker);
  const points = [...peers, ...(subjectPoint ? [subjectPoint] : [])].sort((a, b) => a.value - b.value || a.ticker.localeCompare(b.ticker));
  const selected = points.find(peer => peer.ticker === inspected) || subjectPoint || points[0];
  if (!selected || !points.length) return <div className={s.emptyChart}>Comparable values unavailable</div>;
  const current = Math.max(0, points.findIndex(peer => peer.ticker === selected.ticker));
  const values = [...points.map(peer => peer.value), metric.min, metric.max, metric.q1, metric.q3, metric.median].filter(finite);
  const low = Math.min(...values), high = Math.max(...values), span = high - low;
  const padding = span > 0 ? span * 0.035 : Math.max(1, Math.abs(low) * 0.05);
  const floor = low - padding, ceiling = high + padding;
  const x = (n: number) => 44 + (n - floor) / (ceiling - floor) * 712;
  const y = (peer: PlotPeer, index: number) => peer.subject ? 81 : 114 + ((index % 7) - 3) * 5;
  const ticks = [low, (low + high) / 2, high].filter((n, index, all) => all.indexOf(n) === index);

  function move(event: KeyboardEvent<SVGGElement>) {
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(points.length - 1, current + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, current - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = points.length - 1;
    else if (event.key === 'Escape') { event.preventDefault(); setInspected(null); return; }
    else return;
    event.preventDefault(); setInspected(points[next].ticker);
  }
  function inspect(event: PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = 36 + (event.clientX - rect.left) / Math.max(1, rect.width) * 728;
    const py = 56 + (event.clientY - rect.top) / Math.max(1, rect.height) * 95;
    let nearest = points[0], distance = Infinity;
    points.forEach((peer, index) => {
      const next = Math.hypot(x(peer.value) - px, y(peer, index) - py);
      if (next < distance) { distance = next; nearest = peer; }
    });
    setInspected(nearest.ticker);
  }

  return <>
    <div className={s.plotReadout}>
      <div><span>{selected.subject ? 'Selected company' : 'Inspected peer'}</span><strong>{selected.ticker} <b>{format(selected.value, metric.format)}</b></strong><small>{selected.name}</small></div>
      <div className={s.reportReadout}><span>{selected.report.form} · <time dateTime={selected.report.end}>{selected.report.end}</time></span>{selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">SEC filing <ArrowUpRight size={12}/></a>}</div>
    </div>
    <div className={s.chartScroll} tabIndex={0} role="region" aria-label="Peer distribution. Scroll horizontally on narrow screens.">
      <svg viewBox="0 0 800 207" className={s.chart} role="group" aria-label={`${metric.label} peer distribution`}>
        <line x1="44" x2="756" y1="114" y2="114" className={s.axis}/>
        {finite(metric.q1) && finite(metric.q3) && <rect x={x(metric.q1)} y="96" width={Math.max(1, x(metric.q3) - x(metric.q1))} height="36" rx="5" className={s.quartileBand}/>}
        {finite(metric.median) && <><line x1={x(metric.median)} x2={x(metric.median)} y1="57" y2="145" className={s.medianLine}/><text x={x(metric.median)} y="40" textAnchor="middle" className={s.medianLabel}>Median {format(metric.median, metric.format)}</text></>}
        {points.filter(peer => !peer.subject).map(peer => { const index = points.indexOf(peer); return <circle key={peer.ticker} cx={x(peer.value)} cy={y(peer, index)} r={peer.ticker === selected.ticker ? 5 : 3.3} className={peer.ticker === selected.ticker ? s.selectedPeerDot : s.peerDot}><title>{peer.ticker}: {format(peer.value, metric.format)} · {peer.report.end}</title></circle>; })}
        {subjectPoint && <><line x1={x(subjectPoint.value)} x2={x(subjectPoint.value)} y1="80" y2="145" className={s.subjectLine}/><circle cx={x(subjectPoint.value)} cy="81" r="7" className={s.subjectDot}/></>}
        <circle cx={x(selected.value)} cy={y(selected, current)} r={selected.subject ? 11 : 8} className={s.selectedRing}/>
        {ticks.map((tick, index) => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1="149" y2="155" className={s.axis}/><text x={x(tick)} y="178" textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}>{format(tick, metric.format)}</text></g>)}
        <g role="slider" tabIndex={0} aria-label={`${metric.label}: inspect company`} aria-describedby={helpId} aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={current} aria-valuetext={`${selected.ticker}, ${format(selected.value, metric.format)}, report ${selected.report.end}`} onKeyDown={move} className={s.plotControl}>
          <desc id={helpId}>Hover or tap a dot to inspect its company and filing. Arrow keys move through companies by value; Home and End select the extremes. Escape returns to the selected company.</desc>
          <rect x="36" y="56" width="728" height="95" className={s.hitArea} onPointerMove={event => { if (event.pointerType === 'mouse') inspect(event); }} onPointerDown={inspect}/>
          <rect x="36" y="56" width="728" height="95" className={s.focusRing}/>
        </g>
      </svg>
    </div>
    <div className={s.legend}><span><i className={s.companyKey}/>{subject.ticker}</span><span><i className={s.peerKey}/>Peers</span><span><i className={s.bandKey}/>Middle 50%</span><span className={s.chartHint}>Hover, tap or ← →</span>{metric.count > metric.peers.length && <span className={s.sampleLegend}>{metric.peers.length} of {metric.count} peer dots · statistics use all {metric.count}</span>}</div>
    <details className={s.tableDetails}><summary>{metric.count > metric.peers.length ? 'Plotted peers' : 'Peer companies'} & filing dates · {metric.peers.length}</summary>
      <div className={s.tableScroll}><table><caption>{metric.label} · {basis === 'annual' ? 'Annual' : 'Latest / TTM'} prepared SEC reports</caption><thead><tr><th scope="col">Company</th><th scope="col">{metric.label}</th><th scope="col">Report end</th><th scope="col">Filed</th><th scope="col">Evidence</th></tr></thead><tbody>
        {points.map(peer => <tr key={peer.ticker} className={peer.ticker === selected.ticker ? s.selectedRow : undefined}><th scope="row"><button aria-pressed={peer.ticker === selected.ticker} onClick={() => setInspected(peer.ticker)}>{peer.ticker}{peer.subject && <small>Selected</small>}</button><span>{peer.name}</span></th><td>{format(peer.value, metric.format)}</td><td>{peer.report.end}</td><td>{peer.report.filed || '—'}</td><td><div className={s.tableLinks}>{peer.sourceUrl && <a href={peer.sourceUrl} target="_blank" rel="noreferrer">SEC <ArrowUpRight size={11}/></a>}<Link href={`/risk?ticker=${encodeURIComponent(peer.ticker)}&basis=${encodeURIComponent(basis)}`} prefetch={false}>Risk <ArrowUpRight size={11}/></Link></div></td></tr>)}
      </tbody></table></div>
    </details>
  </>;
}

function BenchmarkResult({ result, profileEnd, basis }: { result: Response; profileEnd: string; basis: string }) {
  const [selectedId, setSelectedId] = useState('');
  const metric = result.metrics.find(item => item.id === selectedId) || result.metrics.find(item => item.available) || result.metrics[0];
  const subject = result.subject;
  const available = result.metrics.filter(item => item.available).length;
  return <>
    <div className={s.population}><div><strong>{result.group.label}</strong><span>{result.group.eligible} prepared companies · {result.group.dateWindowDays}-day report window</span></div><span>{available}/{result.metrics.length} benchmark measures</span></div>
    {subject?.report && <div className={s.reportMeta}><span>{subject.ticker} benchmark · {subject.report.form || 'SEC report'} · <time dateTime={subject.report.end}>{subject.report.end}</time></span>{subject.sourceUrl && <a href={subject.sourceUrl} target="_blank" rel="noreferrer">SEC filing <ArrowUpRight size={12}/></a>}{profileEnd && subject.report.end !== profileEnd && <span className={s.dateMismatch}>Profile report: {profileEnd} · Benchmark uses its prepared snapshot</span>}</div>}
    {result.stale && <div role="status" className={s.notice}>Prepared data awaiting refresh · {result.generatedAt?.slice(0, 10)}</div>}
    {result.status === 'uncovered' ? <div className={s.empty}><ChartNoAxesCombined size={30}/><strong>Prepared peer data unavailable</strong><p>This company is not covered by the current benchmark snapshot.</p></div> : <>
      <nav className={s.metricCards} aria-label="Peer benchmark metric">{result.metrics.map(item => <button key={item.id} aria-pressed={metric?.id === item.id} onClick={() => setSelectedId(item.id)} className={!item.available ? s.unavailableCard : undefined}><span>{item.label}</span><strong>{format(item.value, item.format)}</strong><small>{item.available ? `Median ${format(item.median, item.format)} · ${item.count} peers` : item.reason || 'Insufficient comparable inputs'}</small>{item.available && finite(item.percentile) && <div className={s.positionTrack} role="img" aria-label={`${ordinal(item.percentile)} percentile position`}><i style={{ left: `${Math.max(0, Math.min(100, item.percentile))}%` }}/></div>}</button>)}</nav>
      {metric && <section className={s.distribution} aria-label={`${metric.label} benchmark`}><header><h3>{metric.label}</h3><span>Relative position · not a risk rating</span></header>
        <div className={s.statGrid}><div><span>{subject?.ticker || 'Company'}</span><strong>{format(metric.value, metric.format)}</strong></div><div><span>Peer median</span><strong>{metric.available ? format(metric.median, metric.format) : '—'}</strong></div><div><span>Percentile</span><strong>{metric.available ? ordinal(metric.percentile) : '—'}</strong></div><div><span>Comparable peers</span><strong>{metric.count}</strong></div></div>
        {metric.available && subject?.report ? <Distribution key={metric.id} metric={metric} subject={{ ...subject, report: subject.report }} basis={basis}/> : <div className={s.emptyChart}><strong>Benchmark unavailable</strong><span>{metric.reason || `At least ${result.group.minPeers} peers with compatible inputs are required.`}</span></div>}
        <details className={s.method}><summary>Calculation & peer selection</summary><p>{metric.formula}</p><p>{result.group.method}</p><p>Percentile describes the company’s position within available peer values; a higher value does not necessarily mean stronger or weaker credit quality.</p>{result.limitations.map((note, index) => <p key={index}>{note}</p>)}<span className={s.prepared}>Prepared {result.generatedAt}</span></details>
      </section>}
      {!result.metrics.length && <div className={s.empty}><strong>Comparable measures unavailable</strong><p>Try the broader business-model peer group.</p></div>}
    </>}
  </>;
}

export default function RiskPeerBenchmarks({ ticker, cik, basis, profileEnd = '', asOf = '' }: { ticker: string; cik?: string; basis: string; profileEnd?: string; asOf?: string }) {
  const [group, setGroup] = useState<'industry' | 'model'>('industry');
  const [retry, setRetry] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  const key = `${ticker}:${basis}:${group}:${retry}`;
  useEffect(() => {
    if (asOf) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 30_000);
    setLoad({ key, status: 'loading' });
    const params = new URLSearchParams({ ticker, basis, group });
    fetch(`/api/risk/peers?${params}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Peer benchmarks are temporarily unavailable.');
      if (!matchesRiskPeerResponse(body, ticker, basis, group, cik)) throw new Error('The benchmark response did not match this company and reporting basis. Retry to reload.');
      if (!controller.signal.aborted) setLoad({ key, status: 'ready', result: body as Response });
    }).catch(error => {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
      setLoad({ key, status: 'error', error: controller.signal.reason === 'timeout' ? 'The prepared benchmark request timed out. Retry to reload.' : error instanceof Error ? error.message : 'Could not load peer benchmarks.' });
    }).finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [ticker, cik, basis, group, key, asOf]);

  if (asOf) return <div className={s.workspace}><div className={s.empty}><ChartNoAxesCombined size={30}/><strong>Latest prepared peer reports</strong><p>Clear the historical filing cutoff to compare peers.</p></div></div>;
  const current = load?.key === key ? load : null;
  return <div className={s.workspace}>
    <div className={s.controls}><div role="group" aria-label="Peer group"><button aria-pressed={group === 'industry'} onClick={() => setGroup('industry')}>Industry peers</button><button aria-pressed={group === 'model'} onClick={() => setGroup('model')}>Broader business model</button></div><span>{basis === 'annual' ? 'Annual reports' : 'Latest / TTM reports'}</span></div>
    {current?.status === 'error' ? <div className={s.empty} role="alert"><strong>Benchmarks unavailable</strong><p>{current.error}</p><button className={s.retry} onClick={() => setRetry(count => count + 1)}><RefreshCw size={14}/>Retry</button></div> : current?.status === 'ready' && current.result ? <BenchmarkResult key={`${ticker}:${basis}:${group}`} result={current.result} profileEnd={profileEnd} basis={basis}/> : <div className={s.loading} role="status"><ChartNoAxesCombined size={26}/><span>Loading prepared peer benchmarks…</span><div className={s.loadingBars}><i/><i/><i/></div></div>}
  </div>;
}
