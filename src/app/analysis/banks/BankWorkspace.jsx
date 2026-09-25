'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import BankSearch from './BankSearch';
import BankTrendDashboard from './BankTrendDashboard';
import BankCompareVisuals from './BankCompareVisuals';
import { BANK_COLORS } from '../../../utils/bank/visuals.js';
import { BANK_METRICS } from '../../../utils/bank/definitions.js';
import { GROUPS, PENDING, bankHref, bankMetric, bankReport, formatBankMetric, metricChange, quarterLabel, unavailableReason } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';
const TrendChart = dynamic(() => import('./BankTrendChart'), { ssr: false, loading: () => <p className={styles.basis}>Loading chart…</p> });
const sameBank = (a, b) => String(a) === String(b);
export default function BankWorkspace({ initialState, rssd, options, error }) {
  const router = useRouter();
  const [state, setState] = useState(initialState), [requesting, setRequesting] = useState(''), [notice, setNotice] = useState(''), [copied, setCopied] = useState(false);
  useEffect(() => { setState(initialState); }, [initialState]);
  const selection = [rssd, ...options.peers].join(',');
  const pending = state.jobs?.some(j => PENDING.has(j.status));
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController(); let timer, stopped = false, attempts = 0;
    const poll = async () => {
      try {
        if (document.visibilityState !== 'hidden') {
          const response = await fetch(`/api/banks?rssds=${selection}`, { signal: controller.signal });
          const body = await response.json();
          if (response.ok) { setState(body); if (!body.jobs?.some(j => PENDING.has(j.status))) return; }
        }
      } catch (e) { if (e.name === 'AbortError') return; }
      if (!stopped && ++attempts < 90) timer = setTimeout(poll, Math.min(30000, 5000 + attempts * 2000));
    };
    timer = setTimeout(poll, 4000);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [pending, selection]);
  const bank = state.banks?.find(b => sameBank(b.id_rssd, rssd));
  const banks = [rssd, ...options.peers].map(id => state.banks?.find(b => sameBank(b.id_rssd, id))).filter(Boolean);
  const periods = state.periods || [];
  const period = options.period || periods[0] || '';
  const navigate = changes => router.push(bankHref(rssd, { ...options, period, ...changes }), { scroll: false });
  const href = changes => bankHref(rssd, { ...options, period, ...changes });
  async function prepare(id) {
    setRequesting(String(id)); setNotice('');
    try {
      const response = await fetch('/api/banks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rssd: String(id) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Bank preparation is temporarily unavailable.');
      const refresh = await fetch(`/api/banks?rssds=${selection}`, { cache: 'no-store' });
      if (!refresh.ok) throw new Error('Preparation was accepted. Reload shortly to see the latest status.');
      setState(await refresh.json());
      setNotice(body.queued ? 'Preparation requested. This page updates automatically; you can also return using this link.' : 'This bank is already prepared or in the preparation queue.');
    } catch (e) { setNotice(e.message); } finally { setRequesting(''); }
  }
  async function share() { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { setNotice('Use the address in your browser to share this view.'); } }
  const report = bankReport(state, rssd, period);
  return <div className={styles.page}>
    <div className={styles.eyebrow}><Link href="/analysis/banks">BANKSCOPE</Link><span>FFIEC · CALL REPORT RESEARCH</span></div>
    <header className={styles.header}><div><h1 className={styles.bankTitle}>{bank?.legal_name || `RSSD ${rssd}`}</h1><p>{[bank?.city, bank?.state].filter(Boolean).join(', ')}{bank?.city || bank?.state ? ' · ' : ''}RSSD {rssd}{bank?.fdic_certificate ? ` · FDIC ${bank.fdic_certificate}` : ''}{bank?.form_type ? ` · FFIEC ${bank.form_type}` : ''}</p><p>Legal bank entity · Figures may differ from its holding company.</p></div><button type="button" onClick={share}>{copied ? 'Link copied' : 'Copy view link'}</button></header>
    <details className={styles.switchBank}><summary>Find another bank</summary><BankSearch compact /></details>
    {(error || notice) && <p className={styles.notice} role="status">{error ? 'Bank research is temporarily unavailable. Please reload to try again.' : notice}</p>}
    <nav className={styles.tabs} aria-label="Bank research views">{[['overview', 'Overview'], ['compare', 'Compare'], ['trends', 'Trends']].map(([view, label]) => <Link key={view} href={href({ view, ...(view === 'trends' && options.view !== 'trends' ? { basis: 'quarterly' } : {}) })} scroll={false} aria-current={options.view === view ? 'page' : undefined}>{label}</Link>)}</nav>
    <div className={styles.toolbar}><div><h2>{options.view === 'compare' ? 'Compare FFIEC banks' : options.view === 'trends' ? 'The financial trajectory' : 'The bank at a glance'}</h2><p>{options.view === 'compare' ? 'One reporting date. Consistent units. Up to four legal banks.' : options.view === 'trends' ? 'See balances, earnings and capital evolve over time.' : 'Capital, credit quality, funding and earnings.'}</p></div>{options.view !== 'trends' && <label>Report date<select value={period} onChange={e => navigate({ period: e.target.value })} disabled={!periods.length}>{period && !periods.includes(period) && <option value={period}>{quarterLabel(period)} · Outside available history</option>}{periods.map(p => <option key={p} value={p}>{quarterLabel(p)} · {p}</option>)}</select></label>}</div>
    <Preparation bank={bank} state={state} requesting={requesting} onPrepare={prepare} />
    {options.view === 'overview' && (report?.validation?.passed ? <Overview report={report} bank={bank} /> : <EmptyPeriod state={state} rssd={rssd} period={period} />)}
    {options.view === 'compare' && <>
      <div className={styles.peerChips}>{banks.map((b, i) => <span key={b.id_rssd} style={{ '--accent': BANK_COLORS[i] }}><strong><i className={styles.bankNumber}>{i + 1}</i>{b.legal_name}</strong><small>RSSD {b.id_rssd}{i === 0 ? ' · Selected bank' : ''}</small>{i > 0 && <button type="button" onClick={() => navigate({ peers: options.peers.filter(id => !sameBank(id, b.id_rssd)) })} aria-label={`Remove ${b.legal_name}`}>×</button>}</span>)}</div>
      {options.peers.some(id => !banks.some(b => sameBank(b.id_rssd, id))) && <p className={styles.notice}>A linked peer is not in the FFIEC directory. <button onClick={() => navigate({ peers: options.peers.filter(id => banks.some(b => sameBank(b.id_rssd, id))) })}>Remove unavailable peers</button></p>}
      {banks.length < 4 && <BankSearch compact label="Add an FFIEC bank to compare" exclude={banks.map(b => b.id_rssd)} onSelect={b => navigate({ peers: [...options.peers, String(b.id_rssd)].slice(0, 3) })} />}
      {banks.slice(1).map(b => <Preparation key={b.id_rssd} bank={b} state={state} requesting={requesting} onPrepare={prepare} />)}
      <Compare state={state} banks={banks} period={period} basis={options.basis} onBasis={basis => navigate({ basis })} />
    </>}
    {options.view === 'trends' && <Trends state={state} rssd={rssd} options={options} onChange={navigate} />}
    <footer className={styles.footer}><div><strong>Source first. Bank by bank.</strong><p>FFIEC 031, 041 and 051 Call Reports · USD millions, except ratios. Missing values stay unavailable. N/A means the item does not apply to the form or capital framework.</p><p>Four latest available reporting periods. Prepared banks are checked for new submissions daily while active. Original source versions are retained.</p></div><Link href="/analysis/banks">All banks →</Link></footer>
  </div>;
}
function Preparation({ bank, state, requesting, onPrepare }) {
  if (!bank) return null;
  const jobs = state.jobs?.filter(j => sameBank(j.id_rssd, bank.id_rssd)) || [];
  const running = jobs.some(j => PENDING.has(j.status));
  const ready = state.periods?.filter(p => bankReport(state, bank.id_rssd, p)?.validation?.passed).length || 0;
  const available = bank.available_periods || state.periods || [];
  const complete = available.length && ready === available.length;
  if (complete && !running) return null;
  const unrequested = available.some(p => !jobs.some(j => j.report_date === p));
  const problem = jobs.some(j => ['review', 'unavailable'].includes(j.status));
  return <section className={styles.preparation} aria-label={`Preparation for ${bank.legal_name}`}><div><strong>{bank.legal_name}</strong><p role="status">{ready} / {available.length || 4} eligible quarters ready{running ? ' · Preparing Call Reports…' : problem ? ' · Some periods are unavailable or require review.' : ' · Prepare this bank’s recent Call Reports to begin.'}</p>{running && <p>Preparation continues if you leave this page. Busy periods can take a few minutes.</p>}</div>{unrequested && !running && <button className={styles.primaryButton} disabled={!!requesting} onClick={() => onPrepare(bank.id_rssd)}>{sameBank(requesting, bank.id_rssd) ? 'Requesting…' : 'Prepare Call Reports'}</button>}</section>;
}
function EmptyPeriod({ state, rssd, period }) {
  const job = state.jobs?.find(j => sameBank(j.id_rssd, rssd) && j.report_date === period);
  const bank = state.banks?.find(b => sameBank(b.id_rssd, rssd));
  if (bank?.available_periods && !bank.available_periods.includes(period)) return <div className={styles.empty}><h3>No Call Report listing for this date</h3><p>{quarterLabel(period)} · This bank is not listed in the FFIEC reporting panel for this period. Choose another reporting date.</p></div>;
  return <div className={styles.empty}><h3>{PENDING.has(job?.status) ? 'Preparing this reporting period' : job?.status === 'review' ? 'This report needs a financial review' : 'No prepared report for this period'}</h3><p>{quarterLabel(period)} · A different reporting date is never substituted. {job?.status === 'review' ? 'Figures are withheld until the source and financial checks can be reconciled.' : 'Use the preparation control above or choose an available quarter.'}</p></div>;
}
function MetricValue({ metric, exact = false }) { return <span title={metric?.value == null ? unavailableReason(metric) : undefined}>{formatBankMetric(metric, { exact })}</span>; }
function Overview({ report, bank }) {
  const metrics = report.metrics;
  return <><p className={styles.basis}>Amounts in USD millions, except ratios. Balance sheet and credit quality are quarter-end; earnings and charge-offs are calendar year to date. <strong>Financial checks passed</strong>{report.source_metadata?.capitalFramework === 'CBLR' && <span> · Community Bank Leverage Ratio framework</span>}</p>
    <section className={styles.highlights} aria-label="Financial overview">{['assets', 'loans', 'deposits', 'equity', 'net_income'].map(key => { const m = metrics.find(x => x.key === key); return m && <div key={key}><span>{m.label}{m.period === 'ytd' ? ' · YTD' : ''}</span><strong><MetricValue metric={m} /></strong><small>{m.schedule} · {m.codes.join(' + ')}</small></div>; })}</section>
    <div className={styles.groups}>{GROUPS.map(group => <section key={group} className={styles.group}><h2>{group}</h2>{BANK_METRICS.filter(m => m.group === group).map(def => { const m = metrics.find(x => x.key === def.key); return m && <MetricDetail key={`${report.source_sha256}-${m.key}`} metric={m} report={report} />; })}</section>)}</div>
    <SourceRecord report={report} bank={bank} />
  </>;
}
function MetricDetail({ metric: m, report }) {
  const [source, setSource] = useState(null), [status, setStatus] = useState('');
  async function load(event) {
    if (!event.currentTarget.open || source || status === 'Loading source details…') return;
    setStatus('Loading source details…');
    try { const response = await fetch(sourceUrl(report, m.key)); if (!response.ok) throw new Error(); setSource(await response.json()); setStatus(''); } catch { setStatus('Source details could not be loaded. Close and reopen to try again.'); }
  }
  return <details onToggle={load}><summary><span>{m.label}{m.period === 'ytd' ? ' · YTD' : ''}</span><strong><MetricValue metric={m} /></strong></summary><div className={styles.lineage}><p>{m.basis}</p><p>{m.schedule}, item {m.item} · {m.status?.replaceAll('_', ' ')}{m.value == null ? ` · ${unavailableReason(m)}` : ''}</p><p>{m.formula || m.codes.join(' / ')}{m.unit === 'percent' ? ' · XBRL pure fraction × 100' : ' · XBRL USD; shown above in millions'}</p><p>Exact value: <MetricValue metric={m} exact />{m.unit === 'USD' ? ' USD millions' : ''}</p>{status && <p role="status">{status}</p>}{source?.lineage?.map((f, i) => <p key={i}><code>{f.code}</code> = {f.rawValue ?? 'Unavailable'} {f.unit} · context {f.contextRef || 'Unavailable'}{f.contextNote ? ` · ${f.contextNote}` : ''}{f.corroboration ? ` · Corroboration: ${f.corroboration.map(c => `${c.code} = ${c.rawValue}`).join(' minus ')}` : ''}</p>)}{source?.frameworkLineage?.map((f, i) => <p key={`framework-${i}`}>Capital framework election: {f.code} = {f.rawValue}</p>)}</div></details>;
}
function sourceUrl(report, metric) { return `/api/banks/source?${new URLSearchParams({ rssd: String(report.id_rssd), period: report.report_date, hash: report.source_sha256, ...(metric ? { metric } : {}) })}`; }
function SourceRecord({ report, bank }) {
  return <details className={styles.audit}><summary>Source and validation record · {quarterLabel(report.report_date)}</summary><p>{bank?.legal_name} · RSSD {report.id_rssd} · FFIEC {report.form_type}</p><p>Retrieved {report.retrieved_at}. FFIEC submission: {report.submission_date_raw || 'Unavailable'} (source timezone not specified).</p><p className={styles.hash}>SHA-256: {report.source_sha256}</p><p><a href={sourceUrl(report)} download>Download original FFIEC XBRL</a> · <a href={`https://www.ffiec.gov/resources/reporting-forms/ffiec${report.form_type}`} target="_blank" rel="noreferrer">Form {report.form_type} and instructions ↗</a></p><ul>{report.validation?.checks?.map(c => <li key={c.name}>{c.passed ? 'Passed' : 'Review'} · {c.name.replaceAll('_', ' ')}</li>)}</ul></details>;
}
function BasisControl({ basis, onChange }) { return <label>Earnings &amp; credit loss flows<select value={basis} onChange={e => onChange(e.target.value)}><option value="ytd">Reported year to date</option><option value="quarterly">Individual quarter</option></select></label>; }
function Compare({ state, banks, period, basis, onBasis }) {
  return <><div className={styles.toolbar}><p className={styles.basis}>Amounts in USD millions; ratios in %. Balances are at quarter-end. {basis === 'quarterly' ? 'Quarterly flows = current YTD minus previous YTD; Q1 equals YTD.' : 'Earnings and charge-offs are calendar year to date.'}</p><BasisControl basis={basis} onChange={onBasis} /></div>
    <BankCompareVisuals state={state} banks={banks} period={period} basis={basis} />
    <details className={styles.exactDetails}><summary>All comparison figures <span>35 reported metrics · exact values</span></summary>
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Bank comparison table"><table className={styles.comparison}><caption>FFIEC bank comparison · {quarterLabel(period)} · {basis === 'quarterly' ? 'Individual-quarter flows' : 'YTD flows'}</caption><thead><tr><th scope="col">Metric</th>{banks.map(b => <th key={b.id_rssd} scope="col"><Link href={bankHref(b.id_rssd, { period })}>{b.legal_name}</Link><small>RSSD {b.id_rssd} · FFIEC {bankReport(state, b.id_rssd, period)?.form_type || b.form_type}</small><small>{bankReport(state, b.id_rssd, period)?.validation?.passed ? 'Financial checks passed' : 'No validated report for this date'}</small></th>)}</tr></thead>{['Overview', 'Capital', 'Credit quality', 'Funding', 'Earnings'].map(group => <tbody key={group}><tr className={styles.groupRow}><th colSpan={banks.length + 1} scope="colgroup">{group}</th></tr>{BANK_METRICS.filter(m => m.group === group).map(m => <tr key={m.key}><th scope="row">{m.label}{m.period === 'ytd' && <small>{basis === 'quarterly' ? 'Individual quarter' : 'Year to date'}</small>}</th>{banks.map(b => { const value = bankMetric(state, b.id_rssd, period, m.key, basis); return <td key={b.id_rssd}><MetricValue metric={value} exact />{value.value == null && <small>{unavailableReason(value)}</small>}</td>; })}</tr>)}</tbody>)}</table></div></details>
    <p className={styles.basis}>Form 031 may include foreign offices; forms 041 and 051 cover domestic offices. CBLR banks do not report the same risk-based capital measures. Bank size and business model affect comparability.</p>
    {banks.map(b => { const r = bankReport(state, b.id_rssd, period); return r?.validation?.passed && <SourceRecord key={b.id_rssd} report={r} bank={b} />; })}
  </>;
}
function Trends({ state, rssd, options, onChange }) {
  const def = BANK_METRICS.find(m => m.key === options.metric) || BANK_METRICS[0];
  const dates = useMemo(() => [...(state.periods || [])].sort(), [state.periods]);
  const points = dates.map(date => { const metric = bankMetric(state, rssd, date, def.key, options.basis); return { date, label: quarterLabel(date), metric, value: metric.value == null ? null : metric.value / (metric.unit === 'percent' ? 1 : 1e6) }; });
  const flow = def.period === 'ytd';
  const meaningfulChange = !flow || options.basis === 'quarterly';
  return <><BankTrendDashboard state={state} rssd={rssd} basis={options.basis} onBasis={basis => onChange({ basis })} />
    <details className={styles.exactDetails} open={options.metric !== 'assets' || undefined}><summary>Explore an individual metric <span>All 35 metrics · detailed chart &amp; quarterly changes</span></summary>
    <div className={styles.trendControls}><label>Metric<select value={def.key} onChange={e => onChange({ metric: e.target.value })}>{['Overview', ...GROUPS.filter(g => g !== 'Overview')].map(group => <optgroup label={group} key={group}>{BANK_METRICS.filter(m => m.group === group).map(m => <option value={m.key} key={m.key}>{m.label}</option>)}</optgroup>)}</select></label>{flow && <BasisControl basis={options.basis} onChange={basis => onChange({ basis })} />}</div>
    <section className={styles.chartPanel}><div className={styles.sectionHeading}><h3>{def.label}</h3><span>{def.unit === 'percent' ? 'Percent' : 'USD millions'} · {flow ? options.basis === 'quarterly' ? 'Individual quarter' : 'Calendar year to date' : 'Quarter-end'}</span></div>{points.some(p => p.value != null) ? <TrendChart points={points} quarterly={flow} unit={def.unit} label={def.label} /> : <p className={styles.empty}>No values available for this metric in the prepared history.</p>}</section>
    {flow && <p className={styles.basis}>{options.basis === 'quarterly' ? 'Quarterly flows subtract the previous quarter’s YTD amount within the same year. Q1 equals YTD. A quarter is unavailable if its preceding YTD figure is outside the prepared history.' : 'Year-to-date figures accumulate during each calendar year and reset in Q1. Quarter-to-quarter growth is not calculated on this basis; choose Individual quarter to compare flows.'}</p>}
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Trend figures"><table className={styles.trendTable}><caption>Exact trend figures · {def.unit === 'percent' ? '%' : 'USD millions'}</caption><thead><tr><th scope="col">Period</th><th scope="col">{def.label}</th><th scope="col">Change from prior quarter</th><th scope="col">Basis / availability</th></tr></thead><tbody>{points.map((p, i) => { const change = meaningfulChange ? metricChange(p.metric, points[i - 1]?.metric) : null; return <tr key={p.date}><th scope="row"><Link href={bankHref(rssd, { period: p.date })}>{p.label}</Link><small>{p.date}</small></th><td><MetricValue metric={p.metric} exact /></td><td>{change ? `${change.value > 0 ? '+' : ''}${change.value.toFixed(2)} ${change.unit}` : '—'}</td><td>{p.metric.value == null ? unavailableReason(p.metric) : p.metric.derived || (flow ? 'Reported calendar year to date' : 'Reported quarter-end value')}</td></tr>; })}</tbody></table></div><p className={styles.basis}>Ratio changes are percentage points (pp). Percentage growth requires a positive prior amount. Figures reflect the latest validated version prepared for each date; restatements can change history.</p></details>
  </>;
}
