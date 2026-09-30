'use client';

import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BookOpen, CalendarDays, FileSearch, FileText, Landmark, ListChecks, Loader2, LockKeyhole, Shield, Users, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { disclosureWordDiff } from '../../utils/disclosureResearch.js';
import type { RiskSource } from './riskTypes';
import s from './RiskChangeTimeline.module.css';

type Passage = { text: string; url: string; section?: string; paragraphIndex?: number; truncated?: boolean };
type TimelineSide = { end?: string; date?: string; start?: string | null; windowEnd?: string; filed?: string; form?: string; value?: number | null; formula?: string; sources?: RiskSource[]; sourceUrls?: string[]; evidence?: Passage[] };
export type RiskTimelineEvent = {
  id: string; kind: string; date: string; dateBasis?: string; category: string; categoryLabel?: string; title: string;
  direction?: string; format?: string; deltaFormat?: string; delta?: number | null; relativeChange?: number | null; metricId?: string | null;
  note?: string; scope?: string; criterion?: string | { id?: string; label: string; threshold?: unknown; observed?: unknown };
  before: TimelineSide; after: TimelineSide;
};
type Period = { id?: string; date: string; label?: string; eventCount?: number; comparisonAvailable?: boolean };
type Category = { id: string; label: string };
export type RiskTimelineModel = {
  basis?: string; events: RiskTimelineEvent[]; periods?: Period[]; categories?: Category[];
  criteria?: { id?: string; label: string; detail?: string; threshold?: unknown }[]; limitations?: string[];
  coverage?: { comparisons?: number; comparablePairs?: number; excludedPairs?: number; cutoffExcludedPairs?: number; eventCount?: number };
  gaps?: { id: string; label: string; count?: number }[];
};

