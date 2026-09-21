"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, ChartNoAxesCombined, Check, Loader2, Plus, Search, Users, X } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts';
import { useSecFilerSearch } from '../../utils/useSecFilerSearch.js';
import { filerCik, hasBrokerDealerAnnualReports } from '../../utils/secFilerSearch.js';
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG } from '../../utils/cftc.js';
import { fetchPreparedCftc, clearPreparedCftc } from '../../utils/cftcClient.js';
import { BROKER_DEALER_PEER_CANDIDATES, BROKER_PEER_COLUMNS, brokerPeerRow, brokerCftcSeries, compareBrokerPeriods, fetchBrokerPeer } from '../../utils/brokerDealerContext.js';
import styles from './BrokerDealerContext.module.css';

type Props = { cik: string; research: any };
type Peer = { cik: string; name: string; status: 'loading' | 'ready' | 'error'; data?: any; error?: string };
const finite = (value: any): value is number => typeof value === 'number' && Number.isFinite(value);
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value);
const display = (value: any, format = 'multiple') => !finite(value) ? 'Not disclosed' : format === 'currency' ? money(value) : format === 'percent' ? `${(value * 100).toFixed(2)}%` : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}×`;
const signed = (value: any, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}` : 'Unavailable';

export default function BrokerDealerContext({ cik, research }: Props) {
  const [tab, setTab] = useState<'peers' | 'markets'>('peers');
  const id = useId();
  return <section className={styles.root} aria-label="Broker-dealer comparisons and market context">
    <header className={styles.heading}><div><span className={styles.eyebrow}>Broaden the research</span><h2>Peers & market context</h2></div><div className={styles.tabs} role="tablist" aria-label="Research context"><button type="button" id={`${id}-peers-tab`} aria-controls={`${id}-peers`} role="tab" aria-selected={tab === 'peers'} onClick={() => setTab('peers')}><Users size={15} />Peer comparison</button><button type="button" id={`${id}-markets-tab`} aria-controls={`${id}-markets`} role="tab" aria-selected={tab === 'markets'} onClick={() => setTab('markets')}><ChartNoAxesCombined size={15} />CFTC positioning</button></div></header>
    <div id={`${id}-peers`} role="tabpanel" aria-labelledby={`${id}-peers-tab`} hidden={tab !== 'peers'}><Peers key={cik} cik={cik} research={research} /></div>
    <div id={`${id}-markets`} role="tabpanel" aria-labelledby={`${id}-markets-tab`} hidden={tab !== 'markets'}>{tab === 'markets' && <Markets research={research} />}</div>
  </section>;
}

