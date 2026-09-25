'use client';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';
export default function BankTrendChart({ points, quarterly, unit, label }) {
  const Chart = quarterly ? BarChart : LineChart;
  return <div style={{ width: '100%', height: 290 }} role="img" aria-label={`${label} across reporting periods. Exact figures are in the table below.`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1000, height: 290 }}><Chart data={points} margin={{ top: 20, right: 22, left: 14, bottom: 10 }} accessibilityLayer>
      <CartesianGrid stroke="#30415a" strokeDasharray="3 5" vertical={false} />
      <XAxis dataKey="label" stroke="#a5b6cb" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
      <YAxis stroke="#a5b6cb" width={78} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)} domain={quarterly ? [min => Math.min(0, min), max => Math.max(0, max)] : ['auto', 'auto']} />
      <Tooltip contentStyle={{ background: '#142136', color: '#e8edf5', border: '1px solid #51647e', borderRadius: 8 }} labelStyle={{ color: '#d4b477' }} formatter={value => [`${Number(value).toLocaleString('en-US', { maximumFractionDigits: unit === 'percent' ? 4 : 3 })}${unit === 'percent' ? '%' : ' USD millions'}`, label]} />
      {quarterly ? <Bar dataKey="value" fill="#d4b477" maxBarSize={80} radius={[4, 4, 0, 0]} /> : <Line type="linear" dataKey="value" stroke="#d4b477" strokeWidth={2.5} dot={{ r: 5, fill: '#d4b477', stroke: '#172236', strokeWidth: 2 }} connectNulls={false} />}
    </Chart></ResponsiveContainer>
  </div>;
}
