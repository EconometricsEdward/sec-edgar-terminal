"use client";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { analysisValue } from "../../utils/analysisNotebook.js";
import { daysBetween } from "../../utils/xbrlPeriods.js";
import styles from "./analysis.module.css";
const colors = ["#e5aa22", "#27b7c5", "#9b88ef"];
export default function AnalysisChart({ data, settings, index }: any) {
  const keys = (
    settings.chart.length
      ? settings.chart
      : [data.revenueKey || "premiumsEarned", "netIncome"]
  )
    .filter((k) => data.metrics[k])
    .slice(0, 3);
  const definitions = keys.map((k) =>
    data.definitions.find((d) => d.key === k),
  );
  const mixed = new Set(definitions.map((d) => d.format)).size > 1;
  const indexed = settings.indexed || mixed;
  const periods = data.periods
    .slice(index, index + settings.years)
    .map((p, offset) => ({ p, index: index + offset }))
    .reverse();
  const base = periods.find(({ index: i }) =>
    keys.every((key) => data.metrics[key][i]?.value > 0),
  );
  const chart = periods.flatMap(({ p, index: i }, n) => {
    const row: any = { end: p.end };
    for (const key of keys) {
      const value = data.metrics[key][i]?.value;
      row[key] =
        Number.isFinite(value) && (!indexed || (base && p.end >= base.p.end))
          ? indexed
            ? (value / data.metrics[key][base.index].value) * 100
            : value
          : null;
    }
    const gap =
      n > 0 &&
      daysBetween(periods[n - 1].p.end, p.end) >
        (settings.basis === "annual" ? 400 : 120);
    return gap ? [{ end: `Missing period before ${p.end}` }, row] : [row];
  });
  return (
    <>
      <p className={styles.muted}>
        {indexed
          ? base
            ? `Indexed to 100 at ${base.p.end}, the first displayed period with positive values for every selected metric.`
            : "No shared positive starting period is available for indexing."
          : "Reported values on a shared unit scale. Gaps remain visible."}
        {mixed && " Mixed units are automatically indexed."} Click a period
        value below to inspect its evidence.
      </p>
      <div
        className={styles.chart}
        role="img"
        aria-label={`Financial trends for ${definitions.map((d) => d.label).join(", ")}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chart}
            margin={{ top: 15, right: 15, left: 15, bottom: 20 }}
          >
            <CartesianGrid
              stroke="var(--analysis-border)"
              strokeDasharray="3 4"
              vertical={false}
            />
            <XAxis
              dataKey="end"
              tick={{ fontSize: 11, fill: "var(--analysis-muted)" }}
              minTickGap={50}
            />
            <YAxis
              width={75}
              tick={{ fontSize: 11, fill: "var(--analysis-muted)" }}
              tickFormatter={(v) =>
                indexed
                  ? String(Math.round(v))
                  : analysisValue(v, definitions[0]?.format)
              }
            />
            <Tooltip
              contentStyle={{
                background: "var(--analysis-panel)",
                border: "1px solid var(--analysis-border)",
                color: "var(--analysis-text)",
              }}
              formatter={(v: any, name: any) => [
                indexed
                  ? Number(v).toFixed(2)
                  : analysisValue(
                      Number(v),
                      definitions.find((d) => d.label === name)?.format,
                    ),
                name,
              ]}
            />
            <Legend wrapperStyle={{ paddingTop: 15, fontSize: 12 }} />
            {keys.map((key, i) => (
              <Line
                key={key}
                type="linear"
                dataKey={key}
                name={definitions[i].label}
                stroke={colors[i]}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
