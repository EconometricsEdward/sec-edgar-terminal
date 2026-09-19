"use client";
import { useMemo, useState, type CSSProperties } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ScatterChart,
  Scatter,
  ReferenceLine,
  LabelList,
} from "recharts";
import { ArrowUpRight } from "lucide-react";
import {
  trendSeries,
  historicGrowth,
  METRIC_BY_KEY,
  periodBucket,
} from "../../../utils/compareResearch.js";
import {
  COLORS,
  displayValue,
  type CompareSettings,
  type CompareEvidence,
} from "../compareTypes";
import { compatibleMapSample } from "../../../utils/compareBenchmarks.js";
import styles from "./CompareCharts.module.css";

type Props = {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  update: (patch: Partial<CompareSettings>) => void;
  inspect: (e: CompareEvidence) => void;
};

function companyStyle(entry: any, index: number): CSSProperties {
  return { "--company-color": entry.color || COLORS[index % COLORS.length] } as CSSProperties;
}

function evidence(entry: any, metric: any, point: any): CompareEvidence {
  return {
    metric,
    cell: {
      ticker: entry.ticker,
      cik: entry.data?.cik,
      name: entry.data?.name,
      point,
      period: point?.period || entry.period,
    },
  };
}

function trendPoint(entry: any, key: string, bucket: string, basis: string) {
  return entry.period && entry.index >= 0
    ? entry.data?.metrics[key]?.find((point: any) =>
      periodBucket(point.period, basis) === bucket && point.period.end <= entry.period.end,
    )
    : null;
}

function TrendTooltip({ active, payload, label, metric, indexed }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <strong>{label} · {metric.label}</strong>
      {payload.map((item: any) => (
        <div className={styles.tooltipRow} key={item.dataKey}>
          <span><i style={{ background: item.color }} />{item.name}<small>{item.payload[`${item.dataKey}Date`]}</small></span>
          <b>{indexed ? `${Number(item.value).toFixed(1)} index` : displayValue(item.value, metric.format)}</b>
        </div>
      ))}
    </div>
  );
}

function MapTooltip({ active, payload, xMetric, yMetric }: any) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className={styles.tooltip}>
      <strong>{point.ticker} · {point.company.data.name}</strong>
      <small>{point.company.period.end}</small>
      <div className={styles.tooltipRow}><span>{xMetric.label}</span><b>{displayValue(point.x, xMetric.format)}</b></div>
      <div className={styles.tooltipRow}><span>{yMetric.label}</span><b>{displayValue(point.y, yMetric.format)}</b></div>
      <small>Select the point to inspect {yMetric.label.toLowerCase()}.</small>
    </div>
  );
}

