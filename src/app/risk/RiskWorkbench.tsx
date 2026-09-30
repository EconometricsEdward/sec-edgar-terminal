'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowUpRight, BookOpen, ChartNoAxesCombined, Database, Layers3 } from 'lucide-react';
import ChartPeriodOverlay from '../../components/charts/ChartPeriodOverlay';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { buildRiskResearchModel } from './riskResearchModel.js';
import { maturityView } from './riskEvidenceModel.js';
import type { RiskData, RiskProfile, RiskSource } from './riskTypes';
import s from './RiskWorkbench.module.css';

type Measure = { id: string; label: string; value: number | null; prior?: number | null; format: string; formula?: string; sources?: RiskSource[]; series?: { end: string; value: number | null }[]; metricId?: string | null; note?: string };
type EvidenceId = 'maturities' | 'bank' | 'notes' | 'markets' | 'connections';
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const value = (n: unknown, format: string) => finite(n) ? formatRiskValue(n, format) : 'Unavailable';
const deltaFormat = (format: string) => ['pct', 'pp'].includes(format) ? 'pp' : format;

function historyGeometry(metric: Measure, basis: string, left: number, right: number, top: number, bottom: number) {
  const points = metric.series || [], values = points.map(p => p.value).filter(finite);
  const first = Date.parse(points[0]?.end), last = Date.parse(points.at(-1)?.end || '');
  const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 0;
  const x = (i: number) => last > first ? left + (Date.parse(points[i].end) - first) / (last - first) * (right - left) : (left + right) / 2;
  const y = (n: number) => high > low ? bottom - (n - low) / (high - low) * (bottom - top) : (top + bottom) / 2;
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((point, i) => {
    const gap = i > 0 ? (Date.parse(point.end) - Date.parse(points[i - 1].end)) / 86400000 : 0;
    if (!finite(point.value) || gap > (basis === 'ttm' ? 145 : 460)) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
    if (finite(point.value)) segment.push(x(i) + ',' + y(point.value));
  });
  if (segment.length) segments.push(segment.join(' '));
  return { points, values, low, high, x, y, segments };
}

function Sparkline({ metric, basis }: { metric: Measure; basis: string }) {
  const g = historyGeometry(metric, basis, 2, 158, 5, 38);
  if (!g.values.length) return <span className={s.sparkEmpty}>—</span>;
  return <svg viewBox="0 0 160 44" aria-hidden="true" className={s.spark}>
    {g.segments.map((line, i) => <polyline key={i} points={line} className={s.trend} fill="none"/>)}
    {g.points.map((p, i) => finite(p.value) && <circle key={p.end} cx={g.x(i)} cy={g.y(p.value)} r="1.8" className={s.dot}/>)}
  </svg>;
}

function DriverHistory({ metric, basis }: { metric: Measure; basis: string }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const g = historyGeometry(metric, basis, 72, 604, 28, 172);
  if (!g.values.length) return <div className={s.history}><div className={s.historyReadout}><div><span>{metric.label}</span><strong>{value(metric.value, metric.format)}</strong></div></div><div className={s.noHistory}>Compatible history unavailable</div></div>;
  const activeIndex = Math.max(0, g.points.findIndex(p => p.end === (inspected || g.points.at(-1)?.end))), active = g.points[activeIndex];
  return <div className={s.history}>
    <div className={s.historyReadout}><div><span>{metric.label}</span><strong>{value(active.value, metric.format)}</strong></div><time dateTime={active.end}>{active.end}</time></div>
    <div className={s.chartScroll} tabIndex={0} role="region" aria-label="Metric history. Scroll horizontally on narrow screens."><svg viewBox="0 0 620 210" role="group" aria-label={metric.label + ' reporting history'} className={s.chart}>
      {[g.low, (g.low + g.high) / 2, g.high].filter((n, i, all) => all.indexOf(n) === i).map(n => <g key={n}><line x1="72" x2="604" y1={g.y(n)} y2={g.y(n)} className={s.guide}/><text x="62" y={g.y(n) + 4} textAnchor="end">{value(n, metric.format)}</text></g>)}
      {g.low < 0 && g.high > 0 && <line x1="72" x2="604" y1={g.y(0)} y2={g.y(0)} className={s.zeroLine}/>}
      {g.segments.map((line, i) => <polyline key={i} points={line} fill="none" className={s.trend}/>)}
      {g.points.map((p, i) => finite(p.value) && <circle key={p.end} cx={g.x(i)} cy={g.y(p.value)} r={activeIndex === i ? 4.5 : 2.5} className={s.dot}><title>{p.end + ': ' + value(p.value, metric.format)}</title></circle>)}
      <line x1={g.x(activeIndex)} x2={g.x(activeIndex)} y1="18" y2="181" className={s.inspectionLine}/>
      <text x="72" y="202">{g.points[0].end}</text><text x="604" y="202" textAnchor="end">{g.points.at(-1)?.end}</text>
      <ChartPeriodOverlay points={g.points.map((p, i) => ({ id: p.end, label: p.end, x: g.x(i) }))} activeId={active.end} onInspect={setInspected} left={70} right={620} top={0} bottom={185} label={metric.label} describePoint={id => id + ': ' + value(g.points.find(p => p.end === id)?.value, metric.format)}/>
    </svg></div>
    <div className={s.chartHint}>Own scale · Hover, tap or ← →</div>
  </div>;
}

