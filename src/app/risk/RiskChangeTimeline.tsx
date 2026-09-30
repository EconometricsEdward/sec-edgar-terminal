'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, GitCompareArrows, Loader2 } from 'lucide-react';
import { disclosureWordDiff } from '../../utils/disclosureResearch.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { downloadRiskFile } from './riskDownload';
import s from './RiskChangeTimeline.module.css';

type Filing = { accession: string; form: string; reportDate: string; filingDate: string; url: string };
type Evidence = { filing: Filing; value?: number; sources?: any[]; formula?: string; text?: string; excerpted?: boolean; section?: string; window?: { start: string; end: string; basis: string; scheduleBasis: string } };
type Event = { id: string; topic: string; kind: string; level: string; title: string; label: string; date: string; delta?: number; percentChange?: number | null; before: Evidence; after: Evidence; note: string; basis: string; change?: string };
type Timeline = { ticker: string; status: string; mode: string; includeText: boolean; filings: Filing[]; events: Event[]; observations: any[]; coverage: { financial: any[]; text: any[]; documentsRead: number; historyLimited: boolean }; notices: string[] };
const TOPICS = [['cash', 'Cash & earnings'], ['refinancing', 'Debt & funding'], ['customers', 'Customer concentration'], ['covenants', 'Covenants'], ['collateral', 'Collateral']];
const cache = new Map<string, { data: Timeline; until: number }>(), pending = new Map<string, Promise<Timeline>>();
async function readTimeline(url: string) {
  const found = cache.get(url); if (found && found.until > Date.now()) return found.data;
  if (pending.has(url)) return pending.get(url)!;
  const task = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(55_000) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'The filing comparison could not be loaded.');
    if (data.status !== 'partial') {
      cache.delete(url); cache.set(url, { data, until: Date.now() + 300_000 });
      while (cache.size > 8) cache.delete(cache.keys().next().value!);
    }
    return data as Timeline;
  })().finally(() => pending.delete(url));
  pending.set(url, task); return task;
}
const money = (n?: number | null, signed = false) => n == null ? 'Unavailable' : formatRiskValue(n, 'usd', signed);
const dateLabel = (date: string) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
function AmountComparison({ event }: { event: Event }) {
  const before = event.before.value ?? 0, after = event.after.value ?? 0;
  const low = Math.min(0, before, after), high = Math.max(0, before, after), span = high - low || 1;
  const x = (n: number) => 10 + (n - low) / span * 470, zero = x(0);
  return <svg className={s.bars} viewBox="0 0 500 72" role="img" aria-label={`${event.label}: before ${money(before)}, after ${money(after)}`}>
    <line x1={zero} x2={zero} y1="4" y2="68" className={s.zero}/>
    <rect x={Math.min(zero, x(before))} y="8" width={Math.abs(x(before) - zero)} height="20" rx="3" className={s.beforeBar}/>
    <rect x={Math.min(zero, x(after))} y="44" width={Math.abs(x(after) - zero)} height="20" rx="3" className={s.afterBar}/>
  </svg>;
}
function TextEvidence({ event, side }: { event: Event; side: 'before' | 'after' }) {
  const parts = useMemo(() => disclosureWordDiff(event.before.text || '', event.after.text || ''), [event.before.text, event.after.text]);
  const evidence = event[side];
  if (!evidence.text) return <p className={s.missing}>No matched passage in this report. Check the original section.</p>;
  return <><p className={s.quote}>{parts.filter(part => side === 'before' ? part.kind !== 'added' : part.kind !== 'removed').map((part, i) => part.kind === 'same' ? <span key={i}>{part.text}</span> : <mark key={i} data-side={side}>{part.text}</mark>)}</p>{evidence.excerpted && <small>Excerpt · full passage in the SEC original</small>}</>;
}
function EvidenceCard({ event, side }: { event: Event; side: 'before' | 'after' }) {
  const evidence = event[side], filing = evidence.filing;
  return <article className={s.evidenceCard} aria-label={`${side === 'before' ? 'Before' : 'After'} filing evidence`}>
    <header><span>{side === 'before' ? 'Before' : 'After'}</span><strong>{filing.form} · {filing.reportDate}</strong><small>Filed {filing.filingDate}</small></header>
    {event.kind === 'financial' ? <><strong className={s.amount}>{money(evidence.value)}</strong><p className={s.formula}>{evidence.formula}</p>{evidence.window && <p className={s.formula}>Obligation window: {evidence.window.start} to {evidence.window.end}{evidence.window.basis === 'anniversary-estimate' && ' (fiscal anniversary estimate)'}</p>}<div className={s.inputs}>{evidence.sources?.map((source, i) => <div key={i}><span>{source.label || source.tag}<small>{source.start ? source.start + ' to ' : ''}{source.end} · filed {source.filed}</small><small>{source.tag} · {source.accession}</small></span><strong>{money(source.value)}</strong>{source.documentUrl && <a href={source.documentUrl} target="_blank" rel="noreferrer" aria-label={`SEC input ${source.tag}, ${source.end}`}>SEC<ArrowUpRight size={13}/></a>}{source.scopeNote && <details><summary>Input scope</summary><p>{source.scopeNote}</p></details>}</div>)}</div></> : <><small className={s.section}>{evidence.section}</small><TextEvidence event={event} side={side}/></>}
    <a className={s.sourceLink} href={filing.url} target="_blank" rel="noreferrer">Original filing<ArrowUpRight size={14}/></a><small className={s.accession}>{filing.accession}</small>
  </article>;
}
function exportTimeline(data: Timeline) {
  return `# ${data.ticker} — Changing risks\n\n${data.mode} reports; figures available by each original filing date.\n\n` + data.events.map(event => [
    `## ${event.date} — ${event.title}`, `${event.basis} · ${event.kind === 'financial' ? money(event.delta, true) : 'Disclosure review'}`,
    `Before: ${event.before.filing.form} ${event.before.filing.reportDate}, filed ${event.before.filing.filingDate}\n${event.before.value != null ? money(event.before.value) : event.before.text || 'No matched passage'}\n${event.before.filing.url}`,
    ...(event.before.sources || []).map(source => `- ${source.tag}: ${source.value} ${source.unit}; ${source.start || 'instant'} to ${source.end}; filed ${source.filed}; ${source.documentUrl}`),
    `After: ${event.after.filing.form} ${event.after.filing.reportDate}, filed ${event.after.filing.filingDate}\n${event.after.value != null ? money(event.after.value) : event.after.text || 'No matched passage'}\n${event.after.filing.url}`,
    ...(event.after.sources || []).map(source => `- ${source.tag}: ${source.value} ${source.unit}; ${source.start || 'instant'} to ${source.end}; filed ${source.filed}; ${source.documentUrl}`), event.note,
  ].join('\n\n')).join('\n\n') + '\n\n' + data.notices.join('\n');
}

