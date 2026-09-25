'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { formatBankMetric, unavailableReason } from '../../../utils/bank/viewModel.js';
import { BANK_COLORS, compactMetric, shortBankName, VISUAL_METRICS, visualMetric } from '../../../utils/bank/visuals.js';
import styles from './banks.module.css';
const PeerMap = dynamic(() => import('./BankTrendChart').then(m => m.BankPeerMap), { ssr: false, loading: () => <div className={styles.chartLoading}>Loading peer map…</div> });
const groups = [
  { title: 'Balance sheet & earnings', label: 'Scale', keys: ['assets', 'deposits', 'loans', 'equity', 'net_income', 'net_interest_income'] },
  { title: 'Capital position', label: 'Capital', keys: ['leverage_ratio', 'cet1_ratio', 'tier1_ratio', 'total_capital_ratio'] },
  { title: 'Funding profile', label: 'Funding', keys: ['loans_to_deposits', 'brokered_ratio'] },
  { title: 'Loan quality', label: 'Credit', keys: ['nonperforming_ratio', 'allowance_ratio'] },
];
export default function BankCompareVisuals({ state, banks, period, basis }) {
  const [mode, setMode] = useState('snapshot');
  return <section aria-label="Visual bank comparison" className={styles.comparisonVisuals}>
    <div className={styles.visualToolbar}><div><h3>See the differences</h3><p>Same reporting date. One color per bank.</p></div><div className={styles.segmented} role="group" aria-label="Comparison visualization"><button type="button" aria-pressed={mode === 'snapshot'} onClick={() => setMode('snapshot')}>Metric charts</button><button type="button" aria-pressed={mode === 'map'} onClick={() => setMode('map')}>Peer map</button></div></div>
    {banks.length < 2 && <p className={styles.visualNote}>Add another FFIEC bank above to see comparisons side by side.</p>}
    {mode === 'snapshot' ? <div className={styles.visualGrid}>{groups.map(group => <ComparisonPanel key={group.label} group={group} state={state} banks={banks} period={period} basis={basis} />)}</div> : <PeerMapPanel state={state} banks={banks} period={period} basis={basis} />}
    <p className={styles.visualNote}>Colors identify banks, not ratings. Each bar chart has its own scale and includes zero. Ratios adjust for size but do not remove differences in business mix or reporting frameworks.</p>
  </section>;
}
function ComparisonPanel({ group, state, banks, period, basis }) {
  const [key, setKey] = useState(group.keys[0]);
  const def = VISUAL_METRICS.find(m => m.key === key);
  const rows = banks.map((bank, i) => ({ bank, color: BANK_COLORS[i], number: i + 1, metric: visualMetric(state, bank.id_rssd, period, key, basis) }));
  const finite = rows.filter(r => Number.isFinite(r.metric.value));
  const min = Math.min(0, ...finite.map(r => r.metric.value)), max = Math.max(0, ...finite.map(r => r.metric.value));
  const span = max - min || 1, origin = -min / span * 100;
  return <section className={styles.visualPanel} aria-label={`${group.label} comparison`}><div className={styles.panelTitle}><div><span>{group.label.toUpperCase()}</span><h3>{group.title}</h3></div></div>
    <label className={styles.chartMetricSelect}><span className={styles.srOnly}>{group.label} metric</span><select value={key} onChange={e => setKey(e.target.value)}>{group.keys.map(k => <option key={k} value={k}>{VISUAL_METRICS.find(m => m.key === k).label}</option>)}</select></label>
    <p className={styles.panelSubtitle}>{def.unit === 'percent' ? 'Percent' : 'USD · compact totals'} · {def.period === 'ytd' ? basis === 'quarterly' ? 'Individual quarter' : 'Calendar year to date' : 'Quarter-end'}</p>
    <div className={styles.comparisonBars}>{rows.map(({ bank, color, number, metric }) => {
      const valid = Number.isFinite(metric.value), valuePosition = valid ? (metric.value - min) / span * 100 : origin;
      return <div key={bank.id_rssd} className={styles.comparisonBarRow} style={{ '--accent': color }}><div><span title={`${bank.legal_name} · RSSD ${bank.id_rssd}`}><i>{number}</i>{shortBankName(bank)}</span><strong title={valid ? `${formatBankMetric(metric, { exact: true })}${metric.unit === 'USD' ? ' USD millions' : ''}` : unavailableReason(metric)}>{compactMetric(metric)}</strong></div><div className={styles.barTrack} role="img" aria-label={`${bank.legal_name}: ${def.label} ${valid ? `${formatBankMetric(metric, { exact: true })}${metric.unit === 'USD' ? ' USD millions' : ''}` : unavailableReason(metric)}`}><span className={styles.barOrigin} style={{ left: `${origin}%` }} />{valid && <span className={styles.barFill} style={{ left: `${Math.min(origin, valuePosition)}%`, width: `${Math.abs(valuePosition - origin)}%`, background: color }} />}</div>{!valid && <small>{unavailableReason(metric)}</small>}</div>;
    })}</div>
    <details className={styles.chartDetails}><summary>Metric definition</summary><p>{def.formula || def.basis}</p>{def.period === 'ytd' && <p>{basis === 'quarterly' ? 'Current YTD less preceding same-year YTD. Q1 equals YTD.' : 'Reported calendar year-to-date total.'}</p>}<p>Exact reported figures and source records are available below.</p></details>
  </section>;
}
function PeerMapPanel({ state, banks, period, basis }) {
  const [x, setX] = useState('nonperforming_ratio'), [y, setY] = useState('leverage_ratio');
  const xKeys = ['nonperforming_ratio', 'loans_to_deposits', 'brokered_ratio', 'allowance_ratio'];
  const yKeys = ['leverage_ratio', 'cet1_ratio', 'total_capital_ratio'];
  const xLabel = VISUAL_METRICS.find(m => m.key === x).label, yLabel = VISUAL_METRICS.find(m => m.key === y).label;
  const rows = banks.map((b, i) => ({ name: b.legal_name, rssd: b.id_rssd, number: i + 1, color: BANK_COLORS[i], x: visualMetric(state, b.id_rssd, period, x, basis).value, y: visualMetric(state, b.id_rssd, period, y, basis).value }));
  const points = rows.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  return <section className={styles.visualPanel} aria-label="Bank peer map"><div className={styles.mapControls}>{[['Horizontal axis', x, setX, xKeys], ['Vertical axis', y, setY, yKeys]].map(([label, value, setter, keys]) => <label key={label}>{label}<select value={value} onChange={e => setter(e.target.value)}>{keys.map(key => <option key={key} value={key}>{VISUAL_METRICS.find(m => m.key === key).label}</option>)}</select></label>)}</div><div className={styles.mapAxisLabel}>{yLabel} (%) ↑</div>{points.length ? <PeerMap points={points} xLabel={xLabel} yLabel={yLabel} /> : <div className={styles.chartEmpty}>No banks have both selected measures for this date.</div>}<div className={styles.mapAxisLabelRight}>{xLabel} (%) →</div>
    <div className={styles.mapLegend}>{rows.map(row => <div key={row.rssd}><span className={styles.bankNumber} style={{ '--accent': row.color }}>{row.number}</span><span><strong>{row.name}</strong><small>{Number.isFinite(row.x) && Number.isFinite(row.y) ? `${xLabel}: ${row.x.toFixed(2)}% · ${yLabel}: ${row.y.toFixed(2)}%` : 'Not plotted: a selected measure is unavailable or not applicable.'}</small></span></div>)}</div><p className={styles.visualNote}>Equal-sized points represent legal banks. Positions show the two selected ratios; they are not a credit score. Overlapping points share similar values.</p>
    <details className={styles.chartDetails}><summary>Axis definitions</summary>{[x, y].map(key => { const m = VISUAL_METRICS.find(def => def.key === key); return <p key={key}><strong>{m.label}:</strong> {m.formula || m.basis}</p>; })}</details>
  </section>;
}