const ICONS: Record<string, LucideIcon> = {
  'cash-generation': Wallet, liquidity: Wallet, refinancing: CalendarDays, capital: Landmark,
  'asset-quality': Shield, investment: Activity, distributions: ArrowUpRight,
  'customer-concentration': Users, covenants: ListChecks, collateral: LockKeyhole,
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberLabel = (value: unknown, format = 'usd', signed = false) => finite(value)
  ? formatRiskValue(format === 'count' ? Number(value.toFixed(2)) : value, format, signed) : 'Unavailable';
const dateLabel = (date?: string, compact = false) => date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
  ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', ...(compact ? {} : { day: 'numeric' }), year: 'numeric', timeZone: 'UTC' }) : date || 'Date unavailable';

function urlsFor(side: TimelineSide) {
  return [...new Set([...(side.sourceUrls || []), ...(side.sources || []).map(source => source.documentUrl || source.url), ...(side.evidence || []).map(passage => passage.url)].filter((url): url is string => typeof url === 'string' && !!url))];
}

function FilingLinks({ side }: { side: TimelineSide }) {
  const allUrls = urlsFor(side);
  const filings = allUrls.filter(url => /\/Archives\/edgar\/data\//.test(url));
  const urls = filings.length ? filings : allUrls;
  if (!urls.length) return <span className={s.sourceUnavailable}>Source link unavailable</span>;
  return <div className={s.filingLinks}>{urls.map((url, index) => {
    const source = side.sources?.find(item => item.documentUrl === url || item.url === url);
    const filed = source?.filed || side.filed;
    return <a key={url} href={url} target="_blank" rel="noreferrer"><FileText size={14} aria-hidden="true" /><span>{filings.length ? `${side.form || 'SEC'} original${urls.length > 1 ? ` ${index + 1}` : ''}` : 'SEC fact API'}{filed && <small>Filed {dateLabel(filed)}</small>}</span><ArrowUpRight size={14} aria-hidden="true" /></a>;
  })}</div>;
}

function EvidenceSide({ side, event, label }: { side: TimelineSide; event: RiskTimelineEvent; label: string }) {
  const sources = side.sources || [], passages = side.evidence || [];
  return <article className={s.side} data-side={label.toLowerCase()}>
    <header><span>{label}</span><time dateTime={side.end || side.date}>{dateLabel(side.end || side.date)}</time></header>
    {event.kind === 'metric' ? <><strong className={s.sideValue}>{numberLabel(side.value, event.format)}</strong>{side.start && <p className={s.interval}>{side.windowEnd ? 'Forward window' : 'Flow interval'}: {dateLabel(side.start)} – {dateLabel(side.windowEnd || side.end || side.date)}</p>}{side.formula && <p className={s.formula}>{side.formula}</p>}</>
      : passages.length ? <div className={s.passages}>{passages.map((passage, index) => <PassageEvidence key={passage.url + ':' + index} passage={passage} before={event.before.evidence?.[index]?.text} after={event.after.evidence?.[index]?.text} isBefore={label === 'Before'}/>)}</div>
        : <p className={s.noPassage}>Comparable passage unavailable</p>}
    <FilingLinks side={side}/>
    {sources.length > 0 && <details className={s.inputs}><summary>Reported inputs · {sources.length}</summary><div className={s.tableScroll}><table><thead><tr><th scope="col">Reported fact</th><th scope="col">Value</th></tr></thead><tbody>{sources.map((source, index) => <tr key={[source.tag, source.accession, source.start, source.end, index].join(':')}><th scope="row">{source.label || source.tag}<small>{source.start ? `${source.start} → ` : ''}{source.end}{source.filed ? ` · filed ${source.filed}` : ''}</small><code>{source.tag}</code></th><td>{finite(source.value) ? `${source.value.toLocaleString('en-US', { maximumFractionDigits: 8 })}${source.unit ? ` ${source.unit}` : ''}` : 'Unavailable'}</td></tr>)}</tbody></table></div></details>}
  </article>;
}

function PassageEvidence({ passage, before, after, isBefore }: { passage: Passage; before?: string; after?: string; isBefore: boolean }) {
  const parts = useMemo(() => before && after ? disclosureWordDiff(before, after).filter(part => isBefore ? part.kind !== 'added' : part.kind !== 'removed') : null, [before, after, isBefore]);
  const beyondPreview = before === after && passage.truncated;
  return <div>{passage.section && <span className={s.section}>{passage.section}</span>}<blockquote>{parts ? parts.map((part, index) => part.kind === 'same' ? <span key={index}>{part.text}</span> : <mark key={index}>{part.text}</mark>) : passage.text}{passage.truncated && !/…$|\.{3}$/.test(passage.text) && '…'}</blockquote>{passage.truncated && <span className={s.excerptNote}>{beyondPreview ? 'Change beyond preview · open original' : 'Excerpt · ellipses omit text · full passage in source'}</span>}</div>;
}

function ComparisonBars({ event }: { event: RiskTimelineEvent }) {
  const before = event.before.value, after = event.after.value;
  if (!finite(before) || !finite(after)) return null;
  const low = Math.min(0, before, after), high = Math.max(0, before, after), range = high - low || 1;
  const x = (n: number) => 10 + (n - low) / range * 400, zero = x(0);
  return <svg className={s.comparisonBars} viewBox="0 0 420 48" role="img" aria-label={`Before ${numberLabel(before, event.format)}. Current ${numberLabel(after, event.format)}. Shared scale.`}>
    <line x1={zero} x2={zero} y1="0" y2="48" className={s.zeroLine}/>
    <rect x={Math.min(zero, x(before))} y="5" width={Math.abs(x(before) - zero)} height="12" rx="2" className={s.beforeBar}/>
    <rect x={Math.min(zero, x(after))} y="29" width={Math.abs(x(after) - zero)} height="12" rx="2" className={s.currentBar}/>
  </svg>;
}

export default function RiskChangeTimeline({ model, disclosureEvents = [], disclosureStatus = 'idle', disclosureMessage, onLoadDisclosures, onInspect, disclosureCoverage }: {
  model: RiskTimelineModel; disclosureEvents?: RiskTimelineEvent[]; disclosureStatus?: string; disclosureMessage?: string;
  onLoadDisclosures?: () => void; onInspect?: (metricId: string) => void; disclosureCoverage?: ReactNode;
}) {
  const headingId = useId(), detailId = useId();
  const events = useMemo(() => [...model.events, ...disclosureEvents].sort((a, b) => b.date.localeCompare(a.date)), [model.events, disclosureEvents]);
  const [category, setCategory] = useState('all');
  const [selectedDate, setSelectedDate] = useState(() => events[0]?.date || model.periods?.at(-1)?.date || '');
  const [selectedId, setSelectedId] = useState(() => events[0]?.id || '');
  const categories = [...new Map([...(model.categories || []), ...events.map(event => ({ id: event.category, label: event.categoryLabel || event.category }))].map(item => [item.id, item])).values()].filter(item => events.some(event => event.category === item.id));
  const availablePeriods: Period[] = [...(model.periods || []), ...events.filter(event => !model.periods?.some(period => period.date === event.date)).map(event => ({ date: event.date }))];
  const periods = [...new Map(availablePeriods.map(period => [period.date, period] as const)).values()].sort((a, b) => a.date.localeCompare(b.date));
  const filtered = category === 'all' ? events : events.filter(event => event.category === category);
  const activeDate = periods.some(period => period.date === selectedDate) ? selectedDate : filtered[0]?.date || periods.at(-1)?.date || '';
  const periodEvents = filtered.filter(event => event.date === activeDate);
  const active = periodEvents.find(event => event.id === selectedId) || periodEvents[0];
  function chooseCategory(next: string) {
    const first = next === 'all' ? events[0] : events.find(event => event.category === next);
    setCategory(next); setSelectedDate(first?.date || periods.at(-1)?.date || ''); setSelectedId(first?.id || '');
  }
  function choosePeriod(date: string) {
    setSelectedDate(date); setSelectedId(filtered.find(event => event.date === date)?.id || '');
  }
  const loading = disclosureStatus === 'loading';
  const compared = ['ready', 'no_changes', 'no_filing'].includes(disclosureStatus);

  return <section className={s.timeline} aria-labelledby={headingId}>
    <header className={s.head}><div><span className={s.eyebrow}><CalendarDays size={15} aria-hidden="true"/> Change timeline</span><h2 id={headingId}>Follow the change. Open the evidence.</h2><p>Report periods · Filing dates shown in sources</p></div>{onLoadDisclosures && <button className={s.compareButton} type="button" onClick={onLoadDisclosures} disabled={loading || compared}>{loading ? <Loader2 size={16} className={s.spin} aria-hidden="true"/> : <FileSearch size={16} aria-hidden="true"/>}{loading ? 'Comparing filings…' : compared ? 'Filings compared' : ['error', 'partial'].includes(disclosureStatus) ? 'Retry comparison' : 'Compare filings'}</button>}</header>
    <div className={s.disclosureTopics} aria-label="Filing text comparison topics"><span>Filing text</span><span><Users size={13} aria-hidden="true"/>Customers</span><span><ListChecks size={13} aria-hidden="true"/>Covenants</span><span><LockKeyhole size={13} aria-hidden="true"/>Collateral</span></div>
    <nav className={s.filters} aria-label="Timeline change categories"><button type="button" aria-pressed={category === 'all'} onClick={() => chooseCategory('all')}>All changes<span>{events.length}</span></button>{categories.map(item => { const Icon = ICONS[item.id] || Activity; return <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => chooseCategory(item.id)}><Icon size={14} aria-hidden="true"/>{item.label}<span>{events.filter(event => event.category === item.id).length}</span></button>; })}</nav>
    {periods.length > 0 && <div className={s.periodScroll} role="region" tabIndex={0} aria-label="Report-period timeline. Scroll horizontally for more periods."><ol className={s.periods}>{periods.map(period => {
      const count = filtered.filter(event => event.date === period.date).length;
      return <li key={period.date}><button type="button" aria-pressed={activeDate === period.date} aria-controls={detailId} onClick={() => choosePeriod(period.date)}><span className={s.node} data-events={count > 0 || undefined}/><time dateTime={period.date}>{dateLabel(period.date, true)}</time><span className={s.periodLabel}>{period.label || period.date}</span><span className={s.eventCount}>{count} {count === 1 ? 'change' : 'changes'}</span></button></li>;
    })}</ol></div>}
    <div className={s.eventGrid} aria-label={`${dateLabel(activeDate)} changes`}>{periodEvents.map(event => { const Icon = ICONS[event.category] || Activity; return <button key={event.id} type="button" aria-pressed={active?.id === event.id} aria-controls={detailId} onClick={() => setSelectedId(event.id)}><span className={s.eventCategory}><Icon size={14} aria-hidden="true"/>{event.categoryLabel || event.category}</span><span className={s.eventTitle}>{event.title}</span><strong>{event.kind === 'metric' ? numberLabel(event.delta, event.deltaFormat || (['pct', 'pp'].includes(event.format || '') ? 'pp' : event.format), true) : 'Passage differs'}{event.kind === 'metric' && finite(event.delta) && (event.delta < 0 ? <ArrowDownRight size={18} aria-hidden="true"/> : event.delta > 0 ? <ArrowUpRight size={18} aria-hidden="true"/> : null)}</strong></button>; })}</div>
    {!periodEvents.length && <div className={s.empty}>No supported timeline changes for this period{category !== 'all' ? ' and category' : ''}.</div>}
    {active && <div className={s.detail} id={detailId}><header className={s.detailHead}><div><span>{active.kind === 'metric' ? 'Financial comparison' : 'Filing passage comparison'}</span><h3>{active.title}</h3></div>{active.kind === 'metric' && <strong>{numberLabel(active.delta, active.deltaFormat || (['pct', 'pp'].includes(active.format || '') ? 'pp' : active.format), true)}</strong>}</header>
      {active.kind === 'metric' && <div className={s.barLegend}><span><i/>Before</span><ComparisonBars event={active}/><span>Current<i/></span></div>}
      <div className={s.evidenceGrid}><EvidenceSide side={active.before} event={active} label="Before"/><EvidenceSide side={active.after} event={active} label="Current"/></div>
      <div className={s.detailFoot}>{active.kind === 'metric' && active.metricId && onInspect && <button type="button" onClick={() => onInspect(active.metricId!)}><BookOpen size={14} aria-hidden="true"/>Metric explorer<ArrowUpRight size={13} aria-hidden="true"/></button>}<details><summary>Comparison basis & scope</summary>{active.criterion && <p>{typeof active.criterion === 'string' ? active.criterion : active.criterion.label}</p>}{active.scope && <p>{active.scope}</p>}{active.note && active.note !== active.scope && <p>{active.note}</p>}{active.kind === 'disclosure' && <p>These dated passages differ. Their wording alone does not establish a change in risk severity or resolution.</p>}{model.basis === 'ttm' && active.kind === 'metric' && !active.after.windowEnd && <p>TTM flows overlap. Period-end balances and annual or TTM flows retain their own source intervals.</p>}</details></div>
    </div>}
    <div className={s.disclosureState}>{disclosureMessage && <p role="status">{disclosureMessage}</p>}{disclosureCoverage}</div>
    <details className={s.method}><summary>Timeline criteria & coverage</summary>{model.coverage && <p>{model.coverage.comparablePairs ?? model.coverage.comparisons ?? 0} compatible measure comparisons{model.coverage.excludedPairs ? ` · ${model.coverage.excludedPairs} excluded comparisons` : ''}{model.coverage.cutoffExcludedPairs ? ` · ${model.coverage.cutoffExcludedPairs} excluded by filing cutoff` : ''}. Changes are selected by the stated criteria; this timeline is not a complete list of company risks.</p>}{model.gaps?.length ? <ul>{model.gaps.map(gap => <li key={gap.id}>{gap.label}{finite(gap.count) ? ` · ${gap.count}` : ''}</li>)}</ul> : null}{model.criteria?.length ? <ul>{model.criteria.map((criterion, index) => <li key={criterion.id || index}><strong>{criterion.label}</strong>{criterion.detail && <span> · {criterion.detail}</span>}</li>)}</ul> : null}{model.limitations?.map(note => <p key={note}>{note}</p>)}<p>Disclosure comparisons load only when requested. Missing passages and omitted topics do not indicate that a risk has been resolved.</p></details>
  </section>;
}