export default function RiskChangeTimeline({ ticker }: { ticker: string }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false), [mode, setMode] = useState('annual'), [includeText, setIncludeText] = useState(false);
  const [data, setData] = useState<Timeline | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(''), [topic, setTopic] = useState('all'), [view, setView] = useState('all');
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '200px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true; setLoading(true); setError('');
    const url = `/api/risk/timeline?ticker=${encodeURIComponent(ticker)}&mode=${mode}${includeText ? '&include=text' : ''}`;
    readTimeline(url).then(body => { if (active) setData(body); }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ticker, mode, includeText, visible, retry]);
  const current = data?.ticker === ticker && data.mode === mode ? data : null;
  const events = current?.events.filter(event => (topic === 'all' || event.topic === topic) && (view === 'all' || event.kind === view)) || [];
  const event = events.find(item => item.id === selected) || events[0];
  const topics = topic === 'all' ? TOPICS : TOPICS.filter(([id]) => id === topic);
  function changeMode(next: string) { setMode(next); setSelected(''); }
  function loadText() { setIncludeText(true); setView('all'); }
  return <section id="risk-change-timeline" ref={ref} className={s.shell} aria-labelledby="risk-change-title">
    <header className={s.heading}><div><span className={s.eyebrow}><GitCompareArrows size={15}/> Across filings</span><h2 id="risk-change-title">Changing risks</h2></div><div className={s.tools}><div className={s.segmented} aria-label="Timeline report type">{[['annual', 'Annual'], ['quarterly', 'Quarterly']].map(([id, label]) => <button key={id} aria-pressed={mode === id} onClick={() => changeMode(id)}>{label}</button>)}</div>{current && <button className={s.export} onClick={() => downloadRiskFile(`${ticker}-risk-changes-${mode}.md`, exportTimeline(current))}><ArrowDownToLine size={15}/>Export</button>}</div></header>
    <div className={s.toolbar}><nav aria-label="Risk change filters">{[['all', 'All changes'], ['financial', 'Reported amounts'], ['disclosure', 'Filing text']].map(([id, label]) => <button key={id} aria-pressed={view === id} onClick={() => { setView(id); if (id === 'disclosure') setIncludeText(true); }}>{label}</button>)}</nav><label>Risk driver<select aria-label="Filter timeline by risk driver" value={topic} onChange={e => setTopic(e.target.value)}><option value="all">All drivers</option>{TOPICS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div>
    {loading && <div className={s.state} role="status"><Loader2 size={16} className={s.spin}/>{includeText ? 'Comparing filing passages…' : 'Comparing original reported amounts…'}</div>}
    {error && <div className={s.state} role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
    {!visible && <div className={s.state}>Filing comparisons load as you reach this timeline.</div>}
    {current && <>
      <div className={s.meta}><span><strong>{current.filings.length}</strong> original reports</span><span><strong>{events.length}</strong> shifts{current.status === 'partial' ? ' · partial coverage' : ''}</span><div className={s.legend}><span data-level="weakening">Cash / earnings decline</span><span data-level="improving">Cash / earnings rise</span><span data-level="context">Contextual change</span><span data-level="review">Text review</span></div></div>
      <div className={s.timelineScroll} tabIndex={0} role="region" aria-label="Risk change timeline. Scroll horizontally on smaller screens."><div className={s.timeline} style={{ gridTemplateColumns: `170px repeat(${Math.max(current.filings.length, 1)}, minmax(120px, 1fr))` }}>
        <div className={s.axisLabel}>Reporting date</div>{current.filings.map(filing => <div key={filing.accession} className={s.date}><strong>{dateLabel(filing.reportDate)}</strong><time dateTime={filing.reportDate}>{filing.reportDate}</time><small>{filing.form}</small></div>)}
        {topics.map(([id, label]) => <div key={id} className={s.lane}><div className={s.laneLabel}>{label}</div>{current.filings.map((filing, index) => {
          const matches = events.filter(item => item.topic === id && item.after.filing.accession === filing.accession);
          const active = matches.some(item => item.id === event?.id);
          const level = matches.some(item => item.level === 'weakening') ? 'weakening' : matches[0]?.level;
          const textPending = ['customers', 'covenants', 'collateral'].includes(id) && !current.includeText;
          const unavailable = current.coverage.financial.some(row => row.topic === id && row.current === filing.accession && row.status === 'unavailable')
            || current.coverage.text.some(row => row.accession === filing.accession && row.status === 'unavailable'
              || row.topic === id && row.current === filing.accession && ['missing', 'uncompared', 'unavailable'].includes(row.status));
          return <div key={filing.accession} className={s.cell} data-active={active || undefined}><span className={s.track}/>{matches.length ? <button className={s.marker} data-level={level} aria-pressed={active} aria-label={`${label}, ${filing.reportDate}, ${matches.length} change${matches.length === 1 ? '' : 's'}. ${matches[0].title}`} title={matches.map(item => item.title).join('; ')} onClick={() => setSelected(matches[0].id)}><span>{matches.length}</span><small>{matches[0].kind === 'financial' ? money(matches[0].delta, true) : matches[0].change === 'revised' ? 'Changed' : 'Unmatched'}</small></button> : <span className={s.noMarker} title={index === 0 ? 'Baseline report' : textPending ? 'Open filing text to compare this driver' : unavailable ? 'Comparison unavailable' : 'No screened change in inspected evidence'}>{index === 0 ? 'Baseline' : textPending ? 'Text' : unavailable ? 'N/A' : '—'}</span>}</div>;
        })}</div>)}
      </div></div>
      {!current.includeText && <div className={s.textPrompt}><span>Customers · covenants · collateral</span><button disabled={loading} onClick={loadText}><GitCompareArrows size={15}/>Compare filing text</button></div>}
      {events.length > 0 && <div className={s.eventStrip} aria-label="Individual risk changes">{events.map(item => <button key={item.id} aria-pressed={item.id === event?.id} data-level={item.level} onClick={() => setSelected(item.id)}><span>{dateLabel(item.date)}</span><strong>{item.title}</strong><small>{item.kind === 'financial' ? money(item.delta, true) : 'Compare wording'}</small></button>)}</div>}
      {event ? <div className={s.detail} aria-label="Selected change evidence"><div className={s.detailHeading}><div><span className={s.badge} data-level={event.level}>{event.kind === 'financial' ? event.basis : 'Disclosure review'}</span><h3>{event.title}</h3></div>{event.kind === 'financial' && <div className={s.delta}><strong>{money(event.delta, true)}</strong>{event.percentChange != null && <span>{event.percentChange > 0 ? '+' : ''}{event.percentChange.toFixed(1)}%</span>}</div>}</div>
        {event.kind === 'financial' && <AmountComparison event={event}/>}
        <div className={s.evidence}><EvidenceCard event={event} side="before"/><EvidenceCard event={event} side="after"/></div><p className={s.note}>{event.note}</p>
      </div> : !loading && <div className={s.empty}>{current.filings.length < 2 ? 'Comparable original filings unavailable.' : view === 'disclosure' && !current.includeText ? 'Open filing text to compare disclosure changes.' : 'No screened changes in the selected evidence.'}<small>Missing inputs and unmatched passages do not establish an absence of risk.</small></div>}
      <details className={s.method}><summary>Coverage & comparison rules</summary><p>Up to four original reports of the same form; amendments stay in the filing reader. Figures use compatible USD inputs available by each filing date. Quarter flows are standalone quarters and can vary seasonally. Markers screen changes of at least 15%, moves from zero, or a sign change; they are research prompts, not credit ratings. Current debt is a balance-sheet measure, not a debt-maturity calendar.</p><p>Filing text compares up to 64 relevant prose passages per driver and report, including recognized financial notes. Up to three matched revisions per driver and report pair appear. Rolling reporting-date wording is suppressed; contract dates remain significant. Unmatched language and missing mentions remain coverage gaps. Concentration percentages may use different benchmarks or anonymous customers. Negation remains visible. Highlighted text is approximate; check the originals.</p>
        {current.notices.map(notice => <p key={notice}>{notice}</p>)}{current.coverage.historyLimited && <p>Filing history is limited to the inspected recent feed and up to two archived manifests.</p>}
        <div className={s.coverageTable}><table><caption>Inspected comparisons</caption><thead><tr><th>Driver</th><th>Comparison</th><th>Coverage</th></tr></thead><tbody>{[...current.coverage.financial, ...current.coverage.text].map((row, i) => <tr key={i}><td>{TOPICS.find(([id]) => id === row.topic)?.[1] || 'Filing text'}</td><td>{row.current || row.accession}<small>{row.prior}</small></td><td>{row.status}{row.reason && <small>{row.reason}</small>}{row.truncated && <small>Passage limit reached</small>}{row.currentMatches != null && <small>{row.priorMatches} → {row.currentMatches} matches</small>}</td></tr>)}</tbody></table></div>
      </details>
      {current.status === 'partial' && <button className={s.retry} onClick={() => setRetry(n => n + 1)}>Retry incomplete sources</button>}
    </>}
  </section>;
}
