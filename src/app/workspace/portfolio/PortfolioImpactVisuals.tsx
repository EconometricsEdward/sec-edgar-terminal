"use client";

import { useId } from "react";
import s from "./PortfolioImpact.module.css";

export const impactNumber = (value: unknown, signed = false, digits = 1) =>
  typeof value !== "number" || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        maximumFractionDigits: digits,
        signDisplay: signed ? "exceptZero" : "auto",
      }).format(Math.abs(value) < 1e-9 ? 0 : value);

export const impactMoney = (value: unknown, signed = false, full = false) =>
  typeof value !== "number" || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: full ? "standard" : "compact",
        maximumFractionDigits: full ? 0 : 2,
        signDisplay: signed ? "exceptZero" : "auto",
      }).format(Math.abs(value) < 1e-9 ? 0 : value);

function axis(values: number[]) {
  const low = Math.min(0, ...values),
    high = Math.max(0, ...values);
  const padding = (high - low || 1) * 0.12;
  return { low: low < 0 ? low - padding : 0, high: high + padding };
}

export function ImpactWaterfall({ row }: { row: any }) {
  const id = useId();
  const changes = row.components || [];
  const labels: Record<string, string> = {
    revenue: "Revenue change",
    volumeCosts: "Volume-linked costs",
    costChange: "Cost pressure",
    cashFlow: "Cash flow change",
    assetLoss: "Asset loss",
  };
  const bars = [
    {
      id: "baseline",
      label: "Reported",
      value: row.baseline,
      start: 0,
      end: row.baseline,
      total: true,
    },
    ...changes.map((part: any, index: number) => {
      const start =
        row.baseline +
        changes
          .slice(0, index)
          .reduce((sum: number, item: any) => sum + item.value, 0);
      return {
        ...part,
        label: labels[part.id] || part.label,
        start,
        end: start + part.value,
        total: false,
      };
    }),
    {
      id: "modeled",
      label: "Scenario",
      value: row.modeled,
      start: 0,
      end: row.modeled,
      total: true,
    },
  ];
  const domain = axis(bars.flatMap((bar: any) => [bar.start, bar.end]));
  const width = 580,
    height = 270,
    left = 66,
    right = 18,
    top = 27,
    bottom = 66;
  const plotHeight = height - top - bottom;
  const y = (value: number) =>
    top + ((domain.high - value) / (domain.high - domain.low)) * plotHeight;
  const step = (width - left - right) / bars.length;
  const barWidth = Math.min(62, step * 0.64);
  return (
    <svg
      className={s.chart}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
    >
      <title id={`${id}-title`}>
        {row.ticker}: from reported to modeled {row.metricLabel}
      </title>
      <desc id={`${id}-description`}>
        Reported {impactMoney(row.baseline, false, true)}.{" "}
        {row.components
          .map(
            (part: any) =>
              `${part.label}: ${impactMoney(part.value, true, true)}.`,
          )
          .join(" ")}{" "}
        Scenario {impactMoney(row.modeled, false, true)}. All values are company
        dollars.
      </desc>
      {[0, 1, 2, 3].map((tick) => {
        const value = domain.low + ((domain.high - domain.low) * tick) / 3;
        return (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
              className={s.gridLine}
            />
            <text
              x={left - 9}
              y={y(value) + 4}
              textAnchor="end"
              className={s.axisText}
            >
              {impactMoney(value)}
            </text>
          </g>
        );
      })}
      <line
        x1={left}
        x2={width - right}
        y1={y(0)}
        y2={y(0)}
        className={s.zeroLine}
      />
      {bars.map((bar: any, index: number) => {
        const x = left + step * (index + 0.5),
          barTop = Math.min(y(bar.start), y(bar.end));
        const parts = bar.label.split(" ");
        const split =
          parts.length > 2 ? Math.ceil(parts.length / 2) : parts.length;
        return (
          <g key={bar.id}>
            {index < bars.length - 1 && (
              <line
                x1={x + barWidth / 2}
                x2={x + step - barWidth / 2}
                y1={y(bar.end)}
                y2={y(bar.end)}
                className={s.connectorLine}
              />
            )}
            <rect
              x={x - barWidth / 2}
              y={barTop}
              width={barWidth}
              height={Math.max(1, Math.abs(y(bar.end) - y(bar.start)))}
              rx="3"
              className={
                bar.total
                  ? index === 0
                    ? s.baselineFill
                    : s.scenarioFill
                  : bar.value < 0
                    ? s.negativeFill
                    : s.positiveFill
              }
            />
            <text
              x={x}
              y={Math.max(13, barTop - 8)}
              textAnchor="middle"
              className={s.valueText}
            >
              {impactMoney(bar.value, !bar.total)}
            </text>
            <text
              x={x}
              y={height - bottom + 22}
              textAnchor="middle"
              className={s.axisText}
            >
              <tspan x={x}>{parts.slice(0, split).join(" ")}</tspan>
              {split < parts.length && (
                <tspan x={x} dy="16">
                  {parts.slice(split).join(" ")}
                </tspan>
              )}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ImpactSensitivity({
  row,
  control,
  value,
}: {
  row: any;
  control: any;
  value: number;
}) {
  const id = useId();
  const observations = [...(row.sensitivity || [])]
    .filter((point: any) => Number.isFinite(point.shock))
    .sort((a: any, b: any) => a.shock - b.shock);
  const points = observations.filter((point: any) =>
    Number.isFinite(point.value),
  );
  if (points.length < 2)
    return (
      <p>There is not enough valid input coverage to draw this sensitivity.</p>
    );
  const width = 580,
    height = 270,
    left = 66,
    right = 25,
    top = 27,
    bottom = 66;
  const domain = axis([
    ...points.map((point: any) => point.value),
    row.modeled,
  ]);
  const min = Math.min(points[0].shock, value),
    max = Math.max(points[points.length - 1].shock, value);
  const x = (shock: number) =>
    left + ((shock - min) / (max - min || 1)) * (width - left - right);
  const y = (amount: number) =>
    top +
    ((domain.high - amount) / (domain.high - domain.low)) *
      (height - top - bottom);
  const line = observations
    .map((point: any, index: number) =>
      Number.isFinite(point.value)
        ? `${index && Number.isFinite(observations[index - 1].value) ? "L" : "M"}${x(point.shock)},${y(point.value)}`
        : "",
    )
    .join(" ");
  return (
    <svg
      className={s.chart}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${id}-title ${id}-description`}
    >
      <title id={`${id}-title`}>
        {row.ticker}: sensitivity to {control.label}
      </title>
      <desc id={`${id}-description`}>
        The line varies only {control.label.toLowerCase()}, keeping other
        assumptions fixed. Your assumption is {impactNumber(value)}
        {control.unit || "%"}, producing {impactMoney(row.modeled, false, true)}
        . This is a calculated sensitivity, without assigned probabilities.
      </desc>
      {[0, 1, 2, 3].map((tick) => {
        const amount = domain.low + ((domain.high - domain.low) * tick) / 3;
        return (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={y(amount)}
              y2={y(amount)}
              className={s.gridLine}
            />
            <text
              x={left - 9}
              y={y(amount) + 4}
              textAnchor="end"
              className={s.axisText}
            >
              {impactMoney(amount)}
            </text>
          </g>
        );
      })}
      <line
        x1={left}
        x2={width - right}
        y1={y(0)}
        y2={y(0)}
        className={s.zeroLine}
      />
      <path d={line} className={s.sensitivityLine} />
      <line
        x1={x(value)}
        x2={x(value)}
        y1={top}
        y2={height - bottom}
        className={s.currentLine}
      />
      <circle
        cx={x(value)}
        cy={y(row.modeled)}
        r="5"
        className={s.scenarioFill}
      />
      {[min, (min + max) / 2, max].map((shock, index) => (
        <text
          key={index}
          x={x(shock)}
          y={height - bottom + 23}
          textAnchor="middle"
          className={s.axisText}
        >
          {impactNumber(shock, true)}
          {control.unit || "%"}
        </text>
      ))}
      <text
        x={width / 2}
        y={height - 10}
        textAnchor="middle"
        className={s.axisText}
      >
        {control.label} · other assumptions held fixed
      </text>
    </svg>
  );
}
