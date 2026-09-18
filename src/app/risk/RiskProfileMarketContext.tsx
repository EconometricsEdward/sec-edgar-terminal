'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, RefreshCw } from 'lucide-react';
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, cftcCsv } from '../../utils/cftc.js';
import { clearPreparedCftc, fetchPreparedCftc } from '../../utils/cftcClient.js';
import { cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import { positioningHistoryChart, signedPlotExtent } from '../../components/cftc/cftcVisualAnalytics.js';
import { downloadText } from '../../utils/download.js';
import { matchesRiskProfileHistory, riskProfileExposureRows, riskProfileMarketChannel, riskProfileReferenceMarkets } from './riskProfileMarket.js';
import s from './RiskProfileMarketContext.module.css';

type Props = { ticker: string; companyName?: string; asOf?: string; basis?: string; companyType?: string };
type Benchmark = { family: string; contract: string; label: string; group: string; fit: string; basisLimit: string };
type Evidence = { id: string; text: string; url: string; form: string; filed: string; reportDate: string; disclosureDirection?: string };
type Exposure = { id: string; category: string; marketId: string; marketLabel: string; benchmark: Benchmark | null; benchmarkUnavailableReason?: string; evidence: Evidence[] };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const number = (value: unknown, digits = 0) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'Unavailable';
const signed = (value: unknown, digits = 1, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${number(value, digits)}${suffix}` : 'Unavailable';
const compact = (value: number) => Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(1)}m` : Math.abs(value) >= 1e3 ? `${(value / 1e3).toFixed(0)}k` : number(value);
const CFTC_METHOD = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm';

export default function RiskProfileMarketContext(props: Props) {
  return <ProfileMarket key={`${props.ticker}:${props.basis || 'ttm'}:${props.asOf || ''}:${props.companyType || ''}`} {...props} />;
}

function ProfileMarket({ ticker, companyName, asOf = '', basis = 'ttm', companyType = 'corporate' }: Props) {
  const root = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [discovery, setDiscovery] = useState<any>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryPending, setDiscoveryPending] = useState(false);
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const [choice, setChoice] = useState('');
  const [reference, setReference] = useState('');
  const discoveryPath = `/api/v1/cftc/company-exposures?${new URLSearchParams({ ticker, ...(asOf ? { asOf } : {}) })}`;

  useEffect(() => {
    if (!('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '500px' });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setDiscoveryPending(true); setDiscoveryError('');
    fetchPreparedCftc(discoveryPath, { signal: controller.signal }).then(body => {
      riskProfileExposureRows(body, { ticker, asOf, basis, companyType });
      if (!controller.signal.aborted) setDiscovery(body);
    }).catch(error => { if (!controller.signal.aborted) setDiscoveryError(error.message || 'Company filing evidence is temporarily unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setDiscoveryPending(false); });
    return () => controller.abort();
  }, [visible, discoveryPath, discoveryRetry, ticker, asOf, basis, companyType]);

  const exposures: Exposure[] = useMemo(() => discovery ? riskProfileExposureRows(discovery, { ticker, asOf, basis, companyType }) : [], [discovery, ticker, asOf, basis, companyType]);
  const selected = exposures.find(item => item.id === choice) || exposures[0] || null;
  const channel = riskProfileMarketChannel(selected, companyType);
  const references = riskProfileReferenceMarkets(selected);
  const manual = reference ? CFTC_LAUNCH_CATALOG.find(item => `${item.family}:${item.code}` === reference) : null;
  const market: Benchmark | null = manual
    ? { family: manual.family, contract: manual.code, label: manual.label, group: manual.family === 'tff' ? 'leveraged-funds' : 'managed-money', fit: 'user-selected', basisLimit: 'Independent reference selected by you. A benchmark connection to the company has not been established by this selection.' }
    : selected?.benchmark || null;
  const complete = !discoveryPending && (discovery || discoveryError);
  const exposureUrl = `/risk?${new URLSearchParams({ ticker, view: 'exposures', ...(basis === 'annual' ? { basis } : {}), ...(asOf ? { asOf } : {}) })}`;

  return <section ref={root} className={s.root} aria-label={`${ticker} financial risk and CFTC market context`}>
    <header className={s.header}><div><span className={s.kicker}><ChartNoAxesCombined size={15} /> Related market risk</span><h2>Where markets meet the balance sheet.</h2><p>Connect {companyName || ticker}’s disclosed financial exposure to the market’s positioning history.</p></div><a href={exposureUrl}>Full exposure map <ArrowUpRight size={14} /></a></header>
    {!complete && <p className={s.status} role="status">{visible ? 'Finding the market connections in the company’s SEC filings…' : 'Company connections and CFTC history load as you reach this section.'}</p>}
    {discoveryError && <div className={s.notice} role="status"><p>{discoveryError}</p><button type="button" onClick={() => { clearPreparedCftc(discoveryPath); setDiscoveryRetry(value => value + 1); }}><RefreshCw size={13} />Retry company evidence</button></div>}
    {complete && <>
      <div className={s.connectionBar}>
        {exposures.length > 0 ? <label>Financial connection<select value={selected?.id || ''} onChange={event => { setChoice(event.target.value); setReference(''); }}>{exposures.map(row => <option key={row.id} value={row.id}>{riskProfileMarketChannel(row, companyType).label} · {row.marketLabel}</option>)}</select></label> : <div><strong>Choose a market reference</strong><p>No supported company connection was established in the reviewed filing text.</p></div>}
        <label>{selected?.benchmark ? 'Filing benchmark or independent reference' : 'Select a reference to see the chart'}<select value={reference} onChange={event => setReference(event.target.value)}><option value="">{selected?.benchmark ? `${selected.benchmark.label} · filing-linked` : 'Choose a market for independent context'}</option>{references.map(item => <option key={`${item.family}:${item.code}`} value={`${item.family}:${item.code}`}>{item.label}</option>)}</select></label>
      </div>
      <div className={s.workspace}>
        <aside className={s.transmission}><span className={s.kicker}>{channel.label}</span><h3>{channel.effect}</h3><p>{channel.connection}</p>{selected && <div className={s.connectionSource}><span>Disclosed market</span><strong>{selected.marketLabel}</strong><span>{basis === 'annual' ? 'Annual filing evidence' : 'Annual filing and eligible quarterly updates'}</span></div>}
          {market ? <p className={s.limit}>{market.fit === 'user-selected' ? 'You selected this reference. It is not an identified company benchmark or a measure of its exposure.' : market.basisLimit}</p> : <p className={s.limit}>{selected?.benchmarkUnavailableReason || 'No futures contract has been assigned to this company.'} Select a reference to inspect its market history.</p>}
          {selected && <details className={s.evidence}><summary>SEC evidence · {selected.evidence.length} passage{selected.evidence.length === 1 ? '' : 's'}</summary>{selected.evidence.map(item => <blockquote key={item.id}><p>{item.text}</p><a href={item.url} target="_blank" rel="noreferrer">{item.form} · Period {item.reportDate || 'not supplied'} · Filed {item.filed} <ArrowUpRight size={12} /></a>{item.disclosureDirection === 'qualifying-or-negative' && <small>Qualifying or negative disclosure</small>}</blockquote>)}</details>}
        </aside>
        {market ? <MarketChart key={`${market.family}:${market.contract}`} ticker={ticker} market={market} asOf={asOf} /> : <div className={s.emptyChart}><ChartNoAxesCombined size={30} strokeWidth={1.3} /><h3>Bring a relevant market into view.</h3><p>{selected?.category === 'currencies' ? 'Choose a currency reference above. An unspecified foreign-exchange disclosure does not identify a currency pair.' : selected?.category === 'borrowing' || selected?.category === 'investments' ? 'Choose a rate or market reference above. The company’s borrowing or investment disclosure remains separate from aggregate futures positions.' : 'Choose a reference above to view positioning, open interest and changes over time.'}</p><span>No company exposure is inferred from the reference you select.</span></div>}
      </div>
      {discovery && <details className={s.coverage}><summary>Filing coverage and market interpretation</summary><p>{discovery.coverage?.filingsScanned || 0} filing(s) scanned. {basis === 'annual' ? 'Only evidence from the eligible annual filing is used for this financial basis.' : 'Annual and eligible quarterly disclosures retain their own dates.'} A missing passage or benchmark does not establish zero exposure.</p>{(discovery.status === 'partial' || discovery.coverage?.extractionLimited || discovery.coverage?.historyLimited) && <p>The source review reached a coverage limit. Some reports, passages or connections may be absent from this view.</p>}<p>CFTC reports describe aggregate futures positions by trader category. They do not identify {ticker}’s positions, establish hedge coverage, measure cash available for obligations, or predict a price move. Open interest counts contracts and is not a measure of market liquidity.</p><a href={CFTC_METHOD} target="_blank" rel="noreferrer">Official CFTC methodology <ArrowUpRight size={12} /></a></details>}
    </>}
  </section>;
}

function MarketChart({ ticker, market, asOf }: { ticker: string; market: Benchmark; asOf: string }) {
  const [group, setGroup] = useState(market.group);
  const [result, setResult] = useState<{ path: string; data: any } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  const [retry, setRetry] = useState(0);
  const [measure, setMeasure] = useState<'net' | 'interest'>('net');
  const [selectedDate, setSelectedDate] = useState('');
  const path = `/api/v1/cftc/history?${new URLSearchParams({ family: market.family, contract: market.contract, group, window: '1y', date: 'latest' })}`;
  const history = result?.path === path ? result.data : null;
  const family = CFTC_FAMILIES[market.family];

  useEffect(() => {
    const controller = new AbortController();
    setPending(true); setError('');
    fetchPreparedCftc(path, { signal: controller.signal }).then(data => {
      if (!matchesRiskProfileHistory(data, { family: market.family, contract: market.contract, group })) throw new Error('The returned CFTC data does not match the selected contract and trader category.');
      if (!controller.signal.aborted) setResult({ path, data });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message || 'CFTC history is temporarily unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [path, retry, market.family, market.contract, group]);

  const chart = useMemo(() => positioningHistoryChart(history?.history || [], measure), [history, measure]);
  const changes = useMemo(() => [1, 4, 13].map(weeks => ({ weeks, ...cftcPositionChange(history, weeks) })), [history]);
  const extent = signedPlotExtent(changes.map(item => item.available ? item.netPctChange : null));
  const focus = chart?.positions.find(point => point.reportDate === selectedDate) || chart?.positions.at(-1);
  const current = history?.selected;
  const marketUrl = `/market?${new URLSearchParams({ tab: 'positioning', family: market.family, contract: market.contract, group, history: '1y', display: 'net-oi', ...(current?.reportDate ? { date: current.reportDate } : {}) })}`;
  const degraded = history && (history.status !== 'ready' || history.freshness?.source_currency === 'aged' || String(history.freshness?.cache_status).startsWith('stale'));

  return <div className={s.market}>
    <div className={s.chartHeading}><div><span className={s.kicker}>{market.fit === 'user-selected' ? 'Independent CFTC reference' : 'Filing-linked CFTC context'}</span><h3>{market.label}</h3><p>{family.label} · Futures only</p></div><label>Trader category<select value={group} onChange={event => { setGroup(event.target.value); setSelectedDate(''); }}>{family.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
    {asOf && <p className={s.notice}>SEC cutoff: {asOf}. CFTC history below is current market context and can postdate that cutoff; it is not used in historical company calculations.</p>}
    {pending && <p className={s.status} role="status">Loading {market.label} positioning history…</p>}
    {error && <div className={s.notice} role="status"><p>{error}</p><button type="button" onClick={() => { clearPreparedCftc(path); setRetry(value => value + 1); }}><RefreshCw size={13} />Retry CFTC history</button></div>}
    {history && !pending && !error && <>
      {degraded && <p className={s.notice}>Review the dates and coverage. {history.refresh_warning || `Response status: ${history.status}; report age: ${history.freshness?.source_report_age_days ?? 'unknown'} days.`}</p>}
      <div className={s.chartTools}><div className={s.switcher} aria-label="Profile market chart measure"><button type="button" aria-pressed={measure === 'net'} onClick={() => setMeasure('net')}>Net positioning</button><button type="button" aria-pressed={measure === 'interest'} onClick={() => setMeasure('interest')}>Open interest</button></div><span>Latest positions {current.reportDate}</span></div>
      <div className={s.readout} aria-live="polite"><strong>{measure === 'net' ? signed(focus?.netPctOi, 2, '%') : number(focus?.openInterest)}<small>{measure === 'net' ? 'net / open interest' : 'outstanding contracts'}</small></strong><span>{focus?.reportDate || 'Date unavailable'}{measure === 'net' && <small>{signed(focus?.net, 0)} net contracts</small>}</span></div>
      {chart ? <div className={s.chartViewport} tabIndex={0} role="region" aria-label="CFTC history chart; scroll horizontally on small screens"><svg className={s.chart} viewBox="0 0 820 260" role="img" aria-label={`${market.label}, ${current.selectedGroup?.label}: ${measure === 'net' ? 'net positions as a share of market open interest' : 'market open interest'}, ${chart.start} to ${chart.end}. Exact dated values follow in a collapsible table.`}>{chart.ticks.map((tick, index) => <g key={index}><line x1={68} x2={792} y1={tick.y} y2={tick.y} className={s.grid} /><text x={55} y={tick.y + 4} textAnchor="end">{measure === 'net' ? `${number(tick.value, 1)}%` : compact(tick.value)}</text></g>)}<line x1={68} x2={792} y1={chart.zeroY} y2={chart.zeroY} className={s.zero} />{chart.series.map(series => <g key={series.field}>{series.paths.map((path, index) => <path key={index} d={path} className={s.line} />)}{series.dots.map(dot => <circle key={dot.date} cx={dot.x} cy={dot.y} r={dot.date === focus?.reportDate ? 4 : 1.5} className={s.dot}><title>{dot.date}: {measure === 'net' ? signed(dot.value, 2, '%') : `${number(dot.value)} contracts`}</title></circle>)}</g>)}{focus && <line x1={focus.x} x2={focus.x} y1={30} y2={223} className={s.cursor} />}<text x={68} y={252}>{chart.start}</text><text x={792} y={252} textAnchor="end">{chart.end}</text></svg></div> : <p className={s.status}>At least two compatible dated observations are needed for a chart.</p>}
      {chart && <label className={s.inspect}>Inspect report<select value={focus?.reportDate || ''} onChange={event => setSelectedDate(event.target.value)}>{chart.positions.slice().reverse().map(point => <option key={point.reportDate} value={point.reportDate}>{point.reportDate}</option>)}</select></label>}
      <div className={s.shifts}><div className={s.shiftHeading}><strong>Positioning shifts</strong><span>Through {current.reportDate} · percentage points in net / OI</span></div>{changes.map(item => <div className={s.shift} key={item.weeks}><span>{item.weeks} week{item.weeks > 1 ? 's' : ''}</span><div className={s.shiftTrack} aria-hidden="true">{item.available && finite(item.netPctChange) && <i data-negative={item.netPctChange < 0} style={{ left: `${item.netPctChange < 0 ? 50 + item.netPctChange / extent * 50 : 50}%`, width: `${Math.abs(item.netPctChange) / extent * 50}%` }} />}</div><strong>{signed(item.available ? item.netPctChange : null, 2, ' pp')}</strong></div>)}<p className={s.caption}>Changes use exact 1-, 4- and 13-week comparisons on a common ±{extent} pp scale. Gaps remain unavailable. Positioning is market context, not {ticker}’s exposure or a price forecast.</p></div>
      <details className={s.history}><summary>Exact positioning history · {history.history.length} reports</summary><div className={s.tableViewport} role="region" tabIndex={0} aria-label="Dated CFTC observations"><table><thead><tr><th>Report date</th><th>Long</th><th>Short</th><th>Net</th><th>Open interest</th><th>Net / OI</th></tr></thead><tbody>{[...history.history].reverse().map(point => <tr key={point.reportDate}><th scope="row">{point.reportDate}</th><td>{number(point.long)}</td><td>{number(point.short)}</td><td>{signed(point.net, 0)}</td><td>{number(point.openInterest)}</td><td>{signed(point.netPctOi, 2, '%')}</td></tr>)}</tbody></table></div><button type="button" onClick={() => downloadText(`cftc-${market.contract}-${group}-${current.reportDate}.csv`, cftcCsv(history), 'text/csv')}>Download history CSV</button><p>Net = longs − shorts. Net / OI = 100 × net / market open interest. Contract {market.contract} · {current.units} · Retrieved {history.retrieved_at?.slice(0, 16).replace('T', ' ')} UTC.</p></details>
      <div className={s.chartLinks}><a href={marketUrl}>Explore this dated market <ArrowUpRight size={13} /></a><a href={history.source?.url || family.sourceUrl} target="_blank" rel="noreferrer">Official CFTC source <ArrowUpRight size={13} /></a></div>
    </>}
  </div>;
}
