'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, BookOpen, CircleHelp, Layers3, ScanLine } from 'lucide-react';
import ChartPeriodOverlay from '../../components/charts/ChartPeriodOverlay';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { buildRiskResearchModel } from './riskResearchModel.js';
import type { RiskData, RiskProfile, RiskSource } from './riskTypes';
import s from './RiskWorkbench.module.css';

type Measure = { id: string; label: string; value: number | null; prior?: number | null; format: string; formula?: string; sources?: RiskSource[]; series?: { end: string; value: number | null }[]; metricId?: string | null; note?: string };
type EvidenceId = 'maturities' | 'bank' | 'notes' | 'markets' | 'connections';
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const value = (n: unknown, format: string) => finite(n) ? formatRiskValue(n, format) : 'Unavailable';

function DriverHistory({ metric, basis }: { metric: Measure; basis: string }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const points = metric.series || [];
  const values = points.map(p => p.value).filter(finite);
  if (!points.length || !values.length) return <div className={s.noHistory}>A compatible history is not available for this measure. The current calculation and source inputs appear below.</div>;
  const first = Date.parse(points[0].end), last = Date.parse(points.at(-1)!.end);
  const low = Math.min(...values), high = Math.max(...values), range = high - low;
  const x = (i: number) => last > first ? 16 + (Date.parse(points[i].end) - first) / (last - first) * 588 : 310;
  const y = (n: number) => range > 0 ? 139 - (n - low) / range * 108 : 85;
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((point, i) => {
    const gap = i > 0 ? (Date.parse(point.end) - Date.parse(points[i - 1].end)) / 86400000 : 0;
    if (!finite(point.value) || gap > (basis === 'ttm' ? 145 : 460)) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
    if (finite(point.value)) segment.push(x(i) + ',' + y(point.value));
  });
  if (segment.length) segments.push(segment.join(' '));
  const activeIndex = Math.max(0, points.findIndex(p => p.end === (inspected || points.at(-1)?.end)));
  const active = points[activeIndex];
  return <div className={s.history}>
    <div className={s.historyReadout}><div><span>{metric.label}</span><strong>{value(active.value, metric.format)}</strong></div><time dateTime={active.end}>{active.end}</time></div>
    <svg viewBox="0 0 620 178" role="group" aria-label={metric.label + ' reporting history'} className={s.chart}>
      <line x1="16" x2="604" y1="145" y2="145" className={s.guide}/>
      {segments.map((line, i) => <polyline key={i} points={line} fill="none" className={s.trend}/>)}
      {points.map((p,i) => finite(p.value) && <circle key={p.end} cx={x(i)} cy={y(p.value)} r={activeIndex === i ? 4.5 : 2.5} className={s.dot}><title>{p.end + ': ' + value(p.value, metric.format)}</title></circle>)}
      <line x1={x(activeIndex)} x2={x(activeIndex)} y1="22" y2="145" className={s.inspectionLine}/>
      <text x="16" y="170">{points[0].end}</text><text x="604" y="170" textAnchor="end">{points.at(-1)?.end}</text>
      <ChartPeriodOverlay points={points.map((p,i) => ({id:p.end,label:p.end,x:x(i)}))} activeId={active.end} onInspect={setInspected} left={0} right={620} top={0} bottom={150} label={metric.label} describePoint={id => id + ': ' + value(points.find(p => p.end === id)?.value, metric.format)}/>
    </svg>
    <p>Hover, tap or use arrow keys. Each measure uses its own scale; gaps remain visible.</p>
  </div>;
}

