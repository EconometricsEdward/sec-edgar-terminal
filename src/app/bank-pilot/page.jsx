import { notFound, redirect } from 'next/navigation';
import { bankStore } from '../../utils/bank/store.js';
import { isBankPreview, safeBankError } from '../../utils/bank/errors.js';
import { ingestBankPilot } from '../../utils/bank/ingest.js';
import styles from './pilot.module.css';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 240;
export const metadata = { title: 'Bank Regulatory Data | Private Pilot', robots: { index: false, follow: false }, alternates: { canonical: null } };
async function prepare() {
  'use server';
  if (!isBankPreview()) notFound();
  let code = '';
  try { await ingestBankPilot({ store: bankStore }); } catch (error) { code = safeBankError(error).code; }
  redirect(`/bank-pilot${code ? `?notice=${encodeURIComponent(code)}` : ''}`);
}
function display(metric) {
  if (metric.value == null) return 'Unavailable';
  if (metric.unit === 'percent') return `${metric.value.toFixed(4)}%`;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(metric.value / 1e6);
}
export default async function BankPilotPage({ searchParams }) {
  if (!isBankPreview()) notFound();
  const query = await searchParams; let state, error;
  try { state = await bankStore('read'); } catch (e) { error = safeBankError(e).code; }
  const bank = state?.banks?.find(b => b.pilot_key === query.bank) || state?.banks?.[0];
  const reports = state?.reports?.filter(r => Number(r.id_rssd) === Number(bank?.id_rssd)) || [];
  const report = reports.find(r => r.report_date === query.quarter) || reports[0];
  const metrics = report?.metrics || [];
  return <div className={styles.page}>
    <div className={styles.eyebrow}>EDGAR TERMINAL <span>PRIVATE RESEARCH PILOT</span></div>
    <header className={styles.header}><div><h1>Bank Regulatory Data</h1><p>Three legal banks. Four reporting quarters. Every figure has a source.</p></div><span className={styles.badge}>FFIEC · Call Reports</span></header>
    <nav className={styles.banks} aria-label="Pilot banks">{(state?.banks?.length ? state.banks : [{ pilot_key: 'jpmorgan', legal_name: 'JPMorgan Chase Bank, N.A.' }, { pilot_key: 'bank-of-america', legal_name: 'Bank of America, N.A.' }, { pilot_key: 'wells-fargo', legal_name: 'Wells Fargo Bank, N.A.' }]).map(b => <a key={b.pilot_key} aria-current={bank?.pilot_key === b.pilot_key ? 'page' : undefined} href={`?bank=${b.pilot_key}`}><span>{b.legal_name}</span><small>{b.id_rssd ? `RSSD ${b.id_rssd}` : 'Identity verification pending'}</small></a>)}</nav>
    {error || query.notice ? <p role="alert" className={styles.notice}>Pilot status: {error || query.notice}. No missing values have been substituted.</p> : null}
    {bank && <section className={styles.toolbar}><div><h2>{bank.legal_name}</h2><p>RSSD {bank.id_rssd} · FDIC {bank.fdic_certificate || 'Unavailable'} · FFIEC 031</p></div>
      <form method="get"><input type="hidden" name="bank" value={bank.pilot_key}/><label>Report date <select name="quarter" defaultValue={report?.report_date || ''}>{reports.map(r => <option key={r.id} value={r.report_date}>{r.report_date}</option>)}</select></label><button type="submit">View quarter</button></form></section>}
    {report ? <>
      <p className={styles.basis}>Amounts in USD millions, except ratios. Balance sheet and credit quality are quarter-end; earnings and charge-offs are calendar year to date. <strong>{report.validation?.passed ? 'Financial checks passed' : 'Financial review required'}</strong></p>
      <section className={styles.highlights} aria-label="Financial overview">{['assets', 'loans', 'deposits', 'equity', 'net_income'].map(key => { const m = metrics.find(x => x.key === key); return m && <div key={key}><span>{m.label}{m.period === 'ytd' ? ' · YTD' : ''}</span><strong>{display(m)}</strong><small>{m.schedule} · {m.codes.join(' + ')}</small></div>; })}</section>
      <div className={styles.groups}>{['Capital', 'Credit quality', 'Funding', 'Earnings', 'Overview'].map(group => <section key={group} className={styles.group}><h2>{group}</h2>{metrics.filter(m => m.group === group).map(m => <details key={m.key}><summary><span>{m.label}{m.period === 'ytd' ? ' · YTD' : ''}</span><strong>{display(m)}</strong></summary><div className={styles.lineage}><p>{m.basis}</p><p>{m.schedule}, item {m.item} · {m.status}{m.reason ? ` · ${m.reason}` : ''}</p><p>{m.formula || m.codes.join(' / ')}{m.unit === 'percent' ? ' · XBRL pure fraction × 100' : ' · XBRL USD; decimals encode precision'}</p>{m.lineage.map((f, i) => <p key={i}><code>{f.code}</code> = {f.rawValue ?? 'Unavailable'} {f.unit} · context {f.contextRef || 'Unavailable'}{f.contextNote ? ` · ${f.contextNote}` : ''}{f.corroboration ? ` · Corroboration: ${f.corroboration.map(c => `${c.code} = ${c.rawValue}`).join(' minus ')}` : ''}</p>)}</div></details>)}</section>)}</div>
      <details className={styles.audit}><summary>Source and validation record</summary><p>Retrieved {report.retrieved_at}. FFIEC submission: {report.submission_date_raw || 'Unavailable'} (timezone not specified).</p><p className={styles.hash}>SHA-256: {report.source_sha256}</p><p><a href={`/api/internal/bank-pilot/source?rssd=${bank.id_rssd}&quarter=${report.report_date}`}>View stored FFIEC XBRL source</a> · <a href="https://www.ffiec.gov/resources/reporting-forms/ffiec031" target="_blank" rel="noreferrer">FFIEC 031 forms and instructions</a></p><ul>{report.validation.checks.map(c => <li key={c.name}>{c.passed ? 'Passed' : 'Review'} · {c.name.replaceAll('_', ' ')}</li>)}</ul></details>
    </> : <section className={styles.empty}><h2>Ready to verify the first filings</h2><p>The first preparation identifies each legal institution through FFIEC and loads its latest available Call Report. Historical quarters follow only after the latest figures pass validation.</p></section>}
    <footer className={styles.footer}><div><strong>Preparation controls</strong><p>{state?.reports?.length || 0} / 12 filings stored · {state?.requestCount || 0} FFIEC requests dispatched</p><p>Viewing banks and quarters reads stored data only. Preparation stops at three banks and four quarters.</p>{state?.lastRunResult && <p>Last preparation: {state.lastRunResult.status} · {state.lastRunResult.stored} stored · {state.lastRunResult.skipped} reused</p>}</div><form action={prepare}><button disabled={!!error || state?.running || !!state?.cooldownUntil}>Prepare next batch</button></form></footer>
  </div>;
}
