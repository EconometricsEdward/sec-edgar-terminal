'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Loader2, RefreshCw } from 'lucide-react';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS } from '../../utils/cftc.js';
import { fetchPreparedCftc, clearPreparedCftc } from '../../utils/cftcClient.js';
import { cftcContextChart, cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import s from './ExposureMarketContext.module.css';

type Benchmark = { family: string; contract: string; label: string; group: string; fit: string; basisLimit: string };
type Props = { market: Benchmark; ticker: string; asOf?: string };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const value = (number: unknown, decimals = 1, suffix = '') => finite(number) ? `${number.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}${suffix}` : 'Unavailable';
const signed = (number: unknown, decimals = 0, suffix = '') => finite(number) ? `${number > 0 ? '+' : ''}${value(number, decimals, suffix)}` : 'Unavailable';

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
    <div className={s.header}><div><span className={s.eyebrow}><ChartNoAxesCombined size={15} /> Related market observations</span><h3>{market.label}</h3><p>{family?.label} · Futures only · Contract {market.contract}</p></div><label>Trader category<select value={group} onChange={event => setGroup(event.target.value)}>{family?.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
    <p className={s.scope}>These are aggregate futures positions. They do not show {ticker}’s holdings, hedge coverage, or financial sensitivity.</p>
    {asOf && <p className={s.notice}>SEC evidence is limited to filings through {asOf}. This panel shows the latest available CFTC observations; they are not a reconstruction of what was public at that cutoff.</p>}
    {loading && <p className={s.loading} role="status"><Loader2 className={s.spin} size={16} />Loading the selected CFTC market…</p>}
    {error && <div className={s.notice} role="alert"><p>{error} The SEC exposure evidence above remains available.</p><button type="button" onClick={() => { clearPreparedCftc(path); setRetry(count => count + 1); }}><RefreshCw size={14} />Retry market data</button></div>}
    {history && !loading && !error && <>
      <div className={s.dates}><span>Positions as of <strong>{selected.reportDate}</strong></span><span>Retrieved <strong>{history.retrieved_at?.slice(0, 16).replace('T', ' ')} UTC</strong></span></div>
      {degraded && <p className={s.notice}>Review the source coverage and dates. {history.refresh_warning || `The market response is ${history.status}; cache state: ${history.freshness?.cache_status}.`}</p>}
      <div className={s.metrics}>
        <div><span>Net / open interest</span><strong>{value(selected.selectedGroup?.netPctOi, 1, '%')}</strong><small>{signed(selected.selectedGroup?.net)} net contracts</small></div>
        <div><span>Weekly change</span><strong>{signed(selected.oneWeekNetPctChange, 2)}</strong><small>Percentage points in net / OI</small></div>
        <div><span>52-report percentile</span><strong>{value(history.percentile?.value, 1, '%')}</strong><small>{history.percentile?.observations}/52 valid prior observations</small></div>
      </div>
      {chart && <div className={s.chartWrap}><p>{selected.selectedGroup?.label} · Net position / market open interest</p><svg viewBox="0 0 680 210" className={s.chart} role="img" aria-label={`Net positioning: ${chart.count} observations between ${chart.start} and ${chart.end}. Open contract history for the complete numeric table.`}><line x1="48" x2="640" y1={chart.zeroY} y2={chart.zeroY} className={s.zeroLine} />{chart.paths.map((path, index) => <path key={index} d={path} />)}{chart.dots.map(point => <circle key={point.date} cx={point.x} cy={point.y} r="1.5"><title>{point.date}: {point.value.toFixed(2)}%</title></circle>)}<text x="3" y="39">{chart.max.toFixed(1)}%</text><text x="3" y="174">{chart.min.toFixed(1)}%</text><text x="48" y="202">{chart.start}</text><text x="560" y="202">{chart.end}</text></svg></div>}
      <p className={s.change}>{weekly.available ? weekly.explanation : weekly.reason}</p>
      <p className={s.scope}>Net = longs − shorts. The percentile compares net / open interest with 52 earlier reports for the same contract and category. Position changes do not establish cash flows, trader intent, or a price forecast.</p>
      <div className={s.links}><a href={marketUrl}>Open dated contract history <ArrowUpRight size={14} /></a><a href={history.source?.url} target="_blank" rel="noreferrer">Official CFTC source <ArrowUpRight size={14} /></a></div>
    </>}
  </section>;
}
