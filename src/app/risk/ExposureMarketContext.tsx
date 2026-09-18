'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Loader2, RefreshCw } from 'lucide-react';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS } from '../../utils/cftc.js';
import { fetchPreparedCftc, clearPreparedCftc } from '../../utils/cftcClient.js';
import { cftcContextChart, cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import s from './ExposureMarketContext.module.css';

type Benchmark = { family: string; contract: string; label: string; group: string; fit: string; basisLimit: string };
type Props = { market: Benchmark; ticker: string; asOf?: string };
const finite = (input: unknown): input is number => typeof input === 'number' && Number.isFinite(input);
const value = (input: unknown, decimals = 1, suffix = '') => finite(input) ? `${input.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}${suffix}` : 'Unavailable';
const signed = (input: unknown, decimals = 0, suffix = '') => finite(input) ? `${input > 0 ? '+' : ''}${value(input, decimals, suffix)}` : 'Unavailable';
const share = (input: unknown, total: unknown) => finite(input) && finite(total) && total > 0 && input >= 0 && input <= total ? input / total * 100 : null;

export default function ExposureMarketContext(props: Props) {
  return <MarketContext key={`${props.ticker}:${props.market.family}:${props.market.contract}:${props.asOf || ''}`} {...props} />;
}

function MarketContext({ market, ticker, asOf = '' }: Props) {
  const [group, setGroup] = useState(market.group);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ path: string; data: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const family = CFTC_FAMILIES[market.family];
  const path = `/api/v1/cftc/history?${new URLSearchParams({ family: market.family, contract: market.contract, group, window: '1y', date: 'latest' })}`;
  const history = result?.path === path ? result.data : null;
  const selected = history?.selected;
  const chart = useMemo(() => cftcContextChart(history?.history || []), [history]);
  const weekly = useMemo(() => cftcPositionChange(history), [history]);
  const fourWeekly = useMemo(() => cftcPositionChange(history, 4), [history]);
  const percentile = finite(history?.percentile?.value) && history.percentile.value >= 0 && history.percentile.value <= 100 ? history.percentile.value : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetchPreparedCftc(path, { signal: controller.signal }).then(data => {
      if (!data?.selected || data.selection?.contract !== market.contract || data.selected.code !== market.contract || data.selection?.group !== group || data.selected.selectedGroup?.id !== group || data.report_family !== market.family || data.report_basis !== CFTC_REPORT_BASIS || data.selection?.history_window !== '1y' || data.percentile?.required !== 52 || !Array.isArray(data.history)) throw new Error('The CFTC observation did not match the selected benchmark.');
      if (!controller.signal.aborted) setResult({ path, data });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message || 'CFTC market data is unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, retry, group, market.contract, market.family]);
  const marketUrl = `/market?${new URLSearchParams({ tab: 'positioning', family: market.family, contract: market.contract, group, history: '1y', display: 'net-oi', ...(selected ? { date: selected.reportDate } : {}) })}`;
  const degraded = history && (history.status !== 'ready' || history.freshness?.source_currency === 'aged' || String(history.freshness?.cache_status).startsWith('stale'));

  return <section className={s.root} aria-label={`${market.label} CFTC market observations`}>
    <header className={s.header}>
      <div><span className={s.eyebrow}><ChartNoAxesCombined size={15} /> Market positioning</span><h3>How this market compares with its own history</h3><p>{market.label} · {family?.label} · Futures only · Contract {market.contract}</p></div>
      <label>Trader category<select value={group} onChange={event => setGroup(event.target.value)}>{family?.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </header>
    <p className={s.scope}>Aggregate futures positions provide context for the disclosed business exposure. They do not show {ticker}’s holdings, hedge coverage, or financial sensitivity.</p>
    {asOf && <p className={s.notice}>SEC evidence is limited to filings through {asOf}. This panel shows the latest available CFTC observations; they are not a reconstruction of what was public at that cutoff.</p>}
    {loading && <p className={s.loading} role="status"><Loader2 className={s.spin} size={16} />Loading the selected CFTC market…</p>}
    {error && <div className={s.notice} role="alert"><p>{error} The SEC exposure evidence remains available.</p><button type="button" onClick={() => { clearPreparedCftc(path); setRetry(count => count + 1); }}><RefreshCw size={14} />Retry market data</button></div>}
    {history && !loading && !error && <>
      <div className={s.dates}><span>Positions as of <strong>{selected.reportDate}</strong></span><span>Retrieved <strong>{history.retrieved_at?.slice(0, 16).replace('T', ' ')} UTC</strong></span></div>
      {degraded && <p className={s.notice}>Review the source coverage and dates. {history.refresh_warning || `The market response is ${history.status}; cache state: ${history.freshness?.cache_status}.`}</p>}
      <dl className={s.metrics}>
        <div><dt>Net position / open interest</dt><dd>{signed(selected.selectedGroup?.netPctOi, 1, '%')}</dd><small>{signed(selected.selectedGroup?.net)} net contracts</small></div>
        <div><dt>One-week change</dt><dd>{signed(weekly.available ? weekly.netPctChange : null, 2, ' pp')}</dd><small>{weekly.available ? `Since ${weekly.priorDate}` : 'Exact prior week unavailable'}</small></div>
        <div><dt>Four-week change</dt><dd>{signed(fourWeekly.available ? fourWeekly.netPctChange : null, 2, ' pp')}</dd><small>{fourWeekly.available ? `Since ${fourWeekly.priorDate}` : 'Exact four-week comparison unavailable'}</small></div>
      </dl>
      <div className={s.visuals}>
        <figure className={s.chartWrap}>
          <figcaption><span>{selected.selectedGroup?.label}</span><strong>Net positioning over time</strong><small>Net contracts ÷ market open interest</small></figcaption>
          {chart ? <svg viewBox="0 0 680 210" className={s.chart} role="img" aria-label={`Net positioning: ${chart.count} observations between ${chart.start} and ${chart.end}. Gaps mark missing reports. Open dated contract history for the complete numeric table.`}>
            <line x1="48" x2="640" y1="38" y2="38" className={s.gridLine} /><line x1="48" x2="640" y1="170" y2="170" className={s.gridLine} /><line x1="48" x2="640" y1={chart.zeroY} y2={chart.zeroY} className={s.zeroLine} />
            {chart.paths.map((segment, index) => <path key={index} d={segment} />)}
            {chart.dots.map((point, index) => <circle key={point.date} cx={point.x} cy={point.y} r={index === chart.dots.length - 1 ? 4 : 1.5}><title>{point.date}: {point.value.toFixed(2)}%</title></circle>)}
            <text x="3" y="39">{chart.max.toFixed(1)}%</text><text x="3" y="174">{chart.min.toFixed(1)}%</text><text x="48" y="202">{chart.start}</text><text x="640" y="202" textAnchor="end">{chart.end}</text>
          </svg> : <p className={s.chartEmpty}>At least two valid observations are needed to draw a history.</p>}
          <p className={s.change}>{weekly.available ? weekly.explanation : weekly.reason}</p>
        </figure>
        <aside className={s.comparison} aria-label="Historical rank and long-short comparison">
          <span className={s.eyebrow}>Historical position</span>
          <div className={s.rankValue}><strong>{value(percentile, 1, '%')}</strong><span>52-report<br />percentile</span></div>
          {percentile !== null && <div className={s.rankVisual} role="img" aria-label={`${value(percentile, 1)} percentile compared with 52 earlier reports; this is a positioning rank, not a company risk score.`}><div className={s.rankTrack}><i style={{ left: `${percentile}%` }} /></div><div className={s.rankAxis}><span>0</span><span>50</span><span>100</span></div></div>}
          <p className={s.scope}>{percentile === null ? history.percentile?.reason || 'Not enough valid prior observations.' : 'Low to high net positioning for this contract and trader category.'} {history.percentile?.observations ?? 0}/52 valid prior reports. This is a positioning rank, not a company risk score.</p>
          {history.percentile?.comparisonRange?.earliest && <p className={s.comparisonDates}>{history.percentile.comparisonRange.earliest} to {history.percentile.comparisonRange.latest}</p>}
          <div className={s.positions}>
            <h4>Longs and shorts</h4>
            {(['long', 'short'] as const).map(side => {
              const positionShare = share(selected.selectedGroup?.[side], selected.openInterest);
              return <div className={s.position} key={side}><div><span>{side === 'long' ? 'Long' : 'Short'}</span><strong>{value(selected.selectedGroup?.[side], 0)}</strong></div><div className={s.positionTrack} aria-hidden="true">{positionShare !== null && <i data-side={side} style={{ width: `${positionShare}%` }} />}</div><small>{value(positionShare, 1, '%')} of market open interest</small></div>;
            })}
            <p className={s.scope}>Market open interest: {value(selected.openInterest, 0)} contracts. Long and short bars use the same 0–100% scale; separately reported spreading is excluded.</p>
          </div>
        </aside>
      </div>
      <footer className={s.footer}><p className={s.scope}>Net = longs − shorts. The rank compares net / open interest with 52 earlier reports, using half weight for ties. Position changes do not establish cash flows, trader intent, or a price forecast.</p><div className={s.links}><a href={marketUrl}>Open dated contract history <ArrowUpRight size={14} /></a><a href={history.source?.url} target="_blank" rel="noreferrer">Official CFTC source <ArrowUpRight size={14} /></a></div></footer>
    </>}
  </section>;
}
