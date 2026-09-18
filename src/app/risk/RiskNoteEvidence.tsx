'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import s from './RiskNoteEvidence.module.css';

type Fact = { value: number; start?: string; end: string; contextId: string; factId?: string; sourceUrl: string; tag: string };
type Row = { id: string; kind: string; category: string; label: string; unit: string; dimensions: { axis: string; member: string; label: string }[]; current: Fact; prior: Fact | null };
type Notes = { status: string; ticker: string; companyName?: string; checkedAt: string; filing?: { form: string; filed: string; reportDate: string; accession: string; url: string }; rows: Row[]; limitations?: string[]; message?: string };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const valueLabel = (row: Row, value: number) => formatRiskValue(value, row.unit === 'pure' ? 'pct' : 'usd');
const exactValue = (row: Row, value: number, delta = false) => `${delta && value > 0 ? '+' : ''}${(row.unit === 'pure' ? value*100 : value).toLocaleString('en-US',{maximumFractionDigits:8})}${row.unit === 'pure' ? delta ? ' pp' : '%' : ' USD'}`;
const contextDates = (fact: Fact) => fact.start ? `${fact.start} → ${fact.end}` : fact.end;

function ComparisonPlot({ rows, concentration = false }: { rows: Row[]; concentration?: boolean }) {
  const maximum = concentration ? 1 : Math.max(...rows.flatMap(row => [row.current.value, row.prior?.value ?? 0]), 1);
  const x = (value: number) => 40 + value / maximum * 580;
  const height = rows.length * 93 + 37;
  return <div className={s.chartScroll} role="region" tabIndex={0} aria-label={`${concentration ? 'Credit concentration' : 'Derivative notional'} comparison chart; scroll horizontally on small screens`}><svg className={s.chart} viewBox={`0 0 700 ${height}`} role="img" aria-label={`${concentration ? 'Credit concentration' : 'Derivative notional'} comparisons. Filled dots show the reporting date; outlined dots show the prior date. Exact values and dates are in the table below.`}>
    {[0,.25,.5,.75,1].map(fraction => <g key={fraction}><line x1={x(maximum*fraction)} x2={x(maximum*fraction)} y1={8} y2={height-28} className={s.grid}/><text x={x(maximum*fraction)} y={height-8} textAnchor="middle" className={s.axis}>{formatRiskValue(maximum*fraction, concentration ? 'pct' : 'usd')}</text></g>)}
    {rows.map((row,index) => { const y = index*93+30; return <g key={row.id}>
      <text x={40} y={y} className={s.rowLabel}>{row.label}</text>
      <line x1={40} x2={620} y1={y+29} y2={y+29} className={s.track}/>
      {row.prior && <><line x1={x(row.prior.value)} x2={x(row.current.value)} y1={y+29} y2={y+29} className={s.connector}/><circle cx={x(row.prior.value)} cy={y+29} r={6} className={s.prior}><title>{row.prior.end}: {valueLabel(row,row.prior.value)}</title></circle></>}
      <circle cx={x(row.current.value)} cy={y+29} r={5} className={s.current}><title>{row.current.end}: {valueLabel(row,row.current.value)}</title></circle>
      <text x={686} y={y+33} textAnchor="end" className={s.value}>{valueLabel(row,row.current.value)}</text>
    </g>; })}
  </svg></div>;
}

function EvidenceTable({ rows }: { rows: Row[] }) {
  return <details className={s.details}><summary>Exact values, dates & SEC tags ({rows.length})</summary><div className={s.tableScroll}><table><caption>Comparisons use matching tags and dimensions within the same SEC filing. Full SEC context dates are preserved.</caption><thead><tr><th>Reported measure</th><th>Current observation</th><th>Prior observation</th><th>Change</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row"><a href={row.current.sourceUrl} target="_blank" rel="noreferrer">{row.label}<ArrowUpRight size={12}/></a><small>{row.current.tag}</small></th><td>{exactValue(row,row.current.value)}<small>{contextDates(row.current)}</small></td><td>{row.prior ? <>{exactValue(row,row.prior.value)}<small>{contextDates(row.prior)}</small></> : 'Not reported'}</td><td>{row.prior ? exactValue(row,row.current.value-row.prior.value,true) : '—'}</td></tr>)}</tbody></table></div><p>Concentration groups may overlap. Derivative notionals describe contract scale; they are not fair values, net currency exposure, or potential losses.</p></details>;
}