export function CompareTrends({ entries, metrics, settings, update, inspect }: Props) {
  const metric = METRIC_BY_KEY[settings.metric] || metrics[0];
  const [highlighted, setHighlighted] = useState("");
  const series = useMemo(() => trendSeries(entries, metric.key, settings), [entries, metric.key, settings]);
  const companies = entries.filter((entry) => entry.data);
  const active = companies.some((entry) => entry.ticker === highlighted) ? highlighted : "";
  const hasValues = series.rows.some((row) => companies.some((entry) => Number.isFinite(row[entry.ticker])));
  const formatter = (value: any) => settings.mode === "indexed"
    ? Number(value).toFixed(0)
    : displayValue(Number(value), metric.format);
  return (
    <section className={styles.workspace} aria-label="Trends and growth">
      <div className={styles.heading}>
        <div><span className={styles.eyebrow}>Across time</span><h2>{metric.label}</h2><p>See how each company has changed.</p></div>
        <div className={styles.controls}>
          <label>Metric<select value={metric.key} onChange={(event) => update({ metric: event.target.value })}>
            {metrics.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select></label>
          <label>Scale<select value={settings.mode} onChange={(event) => update({ mode: event.target.value })}>
            <option value="absolute">Actual values</option><option value="indexed">Start together at 100</option>
          </select></label>
          <label>History<select value={settings.years} onChange={(event) => update({ years: Number(event.target.value) })}>
            <option value={3}>3 years</option><option value={5}>5 years</option><option value={10}>10 years</option>
          </select></label>
        </div>
      </div>
      <div className={styles.companyLegend} aria-label="Highlight a company in the trend chart">
        {companies.map((entry, index) => (
          <button key={entry.ticker} type="button" className={styles.companyKey} style={companyStyle(entry, index)}
            aria-pressed={active === entry.ticker} onClick={() => setHighlighted(active === entry.ticker ? "" : entry.ticker)}>
            <i />{entry.ticker}
          </button>
        ))}
        <span>Select a company to highlight</span>
      </div>
      {hasValues ? (
        <figure className={styles.chart} aria-label={`${metric.label} historical comparison. Exact values and sources are available in chart observations below.`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series.rows} margin={{ top: 20, right: 22, left: 0, bottom: 8 }} accessibilityLayer>
              <CartesianGrid stroke="var(--compare-border)" strokeOpacity={0.6} strokeDasharray="2 6" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fill: "var(--compare-muted)", fontSize: 11 }} minTickGap={45} tickLine={false} axisLine={false} />
              <YAxis tickFormatter={formatter} tick={{ fill: "var(--compare-muted)", fontSize: 11 }} width={86} tickLine={false} axisLine={false} />
              <Tooltip content={<TrendTooltip metric={metric} indexed={settings.mode === "indexed"} />} />
              {settings.mode === "indexed" && <ReferenceLine y={100} stroke="var(--compare-muted)" strokeDasharray="5 5" />}
              {companies.map((entry, index) => (
                <Line key={entry.ticker} type="linear" dataKey={entry.ticker} name={entry.ticker}
                  stroke={entry.color || COLORS[index % COLORS.length]} strokeWidth={active === entry.ticker ? 3.5 : 2.4}
                  strokeOpacity={active && active !== entry.ticker ? 0.22 : 1}
                  dot={series.rows.length < 15 ? { r: 3, strokeWidth: 0 } : false}
                  activeDot={(dot: any) => {
                    const point = trendPoint(entry, metric.key, dot.payload?.bucket, settings.basis);
                    return <circle cx={dot.cx} cy={dot.cy} r={6} fill={entry.color || COLORS[index % COLORS.length]}
                      stroke="var(--compare-text)" strokeWidth={2} className={styles.mapPoint} role="button" tabIndex={0}
                      aria-label={`Inspect ${entry.ticker} ${metric.label}, ${point?.period.end || dot.payload?.bucket}`}
                      onClick={() => { if (point) inspect(evidence(entry, metric, point)); }}
                      onKeyDown={(event) => { if (point && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); inspect(evidence(entry, metric, point)); } }} />;
                  }}
                  connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </figure>
      ) : (
        <div className={styles.empty}><strong>No chartable observations for this selection.</strong><p>{settings.mode === "indexed" ? series.note : "Choose another metric, period, or company to explore its history."}</p></div>
      )}
      <p className={styles.note}>{series.note}</p>
      <div className={styles.growthSummary}>
        <div className={styles.summaryHeading}><h3>Change at a glance</h3><span>Same period a year earlier{metric.format === "currency" ? " · 3-year annualized growth where available" : " · ratios show the arithmetic change"}</span></div>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th>Company</th><th>Selected period</th><th>Year-over-year change</th>{metric.format === "currency" && <th>3-year CAGR</th>}</tr></thead>
            <tbody>{companies.map((entry, index) => {
              const growth = historicGrowth(entry.data, metric.key, entry.index);
              const point = entry.data.metrics[metric.key]?.[entry.index];
              return (
                <tr key={entry.ticker}>
                  <th scope="row"><span className={styles.companyName} style={companyStyle(entry, index)}><i />{entry.ticker}</span></th>
                  <td><button type="button" className={styles.value} disabled={!point} onClick={() => inspect(evidence(entry, metric, point))}>{displayValue(point?.value, metric.format)}<ArrowUpRight size={12} /></button><small>{entry.period?.end || "No selected period"}</small></td>
                  <td><button type="button" className={styles.value} disabled={!growth.prior} title={growth.yoy.reason || `Compare with ${growth.prior?.period.end}`} onClick={() => inspect(evidence(entry, metric, growth.prior))}>
                    {growth.yoy.value == null ? "—" : `${growth.yoy.value > 0 ? "+" : ""}${growth.yoy.value.toFixed(2)} ${growth.yoy.unit === "x" ? "×" : growth.yoy.unit}`}
                    {growth.prior && <ArrowUpRight size={12} />}
                  </button><small>{growth.yoy.reason || `From ${growth.prior?.period.end}`}</small></td>
                  {metric.format === "currency" && <td><button type="button" className={styles.value} disabled={growth.cagr == null || !growth.start} onClick={() => inspect(evidence(entry, metric, growth.start))}>
                    {growth.cagr == null ? "—" : `${growth.cagr.toFixed(2)}%`}{growth.cagr != null && <ArrowUpRight size={12} />}
                  </button><small>{growth.cagr == null ? growth.cagrReason || "Positive, comparable endpoints required" : `From ${growth.start.period.end}`}</small></td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
      <details className={styles.details}>
        <summary>Chart observations & sources <span>{series.rows.length} period-end buckets</span></summary>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th>Period-end bucket</th>{entries.map((entry) => <th key={entry.ticker}>{entry.ticker}</th>)}</tr></thead>
            <tbody>{[...series.rows].reverse().map((row) => (
              <tr key={row.bucket}><th scope="row">{row.bucket}</th>{entries.map((entry) => {
                const point = trendPoint(entry, metric.key, row.bucket, settings.basis);
                return <td key={entry.ticker}><button type="button" className={styles.value} disabled={!point} onClick={() => inspect(evidence(entry, metric, point))}>{displayValue(point?.value, metric.format)}<ArrowUpRight size={12} /></button><small>{point?.period.end || "No observation"}{settings.mode === "indexed" && ` · Index: ${row[entry.ticker] == null ? "—" : row[entry.ticker].toFixed(1)}`}</small></td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

const MAP_PRESETS = [
  { label: "Capital & returns", x: "equityAssets", y: "roa" },
  { label: "Cash & debt", x: "debtAssets", y: "cashAssets" },
  { label: "Scale & margin", x: "revenue", y: "operatingMargin" },
  { label: "Bank funding & returns", x: "loanDeposits", y: "roe" },
];

export function CompareMap({ entries, metrics, settings, update, inspect }: Props) {
  const xMetric = METRIC_BY_KEY[settings.x], yMetric = METRIC_BY_KEY[settings.y];
  const sample = compatibleMapSample(entries, settings.x, settings.y);
  const plotted = sample.plotted.map((row, index) => ({
    ticker: row.entry.ticker, x: row.x.point.value, y: row.y.point.value,
    color: row.entry.color || COLORS[index % COLORS.length], company: row.entry,
    xPoint: row.x.point, yPoint: row.y.point,
  }));
  const presets = MAP_PRESETS.filter((preset) => [preset.x, preset.y].every((key) => metrics.some((metric) => metric.key === key)));
  return (
    <section className={styles.workspace} aria-label="Peer map">
      <div className={styles.heading}>
        <div><span className={styles.eyebrow}>Side by side</span><h2>Where companies stand</h2><p>Compare two dimensions. Select a company’s point to inspect its source.</p></div>
        <span className={styles.sampleCount}><b>{sample.count}</b> of {sample.total} issuers plotted</span>
      </div>
      <div className={styles.mapToolbar}>
        <div className={styles.presets} aria-label="Peer map presets">{presets.map((preset) => (
          <button type="button" key={preset.label} aria-pressed={settings.x === preset.x && settings.y === preset.y} onClick={() => update({ x: preset.x, y: preset.y })}>{preset.label}</button>
        ))}</div>
        <div className={styles.controls}>
          <label>Horizontal axis<select value={settings.x} onChange={(event) => update({ x: event.target.value })}>{metrics.map((metric) => <option key={metric.key} value={metric.key}>{metric.label}</option>)}</select></label>
          <label>Vertical axis<select value={settings.y} onChange={(event) => update({ y: event.target.value })}>{metrics.map((metric) => <option key={metric.key} value={metric.key}>{metric.label}</option>)}</select></label>
        </div>
      </div>
      <p className={styles.axisCaption}>{yMetric.label} <span>↑</span></p>
      {plotted.length ? (
        <figure className={`${styles.chart} ${styles.mapChart}`} aria-label={`${yMetric.label} on the vertical axis versus ${xMetric.label} on the horizontal axis. Exact values and sources are available below.`}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 35, right: 42, left: 0, bottom: 10 }} accessibilityLayer>
              <CartesianGrid stroke="var(--compare-border)" strokeOpacity={0.6} strokeDasharray="2 6" />
              <XAxis type="number" dataKey="x" name={xMetric.label} tickFormatter={(value) => displayValue(value, xMetric.format)} tick={{ fill: "var(--compare-muted)", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={35} />
              <YAxis type="number" dataKey="y" name={yMetric.label} tickFormatter={(value) => displayValue(value, yMetric.format)} width={86} tick={{ fill: "var(--compare-muted)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<MapTooltip xMetric={xMetric} yMetric={yMetric} />} />
              {sample.xMedian != null && <ReferenceLine x={sample.xMedian} stroke="var(--compare-muted)" strokeDasharray="6 5" />}
              {sample.yMedian != null && <ReferenceLine y={sample.yMedian} stroke="var(--compare-muted)" strokeDasharray="6 5" />}
              {plotted.map((point) => (
                <Scatter key={point.ticker} name={point.ticker} data={[point]} fill={point.color} isAnimationActive={false}
                  shape={(props: any) => <circle cx={props.cx} cy={props.cy} r={7} fill={point.color} stroke="var(--compare-bg)" strokeWidth={2} className={styles.mapPoint} role="button" tabIndex={0}
                    aria-label={`${point.ticker}: ${xMetric.label} ${displayValue(point.x, xMetric.format)}, ${yMetric.label} ${displayValue(point.y, yMetric.format)}. Inspect ${yMetric.label}.`}
                    onClick={() => inspect(evidence(point.company, yMetric, point.yPoint))}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect(evidence(point.company, yMetric, point.yPoint)); } }} />}
                ><LabelList dataKey="ticker" position="top" offset={12} fill="var(--compare-text)" fontSize={12} fontWeight={650} /></Scatter>
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </figure>
      ) : <div className={styles.empty}><strong>No companies have usable values on both axes.</strong><p>Choose different metrics or a reporting period to build the map.</p></div>}
      <p className={`${styles.axisCaption} ${styles.horizontalCaption}`}>{xMetric.label} <span>→</span></p>
      <div className={styles.mapFootnote}>
        {sample.reason ? <p className={styles.note}>Median guides unavailable: {sample.reason}</p> : <p className={styles.note}><span className={styles.dashedKey} />Peer median: {displayValue(sample.xMedian, xMetric.format)} horizontal · {displayValue(sample.yMedian, yMetric.format)} vertical. Both use the same {sample.count} issuers.</p>}
        <span>Equal-size points · Actual reporting dates below</span>
      </div>
      <details className={styles.details}>
        <summary>Values, reporting dates & sources <span>{sample.total - sample.count > 0 ? `${sample.total - sample.count} issuers not plotted` : "All plotted companies"}</span></summary>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr><th>Company / reporting end</th><th>{xMetric.label}</th><th>{yMetric.label}</th><th>Map coverage</th></tr></thead>
            <tbody>{entries.map((entry, index) => (
              <tr key={entry.ticker}>
                <th scope="row"><span className={styles.companyName} style={companyStyle(entry, index)}><i />{entry.ticker}</span><small>{entry.period?.end || "No selected period"}</small></th>
                {[xMetric, yMetric].map((metric, axis) => {
                  const point = entry.data?.metrics[metric.key]?.[entry.index];
                  return <td key={axis}><button type="button" className={styles.value} disabled={!point} onClick={() => inspect(evidence(entry, metric, point))}>{displayValue(point?.value, metric.format)}<ArrowUpRight size={12} /></button></td>;
                })}
                <td className={styles.coverage}>{plotted.some((point) => point.ticker === entry.ticker) ? "Both axis values available" : sample.rows.find((row) => row.entry.ticker === entry.ticker)?.reason || "Missing input or filing"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
