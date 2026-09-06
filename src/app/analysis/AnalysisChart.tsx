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
  ReferenceLine,
} from "recharts";
import { analysisValue } from "../../utils/analysisNotebook.js";
import { buildAnalysisChart } from "../../utils/analysisChart.js";
import styles from "./analysis.module.css";
import chartStyles from "./AnalysisChart.module.css";

const colors = ["#e5aa22", "#27b7c5", "#9b88ef"];
const modeLabels = {
  reported: "Reported values",
  indexed: "Indexed to 100",
  yearChange: "Same-season year-over-year change",
};

export default function AnalysisChart({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const model = buildAnalysisChart(data, settings, index);
  const selected = data.periods[index];
  const formatValue = (value: number, format: string) =>
    analysisValue(value, format, settings.units);
  const inspect = (item: any, row: any) =>
    onInspect?.({
      definition: item.displayDefinition,
      point: row.points[item.key],
    });
  const plottedSeries = model.series.filter((item) =>
    model.plottedKeys.includes(item.key),
  );
  const present = model.rows.reduce(
    (sum, row) =>
      sum +
      model.plottedKeys.filter((key) => Number.isFinite(row.points[key]?.value))
        .length,
    0,
  );
  if (!model.series.length || !selected)
    return (
      <p className={styles.notice}>
        No financial observations are available for this chart.
      </p>
    );
  return (
    <>
      <div className={chartStyles.summary}>
        <strong>{modeLabels[model.mode]}</strong>
        <span>
          {present} / {model.rows.length * model.plottedKeys.length} available
          points
        </span>
      </div>
      <p className={styles.muted}>
        {model.mode === "indexed"
          ? model.base
            ? `Each series equals 100 at ${model.base.period.end}, the first displayed period with a positive value for every selected metric. Later negative values remain visible.`
            : "No shared positive starting period is available for indexing."
          : model.mode === "yearChange"
            ? "Each point compares with the same fiscal season one year earlier. Amounts use percentage growth; percentage ratios use percentage-point changes; multiples and days use absolute changes."
            : "Reported values use the selected display units. Missing observations and missing periods break the line."}
        {data.basis === "ytd" &&
          ` Only fiscal ${selected.fp} observations are displayed, so cumulative periods of different lengths are not joined.`}{" "}
        Select a dot or any table value to inspect its original SEC inputs.
      </p>
      {model.discardedKeys.length > 0 && (
        <p className={styles.notice} role="status">
          {model.discardedKeys.length} saved chart selection
          {model.discardedKeys.length === 1 ? " is" : "s are"} unavailable,
          duplicated, or beyond the three-metric limit.
          {model.usedFallback &&
            " Available company metrics are shown instead."}
        </p>
      )}
      {model.withheldKeys.length > 0 && (
        <p className={styles.notice} role="status">
          {model.series
            .filter((item) => model.withheldKeys.includes(item.key))
            .map((item) => item.definition.label)
            .join(", ")}{" "}
          withheld from this chart because{" "}
          {model.withheldKeys.length === 1 ? "it uses" : "they use"} different
          units from {model.series[0].definition.label}. Choose metrics with the
          same units, or select Indexed to 100 to compare relative paths.
        </p>
      )}
      <div
        className={styles.chart}
        role="img"
        aria-label={`${modeLabels[model.mode]} for ${plottedSeries.map((item) => item.definition.label).join(", ")}. Full values and source controls are in the following table.`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={model.chart}
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
              tickFormatter={(value) =>
                value.startsWith("Missing period") ? "Gap" : value
              }
            />
            <YAxis
              width={90}
              tick={{ fontSize: 11, fill: "var(--analysis-muted)" }}
              tickFormatter={(value) => formatValue(value, model.unit)}
            />
            {model.mode === "yearChange" && (
              <ReferenceLine
                y={0}
                stroke="var(--analysis-muted)"
                strokeDasharray="4 4"
              />
            )}
            {model.mode === "indexed" && (
              <ReferenceLine
                y={100}
                stroke="var(--analysis-muted)"
                strokeDasharray="4 4"
              />
            )}
            <Tooltip
              contentStyle={{
                background: "var(--analysis-panel)",
                border: "1px solid var(--analysis-border)",
                color: "var(--analysis-text)",
              }}
              formatter={(value: any, name: any) => [
                formatValue(
                  Number(value),
                  model.series.find((item) => item.definition.label === name)
                    ?.displayDefinition.format || model.unit,
                ),
                name,
              ]}
            />
            <Legend wrapperStyle={{ paddingTop: 15, fontSize: 12 }} />
            {plottedSeries.map((item, i) => (
              <Line
                key={item.key}
                type="linear"
                dataKey={item.key}
                name={item.definition.label}
                stroke={colors[i]}
                strokeWidth={2.5}
                dot={(props: any) => {
                  const row = model.rows.find(
                    (entry) => entry.index === props.payload?.periodIndex,
                  );
                  if (!row || !Number.isFinite(row.points[item.key]?.value))
                    return <g key={`${item.key}:empty:${props.index}`} />;
                  return (
                    <circle
                      key={`${item.key}:${row.period.end}`}
                      cx={props.cx}
                      cy={props.cy}
                      r={4}
                      fill={colors[i]}
                      stroke="transparent"
                      strokeWidth={12}
                      className={chartStyles.dot}
                      onClick={() => inspect(item, row)}
                    >
                      <title>
                        {item.definition.label}, {row.period.end}:{" "}
                        {formatValue(
                          row.points[item.key].value,
                          item.displayDefinition.format,
                        )}
                        . Inspect SEC evidence.
                      </title>
                    </circle>
                  );
                }}
                activeDot={{ r: 5, pointerEvents: "none" }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div
        className={styles.tableScroll}
        tabIndex={0}
        role="region"
        aria-label="Chart values and SEC evidence; scroll horizontally if needed"
      >
        <table>
          <caption className={chartStyles.caption}>
            {modeLabels[model.mode]} · source evidence for every plotted
            observation
          </caption>
          <thead>
            <tr>
              <th scope="col">Fiscal period</th>
              {model.series.map((item) => (
                <th scope="col" key={item.key}>
                  {item.definition.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.period.end}>
                <th scope="row">
                  {row.period.fp} {row.period.fy}
                  <small className={chartStyles.date}>{row.period.end}</small>
                </th>
                {model.series.map((item) => {
                  const point = row.points[item.key];
                  return (
                    <td key={item.key}>
                      <button
                        type="button"
                        className={styles.valueButton}
                        onClick={() => inspect(item, row)}
                        disabled={!onInspect}
                        aria-label={`Inspect ${item.displayDefinition.label}, ${row.period.end}: ${Number.isFinite(point.value) ? formatValue(point.value, item.displayDefinition.format) : "unavailable"}`}
                      >
                        {formatValue(
                          point.value,
                          item.displayDefinition.format,
                        )}
                      </button>
                      {!Number.isFinite(point.value) && (
                        <small className={chartStyles.reason}>
                          {point.reason}
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
    </>
  );
}
