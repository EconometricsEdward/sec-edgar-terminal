import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from 'recharts';
import { formatValue } from '../utils/xbrlParser.js';

const COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6'];

/**
 * Single-company metric chart. Takes an array of {period, value} and renders a bar chart.
 *
 * `format` controls axis/tooltip formatting (currency, percent, decimal, shares, eps).
 */
export function MetricChart({ title, data, format = 'currency', chartType = 'bar', height = 260 }) {
  // Reverse so oldest is on the left (chronological)
  const chartData = [...data].reverse().map((d) => ({
    period: periodShort(d.period),
    value: d.value,
  })).filter((d) => d.value != null);

  if (chartData.length === 0) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6">
        <div className="text-xs uppercase tracking-[0.2em] text-stone-400 mb-2">{title}</div>
        <div className="h-40 flex items-center justify-center text-stone-600 text-sm">
          No data reported for this metric
        </div>
      </div>
    );
  }

  const Chart = chartType === 'line' ? LineChart : BarChart;
  const Shape = chartType === 'line' ? Line : Bar;

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold mb-3 px-2">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <Chart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c" vertical={false} />
          <XAxis
            dataKey="period"
            stroke="#78716c"
            tick={{ fontSize: 11, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
          />
          <YAxis
            stroke="#78716c"
            tick={{ fontSize: 11, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
            tickFormatter={(v) => shortFormat(v, format)}
            width={65}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1c1917',
              border: '2px solid #44403c',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#f5f5f4',
            }}
            labelStyle={{ color: '#fbbf24', fontWeight: 'bold' }}
            formatter={(value) => [formatValue(value, format), title]}
          />
          <ReferenceLine y={0} stroke="#57534e" strokeWidth={1} />
          {chartType === 'line' ? (
            <Line
              type="monotone"
              dataKey="value"
              stroke={COLORS[0]}
              strokeWidth={2.5}
              dot={{ fill: COLORS[0], r: 4 }}
              activeDot={{ r: 6 }}
            />
          ) : (
            <Bar dataKey="value" fill={COLORS[0]} />
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Multi-company overlay chart for peer comparison.
 * `series` is [{ name, ticker, data: [{period, value}] }, ...]
 */
export function ComparisonChart({ title, series, format = 'currency', height = 320 }) {
  // Build a unified dataset where each row is a period and each series is a column
  const allPeriods = new Set();
  series.forEach((s) => s.data.forEach((d) => allPeriods.add(periodShort(d.period))));
  const sortedPeriods = Array.from(allPeriods).sort(periodSort);

  const chartData = sortedPeriods.map((period) => {
    const row = { period };
    series.forEach((s) => {
      const match = s.data.find((d) => periodShort(d.period) === period);
      row[s.ticker] = match?.value ?? null;
    });
    return row;
  });

  const hasAnyData = chartData.some((row) => series.some((s) => row[s.ticker] != null));

  if (!hasAnyData) {
    return (
      <div className="border-2 border-stone-800 bg-stone-900/30 p-6">
        <div className="text-xs uppercase tracking-[0.2em] text-stone-400 mb-2">{title}</div>
        <div className="h-40 flex items-center justify-center text-stone-600 text-sm">
          No comparable data available across these companies
        </div>
      </div>
    );
  }

  return (
    <div className="border-2 border-stone-800 bg-stone-900/30 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-amber-400 font-bold mb-3 px-2">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#44403c" vertical={false} />
          <XAxis
            dataKey="period"
            stroke="#78716c"
            tick={{ fontSize: 11, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
          />
          <YAxis
            stroke="#78716c"
            tick={{ fontSize: 11, fill: '#a8a29e', fontFamily: 'ui-monospace, monospace' }}
            tickLine={{ stroke: '#44403c' }}
            axisLine={{ stroke: '#44403c' }}
            tickFormatter={(v) => shortFormat(v, format)}
            width={65}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1c1917',
              border: '2px solid #44403c',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '12px',
              color: '#f5f5f4',
            }}
            labelStyle={{ color: '#fbbf24', fontWeight: 'bold' }}
            formatter={(value, name) => [formatValue(value, format), name]}
          />
          <Legend
            wrapperStyle={{ fontFamily: 'ui-monospace, monospace', fontSize: '11px' }}
            iconType="rect"
          />
          <ReferenceLine y={0} stroke="#57534e" strokeWidth={1} />
          {series.map((s, i) => (
            <Line
              key={s.ticker}
              type="monotone"
              dataKey={s.ticker}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 6 }}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Short label for axis: "FY23" instead of "FY 2023"
function periodShort(p) {
  if (!p) return '';
  if (p.fp === 'FY') return `FY${String(p.fy).slice(-2)}`;
  return `${p.fp}'${String(p.fy).slice(-2)}`;
}

// Sort comparator for FY and quarter labels on the x-axis
function periodSort(a, b) {
  const parse = (s) => {
    if (s.startsWith('FY')) return { year: 2000 + parseInt(s.slice(2), 10), q: 0 };
    const [q, yr] = s.split("'");
    return { year: 2000 + parseInt(yr, 10), q: parseInt(q.slice(1), 10) };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.q - pb.q;
}

// Compact number formatting for Y-axis labels
function shortFormat(v, format) {
  if (v == null) return '';
  if (format === 'percent') return `${v.toFixed(0)}%`;
  if (format === 'decimal') return v.toFixed(1);
  if (format === 'eps') return `$${v.toFixed(1)}`;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(0)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs}`;
}
