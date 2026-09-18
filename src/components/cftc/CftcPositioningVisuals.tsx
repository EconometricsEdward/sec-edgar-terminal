'use client';

import { useMemo, useState } from 'react';
import { cftcPositionChange } from '../../utils/cftcContextAnalytics.js';
import { positioningGroups, positioningHistoryChart, signedPlotExtent } from './cftcVisualAnalytics.js';
import ChartPeriodOverlay from '../charts/ChartPeriodOverlay';
import s from './CftcPositioningVisuals.module.css';

type Props = { history: any; onGroupChange: (group: string) => void; onReportInspect?: (date: string) => void; layout?: 'full' | 'compact' };
type ChartView = 'positioning' | 'groups' | 'changes' | 'distribution';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const num = (value: unknown, digits = 0) => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : 'Unavailable';
const signed = (value: unknown, digits = 1, suffix = '') => finite(value) ? `${value > 0 ? '+' : ''}${num(value, digits)}${suffix}` : 'Unavailable';
const sideShare = (amount: unknown, interest: unknown) => finite(amount) && amount >= 0 && finite(interest) && interest > 0 ? `${num(100 * amount / interest, 2)}%` : 'Unavailable';
const compact = (value: number) => Math.abs(value) >= 1000000 ? `${(value / 1000000).toFixed(1)}m` : Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}k` : num(value, 0);
const titles = { net: 'The balance between long and short', sides: 'What sits behind the net position', interest: 'The size of this futures market' };

export default function CftcPositioningVisuals(props: Props) {
  const history = props.history;
  return <PositioningVisuals key={`${history?.report_family}:${history?.selection?.contract}:${history?.selection?.group}:${history?.selected?.reportDate}:${history?.retrieved_at}`} {...props} />;
}

function PositioningVisuals({ history, onGroupChange, onReportInspect, layout = 'full' }: Props) {
  const isCompact = layout === 'compact';
  const [view, setView] = useState<ChartView>('positioning');
  const [display, setDisplay] = useState<'net' | 'sides' | 'interest'>('net');
  const [selectedDate, setSelectedDate] = useState('');
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [distributionDate, setDistributionDate] = useState<string | null>(null);
  const chart = useMemo(() => positioningHistoryChart(history?.history || [], display), [history, display]);
  const groups = useMemo(() => positioningGroups(history?.selected), [history]);
  const selectedGroup = history?.selected?.selectedGroup;
  const baselineDate = selectedDate || history?.selected?.reportDate || '';
  const focusDate = hoverDate || baselineDate;
  const focus = chart?.positions.find(point => point.reportDate === focusDate);
  const inspect = (date: string | null) => { setHoverDate(date); onReportInspect?.(date || baselineDate); };
  const changeView = (next: ChartView) => {
    setView(next);
    setHoverDate(null);
    setDistributionDate(null);
    onReportInspect?.(next === 'groups' || next === 'distribution' ? history?.selected?.reportDate : baselineDate);
  };
  const inspectDistribution = (date: string | null) => {
    setDistributionDate(date);
    if (isCompact) onReportInspect?.(date || history?.selected?.reportDate);
  };
  const changes = useMemo(() => ([1, 4, 13] as const).map(weeks => ({ weeks, ...cftcPositionChange(history ? { ...history, selected: { ...history.selected, reportDate: focusDate } } : null, weeks) })), [history, focusDate]);
  const groupExtent = signedPlotExtent(groups.map(group => group.value));
  const changeExtent = signedPlotExtent(changes.map(change => change.available ? change.netPctChange : null));
  const weekly = changes[0];
  const priorPoints = (history?.history || []).filter(point => point.reportDate < history?.selected?.reportDate && finite(point.netPctOi));
  const distributionPoints = (history?.history || []).filter(point => point.reportDate <= history?.selected?.reportDate && finite(point.netPctOi));
  const distributionFocus = distributionPoints.find(point => point.reportDate === (distributionDate || history?.selected?.reportDate));
  const values = distributionPoints.map(point => point.netPctOi);
  const spreadMin = Math.min(...values), spreadMax = Math.max(...values), spread = spreadMax - spreadMin || 1;
  const place = (value: number) => 24 + 712 * (value - spreadMin) / spread;

  return <div className={`${s.root} ${isCompact ? s.compact : ''}`}>
    {isCompact && <div className={s.viewSwitcher} role="group" aria-label="CFTC chart view">{([['positioning', 'Positioning'], ['groups', 'Trader mix'], ['changes', 'Changes'], ['distribution', 'Historical range']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={view === id} onClick={() => changeView(id)}>{label}</button>)}</div>}
    {(!isCompact || view === 'positioning') && <figure className={s.history}>
      <figcaption><div><span className={s.kicker}>{selectedGroup?.label}</span><h4>{isCompact ? { net: 'Net positioning', sides: 'Long and short positions', interest: 'Market open interest' }[display] : titles[display]}</h4><p>{display === 'interest' ? 'Outstanding futures contracts across the market' : 'Share of each report’s market open interest · missing weeks remain gaps'}</p></div><div className={s.switcher} aria-label="Positioning chart measure">{([['net', 'Net position'], ['sides', 'Longs & shorts'], ['interest', 'Open interest']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={display === id} onClick={() => { setDisplay(id); inspect(null); }}>{label}</button>)}</div></figcaption>
      <div className={s.readout} aria-live="polite"><span>{focus?.reportDate || 'Report unavailable'}</span>{display === 'interest' ? <strong>{num(focus?.openInterest)} <small>contracts</small></strong> : display === 'sides' ? <><strong className={s.long}>Long {sideShare(focus?.long, focus?.openInterest)} <small>of OI · {num(focus?.long)} contracts</small></strong><strong className={s.short}>Short {sideShare(focus?.short, focus?.openInterest)} <small>of OI · {num(focus?.short)} contracts</small></strong></> : <><strong>{signed(focus?.netPctOi, 2, '%')} <small>net / OI</small></strong><span>{signed(focus?.net, 0)} net contracts</span></>}</div>
      {chart ? <div className={s.plotViewport} role="region" tabIndex={0} aria-label="Positioning history chart; scroll horizontally on small screens"><svg className={s.timeline} viewBox="0 0 820 260" role="group" aria-label={`${titles[display]}, from ${chart.start} to ${chart.end}. Use the dated history table for every exact value.`}>
        {chart.ticks.map((tick, i) => <g key={i}><line x1="68" x2="792" y1={tick.y} y2={tick.y} className={s.grid} /><text x="55" y={tick.y + 4} textAnchor="end">{display === 'interest' ? compact(tick.value) : `${num(tick.value, 1)}%`}</text></g>)}
        <line x1="68" x2="792" y1={chart.zeroY} y2={chart.zeroY} className={s.zero} />
        {chart.series.map(series => <g key={series.field} data-series={series.field}>{series.paths.map((path, i) => <path key={i} d={path} className={s.line} />)}{series.dots.map((point, i) => <circle key={point.date} cx={point.x} cy={point.y} r={point.date === focus?.reportDate ? 4 : i === series.dots.length - 1 ? 3 : 1.25} className={s.dot}><title>{point.date}: {num(point.value, display === 'interest' ? 0 : 2)}{display === 'interest' ? ' contracts' : '%'}</title></circle>)}</g>)}
        {focus && <line x1={focus.x} x2={focus.x} y1="30" y2="223" className={s.cursor} />}
        <text x="68" y="252">{chart.start}</text><text x="792" y="252" textAnchor="end">{chart.end}</text>
        <ChartPeriodOverlay points={chart.positions.map(point => ({ id: point.reportDate, label: point.reportDate, x: point.x }))} activeId={focusDate} onInspect={inspect} left={68} right={792} top={28} bottom={224} label="CFTC positioning history" describePoint={date => { const point = chart.positions.find(item => item.reportDate === date); return `${date}: net ${signed(point?.netPctOi, 2, '%')}, long ${sideShare(point?.long, point?.openInterest)} (${num(point?.long)} contracts), short ${sideShare(point?.short, point?.openInterest)} (${num(point?.short)} contracts), open interest ${num(point?.openInterest)} contracts`; }} />
      </svg></div> : <p className={s.empty}>At least two valid dated observations are needed for this chart.</p>}
      {chart && <div className={s.inspectionTools}><span>Hover, tap, or use arrow keys to inspect a report.</span><label className={s.dateControl}>Inspect report<select value={baselineDate} onChange={event => { setSelectedDate(event.target.value); setHoverDate(null); onReportInspect?.(event.target.value); }}>{chart?.positions.slice().reverse().map(point => <option key={point.reportDate} value={point.reportDate}>{point.reportDate}</option>)}</select></label></div>}
    </figure>}

    {(!isCompact || view === 'groups' || view === 'changes') && <div className={s.comparisons}>
      {(!isCompact || view === 'groups') && <figure className={s.groups}><figcaption><span className={s.kicker}>{isCompact ? 'Market participants' : 'Who holds the other side?'}</span><h4>{isCompact ? 'Trader mix' : 'Trader positioning, side by side'}</h4><p>Snapshot: net / open interest on {history?.selected?.reportDate}. Select a category to explore its history.</p></figcaption><div className={s.axis}><span>−{groupExtent}% · net short</span><span>0</span><span>+{groupExtent}% · net long</span></div>{groups.map(item => <button key={item.id} type="button" className={s.group} aria-pressed={item.id === selectedGroup?.id} onClick={() => { if (isCompact) changeView('positioning'); onGroupChange(item.id); }} aria-label={`Show ${item.label} history, net positioning ${signed(item.value, 1, '%')}`}><span>{item.label}</span><strong>{signed(item.value, 1, '%')}</strong><div className={s.track} aria-hidden="true">{finite(item.value) && <i data-negative={item.value < 0} style={{ left: `${item.value < 0 ? 50 + item.value / groupExtent * 50 : 50}%`, width: `${Math.abs(item.value) / groupExtent * 50}%` }} />}</div></button>)}<p className={s.caption}>All groups use the same scale. Separately reported spreading is excluded from net positions.</p></figure>}
      {(!isCompact || view === 'changes') && <figure className={s.changes}><figcaption><span className={s.kicker}>Direction of change</span><h4>{isCompact ? 'Positioning changes' : 'One week or a lasting shift?'}</h4><p>{selectedGroup?.label} · through {focusDate} · change in net / OI, percentage points</p></figcaption>{isCompact && chart && <label className={s.dateControl}>Report date<select value={baselineDate} onChange={event => { setSelectedDate(event.target.value); setHoverDate(null); onReportInspect?.(event.target.value); }}>{chart.positions.slice().reverse().map(point => <option key={point.reportDate} value={point.reportDate}>{point.reportDate}</option>)}</select></label>}<div className={s.axis}><span>−{changeExtent} pp</span><span>0</span><span>+{changeExtent} pp</span></div>{changes.map(item => <div key={item.weeks} className={s.change}><span>{item.weeks === 1 ? '1 week' : `${item.weeks} weeks`}</span><strong>{signed(item.available ? item.netPctChange : null, 2, ' pp')}</strong><div className={s.track} aria-hidden="true">{item.available && finite(item.netPctChange) && <i data-negative={item.netPctChange < 0} style={{ left: `${item.netPctChange < 0 ? 50 + item.netPctChange / changeExtent * 50 : 50}%`, width: `${Math.abs(item.netPctChange) / changeExtent * 50}%` }} />}</div><small>{item.available ? `${signed(item.netChange, 0)} net contracts · since ${item.priorDate}` : `Exact ${item.weeks}-week comparison unavailable`}</small></div>)}<div className={s.decomposition}><span>Behind the week ending {focusDate}</span><dl><div><dt>Change in longs</dt><dd>{signed(weekly.available ? weekly.longChange : null, 0)}</dd></div><div><dt>Change in shorts</dt><dd>{signed(weekly.available ? weekly.shortChange : null, 0)}</dd></div><div><dt>Net: longs − shorts</dt><dd>{signed(weekly.available ? weekly.netChange : null, 0)}</dd></div></dl></div><p className={s.caption}>Position changes describe outstanding contracts. They do not measure cash flows or explain trader intent.</p></figure>}
    </div>}

    {(!isCompact || view === 'distribution') && <figure className={s.distribution}><figcaption><div><span className={s.kicker}>Historical context</span><h4>{isCompact ? 'Historical positioning range' : 'Where the selected report sits in the window'}</h4><p>Snapshot through {history?.selected?.reportDate}. Hover or focus the marks to inspect an exact report.</p></div><strong>{num(history?.percentile?.value, 1)}{finite(history?.percentile?.value) ? '%' : ''}<small>{history?.percentile?.required}-report percentile</small></strong></figcaption><div className={s.distributionReadout} aria-live="polite"><span>{distributionFocus?.reportDate || 'Report unavailable'}</span><strong>{signed(distributionFocus?.netPctOi, 2, '%')} <small>net / OI</small></strong><span>{signed(distributionFocus?.net, 0)} net contracts</span></div>{values.length > 1 && <div className={s.plotViewport} role="region" tabIndex={0} aria-label="Historical positioning distribution; scroll horizontally on small screens"><svg className={s.distributionPlot} viewBox="0 0 760 82" role="group" aria-label={`Historical net positioning distribution, ${priorPoints.length} prior observations. Selected report ${signed(selectedGroup?.netPctOi, 2, '%')}. A positioning percentile is not a company risk score.`}><line x1="24" x2="736" y1="37" y2="37" className={s.grid} />{priorPoints.map(point => <line key={point.reportDate} x1={place(point.netPctOi)} x2={place(point.netPctOi)} y1="23" y2="49" className={s.rug}><title>{point.reportDate}: {signed(point.netPctOi, 2, '%')}</title></line>)}{finite(distributionFocus?.netPctOi) && <g><line x1={place(distributionFocus.netPctOi)} x2={place(distributionFocus.netPctOi)} y1="11" y2="58" className={s.latest} /><circle cx={place(distributionFocus.netPctOi)} cy="11" r="4" className={s.latestDot} /></g>}<text x="24" y="77">{signed(spreadMin, 1, '%')}</text><text x="736" y="77" textAnchor="end">{signed(spreadMax, 1, '%')}</text><ChartPeriodOverlay points={distributionPoints.map(point => ({ id: point.reportDate, label: point.reportDate, x: place(point.netPctOi) }))} activeId={distributionFocus?.reportDate || ''} onInspect={inspectDistribution} left={24} right={736} top={5} bottom={60} label="Positioning distribution, ordered by net share" describePoint={date => { const point = distributionPoints.find(item => item.reportDate === date); return `${date}: ${signed(point?.netPctOi, 2, '%')} net / open interest, ${signed(point?.net, 0)} net contracts`; }} /></svg></div>}<p className={s.caption}>The percentile remains tied to the {history?.selected?.reportDate} report; inspecting a mark does not recalculate its rank. {history?.percentile?.observations ?? 0}/{history?.percentile?.required} valid prior reports. {finite(history?.percentile?.value) ? 'The percentile is a historical positioning rank, not a company risk score or a price forecast.' : history?.percentile?.reason || 'A full compatible comparison window is unavailable.'}</p></figure>}
  </div>;
}
