'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import { matchesRiskNoteResponse } from '../../utils/riskNoteResponse.js';
import s from './RiskNoteEvidence.module.css';

type Fact = { value: number; start?: string; end: string; contextId: string; factId?: string; sourceUrl: string; tag: string };
type Row = { id: string; kind: string; category: string; label: string; unit: string; dimensions: { axis: string; member: string; label: string }[]; current: Fact; prior: Fact | null };
type Notes = { status: string; ticker: string; companyName?: string; checkedAt: string; filing?: { form: string; filed: string; reportDate: string; accession: string; url: string }; rows: Row[]; limitations?: string[]; message?: string };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const valueLabel = (row: Row, value: number) => formatRiskValue(value, row.unit === 'pure' ? 'pct' : 'usd');
const exactValue = (row: Row, value: number, delta = false) => `${delta && value > 0 ? '+' : ''}${(row.unit === 'pure' ? value*100 : value).toLocaleString('en-US',{maximumFractionDigits:8})}${row.unit === 'pure' ? delta ? ' pp' : '%' : ' USD'}`;
const contextDates = (fact: Fact) => fact.start ? `${fact.start} → ${fact.end}` : fact.end;

const deltaLabel = (row: Row) => {
  if (!row.prior) return 'Prior comparison unavailable';
  const delta = row.current.value - row.prior.value;
  const value = row.unit === 'pure'
    ? `${Math.abs(delta * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} pp`
    : valueLabel(row, Math.abs(delta));
  return delta === 0 ? 'Unchanged' : `${delta > 0 ? '+' : '−'}${value}`;
};

function SourceLabel({ row, label }: { row: Row; label: string }) {
  return <a className={s.measureLink} href={row.current.sourceUrl} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={13} aria-hidden="true"/><span className={s.srOnly}> — {row.label}, SEC source</span></a>;
}

function CreditConcentrations({ rows }: { rows: Row[] }) {
  const groups = new Map<string, { label: string; rows: Row[] }>();
  rows.forEach(row => {
    const benchmark = row.dimensions.find(dimension => /ConcentrationRiskByBenchmarkAxis$/.test(dimension.axis));
    const key = benchmark?.member || row.id;
    if (!groups.has(key)) groups.set(key, { label: benchmark?.label || 'Reported credit balance', rows: [] });
    groups.get(key)!.rows.push(row);
  });
  return <div className={s.riskBlock}>
    <div className={s.blockIntro}><span className={s.sectionNumber}>01 / CREDIT EXPOSURE</span><h3>Who pays matters.</h3><p>Collection delays or counterparty losses can reduce the cash available to meet financial obligations.</p><p className={s.interpretation}>These shares show where reported credit balances are concentrated. They do not estimate default probabilities or expected losses.</p></div>
    <div className={s.creditGroups}>
      <div className={s.legend}><span><i className={s.currentKey}/>Reported share</span><span><i className={s.priorKey}/>Prior share in this filing</span></div>
      {[...groups.entries()].map(([key, group]) => <div key={key} className={s.creditGroup}>
        <div className={s.groupHeading}><h4>{group.label}</h4><span>Share of this balance</span></div>
        {group.rows.map(row => {
          const label = row.dimensions.filter(dimension => !/ConcentrationRiskBy(?:Benchmark|Type)Axis$/.test(dimension.axis)).map(dimension => dimension.label).join(' · ') || row.label;
          return <div key={row.id} className={s.concentrationRow}>
            <div className={s.measureHeading}><SourceLabel row={row} label={label}/><div className={s.measureValue}><strong>{valueLabel(row, row.current.value)}</strong><span>{deltaLabel(row)}</span></div></div>
            <div className={s.concentrationTrack} aria-hidden="true"><div className={s.concentrationFill} style={{ width: `${row.current.value * 100}%` }}/>{row.prior && <i className={s.priorMarker} style={{ left: `${row.prior.value * 100}%` }}/>}</div>
            <div className={s.observationDates}><span>{row.current.end}</span><span>{row.prior ? `${valueLabel(row, row.prior.value)} at ${row.prior.end}` : 'No matching prior observation'}</span></div>
          </div>;
        })}
        <div className={s.percentAxis} aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
      </div>)}
      <p className={s.chartFootnote}>Each track uses the named balance as its denominator. Groups can overlap and are never added together.</p>
    </div>
  </div>;
}

const instrumentCopy: Record<string, { label: string; description: string }> = {
  foreign_exchange: { label: 'Currency instruments', description: 'Exchange rates can change the value of foreign-currency cash flows and balances. Contract amounts provide context for the company’s risk management.' },
  interest_rate: { label: 'Interest-rate instruments', description: 'Rates can affect borrowing costs and investment values. These contract amounts describe instruments the company reports in its derivatives note.' },
  other_derivative: { label: 'Other derivatives', description: 'Read the underlying instrument and its purpose alongside the company’s operating, investment and funding exposures.' },
};

