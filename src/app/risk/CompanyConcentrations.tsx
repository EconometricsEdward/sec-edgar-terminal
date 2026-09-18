'use client';

import { useEffect, useId, useState, type CSSProperties } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { matchesCompanyConcentrations, COMPANY_CONCENTRATIONS_VERSION } from '../../utils/companyConcentrationResponse.js';
import s from './CompanyConcentrations.module.css';

type Fact = { value: number; start: string | null; end: string; tag: string; sourceUrl: string; dimensions: { axis: string; member: string; label: string }[] };
type Row = { id: string; label: string; value: number; share: number | null; fact: Fact };
type Group = { id: string; kind: string; label: string; period: string; start: string | null; end: string; scope?: string; reportingBasis?: string; rows: Row[]; denominator: Fact | null; denominatorLabel: string; reconciles: boolean; note: string };
type Data = { ticker: string; basis: string; asOf: string | null; status: string; revenue: Group[]; funding: Group | null; credit: Group[]; filing?: { url: string; form: string; reportDate: string; filed: string }; limitations?: string[]; message?: string };
type Focus = 'overview' | 'revenue' | 'funding' | 'credit';
const responseCache = new Map<string, { savedAt: number; data: Data }>();
const CACHE_TTL_MS = 5 * 60_000;
const colors = ['#87d4cb', '#a8b8ef', '#edc76d', '#bc9ddf', '#dcaa96', '#8db8d7', '#b6c68a'];
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value);
const pct = (value: number) => `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
const scopeLabel = (value?: string) => (value || '').trim();
const exact = (value: number) => `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })} USD`;

function ConcentrationChart({ group, title }: { group: Group; title: string }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const rows = group.rows.slice(0, 7);
  const active = group.rows.find(row => row.id === inspected) || rows[0];
  const composable = group.reconciles && group.rows.every(row => row.value >= 0 && row.share !== null) && group.rows.length <= 7;
  const max = Math.max(...rows.map(row => Math.abs(row.value)), 1);
  const signed = rows.some(row => row.value < 0);
  const low = Math.min(0, ...rows.map(row => row.value)), high = Math.max(0, ...rows.map(row => row.value));
  const span = high - low || 1, zero = -low / span * 100;
  const spotlightShare = !signed && active.share !== null;
  const reset = () => setInspected(null);
  return <div className={s.chart} aria-label={`${title}: ${group.label}`}>
    <div className={s.chartMeta}><span>{group.period}</span>{scopeLabel(group.scope) && <span>{scopeLabel(group.scope)}</span>}{group.reportingBasis && <span>{group.reportingBasis}</span>}</div>
    <div className={s.spotlight}>
      <div><span className={s.spotlightLabel}>{active.label}</span><strong>{spotlightShare ? pct(active.share!) : money(active.value)}</strong><span className={s.spotlightContext}>{spotlightShare ? `of ${group.denominatorLabel.toLowerCase()}` : group.reportingBasis || 'reported amount'}</span></div>
      <a href={active.fact.sourceUrl} target="_blank" rel="noreferrer" className={s.activeValue} title={`Open SEC source: ${exact(active.value)}`}>{money(active.value)}<ArrowUpRight size={15}/></a>
    </div>
    {composable ? <>
      <div className={s.composition} role="group" aria-label={`${group.label}, shares of ${group.denominatorLabel.toLowerCase()}`} onMouseLeave={reset}>
        {rows.map((row, index) => <button type="button" key={row.id} style={{ flexGrow: row.value, '--slice': colors[index % colors.length] } as CSSProperties} className={s.slice} data-selected={active.id === row.id} onMouseEnter={() => setInspected(row.id)} onFocus={() => setInspected(row.id)} onBlur={reset} onClick={() => setInspected(row.id)} aria-label={`${row.label}: ${money(row.value)}, ${pct(row.share!)}. ${group.period}`}><span>{row.share! >= .16 ? pct(row.share!) : ''}</span></button>)}
      </div>
      <div className={s.legend} onMouseLeave={reset}>{rows.map((row, index) => <button type="button" key={row.id} onMouseEnter={() => setInspected(row.id)} onFocus={() => setInspected(row.id)} onBlur={reset} onClick={() => setInspected(row.id)} data-selected={active.id === row.id}><i style={{ background: colors[index % colors.length] }}/><span>{row.label}</span><strong>{pct(row.share!)}</strong></button>)}</div>
    </> : <div className={s.rankBars} onMouseLeave={reset}>{rows.map((row, index) => <button type="button" key={row.id} onMouseEnter={() => setInspected(row.id)} onFocus={() => setInspected(row.id)} onBlur={reset} onClick={() => setInspected(row.id)} data-selected={active.id === row.id} aria-label={`${row.label}: ${exact(row.value)}${row.share !== null ? `, ${pct(row.share)} of ${group.denominatorLabel}` : ''}. ${group.period}`}>
      <span className={s.barLabel}>{row.label}<strong>{!signed && row.share !== null ? pct(row.share) : money(row.value)}</strong></span><span className={s.track}>{signed && <span className={s.zeroLine} style={{ left: `${zero}%` }}/>}<i style={{ width: `${signed ? Math.abs(row.value) / span * 100 : group.denominator && row.share !== null ? row.share * 100 : Math.abs(row.value) / max * 100}%`, ...(signed ? { marginLeft: `${(Math.min(0, row.value) - low) / span * 100}%` } : {}), background: colors[index % colors.length] }}/></span>
    </button>)}{signed && <div className={s.signedAxis}><span>{money(low)}</span><span>{money(high)}</span></div>}</div>}
    <div className={s.denominator}>{group.denominator ? <><span>{group.denominatorLabel}</span><a href={group.denominator.sourceUrl} target="_blank" rel="noreferrer">{money(group.denominator.value)}<ArrowUpRight size={12}/></a></> : <span>A matching total is unavailable; amounts share a dollar scale.</span>}</div>
    {(!group.reconciles || group.reportingBasis) && <p className={s.note}>{group.note}</p>}
    {group.rows.length > rows.length && <p className={s.note}>Largest {rows.length} of {group.rows.length} reported categories. All values are available in the source table.</p>}
  </div>;
}

function ExposureLens({ groups, title, empty }: { groups: Group[]; title: string; empty: string }) {
  const [choice, setChoice] = useState('');
  const id = useId();
  const active = groups.find(group => group.id === choice) || groups[0];
  return <article className={s.lens}>
    <header className={s.lensHeader}><h3>{title}</h3>{groups.length > 1 && <><label htmlFor={id} className={s.srOnly}>{title} breakdown</label><select id={id} value={active.id} onChange={event => setChoice(event.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.label}{scopeLabel(group.scope) ? ` · ${scopeLabel(group.scope)}` : ''}</option>)}</select></>}{groups.length === 1 && <span>{active.label}</span>}</header>
    {active ? <ConcentrationChart key={active.id} group={active} title={title}/> : <div className={s.empty}><p>{empty}</p><span>Coverage gap · review the SEC filing</span></div>}
  </article>;
}

function SourceTable({ groups, data }: { groups: Group[]; data: Data }) {
  return <details className={s.sources}><summary>Concentration values & sources</summary>
    <div className={s.tableScroll}><table><caption>Exact SEC values. Percentages use the named total from the same reporting period.</caption><thead><tr><th>Measure</th><th>Amount</th><th>Share / denominator</th><th>Period</th></tr></thead><tbody>{groups.flatMap(group => group.rows.map(row => <tr key={`${group.id}:${row.id}`}><th scope="row"><a href={row.fact.sourceUrl} target="_blank" rel="noreferrer">{row.label}<ArrowUpRight size={12}/></a><small>{group.label}{group.scope ? ` · ${group.scope}` : ''}</small><small>{row.fact.tag}</small></th><td>{exact(row.value)}</td><td>{row.share === null ? 'Unavailable' : pct(row.share)}<small>{group.denominatorLabel}{group.denominator && ` · ${exact(group.denominator.value)}`}</small></td><td>{row.fact.start ? `${row.fact.start} → ` : ''}{row.fact.end}</td></tr>))}</tbody></table></div>
    {data.limitations?.map(note => <p key={note}>{note}</p>)}
  </details>;
}

export default function CompanyConcentrations(props: { ticker: string; basis?: string; asOf?: string; focus?: Focus }) {
  return <ConcentrationsData key={`${props.ticker}:${props.basis || 'ttm'}:${props.asOf || ''}`} ticker={props.ticker} basis={props.basis || 'ttm'} asOf={props.asOf || ''} focus={props.focus}/>;
}
function ConcentrationsData({ ticker, basis, asOf, focus }: { ticker: string; basis: string; asOf: string; focus?: Focus }) {
  const [selectedFocus, setSelectedFocus] = useState<Focus>('overview');
  const activeFocus = focus || selectedFocus;
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ ticker, basis, v: COMPANY_CONCENTRATIONS_VERSION }); if (asOf) params.set('asOf', asOf);
    const cacheKey = params.toString(), saved = responseCache.get(cacheKey);
    if (saved && Date.now() - saved.savedAt < CACHE_TTL_MS && !retry) { setData(saved.data); return () => controller.abort(); }
    fetch(`/api/risk/concentrations?${params}`, { signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || !matchesCompanyConcentrations(body, ticker, basis, asOf)) throw new Error(body.error || 'Company concentrations could not be loaded.');
      return body as Data;
    }).then(body => { if (!controller.signal.aborted) {
      responseCache.delete(cacheKey); responseCache.set(cacheKey, { savedAt: Date.now(), data: body });
      if (responseCache.size > 12) responseCache.delete(responseCache.keys().next().value!);
      setData(body);
    } }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [ticker, basis, asOf, retry]);
  const groups = data ? [...data.revenue, ...(data.funding ? [data.funding] : []), ...data.credit] : [];
  const visibleGroups = activeFocus === 'overview' ? groups : groups.filter(group => group.kind === activeFocus);
  const creditLead = data?.credit[0]?.rows[0];
  return <section className={s.section} aria-label="Company business concentrations">
    {!data && !error && <p className={s.state} role="status">Reading the company’s revenue, funding and loan concentrations…</p>}
    {error && <div className={s.state} role="status"><p>{error}</p><button onClick={() => { setError(''); setRetry(value => value + 1); }}><RefreshCw size={14}/>Retry concentrations</button></div>}
    {data && <>
      <div className={s.sourceLine}><span>Reported company concentrations</span>{data.filing && <a href={data.filing.url} target="_blank" rel="noreferrer">{data.filing.form} · {data.filing.reportDate}<ArrowUpRight size={13}/></a>}</div>
      {!focus && <nav className={s.focusNav} aria-label="Concentration focus">{(['overview', 'revenue', 'funding', ...(data.credit.length ? ['credit'] : [])] as Focus[]).map(item => <button type="button" key={item} onClick={() => setSelectedFocus(item)} aria-pressed={activeFocus === item}>{({ overview: 'Overview', revenue: 'Revenue', funding: 'Funding', credit: 'Loans & credit' })[item]}</button>)}</nav>}
      <div className={activeFocus === 'overview' ? s.overview : s.focused}>
        {(activeFocus === 'overview' || activeFocus === 'revenue') && <ExposureLens groups={data.revenue} title="Revenue footprint" empty="A revenue breakdown could not be mapped from the supported filing tags. The SEC filing may contain additional segment or geographic disclosures."/>}
        {(activeFocus === 'overview' || activeFocus === 'funding') && <ExposureLens groups={data.funding ? [data.funding] : []} title="Funding dependence" empty="A supported borrowing or deposit breakdown is not available in this filing."/>}
        {activeFocus === 'credit' && <ExposureLens groups={data.credit} title="Loan exposure" empty="A supported loan portfolio breakdown is not available. Customer and counterparty concentration disclosures appear in the credit evidence."/>}
      </div>
      {activeFocus === 'overview' && creditLead && <div className={s.creditSummary}><span>Loan book</span><strong>{creditLead.label}</strong><b>{money(creditLead.value)}</b>{creditLead.share !== null && <span>{pct(creditLead.share)} of {data.credit[0].denominatorLabel.toLowerCase()}</span>}<a href={creditLead.fact.sourceUrl} target="_blank" rel="noreferrer">SEC source<ArrowUpRight size={13}/></a></div>}
      {visibleGroups.length > 0 && <SourceTable groups={visibleGroups} data={data}/>}
    </>}
  </section>;
}
