'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Download, ExternalLink, Loader2, X } from 'lucide-react';
import { MARKET_METRICS, formatMarket, isNumber } from '../../utils/marketResearch.js';
import { sourceDocumentUrl } from '../../utils/xbrlPeriods.js';
import { downloadText } from '../../utils/download.js';
import type { Basis, CompanyDetail, Input } from './marketTypes';
import s from './market.module.css';

const MarketTrend = dynamic(() => import('./MarketTrend'), { loading: () => <div className={s.chartLoading}>Loading trend…</div>, ssr: false });
const INPUT_LABELS: Record<string, string> = { revenue: 'Revenue', netIncome: 'Net income', operatingIncome: 'Operating income', operatingCashFlow: 'Operating cash flow', capex: 'PP&E purchases', totalAssets: 'Total assets', totalLiabilities: 'Total liabilities', stockholdersEquity: 'Stockholders’ equity', cash: 'Cash and cash equivalents' };

function SourceInput({ label, point, cik }: { label: string; point: Input; cik: string }) {
  return <div className={s.sourceInput}><div><b>{label}</b><strong>{formatMarket(point?.value, 'usd')}</strong></div>
    <p className={s.note}>{point?.formula || (isNumber(point?.value) ? 'Reported financial fact' : 'Unavailable for this reporting period')}</p>
    {point?.calculations?.length > 0 && <details className={s.details}><summary>Intermediate calculations ({point.calculations.length})</summary>{point.calculations.map((c, i) => <p className={s.note} key={i}>{c.start} to {c.end}: {c.value.toLocaleString('en-US', { maximumFractionDigits: 10 })} {c.unit} = {c.formula}</p>)}</details>}
    {point?.sources?.length > 0 && <details className={s.details}><summary>SEC source inputs ({point.sources.length})</summary>{point.sources.map((source, i) => <div className={s.rawSource} key={`${source.accession}-${source.tag}-${i}`}><b>{source.tag}</b><span>{source.value.toLocaleString('en-US', { maximumFractionDigits: 10 })} {source.unit}</span><small>{source.start || 'Balance at'} → {source.end} · filed {source.filed}{source.revised ? ' · Different values filed for this context' : ''}</small><a href={sourceDocumentUrl(cik, source) || undefined} target="_blank" rel="noreferrer">SEC filing {source.accession}<ExternalLink size={12} /></a></div>)}</details>}
  </div>;
}

