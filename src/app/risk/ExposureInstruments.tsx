'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { buildExposureInstrumentGroups, compactInstrumentLabel } from '../../utils/exposureInstruments.js';
import s from './ExposureInstruments.module.css';

type Fact = { value: number; start?: string; end: string; contextId: string; factId?: string; sourceUrl: string; tag: string };
type Row = { id: string; kind: string; category: string; label: string; unit: string; dimensions: { axis: string; member: string; label: string }[]; current: Fact; prior: Fact | null };
type Notes = { status: string; ticker: string; checkedAt: string; filing?: { form: string; filed: string; reportDate: string; accession: string; url: string }; rows: Row[]; limitations?: string[]; message?: string };
type Balance = { id: string; label: string; rows: Row[] };
type Group = { id: string; label: string; description: string; kind: string; rows: Row[]; balances?: Balance[] };
type Props = { ticker: string; basis?: string; asOf?: string };

const cache = new Map<string, { data: Notes; expires: number }>();
const PAGE_SIZE = 4;
const formatValue = (row: Row, value: number) => formatRiskValue(value, row.unit === 'pure' ? 'pct' : 'usd');
const exactValue = (row: Row, value: number, change = false) => `${change && value > 0 ? '+' : ''}${(row.unit === 'pure' ? value * 100 : value).toLocaleString('en-US', { maximumFractionDigits: 8 })}${row.unit === 'pure' ? change ? ' pp' : '%' : ' USD'}`;
const dates = (fact: Fact) => fact.start ? `${fact.start} → ${fact.end}` : fact.end;
const changeLabel = (row: Row) => {
  if (!row.prior) return 'Unavailable';
  const delta = row.current.value - row.prior.value;
  if (!delta) return 'Unchanged';
  return `${delta > 0 ? '+' : '−'}${row.unit === 'pure' ? `${Math.abs(delta * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} pp` : formatValue(row, Math.abs(delta))}`;
};

function ComparisonChart({ rows, concentration, balanceLabel }: { rows: Row[]; concentration: boolean; balanceLabel?: string }) {
  const [page, setPage] = useState(0);
  const [pinnedId, setPinnedId] = useState('');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const controls = useRef<Record<string, HTMLButtonElement | null>>({});
  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selected = pageRows.find(row => row.id === inspectedId) || pageRows.find(row => row.id === pinnedId) || pageRows[0];
  const maximum = concentration ? 1 : Math.max(1, ...rows.flatMap(row => [row.current.value, row.prior?.value ?? 0]));
  if (!selected) return null;
  const selectPage = (next: number) => { setPage(next); setInspectedId(null); setPinnedId(''); };
  return <>
    <div className={s.chartHeader}>
      <div className={s.legend}><span><i className={s.currentKey}/>Current in filing</span><span><i className={s.priorKey}/>Prior in filing</span></div>
      <span className={s.scaleLabel}>{concentration ? `Share of ${balanceLabel?.toLowerCase() || 'reported credit balance'}` : 'Contract notional · USD'}</span>
    </div>
    <div className={s.chart} role="group" aria-label={concentration ? `${balanceLabel || 'Credit balance'} concentration comparison` : 'Derivative notional comparison'}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setInspectedId(null); }}>
      {pageRows.map((row, index) => {
        const label = concentration ? row.dimensions.filter(dimension => !/ConcentrationRiskBy(?:Benchmark|Type)Axis$/.test(dimension.axis)).map(dimension => dimension.label).join(' · ') || row.label : compactInstrumentLabel(row);
        return <button key={row.id} type="button" ref={node => { controls.current[row.id] = node; }} className={`${s.chartRow} ${selected.id === row.id ? s.activeRow : ''}`}
          aria-label={`${row.label}. ${dates(row.current)}: ${exactValue(row, row.current.value)}.${row.prior ? ` ${dates(row.prior)}: ${exactValue(row, row.prior.value)}. Change: ${exactValue(row, row.current.value - row.prior.value, true)}.` : ' Prior comparison unavailable.'}`}
          aria-pressed={pinnedId === row.id}
          onPointerEnter={event => { if (event.pointerType === 'mouse') setInspectedId(row.id); }}
          onFocus={() => setInspectedId(row.id)} onBlur={() => setInspectedId(null)}
          onClick={() => { setPinnedId(row.id); setInspectedId(row.id); }}
          onKeyDown={event => {
            let next = index;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(pageRows.length - 1, index + 1);
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, index - 1);
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = pageRows.length - 1;
            else if (event.key === 'Escape') { event.preventDefault(); setInspectedId(null); return; }
            else return;
            event.preventDefault(); controls.current[pageRows[next].id]?.focus();
          }}>
          <span className={s.rowLabel} title={label}>{label}</span>
          <span className={s.barTrack} aria-hidden="true">
            <span className={s.currentBar} style={{ width: `${row.current.value / maximum * 100}%` }}/>
            {row.prior && <span className={s.priorBar} style={{ width: `${row.prior.value / maximum * 100}%` }}/>}
          </span>
          <span className={s.rowValue}>{formatValue(row, row.current.value)}<small>{row.prior ? formatValue(row, row.prior.value) : 'No prior'}</small></span>
        </button>;
      })}
      <div className={s.axis} aria-hidden="true"><span>{concentration ? '0%' : '$0'}</span><span>{concentration ? '50%' : formatValue(rows[0], maximum / 2)}</span><span>{concentration ? '100%' : formatValue(rows[0], maximum)}</span></div>
    </div>
    <div className={s.chartFooter}><span>Hover or select a measure to inspect. Arrow keys move between measures.</span>{totalPages > 1 && <div className={s.pagination}><button type="button" onClick={() => selectPage(page - 1)} disabled={!page} aria-label="Previous instrument measures"><ChevronLeft size={17}/></button><span>{page * PAGE_SIZE + 1}–{Math.min(rows.length, (page + 1) * PAGE_SIZE)} of {rows.length}</span><button type="button" onClick={() => selectPage(page + 1)} disabled={page === totalPages - 1} aria-label="Next instrument measures"><ChevronRight size={17}/></button></div>}</div>
    <div className={s.readout} aria-live="polite" aria-atomic="true">
      <div className={s.readoutHeading}><span>Selected measure</span><a href={selected.current.sourceUrl} target="_blank" rel="noreferrer">{compactInstrumentLabel(selected)}<ArrowUpRight size={15}/></a></div>
      <dl className={s.readoutValues}>
        <div><dt>{dates(selected.current)}</dt><dd title={exactValue(selected, selected.current.value)}>{formatValue(selected, selected.current.value)}</dd><small>{exactValue(selected, selected.current.value)}</small></div>
        <div><dt>{selected.prior ? dates(selected.prior) : 'Prior observation'}</dt><dd title={selected.prior ? exactValue(selected, selected.prior.value) : undefined}>{selected.prior ? formatValue(selected, selected.prior.value) : '—'}</dd><small>{selected.prior ? exactValue(selected, selected.prior.value) : 'No matching comparison'}</small></div>
        <div><dt>{concentration ? 'Share change' : 'Notional change'}</dt><dd>{changeLabel(selected)}</dd><small>{selected.prior ? 'Matching concept and dimensions' : 'Unavailable for this measure'}</small></div>
      </dl>
    </div>
  </>;
}

