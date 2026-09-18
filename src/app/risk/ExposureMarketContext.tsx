'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Loader2, RefreshCw } from 'lucide-react';
import { CFTC_FAMILIES, CFTC_REPORT_BASIS, cftcCsv } from '../../utils/cftc.js';
import { fetchPreparedCftc, clearPreparedCftc } from '../../utils/cftcClient.js';
import { cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import CftcPositioningVisuals from '../../components/cftc/CftcPositioningVisuals';
import { downloadText } from '../../utils/download.js';
import s from './ExposureMarketContext.module.css';

type Benchmark = { family: string; contract: string; label: string; group: string; fit: string; basisLimit: string };
type Props = { market: Benchmark; ticker: string; asOf?: string };
const finite = (input: unknown): input is number => typeof input === 'number' && Number.isFinite(input);
const value = (input: unknown, decimals = 1, suffix = '') => finite(input) ? `${input.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}${suffix}` : 'Unavailable';
const signed = (input: unknown, decimals = 0, suffix = '') => finite(input) ? `${input > 0 ? '+' : ''}${value(input, decimals, suffix)}` : 'Unavailable';

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
  const weekly = useMemo(() => cftcPositionChange(history), [history]);
  const fourWeekly = useMemo(() => cftcPositionChange(history, 4), [history]);

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
    <p className={s.scope}>{market.fit === 'user-selected' ? 'You selected this market for independent comparison. No company connection is inferred.' : 'Aggregate futures positions provide context for the disclosed business exposure.'} They do not show {ticker}’s holdings, hedge coverage, or financial sensitivity.</p>
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
      <CftcPositioningVisuals history={history} onGroupChange={setGroup} />
      <details className={s.numericHistory}><summary>Inspect numeric history · {history.history.length} observations</summary><div className={s.tableActions}><span>Reported contracts; net / OI is shown to two decimal places.</span><button type="button" onClick={() => downloadText(`cftc-${market.contract}-${group}-${selected.reportDate}.csv`, cftcCsv(history), 'text/csv')}>Download history CSV</button></div><div className={s.historyTable} role="region" aria-label="Dated CFTC positioning values; scroll horizontally for all columns" tabIndex={0}><table><thead><tr><th scope="col">Report date</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Net</th><th scope="col">Open interest</th><th scope="col">Net / OI</th></tr></thead><tbody>{[...history.history].reverse().map((point: any) => <tr key={point.reportDate}><th scope="row">{point.reportDate}</th><td>{value(point.long, 0)}</td><td>{value(point.short, 0)}</td><td>{signed(point.net, 0)}</td><td>{value(point.openInterest, 0)}</td><td>{signed(point.netPctOi, 2, '%')}</td></tr>)}</tbody></table></div></details>
      <footer className={s.footer}><p className={s.scope}>Net = longs − shorts. The rank compares net / open interest with 52 earlier reports, using half weight for ties. Position changes do not establish cash flows, trader intent, or a price forecast.</p><div className={s.links}><a href={marketUrl}>Open dated contract history <ArrowUpRight size={14} /></a><a href={history.source?.url} target="_blank" rel="noreferrer">Official CFTC source <ArrowUpRight size={14} /></a></div></footer>
    </>}
  </section>;
}
