'use client';
import dynamic from 'next/dynamic';
import { bankMetric, formatBankMetric, metricChange, quarterLabel, unavailableReason } from '../../../utils/bank/viewModel.js';
import { chartPoints, compactMetric, METRIC_COLORS, VISUAL_METRICS, visualMetric } from '../../../utils/bank/visuals.js';
import styles from './banks.module.css';

const TrendChart = dynamic(() => import('./BankTrendChart'), { ssr: false, loading: () => <div className={styles.chartLoading}>Loading chart…</div> });
const panels = [
  { title: 'Balance sheet', eyebrow: 'SCALE & FUNDING', keys: ['assets', 'loans', 'deposits'], labels: ['Assets', 'Loans', 'Deposits'], note: 'Quarter-end balances · USD', color: '#67c8ff' },
  { title: 'Earnings', eyebrow: 'INCOME GENERATION', keys: ['net_interest_income', 'net_income'], labels: ['Net interest income', 'Net income'], flow: true, color: '#f4b76c' },
  { title: 'Capital position', eyebrow: 'LOSS ABSORPTION', keys: ['leverage_ratio', 'cet1_ratio', 'total_capital_ratio'], labels: ['Tier 1 leverage', 'CET1', 'Total capital'], note: 'Reported regulatory ratios · %', unit: 'percent', color: '#56d8b4' },
  { title: 'Loan quality', eyebrow: 'CREDIT & RESERVES', keys: ['nonperforming_ratio', 'allowance_ratio'], labels: ['Nonperforming / loans', 'Allowance / HFI loans'], note: 'Calculated from quarter-end balances · %', unit: 'percent', color: '#b5a0ff' },
];
export default function BankTrendDashboard({ state, rssd, basis, onBasis }) {
  const dates = [...(state.periods || [])].sort();
  const latest = dates.at(-1), previous = dates.at(-2);
  const headline = [{ key: 'assets', label: 'Total assets' }, { key: 'deposits', label: 'Deposits' }, { key: 'net_income', label: 'Net income', flow: true }, { key: 'leverage_ratio', label: 'Tier 1 leverage' }];
  return <>
    <div className={styles.dashboardTop}><div className={styles.periodBadge}><span />{quarterLabel(dates[0])} — {quarterLabel(latest)}<small>{dates.length} reporting periods</small></div><label>Earnings basis<select value={basis} onChange={e => onBasis(e.target.value)}><option value="quarterly">Individual quarter</option><option value="ytd">Reported year to date</option></select></label></div>
    <section className={styles.trendHighlights} aria-label={`Latest metrics, ${quarterLabel(latest)}`}>
      {headline.map(({ key, label, flow }) => {
        const current = bankMetric(state, rssd, latest, key, basis), prior = bankMetric(state, rssd, previous, key, basis);
        const change = flow && basis === 'ytd' ? null : metricChange(current, prior);
        return <article key={key} className={styles.trendHighlight} style={{ '--accent': METRIC_COLORS[key] }}><div><span>{label}</span><small>{flow ? basis === 'quarterly' ? 'QUARTER' : 'YTD' : 'QUARTER-END'}</small></div><strong title={current.value == null ? unavailableReason(current) : `${formatBankMetric(current, { exact: true })}${current.unit === 'USD' ? ' USD millions' : ''}`}>{compactMetric(current)}</strong><p>{change ? <><b>{change.value > 0 ? '↗ +' : change.value < 0 ? '↘ ' : ''}{change.value.toFixed(2)}{change.unit === 'pp' ? ' pp' : '%'}</b><span> vs prior quarter</span></> : <span>{current.value == null ? 'No value for latest period' : flow && basis === 'ytd' ? 'Calendar YTD · no QoQ growth' : 'Prior-quarter change unavailable'}</span>}</p><small className={styles.kpiDate}>{quarterLabel(latest)}</small></article>;
      })}
    </section>
    <div className={styles.visualGrid}>{panels.map(panel => <TrendPanel key={panel.title} panel={panel} state={state} rssd={rssd} basis={basis} />)}</div>
    <p className={styles.visualNote}>{basis === 'quarterly' ? 'Quarterly earnings subtract the preceding same-year YTD amount. Missing prior reports leave a gap.' : 'YTD earnings accumulate within each calendar year and reset in Q1; bars show reported totals, not quarterly growth.'} Line-chart axes fit their values; bar charts include zero. Colors identify metrics, not credit ratings.</p>
  </>;
}
function TrendPanel({ panel, state, rssd, basis }) {
  const points = chartPoints(state, rssd, panel.keys, basis);
  const series = panel.keys.map((key, i) => ({ key, label: panel.labels[i], color: METRIC_COLORS[key] }));
  const hasData = points.some(p => panel.keys.some(key => p[key] != null));
  const unavailable = series.filter(s => !points.some(p => p[s.key] != null));
  const partial = series.filter(s => points.some(p => p[s.key] != null) && points.some(p => p[s.key] == null));
  return <section className={styles.visualPanel} style={{ '--accent': panel.color }} aria-label={`${panel.title} trends`}>
    <div className={styles.panelTitle}><div><span>{panel.eyebrow}</span><h3>{panel.title}</h3></div><small>{panel.unit === 'percent' ? '%' : 'USD'}</small></div>
    <p className={styles.panelSubtitle}>{panel.flow ? `${basis === 'quarterly' ? 'Individual-quarter' : 'Calendar year-to-date'} flows · USD` : panel.note}</p>
    <div className={styles.chartLegend}>{series.map(s => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    {hasData ? <TrendChart points={points} series={series} quarterly={panel.flow} unit={panel.unit || 'USD'} label={panel.title} /> : <div className={styles.chartEmpty}>No validated values available for these metrics.</div>}
    {(unavailable.length > 0 || partial.length > 0) && <p className={styles.chartAvailability}>{unavailable.length > 0 && `${unavailable.map(s => s.label).join(', ')} unavailable or not applicable. `}{partial.length > 0 && 'Gaps indicate unavailable periods.'}</p>}
    <details className={styles.chartDetails}><summary>Figures &amp; definitions</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${panel.title} exact figures`}><table><caption>{panel.title} · {panel.unit === 'percent' ? '%' : 'USD millions'}{panel.flow ? basis === 'quarterly' ? ' · Individual quarter' : ' · YTD' : ''}</caption><thead><tr><th scope="col">Period</th>{series.map(s => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead><tbody>{points.map(p => <tr key={p.date}><th scope="row">{p.label}</th>{series.map(s => { const m = visualMetric(state, rssd, p.date, s.key, basis); return <td key={s.key} title={m.value == null ? unavailableReason(m) : undefined}>{formatBankMetric(m, { exact: true })}</td>; })}</tr>)}</tbody></table></div>{panel.keys.map(key => { const def = VISUAL_METRICS.find(m => m.key === key); return <p key={key}><strong>{def.label}:</strong> {def.formula || def.basis}{key === 'leverage_ratio' ? '. CBLR banks retain their reported leverage measure.' : ''}</p>; })}</details>
  </section>;
}