export default function MarketEvidence({ ticker, initialBasis, initialMetric, onClose }: { ticker: string; initialBasis: Basis; initialMetric: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [basis, setBasis] = useState<Basis>(initialBasis);
  const [metric, setMetric] = useState(initialMetric);
  const [period, setPeriod] = useState(0);
  const [exported, setExported] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Company evidence timed out. Please retry.')), 45000);
    async function load() {
      try {
        const response = await fetch(`/api/market-research?ticker=${encodeURIComponent(ticker)}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.evidence) throw new Error(result.error || 'Company evidence is unavailable.');
        setData(result);
      } catch (e) { if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load company evidence.'); }
      finally { clearTimeout(timeout); }
    }
    load();
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [ticker, retry]);
  const definition = MARKET_METRICS.find((m) => m.key === metric) || MARKET_METRICS[0];
  const evidence = data?.evidence[basis] || [];
  const selected = evidence[period];
  return <dialog ref={dialog} className={s.dialog} onClose={onClose} aria-labelledby="market-evidence-title" onClick={(e) => { if (e.target === e.currentTarget) dialog.current?.close(); }}>
    <div className={s.dialogBody}>
      <div className={s.sectionHeading}><div><span className={s.eyebrow}>Company evidence</span><h2 id="market-evidence-title">{ticker} <span className={s.muted}>{data?.name || ''}</span></h2></div><button className={s.iconButton} onClick={() => dialog.current?.close()} aria-label="Close company evidence"><X size={22} /></button></div>
      {!data && !error && <div className={s.empty} role="status"><Loader2 size={24} className={s.spin} /><p>Loading reporting history and SEC source inputs…</p></div>}
      {error && <div className={s.error} role="alert"><p>{error}</p><button className={s.button} onClick={() => { setError(''); setRetry((n) => n + 1); }}>Retry evidence</button></div>}
      {data && <>
        <div className={s.evidenceActions}><div className={s.segmented}>{(['ttm', 'annual'] as Basis[]).map((b) => <button key={b} aria-pressed={basis === b} onClick={() => { setBasis(b); setPeriod(0); }}>{b === 'ttm' ? 'Latest TTM' : 'Annual'}</button>)}</div><Link href={`/risk?ticker=${ticker}`} className={s.button}>Risk profile <ExternalLink size={13} /></Link><Link href={`/analysis/${ticker}`} className={s.button}>Financial statements <ExternalLink size={13} /></Link><button className={s.button} onClick={() => { downloadText(`${ticker}-market-evidence.json`, JSON.stringify(data, null, 2), 'application/json'); setExported(true); }}><Download size={14} />{exported ? 'Evidence exported' : 'Export evidence'}</button></div>
        <div className={s.filters}><label>Evidence metric<select value={metric} onChange={(e) => setMetric(e.target.value)}>{MARKET_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}</select></label><label>Reporting period<select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>{evidence.map((e, i) => <option key={e.period.end} value={i}>{e.period.end} · {basis === 'ttm' ? 'TTM' : `FY${e.period.fy}`}</option>)}</select></label></div>
        {selected ? <>
          <div className={s.evidenceValue}><div><span className={s.eyebrow}>{definition.label}</span><strong>{formatMarket(selected.metrics[metric], definition.unit)}</strong></div><p>{definition.formula || 'Reported USD value'}<small>Period end {selected.period.end} · {selected.period.form} filed {selected.period.filed}</small></p></div>
          <MarketTrend evidence={evidence} metric={metric} unit={definition.unit} basis={basis} />
          <p className={s.note}>{basis === 'ttm' ? 'Each point uses quarter-end balances and trailing-twelve-month flows. Adjacent TTM periods overlap.' : 'Each point uses one reported fiscal year.'} The latest available revisions are included. Missing reporting periods break the line.</p>
          <div className={s.sourceGrid}>{definition.inputs.map((key) => <SourceInput key={key} label={INPUT_LABELS[key] || key} point={selected.inputs[key]} cik={data.cik} />)}{definition.growth && <SourceInput label={`Prior-year revenue (${selected.priorRevenue?.period.end || 'unavailable'})`} point={selected.priorRevenue || { value: null, sources: [], classification: 'unavailable', formula: null, calculations: [] }} cik={data.cik} />}</div>
          <details className={s.details}><summary>Reporting history table</summary><div className={s.tableScroll}><table className={s.comparison}><thead><tr><th>Reporting end</th><th>{definition.label}</th><th>Filed</th><th>Source report</th></tr></thead><tbody>{evidence.map((e) => <tr key={e.period.end}><td>{e.period.end}</td><td>{formatMarket(e.metrics[metric], definition.unit)}</td><td>{e.period.filed}</td><td><a href={sourceDocumentUrl(data.cik, e.period) || undefined} target="_blank" rel="noreferrer">{e.period.form}<ExternalLink size={12} /></a></td></tr>)}</tbody></table></div></details>
        </> : <div className={s.empty}><h3>No compatible reporting periods</h3><p>Try the other reporting basis or open the company’s financial statements.</p></div>}
        <p className={s.note}>Retrieved {data.observedAt.slice(0, 16).replace('T', ' ')} UTC. Raw inputs retain their actual source dates and values. Financial-company cash flows and capital structures require sector-specific interpretation.</p>
      </>}
    </div>
  </dialog>;
}