export default function RiskWorkbench({ data, profile, onInspect, onEvidence, onExposures, onFcm, cftcEnabled }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; onEvidence: (id: EvidenceId) => void; onExposures?: () => void; onFcm?: () => void; cftcEnabled: boolean }) {
  const model = useMemo(() => buildRiskResearchModel(profile, data), [profile, data]);
  const [mode,setMode] = useState('drivers'), [driverId,setDriverId] = useState(() => model.drivers.find(driver => driver.metrics.some(metric => finite(metric.value)))?.id || model.drivers[0]?.id || '');
  const [measureId,setMeasureId] = useState('');
  const driver = model.drivers.find(d => d.id === driverId) || model.drivers[0];
  const metrics: Measure[] = driver?.metrics || [];
  const metric = metrics.find(m => m.id === measureId) || metrics.find(m => finite(m.value)) || metrics[0];
  function openReview(event: {preventDefault: () => void}, href: string) {
    if (href === '#risk-maturities') { event.preventDefault(); onEvidence('maturities'); }
    else if (href === '/analysis/banks') { event.preventDefault(); onEvidence('bank'); }
    else if (href.includes('view=fcm') && cftcEnabled && onFcm) { event.preventDefault(); onFcm(); }
    else if (href.includes('view=exposures') && onExposures) { event.preventDefault(); onExposures(); }
  }
  const end = profile.periods[0]?.end || '';
  const sources = [...new Map((metric?.sources || []).map(source => [(source.documentUrl || source.url || '') + ':' + source.tag + ':' + source.end, source])).values()];
  return <section className={s.shell} aria-label="Business model risk workbench">
    <header className={s.head}><div><span className={s.eyebrow}><ScanLine size={15}/> Business model lens</span><h2>{model.lens.label}</h2><p>{model.lens.description}</p></div><div className={s.scope}><strong>{model.coverage.available}<span> / {model.coverage.total}</span></strong><span>key measures reported</span><time dateTime={end}>{end || 'Period unavailable'}</time></div></header>
    <div className={s.modeBar} aria-label="Risk research view">{[['drivers','Risk drivers',Layers3],['changes','What changed',Activity],['gaps','Evidence gaps',CircleHelp]].map(([id,label,Icon]) => { const Glyph = Icon as typeof Layers3; return <button key={String(id)} aria-pressed={mode === id} onClick={() => setMode(String(id))}><Glyph size={16}/>{String(label)}{id === 'gaps' && <span>{model.gaps.length}</span>}</button>; })}</div>
    {mode === 'drivers' && driver && <div className={s.workbench}>
      <nav className={s.driverList} aria-label="Business-specific risk drivers">{model.drivers.map((d,i) => { const primary = d.metrics.find((m: Measure) => finite(m.value)); const available = d.metrics.filter((m: Measure) => finite(m.value)).length; return <button key={d.id} aria-pressed={driver.id === d.id} aria-controls="risk-driver-detail" onClick={() => {setDriverId(d.id);setMeasureId('');}}><span className={s.driverNumber}>{'0' + (i+1)}</span><div><strong>{d.label}</strong><small>{primary?.label || 'Filing review'}</small><span className={s.driverValue}>{primary ? value(primary.value,primary.format) : 'Evidence unavailable'}</span><div className={s.coverageTrack} aria-hidden="true"><i style={{width:(d.metrics.length ? available / d.metrics.length * 100 : 0) + '%'}}/></div><small>{available} of {d.metrics.length} measures reported</small></div></button>; })}</nav>
      <div id="risk-driver-detail" className={s.detail}><div className={s.detailHeading}><span className={s.eyebrow}>{driver.label}</span><h3>{driver.question}</h3><p>{driver.meaning}</p></div>
        <div className={s.measures} aria-label="Measures for selected driver">{metrics.map(m => <button key={m.id} aria-pressed={metric?.id === m.id} onClick={() => setMeasureId(m.id)}><span>{m.label}</span><strong>{value(m.value,m.format)}</strong><small>{finite(m.value) ? end : 'Compatible inputs unavailable'}</small></button>)}</div>
        {metric && <><DriverHistory key={driver.id + ':' + metric.id} metric={metric} basis={profile.basis}/><div className={s.calculation}><div><span>Calculation</span><p>{metric.formula || 'Reported SEC financial measure'}</p>{metric.note && <p>{metric.note}</p>}</div>{metric.metricId && <button onClick={() => onInspect(metric.metricId!, !finite(metric.value))}><BookOpen size={15}/>Inspect metric</button>}</div>
          {sources.length > 0 && <details className={s.sources}><summary>Source inputs & reporting dates ({sources.length})</summary>{sources.map((source,i) => <div key={i}><span>{source.label || source.tag}<small>{source.start ? source.start + ' to ' : ''}{source.end}{source.filed ? ' · filed ' + source.filed : ''}</small></span><strong>{finite(source.value) ? formatRiskValue(source.value, source.unit === 'pure' ? 'pct' : 'usd') : 'Value unavailable'}</strong>{(source.documentUrl || source.url) && <a href={source.documentUrl || source.url} target="_blank" rel="noreferrer">SEC source</a>}</div>)}</details>}
        </>}
        {driver.gap && <p className={s.gapNote}><CircleHelp size={16}/>{driver.gap}</p>}
        <div className={s.reviewLinks}>{driver.links.map(link => <Link key={link.href + link.label} href={!cftcEnabled && link.href.includes('view=fcm') ? '/filings/' + data.ticker : link.href} prefetch={false} onClick={event => openReview(event,link.href)}><strong>{!cftcEnabled && link.href.includes('view=fcm') ? 'Read legal-entity disclosures' : link.label}</strong><small>{link.scope}</small></Link>)}</div>
      </div>
    </div>}
    {mode === 'changes' && <div className={s.changeView}><div className={s.viewIntro}><h3>Separate changes. Shared questions.</h3><p>{profile.basis === 'ttm' ? 'Current versus prior quarter-end observations. TTM earnings windows overlap.' : 'Current versus prior fiscal-year observations.'} Values keep their own units and reporting basis.</p></div>{model.changes.length ? <div className={s.changes}>{model.changes.map(change => <button key={change.id} onClick={() => change.metricId && onInspect(change.metricId)} disabled={!change.metricId}><span>{change.label}</span><strong>{formatRiskValue(change.delta, ['pct','pp'].includes(change.format) ? 'pp' : change.format,true)}</strong><small>{value(change.prior,change.format)} to {value(change.value,change.format)}</small><em>{change.metricId ? 'Inspect calculation & history' : 'Reported change'}</em></button>)}</div> : <p className={s.noHistory}>No adjacent, compatible observations are available for the key measures.</p>}<p className={s.caption}>A change alone does not establish stronger or weaker credit. Review the business drivers, source inputs and filing explanations together.</p></div>}
    {mode === 'gaps' && <div className={s.gapView}><div className={s.viewIntro}><h3>What the public data still needs to answer.</h3><p>Distinguish missing compatible figures from topics that require the filing notes or a separate regulatory report.</p></div><div className={s.gaps}>{model.gaps.map(gap => <Link key={gap.id} href={!cftcEnabled && gap.href.includes('view=fcm') ? '/filings/' + data.ticker : gap.href} prefetch={false} onClick={event => openReview(event,gap.href)}><CircleHelp size={18}/><div><h4>{gap.label}</h4><p>{gap.detail}</p><span>Review source evidence</span></div></Link>)}</div></div>}
    <div className={s.channels}><div><span className={s.eyebrow}>Transmission channels</span><h3>Connect the business to the wider market.</h3><p>Research paths for this business model. Company exposure requires its own disclosure.</p></div>{model.marketChannels.filter(channel => cftcEnabled || !/cftc|derivatives/i.test(channel.href + channel.id)).map(channel => <Link key={channel.id} href={channel.href} prefetch={false} onClick={event => openReview(event,channel.href)}><strong>{channel.label}</strong><span>{channel.mechanism}</span></Link>)}</div>
    <nav className={s.evidenceNav} aria-label="Open supporting risk evidence"><button onClick={() => onEvidence('maturities')}>Debt timeline</button><button onClick={() => onEvidence('notes')}>Credit & currency notes</button>{profile.industry.isBank && <button onClick={() => onEvidence('bank')}>Bank Call Reports</button>}<button onClick={() => onEvidence('markets')}>Funding{cftcEnabled ? ' & swaps' : ' markets'}</button>{cftcEnabled && <button onClick={() => onEvidence('connections')}>CFTC connections</button>}{onExposures && <button onClick={onExposures}>Business exposure map</button>}</nav>
    <details className={s.limitations}><summary>Basis, scope & limitations</summary><p>Coverage counts compatible values for the selected key measures. It is not a measure of safety or a risk rating. Measures can overlap; they are never added into a score.</p>{model.limitations.map(note => <p key={note}>{note}</p>)}</details>
  </section>;
}
