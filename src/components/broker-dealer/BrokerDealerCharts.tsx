"use client";

import { useId, useState } from "react";
import styles from "./BrokerDealerWorkspace.module.css";

export type ChartSeries = { id: string; label: string; color: string; format?: string };
export type ChartPeriod = { key: string; label: string; values: Record<string, number | null> };

export function displayAmount(value: number | null | undefined, format = "USD", compact = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (format === "percent") return `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  if (format === "multiple" || format === "ratio") return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 0 }).format(value);
}

export function TrendChart({ periods, series, title, description }: { periods: ChartPeriod[]; series: ChartSeries[]; title: string; description: string }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const selected = periods.find(period => period.key === hovered) || periods.at(-1);
  const values = periods.flatMap(period => series.map(item => period.values[item.id])).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const range = high - low || 1;
  const x = (index: number) => periods.length > 1 ? 68 + index * 646 / (periods.length - 1) : 391;
  const y = (value: number) => 211 - (value - low) / range * 174;
  const activeIndex = Math.max(0, periods.findIndex(period => period.key === selected?.key));
  return <figure className={styles.chartPanel} aria-labelledby={titleId}>
    <figcaption><div><h3 id={titleId}>{title}</h3><p>{description}</p></div><span className={styles.chartUnit}>{series[0]?.format === "percent" ? "%" : series[0]?.format === "multiple" ? "Multiple" : "USD"}</span></figcaption>
    {!values.length ? <div className={styles.chartEmpty}>No supported figures for this selection.</div> : <>
      <svg className={styles.trendSvg} viewBox="0 0 750 254" role="group" aria-label={`${title}. Focus a reporting period to inspect exact values.`}>
        {[0, 0.5, 1].map(position => { const value = low + range * position; return <g key={position}><line x1="68" x2="714" y1={y(value)} y2={y(value)} className={styles.gridLine} /><text x="57" y={y(value) + 4} textAnchor="end" className={styles.axisLabel}>{displayAmount(value, series[0]?.format || "USD", true)}</text></g>; })}
        {selected && <line x1={x(activeIndex)} x2={x(activeIndex)} y1="27" y2="217" className={styles.cursorLine} />}
        {series.map(item => {
          // Break paths at missing periods; a missing disclosure is never a zero.
          let previous = false;
          const path = periods.map((period, index) => { const value = period.values[item.id]; if (value === null || value === undefined || !Number.isFinite(value)) { previous = false; return ""; } const point = `${previous ? "L" : "M"}${x(index)},${y(value)}`; previous = true; return point; }).join(" ");
          return <g key={item.id}><path d={path} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />{periods.map((period, index) => typeof period.values[item.id] === "number" && Number.isFinite(period.values[item.id]) ? <circle key={period.key} cx={x(index)} cy={y(period.values[item.id]!)} r={period.key === selected?.key ? 5 : 3.5} fill={item.color} stroke="var(--bdw-surface)" strokeWidth="2" /> : null)}</g>;
        })}
        {periods.map((period, index) => <g key={period.key}>
          <text x={x(index)} y="244" textAnchor="middle" className={styles.axisLabel}>{period.label}</text>
          <rect x={x(index) - (periods.length > 1 ? Math.min(36, 290 / periods.length) : 44)} y="20" width={periods.length > 1 ? Math.min(72, 580 / periods.length) : 88} height="205" fill="transparent" tabIndex={0} role="button" aria-label={`${period.label}: ${series.map(item => `${item.label} ${displayAmount(period.values[item.id], item.format)}`).join(", ")}`} onFocus={() => setHovered(period.key)} onPointerEnter={() => setHovered(period.key)} onClick={() => setHovered(period.key)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setHovered(period.key); } }} />
        </g>)}
      </svg>
      <div className={styles.chartReadout} aria-live="polite"><strong>{selected?.label}</strong>{series.map(item => <span key={item.id}><i style={{ background: item.color }} /><span>{item.label}</span><b>{displayAmount(selected?.values[item.id], item.format)}</b></span>)}</div>
      {periods.length < 2 && <p className={styles.chartNote}>Choose another report period to see change over time.</p>}
    </>}
  </figure>;
}

export function BalanceBars({ title, description, total, items }: { title: string; description: string; total?: number; items: Array<{ id: string; label: string; value?: number; color: string; sourceHref?: string }> }) {
  const visible = items.filter(item => typeof item.value === "number" && Number.isFinite(item.value));
  return <section className={styles.balancePanel}><div className={styles.panelHeading}><h3>{title}</h3><p>{description}</p></div>
    {!visible.length ? <p className={styles.muted}>These balances were not mapped from the selected report.</p> : <div className={styles.balanceBars}>{visible.map(item => {
      const ratio = typeof total === "number" && total > 0 && item.value! >= 0 ? item.value! / total : null;
      return <div key={item.id} className={styles.balanceRow}><div><span>{item.label}</span><strong title={displayAmount(item.value)}>{displayAmount(item.value, "USD", true)}</strong></div><div className={styles.barTrack}><span style={{ width: `${ratio === null ? 0 : Math.min(100, ratio * 100)}%`, background: item.color }} /></div><div className={styles.barFoot}><span>{ratio === null ? "Share unavailable" : `${displayAmount(ratio, "percent")} of total assets`}</span>{item.sourceHref && <a href={item.sourceHref} target="_blank" rel="noreferrer">Source ↗</a>}</div></div>;
    })}</div>}
  </section>;
}
