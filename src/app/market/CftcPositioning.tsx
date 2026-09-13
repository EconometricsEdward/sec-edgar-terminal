'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Database, Download, ExternalLink, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { CFTC_CATEGORY_LABELS, CFTC_FAMILIES, cftcCsv } from '../../utils/cftc.js';
import { CFTC_HISTORY_REPORTS, cftcHeatCellDescription, cftcPercentileForHistory } from '../../utils/marketResearch.js';
import { clearPreparedCftc, fetchPreparedCftc } from '../../utils/cftcClient.js';
import { downloadText } from '../../utils/download.js';
import type { MarketView } from './marketTypes';
import s from './cftcPositioning.module.css';

type Props = { view: MarketView; onView: (patch: Partial<MarketView>, push?: boolean) => void; onNotice: (message: string) => void };
type PreviewFamily = { pending: boolean; data: any; error: string };
type PreviewState = Record<'tff' | 'disaggregated', PreviewFamily>;

const DEFAULTS: Record<MarketView['cftcFamily'], { contract: string; group: string }> = {
  tff: { contract: '13874A', group: 'leveraged-funds' },
  disaggregated: { contract: '067651', group: 'managed-money' },
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fmt = (value: unknown, digits = 1) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
const signed = (value: unknown, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${fmt(value, 1)}${suffix}` : '—';
const retrieved = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? `${value.slice(0, 16).replace('T', ' ')} UTC` : 'Unavailable';

function heatStyle(value: unknown, display: string) {
  if (!finite(value)) return undefined;
  const centered = display === 'percentile' ? value - 50 : value;
  const magnitude = Math.min(1, Math.abs(centered) / (display === 'percentile' ? 50 : 25));
  return { '--heat-alpha': String(0.12 + magnitude * 0.5) } as React.CSSProperties;
}

function SeriesChart({ points, field, title, formatter }: { points: any[]; field: string; title: string; formatter: (value: unknown) => string }) {
  const numeric = points.filter(point => finite(point[field]));
  const endpoint = points.at(-1);
  if (numeric.length < 2) return <div className={s.chart}><div className={s.chartHeading}><h3>{title}</h3><span>{endpoint?.reportDate || 'No report date'}</span></div><p className={s.empty}>This chart needs at least two compatible observations.</p></div>;
  const min = Math.min(...numeric.map(point => point[field])), max = Math.max(...numeric.map(point => point[field]));
  const times = points.map(point => Date.parse(`${point.reportDate}T00:00:00Z`)), first = Math.min(...times), last = Math.max(...times);
  const x = (index: number) => 24 + (times[index] - first) * 532 / Math.max(1, last - first);
  const y = (value: number) => max === min ? 106 : 172 - (value - min) * 132 / (max - min);
  const segments: string[] = [];
  let path = '';
  points.forEach((point, index) => {
    if (!finite(point[field])) { if (path) segments.push(path); path = ''; return; }
    path += `${path ? ' L' : 'M'} ${x(index)} ${y(point[field])}`;
  });
  if (path) segments.push(path);
  const endpointLabel = finite(endpoint?.[field]) ? formatter(endpoint[field]) : 'Unavailable';
  return <div className={s.chart}><div className={s.chartHeading}><h3>{title}</h3><span>{endpointLabel} · {endpoint?.reportDate}</span></div><svg viewBox="0 0 580 205" role="img" aria-label={`${title}, ${numeric.length} reported observations; selected endpoint ${endpoint?.reportDate} is ${endpointLabel}`}><line x1="24" x2="556" y1="172" y2="172" /><line x1="24" x2="556" y1="40" y2="40" />{segments.map((segment, index) => <path key={index} d={segment} />)}<text x="24" y="194">{points[0]?.reportDate}</text><text x="465" y="194">{endpoint?.reportDate}</text><text x="28" y="34">{formatter(max)}</text><text x="28" y="168">{formatter(min)}</text></svg></div>;
}

function SourceAgeNotice({ response, noun }: { response: any; noun: string }) {
  if (response?.freshness?.source_currency !== 'aged') return null;
  return <p className={s.warning} role="status"><AlertTriangle size={15} /><span><b>The source report is older than the current-data threshold.</b> The {noun} report date is {response.freshness.source_report_age_days} calendar days old; retrieval time does not make an older report current.</span></p>;
}

function HeatCell({ family, familyLabel, row, groupDef, display, historyWindow, onOpen }: { family: string; familyLabel: string; row: any; groupDef: any; display: MarketView['cftcDisplay']; historyWindow: MarketView['cftcHistory']; onOpen: () => void }) {
  const group = row.groups[groupDef.id];
  const percentile = cftcPercentileForHistory(group, historyWindow);
  const value = display === 'percentile' ? percentile.value : group?.netPctOi;
  const tone = value == null ? 'missing' : display === 'percentile' ? value < 33 ? 'low' : value > 66 ? 'high' : 'middle' : value >= 0 ? 'positive' : 'negative';
  const description = cftcHeatCellDescription({ family: familyLabel, row, group, groupLabel: groupDef.label, display, historyWindow });
  const tooltipId = `cftc-${family}-${row.code}-${groupDef.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  return <td><button data-sign={tone} style={heatStyle(value, display)} onClick={onOpen} aria-label={`${row.launchLabel || row.contractName}, ${groupDef.label}: ${value == null ? 'unavailable' : `${fmt(value)} percent`}`} aria-describedby={tooltipId} title={description}>{value == null ? '—' : `${fmt(value)}%`}<small>{display === 'percentile' ? `${percentile.observations}/${percentile.required} prior` : group?.oneWeekNetPctChange == null ? 'Weekly change unavailable' : signed(group.oneWeekNetPctChange, ' pp weekly')}</small></button><span className={s.heatTooltip} id={tooltipId} role="tooltip">{description}</span></td>;
}

export default function CftcPositioning({ view, onView, onNotice }: Props) {
  const [marketsState, setMarketsState] = useState<any>(null), [historyState, setHistoryState] = useState<{ key: string; data: any } | null>(null);
  const [loading, setLoading] = useState(true), [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState(''), [query, setQuery] = useState('');
  const [marketsRetry, setMarketsRetry] = useState(0), [historyRetry, setHistoryRetry] = useState(0);
  const family = view.cftcFamily;
  const familyConfig: any = CFTC_FAMILIES[family];
  const marketsPath = `/api/v1/cftc/markets?family=${encodeURIComponent(family)}`;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setMarketsState(null); setLoading(true); setError('');
    fetchPreparedCftc(marketsPath, { signal: controller.signal }).then(result => { if (active) setMarketsState(result); }).catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [marketsPath, marketsRetry]);

  const markets = marketsState?.report_family === family ? marketsState : null;
  const matchingCatalog = useMemo(() => (markets?.catalog || []).filter((item: any) => !query.trim() || `${item.marketName} ${item.exchange} ${item.code} ${item.commodity}`.toLowerCase().includes(query.trim().toLowerCase())), [markets, query]);
  const selectedMarket = markets?.catalog?.find((item: any) => item.code === view.cftcContract) || null;
  const knownContract = Boolean(selectedMarket);
  const suggestedContract = markets?.catalog?.find((item: any) => item.code === DEFAULTS[family].contract) || markets?.catalog?.[0] || null;
  const selectableCatalog = selectedMarket && !matchingCatalog.some((item: any) => item.code === selectedMarket.code) ? [selectedMarket, ...matchingCatalog] : matchingCatalog;
  const contract = knownContract ? view.cftcContract : '';
  const validGroup = markets?.groups?.some((item: any) => item.id === view.cftcGroup) ? view.cftcGroup : markets?.groups?.find((item: any) => item.id === DEFAULTS[family].group)?.id || markets?.groups?.[0]?.id || '';
  const historyKey = `${family}|${contract}|${validGroup}|${view.cftcDate}|${view.cftcHistory}`;
  const history = historyState?.key === historyKey ? historyState.data : null;
  const historyParams = contract && validGroup ? new URLSearchParams({ family, contract, group: validGroup, date: view.cftcDate, window: view.cftcHistory }) : null;
  const historyPath = historyParams ? `/api/v1/cftc/history?${historyParams}` : '';
  const groups = markets?.groups || [];
  const latestRows = markets?.latest || [];
  const selectedLookback = CFTC_HISTORY_REPORTS[view.cftcHistory];
  const spreadingSupported = Boolean(familyConfig.groups.find((item: any) => item.id === validGroup)?.spread);

  useEffect(() => {
    if (!markets || !validGroup || view.cftcGroup === validGroup) return;
    onView({ cftcGroup: validGroup });
  }, [markets, validGroup, view.cftcGroup, onView]);

  useEffect(() => {
    if (!markets || !historyPath) { setHistoryLoading(false); setHistoryError(''); return; }
    let active = true;
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError('');
    fetchPreparedCftc(historyPath, { signal: controller.signal }).then(result => { if (active) setHistoryState({ key: historyKey, data: result }); }).catch(reason => { if (active) { setHistoryState(null); setHistoryError(reason.message); } }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [markets, historyPath, historyKey, historyRetry]);

  function changeFamily(nextFamily: MarketView['cftcFamily']) {
    const defaults = DEFAULTS[nextFamily];
    setHistoryState(null); setQuery('');
    onView({ cftcFamily: nextFamily, cftcContract: defaults.contract, cftcGroup: defaults.group, cftcDate: 'latest' }, true);
  }
  function selectContract(code: string) { onView({ cftcContract: code, cftcDate: 'latest' }, true); }
  function retryMarkets() { clearPreparedCftc(marketsPath); setMarketsRetry(value => value + 1); }
  function retryHistory() { if (historyPath) clearPreparedCftc(historyPath); setHistoryRetry(value => value + 1); }
  function exportJson() { if (!history) return; downloadText(`cftc-${family}-${contract}-${validGroup}.json`, JSON.stringify(history, null, 2), 'application/json'); onNotice('CFTC JSON exported with source fields, dates, units, and formulas.'); }
  function exportCsv() { if (!history) return; downloadText(`cftc-${family}-${contract}-${validGroup}.csv`, cftcCsv(history), 'text/csv'); onNotice('CFTC CSV exported with formulas, coverage, dates, units, and source provenance.'); }

  return <section className={s.workspace} aria-label="CFTC Commitments of Traders positioning">
    <div className={s.intro}><div><span className={s.eyebrow}><BarChart3 size={15} />Official CFTC market context</span><h2>See how reported futures positions are distributed.</h2><p>Compare aggregated long and short positions across the CFTC’s two futures-only COT taxonomies. Every number stays tied to one contract, venue, report family, and Tuesday report date.</p></div><aside><ShieldCheck size={19} /><b>Positioning, not prices</b><span>Aggregated outstanding contracts. No equity returns, flows, issuer exposure, or trade signal is inferred.</span></aside></div>
    <nav className={s.familyTabs} aria-label="CFTC report family"><button aria-pressed={family === 'tff'} onClick={() => changeFamily('tff')}>TFF <span>Financial futures</span></button><button aria-pressed={family === 'disaggregated'} onClick={() => changeFamily('disaggregated')}>Disaggregated <span>Physical commodities</span></button></nav>
    {loading && <div className={s.state} role="status"><Loader2 className={s.spin} /><div><b>Loading the prepared CFTC snapshot</b><span>Catalog, latest positions, and launch-market history are independent of SEC data.</span></div></div>}
    {error && <div className={s.error} role="alert"><AlertTriangle /><div><b>CFTC positioning is temporarily unavailable</b><span>{error}</span></div><button onClick={retryMarkets}><RefreshCw size={14} />Retry {familyConfig.shortLabel}</button></div>}
    {markets && <>
      {markets.status === 'stale' && <p className={s.warning} role="status"><AlertTriangle size={15} /><span><b>Showing the last completed CFTC snapshot.</b> {markets.refresh_warning || 'The current refresh did not replace the preserved snapshot.'}</span></p>}
      {markets.status === 'partial' && <p className={s.warning} role="status"><AlertTriangle size={15} /><span><b>This CFTC snapshot has disclosed coverage or validation limits.</b> {markets.refresh_warning || `${markets.coverage.launch_available} of ${markets.coverage.launch_expected} launch markets are represented; ${markets.coverage.required_values_unavailable?.length || 0} launch rows have unavailable required values.`}</span></p>}
      <SourceAgeNotice response={markets} noun={familyConfig.shortLabel} />
      <div className={s.snapshotBar}><span><b>{familyConfig.shortLabel}</b> · Futures only</span><span>Source report <b>{markets.report_date}</b></span><span>Source-report age <b>{markets.freshness?.source_report_age_days ?? 'Unavailable'} days</b></span><span>Retrieved <b>{retrieved(markets.retrieved_at)}</b></span><span>Cache state <b>{markets.freshness?.cache_status || 'Unavailable'}</b></span></div>
      <div className={s.coverageBar} aria-label={`${familyConfig.shortLabel} snapshot coverage`}><span><b>{markets.catalog.length}</b> verified current contracts</span><span><b>{markets.coverage.launch_available} / {markets.coverage.launch_expected}</b> launch markets available</span><span><b>{markets.coverage.required_values_unavailable?.length || 0}</b> launch rows missing required values</span><span><b>{markets.coverage.quarantined_rows || 0}</b> quarantined source rows</span></div>
      {!knownContract && <div className={s.unsupported} role="alert"><AlertTriangle /><div><b>CFTC contract {view.cftcContract} is not supported in this {familyConfig.shortLabel} snapshot.</b><span>The requested code remains in the URL and has not been replaced. Choose a verified contract from the catalog to load positioning history.</span></div>{suggestedContract && <button onClick={() => selectContract(suggestedContract.code)}>Open {suggestedContract.launchLabel || suggestedContract.marketName} · {suggestedContract.code}</button>}</div>}
      <div className={s.controls}>
        <label className={s.search}><span>Find a contract</span><div><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Name, exchange, commodity, or code" /></div>{query.trim() && matchingCatalog.length === 0 && <small className={s.controlNote}>No verified contracts match this search. The current selection, if supported, remains unchanged.</small>}</label>
        <label><span>Verified contract</span><select value={contract} onChange={event => selectContract(event.target.value)}><option value="" disabled>{knownContract ? 'Select a verified contract' : `Unsupported · ${view.cftcContract}`}</option>{Object.entries(CFTC_CATEGORY_LABELS).map(([category, label]) => { const options = selectableCatalog.filter((item: any) => item.category === category); return options.length ? <optgroup key={category} label={label}>{options.map((item: any) => <option key={item.code} value={item.code}>{item.launch ? '★ ' : ''}{item.marketName} · {item.exchange} · {item.code}</option>)}</optgroup> : null; })}</select></label>
        <label><span>Trader category</span><select value={validGroup} onChange={event => onView({ cftcGroup: event.target.value, cftcDate: 'latest' }, true)}>{groups.map((item: any) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>History / percentile</span><select value={view.cftcHistory} onChange={event => onView({ cftcHistory: event.target.value as MarketView['cftcHistory'] }, true)}><option value="1y">52 prior reports</option><option value="3y">156 prior reports</option><option value="5y">260 prior reports</option></select></label>
        <label><span>Heatmap measure</span><select value={view.cftcDisplay} onChange={event => onView({ cftcDisplay: event.target.value as MarketView['cftcDisplay'] })}><option value="net-oi">Net / open interest</option><option value="percentile">Historical percentile</option></select></label>
      </div>

      <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>{familyConfig.shortLabel} heatmap</span><h2>Positioning across the launch selection</h2><p>{view.cftcDisplay === 'net-oi' ? 'Net contracts as a percentage of each market’s own open interest.' : `Within-contract ${selectedLookback}-prior-report percentile. Unavailable means the full selected comparable history is not present; this is not a cross-market percentile.`}</p></div><span className={s.legend}>{view.cftcDisplay === 'percentile' ? <><i data-tone="low" />Lower historical rank <i />Unavailable <i data-tone="high" />Higher historical rank</> : <><i />Net short <i />Unavailable <i />Net long</>}</span></div>{latestRows.length ? <div className={s.tableWrap} role="region" aria-label={`${familyConfig.shortLabel} positioning heatmap`} tabIndex={0}><table className={s.heatmap}><caption>{familyConfig.label} positioning heatmap with numeric table values and detailed cell descriptions</caption><thead><tr><th scope="col">Contract</th>{groups.map((group: any) => <th scope="col" key={group.id}>{group.label}</th>)}</tr></thead><tbody>{latestRows.map((row: any) => <tr key={row.code}><th scope="row"><button onClick={() => selectContract(row.code)}>{row.launchLabel || row.contractName}<small>{row.exchange} · {row.code}</small></button></th>{groups.map((groupDef: any) => <HeatCell key={groupDef.id} family={family} familyLabel={familyConfig.shortLabel} row={row} groupDef={groupDef} display={view.cftcDisplay} historyWindow={view.cftcHistory} onOpen={() => onView({ cftcContract: row.code, cftcGroup: groupDef.id, cftcDate: 'latest' }, true)} />)}</tr>)}</tbody></table></div> : <p className={s.empty}>No launch-selection rows are available in this partial snapshot. Use the verified contract catalog above for available markets.</p>}</section>

      <section className={s.panel}><div className={s.sectionHeading}><div><span className={s.eyebrow}>Latest report table</span><h2>{groups.find((item: any) => item.id === validGroup)?.label} across the {familyConfig.shortLabel} launch selection</h2><p>Compatible changes require a report exactly seven days earlier. Missing is never displayed as zero.</p></div></div>{latestRows.length ? <div className={s.tableWrap} role="region" aria-label={`${familyConfig.shortLabel} latest positioning table`} tabIndex={0}><table><thead><tr><th scope="col">Contract</th><th scope="col">Open interest</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Net</th><th scope="col">Net / OI</th><th scope="col">Weekly Δ net (contracts)</th><th scope="col">{selectedLookback}-prior-report rank</th></tr></thead><tbody>{latestRows.map((row: any) => { const group = row.groups[validGroup]; const percentile = cftcPercentileForHistory(group, view.cftcHistory); const comparison = percentile.comparisonRange; return <tr key={row.code}><th scope="row"><button className={s.textButton} onClick={() => selectContract(row.code)}>{row.launchLabel || row.contractName}</button><small>{row.code} · {row.exchange}</small></th><td>{fmt(row.openInterest, 0)}</td><td>{fmt(group?.long, 0)}</td><td>{fmt(group?.short, 0)}</td><td>{signed(group?.net)}</td><td>{signed(group?.netPctOi, '%')}</td><td>{signed(group?.oneWeekChange)}</td><td>{percentile.value == null ? <span title={`Needs ${percentile.required} prior valid reports`}>Insufficient</span> : `${fmt(percentile.value)}%`}<small>{comparison?.observations ?? percentile.observations} / {percentile.required} prior · {comparison?.earliest && comparison?.latest ? `${comparison.earliest} to ${comparison.latest}` : 'range unavailable'}</small></td></tr>; })}</tbody></table></div> : <p className={s.empty}>No launch-selection rows are available for this family.</p>}</section>

      <section className={s.detail}><div className={s.detailHead}><div><span className={s.eyebrow}>Contract detail</span><h2>{selectedMarket?.marketName || `Unsupported contract ${view.cftcContract}`}</h2><p>{selectedMarket ? `${selectedMarket.exchange} · CFTC code ${contract} · ${selectedMarket.units || 'Units unavailable'}` : 'Select a verified contract above. No substitute contract has been loaded.'}</p></div><div className={s.actions}><button disabled={!history} onClick={exportCsv}><Download size={14} />CSV</button><button disabled={!history} onClick={exportJson}><Download size={14} />JSON</button></div></div>
        {historyLoading && <p className={s.inlineState} role="status"><Loader2 className={s.spin} size={17} />Loading bounded contract history…</p>}
        {historyError && <div className={s.warning} role="alert"><AlertTriangle size={15} /><span>{historyError}</span><button onClick={retryHistory}><RefreshCw size={14} />Retry this history</button></div>}
        {history && <>
          <p className={s.srStatus} aria-live="polite">Loaded {history.selection.contract}, {history.selected.selectedGroup.label}, through {history.selected.reportDate}.</p>
          {history.status === 'stale' && <p className={s.warning} role="status"><AlertTriangle size={15} /><span><b>Showing preserved CFTC history.</b> {history.refresh_warning || 'The current refresh did not replace the preserved history.'}</span></p>}
          {history.status === 'partial' && <p className={s.warning} role="status"><AlertTriangle size={15} /><span><b>This history has disclosed coverage or validation limits.</b> {history.refresh_warning || `${history.coverage.required_values_unavailable?.length || 0} required selected fields are unavailable; ${history.quarantine?.length || 0} observations were withheld.`}</span></p>}
          <SourceAgeNotice response={history} noun="selected history" />
          <div className={s.detailStats}><div><span>Report date</span><strong>{history.selected.reportDate}</strong></div><div><span>{history.selected.selectedGroup.label} net</span><strong>{signed(history.selected.selectedGroup.net)}</strong><small>{signed(history.selected.selectedGroup.netPctOi, '% of OI')}</small></div><div><span>Exactly one week</span><strong>{signed(history.selected.oneWeekChange)}</strong><small>{history.selected.oneWeekChange == null ? 'Compatible date unavailable' : 'contracts'}</small></div><div><span>Exactly four weeks</span><strong>{signed(history.selected.fourWeekChange)}</strong><small>{history.selected.fourWeekChange == null ? 'Compatible date unavailable' : 'contracts'}</small></div><div><span>Previous available report</span><strong>{signed(history.selected.previousAvailableChange)}</strong><small>{history.selected.previousAvailableDate ? `${history.selected.previousAvailableDate} · ${history.selected.previousAvailableElapsedDays} days` : 'Unavailable'}</small></div><div><span>{history.percentile.required}-prior-report rank</span><strong>{history.percentile.value == null ? 'Insufficient' : `${fmt(history.percentile.value)}%`}</strong><small>{history.percentile.comparisonRange?.observations ?? history.percentile.observations} / {history.percentile.required} prior reports · {history.percentile.comparisonRange?.earliest && history.percentile.comparisonRange?.latest ? `${history.percentile.comparisonRange.earliest} to ${history.percentile.comparisonRange.latest}` : 'comparison range unavailable'}</small>{history.percentile.value == null && history.shorter_percentiles?.length > 0 && <span className={s.shorterRanks}>{history.shorter_percentiles.map((item: any) => <button key={item.required} onClick={() => onView({ cftcHistory: item.required === 52 ? '1y' : item.required === 156 ? '3y' : '5y' })}>Use {item.required}-report rank · {fmt(item.value)}%</button>)}</span>}</div></div>
          <div className={s.reportDate}><label htmlFor="cftc-report-date">Inspect report date</label><select id="cftc-report-date" value={history.selected.reportDate} onChange={event => onView({ cftcDate: event.target.value }, true)}>{[...history.history].reverse().map((point: any) => <option key={point.reportDate} value={point.reportDate}>{point.reportDate}</option>)}</select><button onClick={() => onView({ cftcDate: 'latest' }, true)}>Latest</button></div>
          <div className={s.charts}><SeriesChart points={history.history} field="net" title="Net position (contracts)" formatter={value => signed(value)} /><SeriesChart points={history.history} field="openInterest" title="Open interest (contracts)" formatter={value => fmt(value, 0)} /></div>
          <details className={s.dataTable}><summary>Accessible history table · {history.history.length} observations</summary><div className={s.tableWrap} role="region" aria-label="CFTC contract history" tabIndex={0}><table><thead><tr><th scope="col">Report date</th><th scope="col">Open interest</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Spreading</th><th scope="col">Net</th><th scope="col">Net / OI</th></tr></thead><tbody>{[...history.history].reverse().map((point: any) => <tr key={point.reportDate}><th scope="row">{point.reportDate}</th><td>{fmt(point.openInterest, 0)}</td><td>{fmt(point.long, 0)}</td><td>{fmt(point.short, 0)}</td><td>{point.spreadingStatus === 'not_applicable' || point.spreadingStatus == null && !spreadingSupported ? 'Not applicable' : point.spreadingStatus === 'unavailable' || point.spreading == null ? 'Unavailable' : fmt(point.spreading, 0)}</td><td>{signed(point.net)}</td><td>{signed(point.netPctOi, '%')}</td></tr>)}</tbody></table></div></details>
          <section className={s.participants}><h3>Participant breakdown</h3><div className={s.tableWrap} role="region" aria-label="CFTC participant breakdown" tabIndex={0}><table><thead><tr><th scope="col">Published category</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Spreading</th><th scope="col">Net</th><th scope="col">Net / OI</th></tr></thead><tbody>{history.participants.map((participant: any) => <tr key={participant.id}><th scope="row">{participant.label}</th><td>{fmt(participant.long, 0)}</td><td>{fmt(participant.short, 0)}</td><td>{participant.spreadingStatus === 'not_applicable' ? 'Not applicable' : fmt(participant.spreading, 0)}</td><td>{signed(participant.net)}</td><td>{signed(participant.netPctOi, '%')}</td></tr>)}</tbody></table></div></section>
          <details className={s.source}><summary><Database size={15} />Inspect source and calculation</summary><div className={s.sourceGrid}><dl><dt>Report family</dt><dd>{familyConfig.label}</dd><dt>Basis</dt><dd>Futures only</dd><dt>Contract code</dt><dd>{contract}</dd><dt>Venue code</dt><dd>{history.selected.venueCode || 'Unavailable'}</dd><dt>Report date</dt><dd>{history.selected.reportDate}</dd><dt>Source-report age</dt><dd>{history.freshness?.source_report_age_days ?? 'Unavailable'} days</dd><dt>Cache state</dt><dd>{history.freshness?.cache_status || 'Unavailable'}</dd><dt>Contract units</dt><dd>{history.selected.units || 'Unavailable'}</dd><dt>History observations</dt><dd>{history.coverage.observations}</dd><dt>History range</dt><dd>{history.coverage.earliest} to {history.coverage.latest}</dd><dt>Retrieved</dt><dd>{history.retrieved_at}</dd><dt>Formula version</dt><dd>{history.calculation_version}</dd></dl><div><p><b>Net contracts</b> = reported long − reported short.</p><p><b>Net / open interest</b> = 100 × net contracts / open interest, only when open interest is positive.</p><p><b>Percentile</b> compares the selected observation with the required prior observations from the same contract, venue, unit regime, family, and group. Later observations are excluded.</p><a href={history.source.url} target="_blank" rel="noreferrer">Open bounded CFTC resource query <ExternalLink size={13} /></a><a href={history.source.documentation} target="_blank" rel="noreferrer">Dataset documentation <ExternalLink size={13} /></a></div></div><div className={s.raw}><h4>Raw published fields</h4><div className={s.tableWrap} role="region" aria-label="Raw CFTC fields" tabIndex={0}><table><thead><tr><th scope="col">Field</th><th scope="col">Raw value</th></tr></thead><tbody>{Object.entries(history.selected.raw).map(([field, value]) => <tr key={field}><th scope="row">{field}</th><td>{value == null || value === '' ? 'Unavailable' : String(value)}</td></tr>)}</tbody></table></div></div></details>
        </>}
      </section>
      <details className={s.method}><summary>How to interpret COT positioning</summary><p>COT reports describe aggregated outstanding positions reported for a Tuesday, generally released later in the week. They do not identify individual traders, traded volume, cash flows, dollar inflows, issuer exposure, or automatic buy/sell signals. Contract conventions differ, so a long or short Treasury, rate, currency, or commodity position does not translate automatically into a yield, dollar, or price forecast.</p><p>TFF and Disaggregated categories are not interchangeable. Standard, micro, venue-specific, discontinued, and replacement contracts remain separate. Net contracts are never summed across unrelated markets.</p><a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noreferrer">CFTC COT guidance <ExternalLink size={13} /></a></details>
    </>}
  </section>;
}

export function CftcPositioningPreview({ onOpen }: { onOpen: () => void }) {
  const [state, setState] = useState<PreviewState>({ tff: { pending: true, data: null, error: '' }, disaggregated: { pending: true, data: null, error: '' } });
  useEffect(() => {
    let active = true;
    const controllers = { tff: new AbortController(), disaggregated: new AbortController() };
    const load = (family: keyof PreviewState) => {
      fetchPreparedCftc(`/api/v1/cftc/markets?family=${family}`, { signal: controllers[family].signal })
        .then(data => { if (active) setState(current => ({ ...current, [family]: { pending: false, data, error: '' } })); })
        .catch(reason => { if (active) setState(current => ({ ...current, [family]: { pending: false, data: null, error: reason instanceof Error ? reason.message : 'Unavailable' } })); });
    };
    load('tff'); load('disaggregated');
    return () => { active = false; Object.values(controllers).forEach(controller => controller.abort()); };
  }, []);
  return <section className={s.preview}><div><span className={s.eyebrow}>CFTC positioning</span><h2>Futures positioning, alongside—not inside—company research.</h2><p>Official futures-only COT reports provide separate market context across financial and physical contracts.</p></div><div className={s.previewStats}>{(['tff', 'disaggregated'] as const).map(family => { const item = state[family], label = CFTC_FAMILIES[family].shortLabel; return <span key={family} data-status={item.data?.status || (item.pending ? 'loading' : 'error')}>{item.pending ? <><b><Loader2 className={s.spin} size={14} />Loading</b>{label} report family</> : item.data ? <><b>{item.data.report_date}</b>{label} · {item.data.catalog.length} contracts<small>{item.data.status} · source age {item.data.freshness?.source_report_age_days ?? 'unavailable'} days</small></> : <><b>{label} unavailable</b><small title={item.error}>This report family could not be loaded.</small></>}</span>; })}</div><button onClick={onOpen}>Open CFTC Positioning</button></section>;
}