function Peers({ cik, research }: Props) {
  const [query, setQuery] = useState('');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [metricId, setMetricId] = useState('assetsToEquity');
  const [notice, setNotice] = useState('');
  const requests = useRef(new Map<string, AbortController>());
  const filerSearch = useSecFilerSearch(query, query.trim().length >= 2 && !filerCik(query));
  const searchId = useId();
  const baseline = brokerPeerRow(research, cik);
  const selected = new Set([cik, ...peers.map(peer => peer.cik)]);
  const matches = filerSearch.results.filter(hasBrokerDealerAnnualReports);
  const rows = [baseline, ...peers.filter(peer => peer.status === 'ready').map(peer => brokerPeerRow(peer.data, peer.cik))].filter(Boolean);
  const metric = BROKER_PEER_COLUMNS.find(item => item.id === metricId)!;
  const largest = Math.max(0, ...rows.map(row => Math.abs(row?.measures[metricId]?.value || 0)));
  useEffect(() => { const active = requests.current; return () => { for (const request of active.values()) request.abort(); }; }, []);

  async function addPeer(candidate: { cik: string; name: string }) {
    if (candidate.cik === cik || requests.current.has(candidate.cik)) return;
    const exists = peers.some(peer => peer.cik === candidate.cik);
    if (!exists && peers.length >= 3) { setNotice('Remove a comparison to add another. You can compare up to three other broker-dealers.'); return; }
    const controller = new AbortController();
    requests.current.set(candidate.cik, controller);
    setNotice(''); setQuery('');
    setPeers(current => [...current.filter(peer => peer.cik !== candidate.cik), { ...candidate, status: 'loading' }]);
    try {
      const data = await fetchBrokerPeer(candidate.cik, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(285_000)]) });
      if (!controller.signal.aborted) setPeers(current => current.map(peer => peer.cik === candidate.cik ? { ...candidate, name: data.name, status: 'ready', data } : peer));
    } catch (error: any) {
      if (!controller.signal.aborted) setPeers(current => current.map(peer => peer.cik === candidate.cik ? { ...candidate, status: 'error', error: error?.message || 'The annual report could not be read. Retry this peer.' } : peer));
    } finally { if (requests.current.get(candidate.cik) === controller) requests.current.delete(candidate.cik); }
  }
  function removePeer(peerCik: string) { requests.current.get(peerCik)?.abort(); requests.current.delete(peerCik); setPeers(current => current.filter(peer => peer.cik !== peerCik)); setNotice(''); }

  return <>
    <p className={styles.intro}>Compare the selected filing with public annual reports from up to three other SEC registrants. Start with research candidates or find a broker-dealer by its legal name or CIK.</p>
    <div className={styles.peerTools}><form onSubmit={event => { event.preventDefault(); const direct = filerCik(query); if (direct) void addPeer({ cik: direct, name: `CIK ${direct}` }); }}><label htmlFor={searchId}>Add a broker-dealer</label><div className={styles.searchField}><Search size={16} /><input id={searchId} value={query} onChange={event => setQuery(event.target.value)} placeholder="Legal entity name or SEC CIK" autoComplete="off" maxLength={160} /><button type="submit" disabled={!filerCik(query) || selected.has(filerCik(query) || '') || peers.length >= 3}>Add CIK</button></div></form><div className={styles.candidates}><span>Research candidates</span><div>{BROKER_DEALER_PEER_CANDIDATES.filter(candidate => candidate.cik !== cik).map(candidate => <button type="button" key={candidate.cik} disabled={selected.has(candidate.cik) || peers.length >= 3} onClick={() => void addPeer(candidate)}>{selected.has(candidate.cik) ? <Check size={13} /> : <Plus size={13} />}{candidate.name.replace(' CAPITAL MARKETS INC.', '').replace(' CAPITAL, LLC', '').replace(' SECURITIES, LLC', '')}</button>)}</div></div></div>
    {query.trim().length >= 2 && !filerCik(query) && <div className={styles.searchResults} aria-live="polite">{filerSearch.status === 'loading' && <p>Searching SEC legal entities…</p>}{matches.map((candidate: any) => <button type="button" key={candidate.cik} disabled={selected.has(candidate.cik) || peers.length >= 3} onClick={() => void addPeer(candidate)}><span><b>{candidate.name}</b><small>CIK {candidate.cik} · X-17A-5</small></span><Plus size={16} /></button>)}{filerSearch.status === 'ready' && !matches.length && <p>No verified X-17A-5 registrant found. Try its full legal name or exact CIK.</p>}{filerSearch.warning && <p>{filerSearch.warning}</p>}{filerSearch.status === 'error' && <p>{filerSearch.error} <button type="button" onClick={filerSearch.retry}>Retry search</button></p>}</div>}
    <p className={styles.note}>Candidates are starting points for research. Business model, clearing arrangements, consolidated scope and regulatory capital requirements can differ materially.</p>
    {notice && <p role="status" className={styles.warning}>{notice}</p>}
    {!!peers.length && <div className={styles.peerPills}>{peers.map(peer => <div key={peer.cik}><span>{peer.status === 'loading' && <Loader2 size={14} className={styles.spin} />}{peer.name}</span><button type="button" onClick={() => removePeer(peer.cik)} aria-label={`Remove ${peer.name}`}><X size={14} /></button>{peer.status === 'error' && <p role="alert">{peer.error} <button type="button" onClick={() => void addPeer(peer)}>Retry</button></p>}</div>)}</div>}
    {peers.some(peer => peer.status === 'loading') && <p className={styles.note} role="status">Reading the selected peer’s latest public report. Scanned statements may take longer on their first visit; prepared extracts are reused.</p>}
    {rows.length > 1 ? <div className={styles.comparison}>
      <div className={styles.barPanel}><div className={styles.chartTitle}><h3>Across the selected entities</h3><label>Compare measure<select value={metricId} onChange={event => setMetricId(event.target.value)}>{BROKER_PEER_COLUMNS.map(column => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label></div><div className={styles.bars}>{rows.map(row => <div key={row!.cik} className={styles.barRow}><div><a href={row!.url}>{row!.name}</a><span>{row!.periodEnd}</span></div><div className={styles.barTrack} aria-hidden="true"><i data-primary={row!.cik === cik} style={{ width: `${largest && finite(row!.measures[metricId]?.value) ? Math.abs(row!.measures[metricId].value) / largest * 100 : 0}%` }} /></div><strong>{display(row!.measures[metricId]?.value, metric.format)}</strong></div>)}</div><p className={styles.note}>Bar lengths show magnitude; labels retain the sign. Reporting dates remain visible. This is a comparison of reported measures, without peer ranks or a composite risk score.</p></div>
      <div className={styles.tableWrap}><table><caption>Source-linked broker-dealer comparison</caption><thead><tr><th scope="col">SEC registrant / period</th>{BROKER_PEER_COLUMNS.map(column => <th scope="col" key={column.id}>{column.label}</th>)}</tr></thead><tbody>{rows.map(row => { const dateFit = compareBrokerPeriods(baseline?.periodEnd, row!.periodEnd); return <tr key={row!.cik}><th scope="row"><a href={row!.url}>{row!.name}</a><small>CIK {row!.cik} · {row!.periodEnd}</small><small className={!dateFit.aligned ? styles.periodMismatch : undefined}>{row!.cik === cik ? 'Selected report' : dateFit.label}{row!.status === 'partial' ? ' · Partial coverage' : ''}</small></th>{BROKER_PEER_COLUMNS.map(column => { const amount = row!.measures[column.id]; return <td key={column.id}>{amount ? <a href={amount.sourceUrl} target="_blank" rel="noreferrer" title={`${amount.label}: ${amount.value.toLocaleString('en-US')} · ${row!.periodEnd} · source page ${amount.source?.page || ''}`}>{display(amount.value, column.format)}<ArrowUpRight size={11} /></a> : <span className={styles.missing}>Not disclosed</span>}</td>; })}</tr>; })}</tbody></table></div>
      <p className={styles.note}>Each peer uses its latest available public annual report; the selected company uses your current period. Different reporting dates are not aligned or annualized. Accounting equity, net capital and required minimums measure different things. Missing amounts remain unavailable.</p>
    </div> : <div className={styles.empty}><Users size={24} /><div><h3>Build a comparison that fits your question</h3><p>Add a broker-dealer above to compare its balance-sheet size, equity, leverage and regulatory capital with the selected report. Only selected peers are loaded.</p></div></div>}
  </>;
}

function Markets({ research }: { research: any }) {
  const [contract, setContract] = useState('043602');
  const [window, setWindow] = useState('1y');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; pending: boolean; histories: any; errors: string[] }>({ key: '', pending: true, histories: {}, errors: [] });
  const key = `${contract}:${window}`;
  const analysis = research?.analysis || research || {};
  const periodEnd = analysis.periodEnd || research?.filing?.reportDate;
  const hasRepo = analysis.metrics?.some((metric: any) => ['repos', 'reverseRepos'].includes(metric.id) && finite(metric.value));
  const catalog = CFTC_LAUNCH_CATALOG.filter(item => item.family === 'tff');
  const label = catalog.find(item => item.code === contract)?.label || contract;
  const groups = ['dealer', 'leveraged-funds'];
  const path = (group: string) => `/api/v1/cftc/history?${new URLSearchParams({ family: 'tff', contract, group, window, date: 'latest' })}`;
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, pending: true, histories: {}, errors: [] });
    Promise.allSettled(['dealer', 'leveraged-funds'].map(async group => {
      const requestPath = `/api/v1/cftc/history?${new URLSearchParams({ family: 'tff', contract, group, window, date: 'latest' })}`;
      const history = await fetchPreparedCftc(requestPath, { signal: controller.signal });
      brokerCftcSeries({ [group]: history }, { contract, window });
      return { group, history };
    })).then(results => {
      if (controller.signal.aborted) return;
      const histories = {}, errors: string[] = [];
      results.forEach((result, index) => { if (result.status === 'fulfilled') histories[result.value.group] = result.value.history; else errors.push(`${index ? 'Leveraged Funds' : 'Dealer/Intermediary'}: ${result.reason?.message || 'Data unavailable.'}`); });
      setState({ key, pending: false, histories, errors });
    });
    return () => controller.abort();
  }, [contract, window, key, attempt]);
  const current = state.key === key ? state : { pending: true, histories: {}, errors: [] };
  const series = brokerCftcSeries(current.histories, { contract, window });
  const histories = Object.values(current.histories) as any[];
  const reportDates = [...new Set(histories.map(item => item.selected.reportDate))].sort();
  const degraded = histories.some(item => item.status !== 'ready' || item.freshness?.source_currency === 'aged' || String(item.freshness?.cache_status || '').startsWith('stale'));
  const later = periodEnd && reportDates.some(date => date > periodEnd);
  function retry() { groups.forEach(group => clearPreparedCftc(path(group))); setAttempt(value => value + 1); }

  return <>
    <div className={styles.marketIntro}><div><span className={styles.eyebrow}>Official CFTC · Futures only</span><h3>Positioning around the funding and securities markets</h3><p>{hasRepo ? 'The selected filing discloses repo or reverse-repo balances. Treasury and SOFR futures offer context for rates and funding-market research; the relationship to this firm requires review of its securities and financing notes.' : 'Choose a futures market to explore the broader trading environment. Selecting a market does not establish an exposure for this broker-dealer.'}</p></div><div className={styles.controls}><label>Research market<select value={contract} onChange={event => setContract(event.target.value)}>{catalog.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label><label>History<select value={window} onChange={event => setWindow(event.target.value)}><option value="1y">1 year</option><option value="3y">3 years</option><option value="5y">5 years</option></select></label></div></div>
    <p className={styles.marketBoundary}><b>Market-wide trader categories.</b> These are aggregate futures positions across reporting traders. They do not identify this firm’s holdings, hedges, cash securities, repo book or credit exposure.</p>
    {current.pending && <p className={styles.loading} role="status"><Loader2 size={16} className={styles.spin} />Loading prepared CFTC history…</p>}
    {!!current.errors.length && <div className={styles.warning} role="alert">{current.errors.map(error => <p key={error}>{error}</p>)}<button type="button" onClick={retry}>Retry market data</button></div>}
    {!!histories.length && <>
      <div className={styles.dateLine}><span>Positions as of <b>{reportDates.join(' / ')}</b></span><span>{label} · {contract}</span><a href={CFTC_FAMILIES.tff.documentationUrl} target="_blank" rel="noreferrer">CFTC source <ArrowUpRight size={12} /></a></div>
      {later && <p className={styles.note}>The CFTC observation postdates the selected financial period ({periodEnd}). It is current market context and is excluded from historical financial calculations.</p>}
      {reportDates.length > 1 && <p className={styles.warning}>Trader-category snapshots have different report dates. Compare dated observations in the chart; the latest summary cards are not a same-date comparison.</p>}
      {degraded && <p className={styles.warning}>Showing available CFTC observations with incomplete coverage or an older snapshot. Check the report dates before comparing.</p>}
      <div className={styles.positionCards}>{groups.map(group => { const history = current.histories[group], value = history?.selected?.selectedGroup; return <article key={group}><span><i data-group={group} />{group === 'dealer' ? 'Dealer / Intermediary' : 'Leveraged Funds'}</span><strong>{signed(value?.netPctOi, '%')}</strong><small>Net positions / market open interest</small><div><span>{signed(value?.net)} net contracts</span><span>{history?.selected?.reportDate || 'Unavailable'}</span></div></article>; })}</div>
      <div className={styles.trendPanel}><div className={styles.chartTitle}><h3>Net positioning / open interest</h3><span>Hover or focus the chart to inspect a report</span></div><div className={styles.trend}><ResponsiveContainer width="100%" height="100%"><LineChart data={series.chartRows} margin={{ top: 12, right: 20, bottom: 8, left: 0 }} accessibilityLayer><CartesianGrid vertical={false} stroke="var(--border, #29384a)" strokeDasharray="3 4" /><XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} minTickGap={65} tick={{ fill: 'var(--text-muted, #94a3b8)', fontSize: 11 }} tickFormatter={time => new Date(Number(time)).toISOString().slice(0, 7)} axisLine={false} tickLine={false} /><YAxis unit="%" tick={{ fill: 'var(--text-muted, #94a3b8)', fontSize: 11 }} axisLine={false} tickLine={false} /><ReferenceLine y={0} stroke="#60748b" /><Tooltip contentStyle={{ background: '#101a2a', color: '#e8f0fc', border: '1px solid #35455c', borderRadius: 10 }} labelFormatter={time => `Positions as of ${new Date(Number(time)).toISOString().slice(0, 10)}`} formatter={(value: any, name: any) => [signed(value, '%'), name]} /><Line type="linear" dataKey="dealer" name="Dealer / Intermediary" stroke="#60d9e9" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} /><Line type="linear" dataKey="leveraged-funds" name="Leveraged Funds" stroke="#f4c75d" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div><p className={styles.note}>Positive values indicate aggregate net long positions; negative values indicate net short positions. Each report uses its own market open interest. No company sensitivity or directional return is inferred.</p></div>
      <details className={styles.observations}><summary>Inspect dated observations and source coverage</summary><div className={styles.tableWrap}><table><caption>Market-wide net positions as a percentage of open interest</caption><thead><tr><th scope="col">Report date</th><th scope="col">Dealer / Intermediary</th><th scope="col">Leveraged Funds</th></tr></thead><tbody>{[...series.rows].reverse().map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{signed(row.dealer, '%')}</td><td>{signed(row['leveraged-funds'], '%')}</td></tr>)}</tbody></table></div>{histories.map(history => <p className={styles.note} key={history.selected.selectedGroup.id}>{history.selected.selectedGroup.label} · Retrieved {String(history.retrieved_at || '').replace('T', ' ').slice(0, 19) || 'Unavailable'} UTC · Status {history.status} · {history.history.length} observations</p>)}</details>
      <a className={styles.marketLink} href={`/market?${new URLSearchParams({ tab: 'positioning', family: 'tff', contract, group: 'dealer', history: window, date: current.histories.dealer?.selected.reportDate || reportDates.at(-1) || 'latest', display: 'net-oi' })}`}>Explore the full CFTC market workspace <ArrowUpRight size={14} /></a>
    </>}
  </>;
}