function MarketInstruments({ rows }: { rows: Row[] }) {
  const maximum = Math.max(...rows.flatMap(row => [row.current.value, row.prior?.value ?? 0]), 1);
  const categories = [...new Set(rows.map(row => row.category))];
  return <div className={s.marketBlock}>
    <div className={s.marketHeading}><div><span className={s.sectionNumber}>02 / CURRENCY & RATE EXPOSURE</span><h3>The instruments behind market risk.</h3></div><p>Current and prior contract notionals on the same dollar scale. A larger bar means a larger contract reference amount.</p></div>
    {categories.map(category => {
      const copy = instrumentCopy[category] || instrumentCopy.other_derivative;
      return <div key={category} className={s.instrumentGroup}>
        <div className={s.instrumentIntro}><h4>{copy.label}</h4><p>{copy.description}</p></div>
        <div className={s.instrumentRows}>{rows.filter(row => row.category === category).map(row => <div key={row.id} className={s.instrumentRow}>
          <div className={s.measureHeading}><SourceLabel row={row} label={category === 'other_derivative' ? row.label : row.label.split(' · ').slice(1).join(' · ') || row.label}/><div className={s.measureValue}><strong>{valueLabel(row, row.current.value)}</strong><span>{deltaLabel(row)}{row.prior && row.current.value !== row.prior.value ? ' change in notional' : ''}</span></div></div>
          <div className={s.pairedBars}>
            <div className={s.barObservation}><span className={s.barDate}>{row.current.end}</span><div className={s.barArea} aria-hidden="true"><div className={s.currentBar} style={{ width: `${row.current.value / maximum * 100}%` }}/></div><span className={s.barValue}>{valueLabel(row, row.current.value)}</span></div>
            {row.prior && <div className={s.barObservation}><span className={s.barDate}>{row.prior.end}</span><div className={s.barArea} aria-hidden="true"><div className={s.priorBar} style={{ width: `${row.prior.value / maximum * 100}%` }}/></div><span className={s.barValue}>{valueLabel(row, row.prior.value)}</span></div>}
          </div>
        </div>)}<div className={s.dollarAxis} aria-hidden="true"><span>$0</span><span>Common scale · {valueLabel(rows[0], maximum)}</span></div></div>
      </div>;
    })}
    <p className={s.marketInterpretation}>Notional is not the amount at risk. It is not fair value, net currency exposure, or potential loss. Accounting designation does not establish how much exposure is hedged; contracts without hedge-accounting designation can still serve a risk-management purpose.</p>
  </div>;
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
      if (!response.ok || !matchesRiskNoteResponse(body, ticker, basis, asOf)) throw new Error(body?.message || body?.error || 'The filing notes could not be verified for this company and reporting selection. Please retry.');
      return body as Notes;
    }).then(body => { if (!controller.signal.aborted) setData(body); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  },[ticker,basis,asOf,retry,visible]);
  // This profile section compares notionals and concentration shares only.
  // Other note measures, including fair values, belong to Business Exposures.
  const rows = (data?.rows || []).filter(row => (row.kind === 'derivative_notional' && row.unit === 'USD'
    || row.kind === 'credit_concentration' && row.unit === 'pure')
    && finite(row.current?.value) && row.current.value >= 0 && (!row.prior || (finite(row.prior.value) && row.prior.value >= 0)));
  const derivatives = rows.filter(row => row.kind === 'derivative_notional' && row.unit === 'USD');
  const concentrations = rows.filter(row => row.kind === 'credit_concentration' && row.unit === 'pure' && row.current.value <= 1 && (!row.prior || row.prior.value <= 1));
  return <section ref={root} className={s.section} aria-label="Credit and currency disclosures">
    <div className={s.heading}><div><span className={s.kicker}>COUNTERPARTIES & MARKET EXPOSURES</span><h2>Where financial risk enters the business.</h2><p>Connect credit concentration and market instruments to the company’s capacity to generate and preserve cash.</p></div>{data?.filing && <a className={s.sourceLink} href={data.filing.url} target="_blank" rel="noreferrer">{data.filing.form} · {data.filing.reportDate}<ArrowUpRight size={14}/></a>}</div>
    {!data && !error && <p className={s.state} role="status">{visible ? 'Reading the filing’s tagged risk disclosures…' : 'Filing-note comparisons load as you reach this section.'}</p>}
    {error && <div className={s.state} role="status"><p>{error}</p><button onClick={() => setRetry(n => n+1)}><RefreshCw size={13}/>Retry filing notes</button></div>}
    {data && <>
      {data.filing && <p className={s.filingDate}>Filed {data.filing.filed} · Comparisons use observations in this filing</p>}
      {concentrations.length ? <CreditConcentrations rows={concentrations.slice(0,8)}/> : <div className={s.emptyGroup}><h3>Credit concentration</h3><p>No supported concentration percentages were identified. Credit risk also includes customers, counterparties and investments outside these tagged measures.</p></div>}
      {derivatives.length ? <MarketInstruments rows={derivatives.slice(0,8)}/> : <div className={s.emptyGroup}><h3>Currency & rate exposure</h3><p>No supported notional facts were identified. Review the filing’s currency and derivatives notes; this does not establish zero exposure.</p></div>}
      {(derivatives.length > 8 || concentrations.length > 8) && <p className={s.description}>Charts show the first eight measures in each group. All identified observations appear below.</p>}
      {rows.length > 0 && <EvidenceTable rows={rows}/>}
      <details className={s.details}><summary>Coverage & interpretation</summary><p>This reads supported numeric facts and dimensions from one eligible filing. Missing tags and unsupported note formats remain gaps. It does not calculate a credit rating or infer the company’s CFTC positions.</p>{data.limitations?.map(note => <p key={note}>{note}</p>)}{data.filing && <p>SEC accession {data.filing.accession} · Checked {data.checkedAt?.slice(0,10)}</p>}</details>
    </>}
  </section>;
}