function DebtSnapshot({ data, onOpen }: { data: RiskData; onOpen: () => void }) {
  const profile = data.refinancing;
  const view = maturityView(profile, new Date().toISOString().slice(0, 10));
  const reported = view.buckets.some(bucket => finite(bucket.value));
  return <aside className={s.debt} aria-label="SEC debt maturity snapshot">
    <header><span className={s.eyebrow}>Debt maturities</span><button onClick={onOpen} aria-label="Open full debt timeline"><ArrowUpRight size={17}/></button></header>
    {reported ? <><strong className={s.debtTotal}>{value(profile?.coverage.complete ? profile.totalScheduled : profile?.reportedSubtotal, 'usd')}</strong><span className={s.caption}>{profile?.coverage.complete ? 'Scheduled total' : 'Reported subtotal'} · {profile?.asOf}</span>
      <svg viewBox="0 0 380 185" role="img" aria-label={'Debt maturity schedule reported as of ' + profile?.asOf} className={s.debtChart}>
        <line x1="12" x2="368" y1="140" y2="140" className={s.guide}/>
        {view.buckets.map((bucket, i) => { const x = 14 + i * 61, height = finite(bucket.value) ? Math.max(0, bucket.value) / view.max * 104 : 0; return <g key={bucket.key}>
          {finite(bucket.value) ? <rect x={x} y={140 - height} width="40" height={height} rx="3" className={bucket.elapsed ? s.elapsedBar : s.debtBar}><title>{bucket.shortLabel + ': ' + value(bucket.value, 'usd') + (bucket.elapsed ? ' · elapsed bucket' : '')}</title></rect> : <text x={x + 20} y="124" textAnchor="middle">—</text>}
          <text x={x + 20} y={finite(bucket.value) ? 132 - height : 104} textAnchor="middle">{finite(bucket.value) ? value(bucket.value, 'usd') : 'N/A'}</text>
          <text x={x + 20} y="159" textAnchor="middle">{bucket.shortLabel}</text>
        </g>; })}
      </svg>
      <div className={s.debtCaption}><span>{profile?.coverage.reportedBuckets}/{profile?.coverage.totalBuckets} buckets</span><span>{view.hasElapsed ? 'Muted = elapsed' : 'SEC annual schedule'}</span></div>
    </> : <div className={s.debtMissing}><Database size={32}/><strong>Schedule unavailable</strong><span>Compatible SEC maturity tags missing</span></div>}
    <button className={s.debtLink} onClick={onOpen}>Debt evidence <ArrowUpRight size={14}/></button>
  </aside>;
}

function ChangeBars({ prior, current, format }: { prior: number; current: number; format: string }) {
  const low = Math.min(0, prior, current), high = Math.max(0, prior, current), range = high - low || 1;
  const x = (n: number) => 6 + (n - low) / range * 208, zero = x(0);
  return <svg viewBox="0 0 220 54" role="img" aria-label={'Previous ' + value(prior, format) + ', latest ' + value(current, format)} className={s.changeBars}>
    <line x1={zero} x2={zero} y1="2" y2="52" className={s.zeroLine}/>
    <rect x={Math.min(zero, x(prior))} y="7" width={Math.abs(x(prior) - zero)} height="13" rx="2" className={s.priorBar}/>
    <rect x={Math.min(zero, x(current))} y="32" width={Math.abs(x(current) - zero)} height="13" rx="2" className={s.debtBar}/>
  </svg>;
}

