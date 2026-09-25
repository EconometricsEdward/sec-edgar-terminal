'use client';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar, ReferenceLine, ScatterChart, Scatter, Cell, LabelList } from 'recharts';
import styles from './banks.module.css';

const axis = { stroke: '#9eafc5', tick: { fontSize: 11 }, tickLine: false, axisLine: false };
const tick = (v, unit) => unit === 'percent' ? `${Number(v.toFixed(2))}%` : `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v * 1e6)}`;
function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return <div className={styles.chartTooltip}><strong>{label}</strong>{payload.map((p, i) => <div key={`${p.dataKey}-${i}`}><span><i style={{ background: p.color }} />{p.name}</span><b>{p.value == null ? 'Unavailable' : `${Number(p.value).toLocaleString('en-US', { maximumFractionDigits: unit === 'percent' ? 2 : 3 })}${unit === 'percent' ? '%' : 'm'}`}</b></div>)}{unit !== 'percent' && <small>USD millions</small>}</div>;
}
export default function BankTrendChart({ points, quarterly, unit, label, series = [{ key: 'value', label, color: '#67c8ff' }], height = 230 }) {
  const Chart = quarterly ? BarChart : LineChart;
  const negative = points.some(p => series.some(s => p[s.key] < 0));
  return <div className={styles.chartCanvas} style={{ height }} role="group" aria-label={`${label} chart. Arrow keys explore periods; exact figures are available below.`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 540, height }}><Chart data={points} margin={{ top: 12, right: 14, left: 0, bottom: 4 }} accessibilityLayer>
      <CartesianGrid stroke="#2b3c52" strokeDasharray="3 5" vertical={false} />
      <XAxis dataKey="label" {...axis} minTickGap={8} />
      <YAxis {...axis} width={64} tickCount={4} tickFormatter={v => tick(v, unit)} domain={quarterly ? [min => Math.min(0, min), max => Math.max(0, max)] : ['auto', 'auto']} />
      <Tooltip content={<ChartTooltip unit={unit} />} filterNull={false} cursor={quarterly ? { fill: '#a1b9d210' } : { stroke: '#91a7bf', strokeDasharray: '3 4' }} />
      {negative && <ReferenceLine y={0} stroke="#8494aa" />}
      {series.map((s, i) => quarterly
        ? <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} maxBarSize={35} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        : <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2.5} strokeDasharray={i === 2 ? '5 3' : undefined} dot={{ r: 3.5, fill: s.color, stroke: '#101b2b', strokeWidth: 2 }} activeDot={{ r: 6, stroke: '#e8edf5' }} connectNulls={false} isAnimationActive={false} />)}
    </Chart></ResponsiveContainer>
  </div>;
}
function MapTooltip({ active, payload, xLabel, yLabel }) {
  const bank = payload?.[0]?.payload;
  if (!active || !bank) return null;
  return <div className={styles.chartTooltip}><strong>{bank.name}</strong><div><span>{xLabel}</span><b>{bank.x.toFixed(2)}%</b></div><div><span>{yLabel}</span><b>{bank.y.toFixed(2)}%</b></div><small>RSSD {bank.rssd}</small></div>;
}
export function BankPeerMap({ points, xLabel, yLabel }) {
  return <div className={styles.chartCanvas} style={{ height: 310 }} role="group" aria-label={`${xLabel} versus ${yLabel}. Points are numbered to match the selected banks.`}><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 950, height: 310 }}><ScatterChart margin={{ top: 24, right: 30, left: 8, bottom: 20 }} accessibilityLayer>
    <CartesianGrid stroke="#2b3c52" strokeDasharray="3 5" />
    <XAxis type="number" dataKey="x" name={xLabel} {...axis} tickFormatter={v => tick(v, 'percent')} domain={['auto', 'auto']} />
    <YAxis type="number" dataKey="y" name={yLabel} {...axis} width={68} tickFormatter={v => tick(v, 'percent')} domain={['auto', 'auto']} />
    <Tooltip content={<MapTooltip xLabel={xLabel} yLabel={yLabel} />} cursor={{ strokeDasharray: '3 4' }} />
    <Scatter data={points} isAnimationActive={false}>{points.map(p => <Cell key={p.rssd} fill={p.color} stroke="#101b2b" strokeWidth={2} />)}<LabelList dataKey="number" position="top" fill="#edf4ff" fontSize={12} offset={9} /></Scatter>
  </ScatterChart></ResponsiveContainer></div>;
}
