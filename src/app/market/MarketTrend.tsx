'use client';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { formatMarket, marketTrendPoints } from '../../utils/marketResearch.js';
import type { Basis, Evidence } from './marketTypes';

export default function MarketTrend({ evidence, metric, unit, basis }: { evidence: Evidence[]; metric: string; unit: string; basis: Basis }) {
  const points = marketTrendPoints(evidence, metric, basis);
  return <div style={{ width: '100%', height: 220 }} role="img" aria-label="Historical financial trend. Exact values are provided in the reporting history table below.">
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <LineChart data={points} margin={{ top: 16, right: 20, left: 10, bottom: 4 }}>
        <CartesianGrid stroke="var(--m-line)" vertical={false} />
        <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v) => new Date(v).toISOString().slice(0, 7)} stroke="var(--m-muted)" tick={{ fontSize: 11 }} minTickGap={35} />
        <YAxis tickFormatter={(v) => formatMarket(v, unit, 0)} stroke="var(--m-muted)" tick={{ fontSize: 11 }} width={70} />
        <Tooltip labelFormatter={(v) => new Date(Number(v)).toISOString().slice(0, 10)} formatter={(v) => [formatMarket(Number(v), unit), 'Value']} contentStyle={{ background: 'var(--m-panel)', borderColor: 'var(--m-line)', color: 'var(--m-text)' }} />
        <Line dataKey="value" type="linear" stroke="var(--m-accent)" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