export default function RiskWorkbench({ data, profile, onInspect, onEvidence, onExposures, onFcm, cftcEnabled }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; onEvidence: (id: EvidenceId) => void; onExposures?: () => void; onFcm?: () => void; cftcEnabled: boolean }) {
  const model = useMemo(() => buildRiskResearchModel(profile, data), [profile, data]);
  const allMetrics = [...new Map<string, Measure>((model.drivers.flatMap(d => d.metrics) as Measure[]).map(m => [m.id, m])).values()];
  const [mode, setMode] = useState('dashboard'), [driverId, setDriverId] = useState('all');
  const [measureId, setMeasureId] = useState(() => allMetrics.find(m => finite(m.value))?.id || allMetrics[0]?.id || '');
  const driver = model.drivers.find(d => d.id === driverId);
  const metrics: Measure[] = driver?.metrics || allMetrics;
  const metric = metrics.find(m => m.id === measureId) || metrics.find(m => finite(m.value)) || metrics[0];
  const selectedDriver = model.drivers.find(d => d.metrics.some(m => m.id === metric?.id));
  function openReview(event: { preventDefault: () => void }, href: string) {
    if (href === '#risk-maturities') { event.preventDefault(); onEvidence('maturities'); }
    else if (href === '/analysis/banks') { event.preventDefault(); onEvidence('bank'); }
    else if (href.includes('view=fcm') && cftcEnabled && onFcm) { event.preventDefault(); onFcm(); }
    else if (href.includes('view=exposures') && onExposures) { event.preventDefault(); onExposures(); }
  }
  const end = profile.periods[0]?.end || '';
  const sources = [...new Map((metric?.sources || []).map(source => [[source.documentUrl || source.url || '', source.accession, source.tag, source.start, source.end, source.unit, source.value].join(':'), source])).values()];
  return <section className={s.shell} aria-label="Business model risk workbench">
    <header className={s.head}><div><span className={s.eyebrow}><ChartNoAxesCombined size={15}/> Key metrics</span><h2>{model.lens.label}</h2></div><div className={s.scope}><strong>{model.coverage.available}<span>/{model.coverage.total}</span></strong><span>available measures</span><time dateTime={end}>{end || 'Period unavailable'}</time></div></header>
    <div className={s.modeBar} aria-label="Risk research view">{[['dashboard', 'Dashboard', Layers3], ['changes', 'Changes', Activity], ['coverage', 'Coverage', Database]].map(([id, label, Icon]) => { const Glyph = Icon as typeof Layers3; return <button key={String(id)} aria-pressed={mode === id} onClick={() => setMode(String(id))}><Glyph size={16}/>{String(label)}</button>; })}</div>
    {mode === 'dashboard' && <div className={s.dashboard}>
      <nav className={s.filters} aria-label="Business-specific risk drivers"><button aria-pressed={driverId === 'all'} onClick={() => setDriverId('all')}>All metrics</button>{model.drivers.map(d => <button key={d.id} aria-pressed={driverId === d.id} onClick={() => { setDriverId(d.id); setMeasureId(d.metrics.find(m => finite(m.value))?.id || d.metrics[0]?.id || ''); }}>{d.label}<span>{d.metrics.filter(m => finite(m.value)).length}/{d.metrics.length}</span></button>)}</nav>
      <div className={s.measures} aria-label="Key financial measures">{metrics.map(m => <button key={m.id} aria-pressed={metric?.id === m.id} onClick={() => setMeasureId(m.id)} className={!finite(m.value) ? s.missingMeasure : undefined}>
        <span className={s.measureLabel}>{m.label}</span><strong>{value(m.value, m.format)}</strong>
        <div className={s.measureBottom}><small>{finite(m.value) && finite(m.prior) ? formatRiskValue(m.value - m.prior, deltaFormat(m.format), true) : finite(m.value) ? 'Current value' : 'Missing inputs'}</small><Sparkline metric={m} basis={profile.basis}/></div>
      </button>)}</div>
      <div className={s.visuals}>
        <div className={s.historyPanel}>{metric && <><DriverHistory key={metric.id} metric={metric} basis={profile.basis}/>
          <details className={s.inspector}><summary>Latest calculation & sources{sources.length > 0 ? ' · ' + sources.length : ''}</summary><p>{metric.formula || 'Reported SEC financial measure'}</p>{metric.note && <p>{metric.note}</p>}
            {metric.metricId && <button className={s.inspectLink} onClick={() => onInspect(metric.metricId!, !finite(metric.value))}><BookOpen size={15}/>Full metric evidence</button>}
            {sources.map((source, i) => <div className={s.source} key={i}><span>{source.label || source.tag}<small>{source.start ? source.start + ' to ' : ''}{source.end}{source.filed ? ' · filed ' + source.filed : ''}</small></span><strong>{finite(source.value) ? formatRiskValue(source.value, source.unit === 'pure' ? 'pct' : 'usd') : 'Unavailable'}</strong>{(source.documentUrl || source.url) && <a href={source.documentUrl || source.url} target="_blank" rel="noreferrer">SEC source</a>}</div>)}
            {selectedDriver && <><p>{selectedDriver.question}</p><p>{selectedDriver.meaning}</p>{selectedDriver.gap && <p>{selectedDriver.gap}</p>}<div className={s.reviewLinks}>{selectedDriver.links.map(link => <Link key={link.href + link.label} href={!cftcEnabled && link.href.includes('view=fcm') ? '/filings/' + data.ticker : link.href} prefetch={false} onClick={event => openReview(event, link.href)}>{!cftcEnabled && link.href.includes('view=fcm') ? 'Legal-entity disclosures' : link.label}<ArrowUpRight size={13}/></Link>)}</div></>}
          </details></>}</div>
        <DebtSnapshot data={data} onOpen={() => onEvidence('maturities')}/>
      </div>
    </div>}
    {mode === 'changes' && <div className={s.changeView}><div className={s.viewMeta}><span>{profile.basis === 'ttm' ? 'Prior quarter end → latest · Overlapping TTM flows' : 'Prior fiscal year → latest'}</span><span>Gray: prior · Gold: latest · Own scales</span></div>{model.changes.length ? <div className={s.changes}>{model.changes.map(change => <button key={change.id} onClick={() => { setDriverId('all'); setMeasureId(change.id); setMode('dashboard'); }}><span>{change.label}</span><strong>{formatRiskValue(change.delta, deltaFormat(change.format), true)}</strong><ChangeBars prior={change.prior} current={change.value} format={change.format}/><div><small>{value(change.prior, change.format)}</small><small>{value(change.value, change.format)}</small></div></button>)}</div> : <div className={s.noHistory}>Adjacent compatible observations unavailable</div>}</div>}
    {mode === 'coverage' && <div className={s.coverageView}><div className={s.viewMeta}>Available inputs · Coverage is not a risk grade</div><div className={s.coverageRows}>{model.drivers.map(d => { const available = d.metrics.filter(m => finite(m.value)).length; return <div key={d.id}><strong>{d.label}</strong><div className={s.coverageTrack} role="img" aria-label={available + ' of ' + d.metrics.length + ' measures available'}><i style={{ width: available / Math.max(1, d.metrics.length) * 100 + '%' }}/></div><span>{available}/{d.metrics.length}</span></div>; })}</div><details className={s.inspector}><summary>Evidence gaps · {model.gaps.length}</summary>{model.gaps.map(gap => <div className={s.gap} key={gap.id}><Link href={!cftcEnabled && gap.href.includes('view=fcm') ? '/filings/' + data.ticker : gap.href} prefetch={false} onClick={event => openReview(event, gap.href)}>{gap.label}<ArrowUpRight size={13}/></Link><p>{gap.detail}</p></div>)}</details></div>}
    <nav className={s.evidenceNav} aria-label="Open supporting risk evidence"><span>Evidence</span><button onClick={() => onEvidence('maturities')}>Debt</button><button onClick={() => onEvidence('notes')}>Credit & FX</button>{profile.industry.isBank && <button onClick={() => onEvidence('bank')}>Call Reports</button>}<button onClick={() => onEvidence('markets')}>Funding{cftcEnabled ? ' & swaps' : ''}</button>{cftcEnabled && <button onClick={() => onEvidence('connections')}>CFTC</button>}{onExposures && <button onClick={onExposures}>Exposures</button>}</nav>
    <details className={s.limitations}><summary>Market links, basis & scope</summary><p>{model.lens.description}</p><p>Coverage counts compatible values, not safety. Measures have separate scales and are never added into a score. Card changes compare adjacent compatible observations; each sparkline shows its own reporting history.</p><div className={s.channels}>{model.marketChannels.filter(channel => cftcEnabled || !/cftc|derivatives/i.test(channel.href + channel.id)).map(channel => <div key={channel.id}><Link href={channel.href} prefetch={false} onClick={event => openReview(event, channel.href)}>{channel.label}<ArrowUpRight size={13}/></Link><p>{channel.mechanism}</p></div>)}</div>{model.limitations.map(note => <p key={note}>{note}</p>)}</details>
  </section>;
}
