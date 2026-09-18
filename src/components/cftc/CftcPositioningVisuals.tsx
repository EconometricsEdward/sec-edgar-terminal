'use client';

import { useMemo, useState } from 'react';
import { cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import { positioningGroups, positioningHistoryChart, signedPlotExtent } from './cftcVisualAnalytics.js';
import s from './CftcPositioningVisuals.module.css';

type Props = { history: any; onGroupChange: (group: string) => void };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const num = (value: unknown, digits = 0) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'Unavailable';
const signed = (value: unknown, digits = 1, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${num(value, digits)}${suffix}` : 'Unavailable';
const compact = (value: number) => Math.abs(value) >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}k` : num(value, 0);
const titles = { net: 'The balance between long and short', sides: 'What sits behind the net position', interest: 'The size of this futures market' };

export default function CftcPositioningVisuals({ history, onGroupChange }: Props) {
  const [display, setDisplay] = useState<'net' | 'sides' | 'interest'>('net');
  const [hoverDate, setHoverDate] = useState('');
  const chart = useMemo(() => positioningHistoryChart(history?.history || [], display), [history, display]);
  const groups = useMemo(() => positioningGroups(history?.selected), [history]);
  const changes = useMemo(() => ([1, 4, 13] as const).map(weeks => ({ weeks, ...cftcPositionChange(history, weeks) })), [history]);
  const selectedGroup = history?.selected?.selectedGroup;
  const focus = chart?.positions.find(point => point.reportDate === hoverDate) || chart?.positions.at(-1);
  const groupExtent = signedPlotExtent(groups.map(group => group.value));
  const changeExtent = signedPlotExtent(changes.map(change => change.available ? change.netPctChange : null));
  const weekly = changes[0];
  const priorPoints = (history?.history || []).filter(point => point.reportDate < history?.selected?.reportDate && finite(point.netPctOi));
  const values = [...priorPoints.map(point => point.netPctOi), selectedGroup?.netPctOi].filter(finite);
  const spreadMin = Math.min(...values), spreadMax = Math.max(...values), spread = spreadMax - spreadMin || 1;
  const place = (value: number) => 24 + 712 * (value - spreadMin) / spread;

  return <div className={s.root}>
    <figure className={s.history}>
      <figcaption><div><span className={s.kicker}>{selectedGroup?.label}</span><h4>{titles[display]}</h4><p>{display === 'interest' ? 'Outstanding futures contracts across the market' : 'Share of each report’s market open interest · missing weeks remain gaps'}</p></div><div className={s.switcher} aria-label="Positioning chart measure">{([['net', 'Net position'], ['sides', 'Longs & shorts'], ['interest', 'Open interest']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={display === id} onClick={() => { setDisplay(id); setHoverDate(''); }}>{label}</button>)}</div></figcaption>
      <div className={s.readout} aria-live="polite"><span>{focus?.reportDate || 'Report unavailable'}</span>{display === 'interest' ? <strong>{num(focus?.openInterest)} <small>contracts</small></strong> : display === 'sides' ? <><strong className={s.long}>Long {num(focus?.long)} <small>contracts</small></strong><strong className={s.short}>Short {num(focus?.short)} <small>contracts</small></strong></> : <><strong>{signed(focus?.netPctOi, 2, '%')} <small>net / OI</small></strong><span>{signed(focus?.net, 0)} net contracts</span></>}</div>
      {chart ? <div className={s.plotViewport} role="region" tabIndex={0} aria-label="Positioning history chart; scroll horizontally on small screens"><svg className={s.timeline} viewBox="0 0 820 260" role="img" aria-label={`${titles[display]}, from ${chart.start} to ${chart.end}. Use the dated history table for every exact value.`}>
        {chart.ticks.map((tick, i) => <g key={i}><line x1="68" x2="792" y1={tick.y} y2={tick.y} className={s.grid} /><text x="55" y={tick.y + 4} textAnchor="end">{display === 'interest' ? compact(tick.value) : `${num(tick.value, 1)}%`}</text></g>)}
        <line x1="68" x2="792" y1={chart.zeroY} y2={chart.zeroY} className={s.zero} />
        {chart.series.map(series => <g key={series.field} data-series={series.field}>{series.paths.map((path, i) => <path key={i} d={path} className={s.line} />)}{series.dots.map((point, i) => <circle key={point.date} cx={point.x} cy={point.y} r={point.date === focus?.reportDate ? 4 : i === series.dots.length - 1 ? 3 : 1.25} className={s.dot}><title>{point.date}: {num(point.value, display === 'interest' ? 0 : 2)}{display === 'interest' ? ' contracts' : '%'}</title></circle>)}</g>)}
        {focus && <line x1={focus.x} x2={focus.x} y1="30" y2="223" className={s.cursor} />}
        {chart.positions.map(point => <rect key={point.reportDate} x={Math.max(68, point.x - 724 / chart.positions.length / 2)} y="28" width={724 / chart.positions.length} height="196" fill="transparent" onMouseEnter={() => setHoverDate(point.reportDate)}><title>{point.reportDate}: net {signed(point.netPctOi, 2, '%')}, long {num(point.long)}, short {num(point.short)}, open interest {num(point.openInterest)} contracts</title></rect>)}
        <text x="68" y="252">{chart.start}</text><text x="792" y="252" textAnchor="end">{chart.end}</text>
      </svg></div> : <p className={s.empty}>At least two valid dated observations are needed for this chart.</p>}
      {chart && <label className={s.dateControl}>Inspect report<select value={focus?.reportDate || ''} onChange={event => setHoverDate(event.target.value)}>{chart?.positions.slice().reverse().map(point => <option key={point.reportDate} value={point.reportDate}>{point.reportDate}</option>)}</select></label>}
    </figure>

    <div className={s.comparisons}>
      <figure className={s.groups}><figcaption><span className={s.kicker}>Who holds the other side?</span><h4>Trader positioning, side by side</h4><p>Net / open interest on {history?.selected?.reportDate}. Select a category to explore its history.</p></figcaption><div className={s.axis}><span>−{groupExtent}% · net short</span><span>0</span><span>+{groupExtent}% · net long</span></div>{groups.map(item => <button key={item.id} type="button" className={s.group} aria-pressed={item.id === selectedGroup?.id} onClick={() => onGroupChange(item.id)} aria-label={`Show ${item.label} history, net positioning ${signed(item.value, 1, '%')}`}><span>{item.label}</span><strong>{signed(item.value, 1, '%')}</strong><div className={s.track} aria-hidden="true">{finite(item.value) && <i data-negative={item.value < 0} style={{ left: `${item.value < 0 ? 50 + item.value / groupExtent * 50 : 50}%`, width: `${Math.abs(item.value) / groupExtent * 50}%` }} />}</div></button>)}<p className={s.caption}>All groups use the same scale. Separately reported spreading is excluded from net positions.</p></figure>
      <figure className={s.changes}><figcaption><span className={s.kicker}>Direction of change</span><h4>One week or a lasting shift?</h4><p>{selectedGroup?.label} · change in net / OI, percentage points</p></figcaption><div className={s.axis}><span>−{changeExtent} pp</span><span>0</span><span>+{changeExtent} pp</span></div>{changes.map(item => <div key={item.weeks} className={s.change}><span>{item.weeks === 1 ? '1 week' : `${item.weeks} weeks`}</span><strong>{signed(item.available ? item.netPctChange : null, 2, ' pp')}</strong><div className={s.track} aria-hidden="true">{item.available && finite(item.netPctChange) && <i data-negative={item.netPctChange < 0} style={{ left: `${item.netPctChange < 0 ? 50 + item.netPctChange / changeExtent * 50 : 50}%`, width: `${Math.abs(item.netPctChange) / changeExtent * 50}%` }} />}</div><small>{item.available ? `${signed(item.netChange, 0)} net contracts · since ${item.priorDate}` : `Exact ${item.weeks}-week comparison unavailable`}</small></div>)}<div className={s.decomposition}><span>Behind this week’s move</span><dl><div><dt>Change in longs</dt><dd>{signed(weekly.available ? weekly.longChange : null, 0)}</dd></div><div><dt>Change in shorts</dt><dd>{signed(weekly.available ? weekly.shortChange : null, 0)}</dd></div><div><dt>Net: longs − shorts</dt><dd>{signed(weekly.available ? weekly.netChange : null, 0)}</dd></div></dl></div><p className={s.caption}>Position changes describe outstanding contracts. They do not measure cash flows or explain trader intent.</p></figure>
    </div>

    <figure className={s.distribution}><figcaption><div><span className={s.kicker}>Historical context</span><h4>Where today sits in the reporting window</h4><p>Each faint mark is an earlier net / OI observation; the highlighted mark is the selected report.</p></div><strong>{num(history?.percentile?.value, 1)}{finite(history?.percentile?.value) ? '%' : ''}<small>{history?.percentile?.required}-report percentile</small></strong></figcaption>{values.length > 1 && <div className={s.plotViewport} role="region" tabIndex={0} aria-label="Historical positioning distribution; scroll horizontally on small screens"><svg className={s.distributionPlot} viewBox="0 0 760 82" role="img" aria-label={`Historical net positioning distribution, ${priorPoints.length} prior observations. Selected report ${signed(selectedGroup?.netPctOi, 2, '%')}. A positioning percentile is not a company risk score.`}><line x1="24" x2="736" y1="37" y2="37" className={s.grid} />{priorPoints.map(point => <line key={point.reportDate} x1={place(point.netPctOi)} x2={place(point.netPctOi)} y1="23" y2="49" className={s.rug}><title>{point.reportDate}: {signed(point.netPctOi, 2, '%')}</title></line>)}{finite(selectedGroup?.netPctOi) && <g><line x1={place(selectedGroup.netPctOi)} x2={place(selectedGroup.netPctOi)} y1="11" y2="58" className={s.latest} /><circle cx={place(selectedGroup.netPctOi)} cy="11" r="4" className={s.latestDot} /></g>}<text x="24" y="77">{signed(spreadMin, 1, '%')}</text><text x="736" y="77" textAnchor="end">{signed(spreadMax, 1, '%')}</text></svg></div>}<p className={s.caption}>{history?.percentile?.observations ?? 0}/{history?.percentile?.required} valid prior reports. {finite(history?.percentile?.value) ? 'The percentile is a historical positioning rank, not a company risk score or a price forecast.' : history?.percentile?.reason || 'A full compatible comparison window is unavailable.'}</p></figure>
  </div>;
}