export default function RiskNoteEvidence({ ticker, basis = 'ttm', asOf = '' }: { ticker: string; basis?: string; asOf?: string }) {
  return <NoteEvidence key={`${ticker}:${basis}:${asOf}`} ticker={ticker} basis={basis} asOf={asOf}/>;
}

function NoteEvidence({ ticker, basis, asOf }: { ticker: string; basis: string; asOf: string }) {
  const root = useRef<HTMLElement>(null);
  const [visible,setVisible] = useState(false), [retry,setRetry] = useState(0);
  const [data,setData] = useState<Notes|null>(null), [error,setError] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, {rootMargin:'500px'});
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(); setData(null); setError('');
    const params = new URLSearchParams({ticker,basis}); if (asOf) params.set('asOf',asOf);
    fetch(`/api/risk/notes?${params}`,{signal:controller.signal}).then(async response => {
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.rows) || body.ticker !== ticker || body.status === 'unavailable') throw new Error(body.message || body.error || 'The filing notes could not be loaded.');
      return body as Notes;
    }).then(body => { if (!controller.signal.aborted) setData(body); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  },[ticker,basis,asOf,retry,visible]);
  const rows = (data?.rows || []).filter(row => finite(row.current?.value) && row.current.value >= 0 && (!row.prior || finite(row.prior.value)));
  const derivatives = rows.filter(row => row.kind === 'derivative_notional' && row.unit === 'USD');
  const concentrations = rows.filter(row => row.kind === 'credit_concentration' && row.unit === 'pure' && row.current.value <= 1 && (!row.prior || row.prior.value <= 1));
  return <section ref={root} className={s.section} aria-label="Credit and currency disclosures">
    <div className={s.heading}><div><span className={s.kicker}>INSIDE THE FILING NOTES</span><h2>Credit exposure. Currency exposure.</h2><p>Read the concentrations and financial instruments behind the ratios.</p></div>{data?.filing && <a className={s.sourceLink} href={data.filing.url} target="_blank" rel="noreferrer">{data.filing.form} · {data.filing.reportDate}<ArrowUpRight size={14}/></a>}</div>
    {!data && !error && <p className={s.state} role="status">{visible ? 'Reading the filing’s tagged risk disclosures…' : 'Filing-note comparisons load as you reach this section.'}</p>}
    {error && <div className={s.state} role="status"><p>{error}</p><button onClick={() => setRetry(n => n+1)}><RefreshCw size={13}/>Retry filing notes</button></div>}
    {data && <>
      <div className={s.legend}><span><i/>Reporting date</span><span><i/>Prior date in this filing</span>{data.filing && <span>Filed {data.filing.filed}</span>}</div>
      <div className={s.visuals}>
        <div><h3>Currency & rate contracts</h3><p className={s.description}>Reported derivative notionals, compared on a common dollar scale. Accounting designation does not establish how much exposure is hedged.</p>{derivatives.length ? <ComparisonPlot rows={derivatives.slice(0,8)}/> : <p className={s.state}>No supported notional facts were identified. Review the filing’s currency and derivatives notes; this does not establish zero exposure.</p>}</div>
        <div><h3>Where credit is concentrated</h3><p className={s.description}>Reported shares of receivables or other specified credit balances. Each measure retains its own denominator; groups are not added together.</p>{concentrations.length ? <ComparisonPlot rows={concentrations.slice(0,8)} concentration/> : <p className={s.state}>No supported concentration percentages were identified. Credit risk also includes customers, counterparties and investments outside these tagged measures.</p>}</div>
      </div>
      {(derivatives.length > 8 || concentrations.length > 8) && <p className={s.description}>Charts show the first eight measures in each group. All identified observations appear below.</p>}
      {rows.length > 0 && <EvidenceTable rows={rows}/>}
      <details className={s.details}><summary>Coverage & interpretation</summary><p>This reads supported numeric facts and dimensions from one eligible filing. Missing tags and unsupported note formats remain gaps. It does not calculate a credit rating or infer the company’s CFTC positions.</p>{data.limitations?.map(note => <p key={note}>{note}</p>)}{data.filing && <p>SEC accession {data.filing.accession} · Checked {data.checkedAt?.slice(0,10)}</p>}</details>
    </>}
  </section>;
}
