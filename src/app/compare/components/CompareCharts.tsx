"use client";
import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ScatterChart,
  Scatter,
  ReferenceLine,
  LabelList,
} from "recharts";
import {
  trendSeries,
  metricComparison,
  METRIC_BY_KEY,
  periodBucket,
} from "../../../utils/compareResearch.js";
import {
  COLORS,
  displayValue,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import { GrowthTable } from "./CompareTable";
import styles from "../compare.module.css";

type Props = {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  update: (patch: Partial<CompareSettings>) => void;
  inspect: (e: CompareEvidence) => void;
};
const tooltipStyle = {
  background: "var(--compare-raised)",
  border: "1px solid var(--compare-border)",
  borderRadius: 8,
  color: "var(--compare-text)",
};
export function CompareTrends({
  entries,
  metrics,
  settings,
  update,
  inspect,
}: Props) {
  const metric = METRIC_BY_KEY[settings.metric] || metrics[0];
  const series = useMemo(
    () => trendSeries(entries, metric.key, settings),
    [entries, metric.key, settings],
  );
  const formatter = (v: any) =>
    settings.mode === "indexed"
      ? Number(v).toFixed(1)
      : displayValue(Number(v), metric.format);
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>02 / Historical perspective</span>
          <h2>Separate scale from trajectory.</h2>
          <p>
            Follow one metric across the peer set, with every underlying
            observation available below.
          </p>
        </div>
      </div>
      <div className={styles.inlineControls}>
        <label>
          Trend metric
          <select
            value={metric.key}
            onChange={(e) => update({ metric: e.target.value })}
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chart scale
          <select
            value={settings.mode}
            onChange={(e) => update({ mode: e.target.value })}
          >
            <option value="absolute">Reported / calculated values</option>
            <option value="indexed">Common starting point = 100</option>
          </select>
        </label>
        <label>
          History
          <select
            value={settings.years}
            onChange={(e) => update({ years: Number(e.target.value) })}
          >
            <option value={3}>3 years</option>
            <option value={5}>5 years</option>
            <option value={10}>10 years</option>
          </select>
        </label>
      </div>
      <div
        className={styles.chart}
        role="img"
        aria-label={`${metric.label} historical comparison; exact data in the table below`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={series.rows}
            margin={{ top: 15, right: 24, left: 15, bottom: 5 }}
          >
            <CartesianGrid
              stroke="var(--compare-border)"
              strokeDasharray="3 4"
              vertical={false}
            />
            <XAxis
              dataKey="bucket"
              tick={{ fill: "var(--compare-muted)", fontSize: 11 }}
              minTickGap={35}
            />
            <YAxis
              tickFormatter={formatter}
              tick={{ fill: "var(--compare-muted)", fontSize: 11 }}
              width={88}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={formatter} />
            <Legend />
            {entries
              .filter((c) => c.data)
              .map((c, i) => (
                <Line
                  key={c.ticker}
                  type="linear"
                  dataKey={c.ticker}
                  name={c.ticker}
                  stroke={c.color || COLORS[i % COLORS.length]}
                  strokeWidth={2.5}
                  dot={series.rows.length < 15}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className={styles.chartNote}>{series.note}</p>
      <GrowthTable entries={entries} metric={metric} inspect={inspect} />
      <details className={styles.details}>
        <summary>Explore every chart observation and source</summary>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Period-end bucket</th>
                {entries.map((c) => (
                  <th key={c.ticker}>{c.ticker}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...series.rows].reverse().map((row) => (
                <tr key={row.bucket}>
                  <th scope="row">{row.bucket}</th>
                  {entries.map((c) => {
                    const point = c.data?.metrics[metric.key]?.find(
                      (p: any) =>
                        periodBucket(p.period, settings.basis) === row.bucket &&
                        (!c.period || p.period.end <= c.period.end),
                    );
                    return (
                      <td key={c.ticker}>
                        <button
                          className={styles.valueButton}
                          disabled={!point}
                          onClick={() =>
                            inspect({
                              metric,
                              cell: {
                                ticker: c.ticker,
                                cik: c.data.cik,
                                name: c.data.name,
                                point,
                                period: point.period,
                              },
                            })
                          }
                        >
                          {displayValue(point?.value, metric.format)}
                        </button>
                        <small>{point?.period.end || "No observation"}</small>
                        {settings.mode === "indexed" && (
                          <small>
                            Index:{" "}
                            {row[c.ticker] == null
                              ? "—"
                              : row[c.ticker].toFixed(1)}
                          </small>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function CompareMap({
  entries,
  metrics,
  settings,
  update,
  inspect,
}: Props) {
  const xMetric = METRIC_BY_KEY[settings.x],
    yMetric = METRIC_BY_KEY[settings.y];
  const xComparison = metricComparison(entries, settings.x),
    yComparison = metricComparison(entries, settings.y);
  const plotted = entries.flatMap((c, i) => {
    const x = c.data?.metrics[settings.x]?.[c.index],
      y = c.data?.metrics[settings.y]?.[c.index];
    return x?.value != null && y?.value != null
      ? [
          {
            ticker: c.ticker,
            x: x.value,
            y: y.value,
            color: c.color || COLORS[i % COLORS.length],
            company: c,
            xPoint: x,
            yPoint: y,
          },
        ]
      : [];
  });
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>03 / Peer map</span>
          <h2>Explore the tradeoffs.</h2>
          <p>
            Choose any two metrics. Dashed lines show comparable peer medians;
            dot size has no financial meaning.
          </p>
        </div>
        <span className={styles.badge}>
          {plotted.length}/{entries.length} issuers plotted
        </span>
      </div>
      <div className={styles.inlineControls}>
        <label>
          Horizontal axis
          <select
            value={settings.x}
            onChange={(e) => update({ x: e.target.value })}
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vertical axis
          <select
            value={settings.y}
            onChange={(e) => update({ y: e.target.value })}
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(xComparison.reason || yComparison.reason) && (
        <p className={styles.chartNote}>
          Median guides unavailable: {xComparison.reason || yComparison.reason}{" "}
          Points retain their actual reporting dates below.
        </p>
      )}
      <div
        className={styles.chart}
        role="img"
        aria-label={`${xMetric.label} versus ${yMetric.label}; exact data and sources below`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 28, right: 48, left: 25, bottom: 22 }}>
            <CartesianGrid
              stroke="var(--compare-border)"
              strokeDasharray="3 4"
            />
            <XAxis
              type="number"
              dataKey="x"
              name={xMetric.label}
              tickFormatter={(v) => displayValue(v, xMetric.format)}
              tick={{ fill: "var(--compare-muted)", fontSize: 11 }}
              label={{
                value: xMetric.label,
                position: "bottom",
                fill: "var(--compare-muted)",
                fontSize: 12,
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={yMetric.label}
              tickFormatter={(v) => displayValue(v, yMetric.format)}
              width={85}
              tick={{ fill: "var(--compare-muted)", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={tooltipStyle}
              formatter={(value: any, name: any) => [
                displayValue(
                  Number(value),
                  name === xMetric.label ? xMetric.format : yMetric.format,
                ),
                name,
              ]}
            />
            {xComparison.peerMedian != null && (
              <ReferenceLine
                x={xComparison.peerMedian}
                stroke="var(--compare-muted)"
                strokeDasharray="5 5"
              />
            )}
            {yComparison.peerMedian != null && (
              <ReferenceLine
                y={yComparison.peerMedian}
                stroke="var(--compare-muted)"
                strokeDasharray="5 5"
              />
            )}
            {plotted.map((p) => (
              <Scatter
                key={p.ticker}
                name={p.ticker}
                data={[p]}
                fill={p.color}
                isAnimationActive={false}
                onClick={() =>
                  inspect({
                    metric: yMetric,
                    cell: {
                      ticker: p.ticker,
                      cik: p.company.data.cik,
                      name: p.company.data.name,
                      period: p.company.period,
                      point: p.yPoint,
                    },
                  })
                }
              >
                <LabelList
                  dataKey="ticker"
                  position="top"
                  fill="var(--compare-text)"
                  fontSize={12}
                />
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <caption>
            {yMetric.label} (vertical) versus {xMetric.label} (horizontal)
          </caption>
          <thead>
            <tr>
              <th>Company / reporting end</th>
              <th>{xMetric.label}</th>
              <th>{yMetric.label}</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((c) => (
              <tr key={c.ticker}>
                <th scope="row">
                  {c.ticker}
                  <small>{c.period?.end || "No selected period"}</small>
                </th>
                {[xMetric, yMetric].map((m, axis) => {
                  const point = c.data?.metrics[m.key]?.[c.index];
                  return (
                    <td key={axis}>
                      <button
                        className={styles.valueButton}
                        onClick={() =>
                          inspect({
                            metric: m,
                            cell: {
                              ticker: c.ticker,
                              cik: c.data?.cik,
                              name: c.data?.name,
                              point,
                              period: c.period,
                            },
                          })
                        }
                      >
                        {displayValue(point?.value, m.format)}
                      </button>
                    </td>
                  );
                })}
                <td>
                  {plotted.some((p) => p.ticker === c.ticker)
                    ? "Both values available"
                    : "Not plotted: missing input or filing"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
