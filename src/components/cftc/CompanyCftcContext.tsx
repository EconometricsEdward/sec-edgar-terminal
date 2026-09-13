"use client";

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, ChartNoAxesCombined, Download, FileText, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { CFTC_FAMILIES, CFTC_LAUNCH_CATALOG, cftcCsv } from '../../utils/cftc.js';
import { clearPreparedCftc, fetchPreparedCftc } from '../../utils/cftcClient.js';
import { cftcCompanyResearchNote, cftcContextChart, cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import { downloadText } from '../../utils/download.js';
import s from './CompanyCftcContext.module.css';

export type CftcScenarioContext = { label: string; contract: string; family: string; reportDate: string; summary: string; marketPath?: string };
type Props = { ticker: string; companyName?: string; asOf?: string; mode?: 'analysis' | 'risk'; onOpenScenario?: (context: CftcScenarioContext) => void; onSaveNote?: (text: string) => void };
type Candidate = { id: string; label: string; family: string; contract: string; group: string; reason: string; reviewQuestion: string; evidence: { text: string; url: string; accession: string; form: string; filed: string; reportDate: string }[] };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fmt = (value: unknown, decimals = 0) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) : 'Unavailable';
const signed = (value: unknown, decimals = 0, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${fmt(value, decimals)}${suffix}` : 'Unavailable';
const pct = (value: unknown) => finite(value) ? `${fmt(value, 1)}%` : 'Unavailable';
const retrieved = (value: string) => value ? `${value.slice(0, 16).replace('T', ' ')} UTC` : 'Unavailable';

export default function CompanyCftcContext(props: Props) {
  return <Context key={`${props.ticker}:${props.asOf || ''}`} {...props} />;
}

function Context({ ticker, companyName, asOf = '', mode = 'analysis', onOpenScenario, onSaveNote }: Props) {
  const [discovery, setDiscovery] = useState<any>(null);
  const [discovering, setDiscovering] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryRetry, setDiscoveryRetry] = useState(0);
  const [choice, setChoice] = useState('');
  const [groupOverride, setGroupOverride] = useState('');
  const [window, setWindow] = useState('1y');
  const [historyState, setHistoryState] = useState<{ key: string; data: any } | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRetry, setHistoryRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const discoveryPath = `/api/v1/cftc/company-context?${new URLSearchParams({ ticker, ...(asOf ? { asOf } : {}) })}`;

  useEffect(() => {
    const controller = new AbortController();
    setDiscovering(true); setDiscoveryError('');
    fetchPreparedCftc(discoveryPath, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setDiscovery(value);
    }).catch(error => { if (!controller.signal.aborted) setDiscoveryError(error.message); }).finally(() => { if (!controller.signal.aborted) setDiscovering(false); });
    return () => controller.abort();
  }, [discoveryPath, discoveryRetry]);

  const candidates: Candidate[] = discovery?.ticker === ticker ? discovery.links || [] : [];
  const selectedId = choice || candidates[0]?.id || '';
  const candidate = candidates.find(item => item.id === selectedId) || null;
  const manual = selectedId.startsWith('manual:') ? CFTC_LAUNCH_CATALOG.find(item => `${item.family}:${item.code}` === selectedId.slice(7)) : null;
  const family = candidate?.family || manual?.family || '';
  const contract = candidate?.contract || manual?.code || '';
  const label = candidate?.label || manual?.label || '';
  const familyConfig = CFTC_FAMILIES[family];
  const group = familyConfig?.groups.some(item => item.id === groupOverride) ? groupOverride : candidate?.group || (family === 'tff' ? 'leveraged-funds' : 'managed-money');
  const historyPath = contract && family ? `/api/v1/cftc/history?${new URLSearchParams({ family, contract, group, window, date: 'latest' })}` : '';
  const history = historyState?.key === historyPath ? historyState.data : null;
  useEffect(() => {
    if (!historyPath) return;
    const controller = new AbortController();
    setHistoryPending(true); setHistoryError('');
    fetchPreparedCftc(historyPath, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setHistoryState({ key: historyPath, data: value });
    }).catch(error => { if (!controller.signal.aborted) setHistoryError(error.message); }).finally(() => { if (!controller.signal.aborted) setHistoryPending(false); });
    return () => controller.abort();
  }, [historyPath, historyRetry]);

  const chart = useMemo(() => cftcContextChart(history?.history || []), [history]);
  const weekly = useMemo(() => cftcPositionChange(history), [history]);
  const fourWeeks = useMemo(() => cftcPositionChange(history, 4), [history]);
  const thirteenWeeks = useMemo(() => cftcPositionChange(history, 13), [history]);
  const selected = history?.selected;
  const values = selected?.selectedGroup;
  const marketPath = history ? `/market?${new URLSearchParams({ tab: 'positioning', family, contract, group, date: selected.reportDate, history: window, display: 'net-oi' })}` : '';
  const note = history ? cftcCompanyResearchNote({ ticker, companyName, candidate, history, asOf }) : '';
  function choose(id: string) { setChoice(id); setGroupOverride(''); setNotice(''); setHistoryError(''); }
  function retryDiscovery() { clearPreparedCftc(discoveryPath); setDiscoveryRetry(value => value + 1); }
  function retryHistory() { clearPreparedCftc(historyPath); setHistoryRetry(value => value + 1); }

  return <section className={s.root} aria-label={`${ticker} CFTC market context`}>
    <header className={s.hero}>
      <div><span className={s.eyebrow}><ChartNoAxesCombined size={15} />Company evidence · Market context</span><h2>Connect {ticker}’s disclosures to futures positioning.</h2><p>Review the company connection, inspect the latest market observations, and decide what deserves a closer look.</p></div>
      <span className={s.sourceBadge}>Official CFTC COT<br /><small>Futures-only reports</small></span>
    </header>
    {asOf && <p className={s.warning}><b>Historical SEC cutoff: {asOf}.</b> The CFTC observations below are current market context and may postdate this cutoff. They are excluded from historical financial calculations and are not presented as information available at that time.</p>}
    <div className={s.connections}>
      <div className={s.sectionTitle}><div><span className={s.step}>01 / Company connection</span><h3>Start with the filing evidence</h3></div>{discovery?.filing && <a href={discovery.filing.url} target="_blank" rel="noreferrer">{discovery.filing.form} · Filed {discovery.filing.filed}<ArrowUpRight size={14} /></a>}</div>
      {discovering && <p className={s.loading} role="status"><Loader2 size={16} className={s.spin} /> Checking an annual filing for relevant market disclosures. You can also choose a market below.</p>}
      {discoveryError && <div className={s.warning} role="alert"><p>Company evidence is temporarily unavailable: {discoveryError}</p><button type="button" onClick={retryDiscovery}><RefreshCw size={14} />Retry filing evidence</button></div>}
      {!discovering && !discoveryError && !candidates.length && <div className={s.empty}><BookOpen size={20} /><div><b>No specific company connection established</b><p>{discovery?.status === 'no_matches' ? 'The bounded annual-filing scan did not find a supported market passage. This does not establish that the company has no exposure.' : 'A usable annual filing could not be matched for this review.'} Choose a market for your own research below.</p>{discovery?.retryable && <button type="button" onClick={retryDiscovery}>Retry evidence</button>}</div></div>}
      {candidates.length > 0 && <div className={s.candidateGrid}>{candidates.map(item => <button type="button" key={item.id} aria-pressed={selectedId === item.id} className={s.candidate} onClick={() => choose(item.id)}><span>Filing passage matched</span><strong>{item.label}<ArrowUpRight size={14} /></strong><small>Candidate connection · review required</small></button>)}</div>}
      {candidate && <div className={s.evidence}><div><FileText size={17} /><div><h3>Why this market appears</h3><p>{candidate.reason}</p></div></div>{candidate.evidence.slice(0, 2).map((item, index) => <blockquote key={`${item.accession}:${index}`}><p>“{item.text}”</p><cite><a href={item.url} target="_blank" rel="noreferrer">{item.form} · Filed {item.filed} · Period {item.reportDate || 'not provided'}<ArrowUpRight size={12} /></a></cite></blockquote>)}<p className={s.note}>An automated passage match is a research lead. It does not establish the company’s position, hedge size, or sensitivity to this contract.</p></div>}
      <details className={s.manual} open={!candidates.length}><summary>Choose your own market</summary><label>Research market<select value={manual ? selectedId : ''} onChange={event => choose(event.target.value)}><option value="">Select a market for independent context</option>{['tff', 'disaggregated'].map(reportFamily => <optgroup key={reportFamily} label={CFTC_FAMILIES[reportFamily].label}>{CFTC_LAUNCH_CATALOG.filter(item => item.family === reportFamily).map(item => <option key={item.code} value={`manual:${item.family}:${item.code}`}>{item.label} · {item.code}</option>)}</optgroup>)}</select></label>{manual && <p className={s.note}>You selected {manual.label}. No company connection is inferred from this selection.</p>}</details>
      {discovery?.coverage && <details className={s.coverage}><summary>Evidence coverage and limits</summary><p>{discovery.coverage.filingsScanned || 0} annual filings scanned · {fmt(discovery.coverage.textCharactersScanned)} text characters checked{discovery.coverage.historyLimited ? ' · Filing-history search was limited' : ''}{discovery.coverage.textTruncated ? ' · Filing text was truncated' : ''}.</p>{(discovery.limitations || []).map((item: string, i: number) => <p key={i}>{item}</p>)}</details>}
    </div>
    {contract && <div className={s.observations}>
      <div className={s.sectionTitle}><div><span className={s.step}>02 / Market observations</span><h3>{label}</h3><p>{familyConfig?.label} · Code {contract}</p></div><div className={s.controls}><label>Trader category<select value={group} onChange={event => { setGroupOverride(event.target.value); setNotice(''); }}>{familyConfig?.groups.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>Comparison history<select value={window} onChange={event => { setWindow(event.target.value); setNotice(''); }}><option value="1y">52 prior reports</option><option value="3y">156 prior reports</option><option value="5y">260 prior reports</option></select></label></div></div>
      {historyPending && <p className={s.loading} role="status"><Loader2 size={16} className={s.spin} /> Loading {label} positioning…</p>}
      {historyError && <div className={s.warning} role="alert"><p>{historyError}</p><button type="button" onClick={retryHistory}><RefreshCw size={14} />Retry CFTC data</button></div>}
      {history && !historyPending && !historyError && <>
        <div className={s.dates}><span>Positions as of <b>{selected.reportDate}</b></span><span>Retrieved <b>{retrieved(history.retrieved_at)}</b></span><span>Report age <b>{history.freshness?.source_report_age_days ?? 'Unknown'} days</b></span><span>{selected.exchange}</span></div>
        {(history.status !== 'ready' || history.freshness?.source_currency === 'aged' || String(history.freshness?.cache_status).startsWith('stale')) && <p className={s.warning}><b>{history.status === 'stale' || String(history.freshness?.cache_status).startsWith('stale') ? 'Last successful snapshot.' : 'Coverage or freshness needs review.'}</b> {history.refresh_warning || `Response status: ${history.status}. Some observations may be missing or older than expected.`}</p>}
        <div className={s.metrics}>
          <div><span>Net / open interest</span><strong>{pct(values?.netPctOi)}</strong><small>{signed(values?.net)} net contracts</small></div>
          <div><span>Weekly change in net / OI</span><strong>{signed(selected.oneWeekNetPctChange, 2)}</strong><small>Percentage points · exact 7-day comparison</small></div>
          <div><span>{history.percentile?.required}-report percentile</span><strong>{pct(history.percentile?.value)}</strong><small>{history.percentile?.observations}/{history.percentile?.required} valid prior observations</small></div>
          <div><span>Market open interest</span><strong>{fmt(selected.openInterest)}</strong><small>Outstanding futures contracts</small></div>
        </div>
        <div className={s.chartReview}>
          <div className={s.chartPanel}><h3>{values?.label} · Net / open interest</h3><p className={s.note}>Each observation uses that report’s open interest. Gaps remain visible.</p>{chart ? <svg className={s.chart} viewBox="0 0 680 210" role="img" aria-label={`Net position as a percentage of open interest, ${chart.count} observations from ${chart.start} to ${chart.end}. The full numeric history follows below.`}><line x1="48" x2="640" y1={chart.zeroY} y2={chart.zeroY} className={s.zeroLine} />{chart.paths.map((path, i) => <path key={i} d={path} />)}{chart.dots.map(dot => <circle key={dot.date} cx={dot.x} cy={dot.y} r="1.7"><title>{dot.date}: {dot.value.toFixed(2)}%</title></circle>)}<text x="4" y="40">{chart.max.toFixed(1)}%</text><text x="4" y="174">{chart.min.toFixed(1)}%</text><text x="48" y="202">{chart.start}</text><text x="560" y="202">{chart.end}</text></svg> : <p className={s.empty}>At least two compatible observations are needed to draw the chart.</p>}</div>
          <aside className={s.review}><span className={s.step}>What changed?</span><h3>Separate longs from shorts</h3><p>{weekly.available ? weekly.explanation : weekly.reason}</p>{weekly.available && <dl><div><dt>Change in reported longs</dt><dd>{signed(weekly.longChange)}</dd></div><div><dt>Change in reported shorts</dt><dd>{signed(weekly.shortChange)}</dd></div><div><dt>Net change: longs − shorts</dt><dd>{signed(weekly.netChange)}</dd></div></dl>}<p className={s.note}>Changes describe outstanding positions, not cash flows or the reasons traders held them.</p></aside>
        </div>
        <div className={s.horizons}>{[[fourWeeks, 'Four weeks'], [thirteenWeeks, 'Thirteen weeks']].map(([value, name]: any) => <div key={name}><b>{name}</b><span>{value.available ? `${signed(value.netChange)} net contracts` : 'Comparison unavailable'}</span><small>{value.available ? `${signed(value.netPctChange, 2)} percentage points in net / OI` : value.reason}</small></div>)}</div>
        <div className={s.question}><span className={s.step}>03 / Your next research question</span><p>{candidate?.reviewQuestion || (mode === 'risk' ? 'Does this market relate to a disclosed funding, input-cost, currency, or collateral risk? Verify the connection in the company’s filings before using it in your review.' : 'Which disclosed business driver could make this market relevant to the company? Review the filing before linking these aggregate positions to company results.')}</p></div>
        <div className={s.actions}>
          <a className={s.button} href={marketPath}>Explore this CFTC market<ArrowUpRight size={14} /></a>
          {onSaveNote && <button type="button" onClick={() => { onSaveNote(note); setNotice('Dated CFTC context added to your analysis notebook draft.'); }}><BookOpen size={14} />Add to notebook</button>}
          {onOpenScenario && <button type="button" onClick={() => onOpenScenario({ label, contract, family, reportDate: selected.reportDate, summary: note, marketPath })}><FlaskConical size={14} />Use as scenario context</button>}
          <button type="button" onClick={() => { downloadText(`${ticker}-cftc-context-${selected.reportDate}.md`, note, 'text/markdown'); setNotice('Research note exported with separate SEC and CFTC source dates.'); }}><Download size={14} />Research note</button>
          <button type="button" onClick={() => downloadText(`cftc-${contract}-${group}-${selected.reportDate}.csv`, cftcCsv(history), 'text/csv')}>History CSV</button>
        </div>
        <details className={s.tableDetails}><summary>Inspect numeric history · {history.history.length} observations</summary><div className={s.tableWrap} role="region" aria-label="Company context CFTC history" tabIndex={0}><table><thead><tr><th>Report date</th><th>Long</th><th>Short</th><th>Net</th><th>Open interest</th><th>Net / OI</th></tr></thead><tbody>{[...history.history].reverse().map((point: any) => <tr key={point.reportDate}><th scope="row">{point.reportDate}</th><td>{fmt(point.long)}</td><td>{fmt(point.short)}</td><td>{signed(point.net)}</td><td>{fmt(point.openInterest)}</td><td>{pct(point.netPctOi)}</td></tr>)}</tbody></table></div></details>
        <details className={s.coverage}><summary>Source, calculations, and interpretation</summary><p>Source: <a href={history.source.url} target="_blank" rel="noreferrer">Official CFTC resource<ArrowUpRight size={13} /></a> · <a href={history.source.documentation} target="_blank" rel="noreferrer">Dataset documentation</a></p><p>Net = reported longs − reported shorts. Net / open interest = 100 × net / market open interest. The percentile compares the selected observation with the stated number of prior compatible reports from the same contract and trader category.</p><p>Comparison range: {history.percentile?.comparisonRange?.earliest || 'Unavailable'} to {history.percentile?.comparisonRange?.latest || 'Unavailable'}. Contract units: {selected.units}. Cache state: {history.freshness?.cache_status}.</p><p>{history.coverage?.required_values_unavailable?.length || 0} observations with missing required fields · {history.quarantine?.length || 0} source rows excluded by validation. Missing values remain unavailable.</p></details>
      </>}
    </div>}
    {notice && <p className={s.notice} role="status">{notice}</p>}
    <p className={s.scope}>CFTC reports describe aggregate futures positions by trader category. They do not identify {ticker}’s holdings or establish a price forecast. Company financial ratios, risk screens, and user-entered scenario assumptions remain separate.</p>
  </section>;
}
