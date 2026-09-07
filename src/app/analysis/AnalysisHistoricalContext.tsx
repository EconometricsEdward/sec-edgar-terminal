"use client";

import { useState } from "react";
import { historicalContext } from "../../utils/analysisHistory.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import base from "./analysis.module.css";
import styles from "./AnalysisHistoricalContext.module.css";

export default function AnalysisHistoricalContext({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const [chosen, setChosen] = useState("");
  const definitions = data.definitions.filter((item: any) =>
    ["currency", "shares", "eps", "percent", "decimal", "days"].includes(
      item.format || "currency",
    ),
  );
  const preferred =
    chosen ||
    settings.growthMetric ||
    (data.lens === "banking" ? "bankNetMargin" : "netMargin");
  const metric =
    definitions.find((item: any) => item.key === preferred) ||
    definitions.find((item: any) => item.key === data.revenueKey) ||
    definitions[0];
  if (!metric) return null;
  const context = historicalContext(
    data,
    metric.key,
    index,
    settings.years || 8,
  );
  const value = (point: any) =>
    analysisValue(point?.value, metric.format, settings.units);
  const inspect = (point: any, summary = false) =>
    onInspect({
      definition: summary
        ? {
            ...metric,
            key: `${metric.key}:history:median`,
            label: `${metric.label} · prior same-season median`,
          }
        : metric,
      point,
    });
  const range = context.low && context.high;
  const minimum = range
    ? Math.min(context.low!.point.value, context.current.value)
    : 0;
  const maximum = range
    ? Math.max(context.high!.point.value, context.current.value)
    : 1;
  const position = (amount: number) =>
    maximum === minimum
      ? 50
      : 4 + ((amount - minimum) / (maximum - minimum)) * 92;
  return (
    <section className={base.panel} aria-label="Historical financial context">
      <div className={styles.heading}>
        <div>
          <p className={base.eyebrow}>Company history</p>
          <h2>Put this period in perspective</h2>
        </div>
        <label>
          Historical context measure
          <select
            value={metric.key}
            onChange={(event) => setChosen(event.target.value)}
          >
            {definitions.map((item: any) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={base.muted}>
        Compare the selected period with up to {context.limit} prior years of
        this company. Only the same fiscal season and compatible reporting
        durations enter the sample. The selected period is always excluded.
        {data.basis === "ttm" &&
          " Trailing-year observations use annual anchors so included windows do not overlap."}
      </p>
      <div className={styles.stats}>
        <article>
          <span>Selected period</span>
          <button
            className={styles.value}
            onClick={() => inspect(context.current)}
            disabled={!context.current}
          >
            {value(context.current)}
          </button>
          <small>{context.period?.end}</small>
        </article>
        <article>
          <span>Prior median</span>
          <button
            className={styles.value}
            onClick={() => inspect(context.median, true)}
          >
            {value(context.median)}
          </button>
          <small>
            {context.count >= 2
              ? `${context.count} equally weighted prior observations`
              : "Two compatible prior observations required"}
          </small>
        </article>
        <article>
          <span>Prior observed range</span>
          {range ? (
            <div className={styles.rangeValues}>
              <button onClick={() => inspect(context.low!.point)}>
                {value(context.low!.point)}
                <small>{context.low!.period.end}</small>
              </button>
              <span>to</span>
              <button onClick={() => inspect(context.high!.point)}>
                {value(context.high!.point)}
                <small>{context.high!.period.end}</small>
              </button>
            </div>
          ) : (
            <strong className={styles.plainValue}>—</strong>
          )}
          <small>Historical bounds; no forecast or financial threshold</small>
        </article>
        <article>
          <span>Included prior observations</span>
          <strong className={styles.plainValue}>
            {context.count} / {context.checked}
          </strong>
          <small>
            {context.excluded} excluded after checking available annual anchors
          </small>
        </article>
      </div>
      {context.summaryReason ? (
        <p className={base.notice}>{context.summaryReason}</p>
      ) : (
        <div className={styles.visual}>
          <p>{context.position}</p>
          <div className={styles.track} aria-label="Observed historical range">
            <span
              className={styles.range}
              style={{
                left: `${position(context.low!.point.value)}%`,
                width: `${position(context.high!.point.value) - position(context.low!.point.value)}%`,
              }}
            />
            <button
              className={styles.medianDot}
              style={{ left: `${position(context.median.value!)}%` }}
              onClick={() => inspect(context.median, true)}
              aria-label={`Inspect prior median: ${value(context.median)}`}
              title={`Prior median: ${value(context.median)}`}
            />
            <button
              className={styles.currentDot}
              style={{ left: `${position(context.current.value)}%` }}
              onClick={() => inspect(context.current)}
              aria-label={`Inspect selected period: ${value(context.current)}`}
              title={`Selected period: ${value(context.current)}`}
            />
          </div>
          <div className={styles.legend}>
            <span>
              <i className={styles.currentKey} />
              Selected period
            </span>
            <span>
              <i className={styles.medianKey} />
              Prior median
            </span>
            <span>
              <i className={styles.rangeKey} />
              Prior minimum to maximum
            </span>
          </div>
        </div>
      )}
      <details className={styles.details} open={context.excluded > 0}>
        <summary>
          Review historical sample and SEC evidence · {context.checked} prior
          {context.checked === 1 ? " observation" : " observations"}
        </summary>
        <div
          className={styles.tableWrap}
          tabIndex={0}
          aria-label="Historical sample table; scroll horizontally if needed"
        >
          <table className={styles.table}>
            <caption>
              {metric.label} · prior observations before {context.period?.end}
              {settings.asOf ? ` · filings through ${settings.asOf}` : ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Fiscal period</th>
                <th scope="col">Value & evidence</th>
                <th scope="col">Included in summary?</th>
              </tr>
            </thead>
            <tbody>
              {context.rows.map((row: any) => (
                <tr key={row.period.end}>
                  <th scope="row">
                    {row.period.fp} {row.period.fy}
                    <small>{row.period.end}</small>
                  </th>
                  <td>
                    {row.point ? (
                      <button
                        className={styles.cell}
                        onClick={() => inspect(row.point)}
                      >
                        {value(row.point)}
                      </button>
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                  <td>
                    {row.included ? "Yes · compatible prior observation" : "No"}
                    {(row.reason || row.note) && (
                      <small>{row.reason || row.note}</small>
                    )}
                  </td>
                </tr>
              ))}
              {!context.rows.length && (
                <tr>
                  <td colSpan={3}>
                    No prior annual anchors are available in this extract.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      {context.boundaryReason && (
        <p className={styles.footnote}>{context.boundaryReason}</p>
      )}
      <p className={styles.footnote}>
        This is descriptive company history. Accounting changes, acquisitions,
        business mix and inflation can affect comparability. Inspect the sources
        before interpreting a change. A high or low position is not a risk
        rating.
        {data.asOf
          ? ` Filing cutoff: ${data.asOf}.`
          : " Latest available filed contexts are used, including later revisions to prior periods."}
      </p>
    </section>
  );
}