function GroupView({ group }: { group: Group }) {
  const [balanceId, setBalanceId] = useState('');
  const balance = group.balances?.find(item => item.id === balanceId) || group.balances?.[0];
  const rows = balance?.rows || group.rows;
  return <>
    <div className={s.groupHeading}><div><h3>{group.label}</h3><p>{group.description}</p></div>{group.balances && group.balances.length > 1 && <label className={s.balanceSelect}>Credit balance<select value={balance?.id} onChange={event => setBalanceId(event.target.value)}>{group.balances.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}</div>
    <ComparisonChart key={balance?.id || group.id} rows={rows} concentration={group.kind === 'concentration'} balanceLabel={balance?.label}/>
    <p className={s.interpretation}>{group.kind === 'concentration' ? 'Each share uses the named credit balance. Counterparties and groups may overlap; shares are not added together.' : 'Notional measures contract scale, not potential loss or net exposure. Totals, components and hedge designations may overlap.'}</p>
  </>;
}

function EvidenceTable({ rows }: { rows: Row[] }) {
  return <details className={s.details}><summary>All tagged observations <span>{rows.length}</span></summary><div className={s.tableScroll}><table><caption>Exact reported values and SEC context dates. Each row remains a separate measure.</caption><thead><tr><th>Measure</th><th>Current</th><th>Prior</th><th>Change</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row"><a href={row.current.sourceUrl} target="_blank" rel="noreferrer">{compactInstrumentLabel(row)} <ArrowUpRight size={13}/></a><small>{row.current.tag}</small></th><td>{exactValue(row, row.current.value)}<small>{dates(row.current)}</small></td><td>{row.prior ? <>{exactValue(row, row.prior.value)}<small>{dates(row.prior)}</small></> : 'Unavailable'}</td><td>{row.prior ? exactValue(row, row.current.value - row.prior.value, true) : '—'}</td></tr>)}</tbody></table></div></details>;
}

export default function ExposureInstruments({ ticker, basis = 'ttm', asOf = '' }: Props) {
  return <Instruments key={`${ticker}:${basis}:${asOf}`} ticker={ticker} basis={basis} asOf={asOf}/>;
}

function Instruments({ ticker, basis = 'ttm', asOf = '' }: Props) {
  const root = useRef<HTMLElement>(null);
  const key = `${ticker}:${basis}:${asOf}`;
  const [visible, setVisible] = useState(false);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<Notes | null>(() => { const saved = cache.get(key); return saved && saved.expires > Date.now() ? saved.data : null; });
  const [error, setError] = useState('');
  const [groupId, setGroupId] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '400px' });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const saved = cache.get(key);
    if (!retry && saved && saved.expires > Date.now()) { setData(saved.data); return; }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(new Error('The SEC filing notes took too long to load. Please retry.')), 55_000);
    setError('');
    const params = new URLSearchParams({ ticker, basis });
    if (asOf) params.set('asOf', asOf);
    fetch(`/api/risk/notes?${params}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rows) || body.ticker !== ticker || body.status === 'unavailable') throw new Error(body.message || body.error || 'The SEC filing notes could not be loaded.');
      return body as Notes;
    }).then(body => {
      if (controller.signal.aborted) return;
      if (cache.size >= 12) cache.delete(cache.keys().next().value!);
      cache.set(key, { data: body, expires: Date.now() + 60_000 });
      setData(body);
    }).catch(cause => {
      if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError(cause.message || 'The SEC filing notes could not be loaded.');
    }).finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [ticker, basis, asOf, key, retry, visible]);
  const groups = useMemo(() => buildExposureInstrumentGroups(data?.rows || []) as Group[], [data]);
  const activeGroup = groups.find(group => group.id === groupId) || groups[0];
  const rows = useMemo(() => groups.flatMap(group => group.rows), [groups]);
  return <section ref={root} className={s.section} aria-label="Reported instruments and credit concentrations">
    <div className={s.heading}><div><span className={s.eyebrow}>SEC filing notes</span><h2>Instruments & counterparties</h2><p>Compare {ticker}’s reported contract amounts and credit concentrations.</p></div>{data?.filing && <a className={s.filingLink} href={data.filing.url} target="_blank" rel="noreferrer">{data.filing.form} · {data.filing.reportDate}<ArrowUpRight size={15}/></a>}</div>
    {!data && !error && <p className={s.state} role="status">Loading the company’s tagged filing notes…</p>}
    {error && <div className={s.state} role="status"><p>{error}</p><button type="button" onClick={() => { cache.delete(key); setRetry(value => value + 1); }}><RefreshCw size={15}/>Retry filing notes</button></div>}
    {data && <>
      {groups.length > 0 ? <>
        <div className={s.groups} role="group" aria-label="Instrument or concentration view">{groups.map(group => <button type="button" key={group.id} aria-pressed={activeGroup.id === group.id} onClick={() => setGroupId(group.id)}>{group.label}<span>{group.rows.length}</span></button>)}</div>
        <GroupView key={activeGroup.id} group={activeGroup}/>
        <EvidenceTable rows={rows}/>
      </> : <p className={s.state}>No supported tagged amounts were found in this filing. Open the SEC notes for other disclosed exposures.</p>}
      <details className={s.details}><summary>Source coverage & interpretation</summary><p>Supported standard USD derivative notionals and credit-concentration percentages from one filing. Missing amounts do not establish zero exposure.</p>{data.limitations?.map(note => <p key={note}>{note}</p>)}{data.filing && <p>Filed {data.filing.filed} · SEC accession {data.filing.accession} · Checked {data.checkedAt?.slice(0, 10)}</p>}</details>
    </>}
  </section>;
}
