"use client";
import { useState } from "react";
import {
  endpointCagr,
  fiscalSeasonality,
  growthHistory,
  growthPair,
} from "../../utils/analysisGrowth.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import base from "./analysis.module.css";
import styles from "./analysisGrowth.module.css";

export default function AnalysisGrowthLab({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const candidates = data.definitions.filter(
    (item: any) =>
      ["income", "balance", "cashflow"].includes(item.category) &&
      ["currency", "eps", "shares"].includes(item.format || "currency"),
  );
  const [chosen, setChosen] = useState(data.revenueKey || "netIncome");
  const metric =
    candidates.find(
      (item: any) => item.key === (settings.growthMetric || chosen),
    ) || candidates[0];
  if (!metric)
    return (
      <section className={base.panel}>
        <h2>Growth & fiscal seasonality</h2>
        <p>No compatible financial measures are available.</p>
      </section>
    );
  const history = growthHistory(data, metric.key, index, settings.years || 8);
  const pair = growthPair(data, metric.key, index);
  const three: any = endpointCagr(data, metric.key, index, 3);
  const five: any = endpointCagr(data, metric.key, index, 5);
  const seasons: any = fiscalSeasonality(data, metric.key, index);
  const inspect = (
    point: any,
    label = metric.label,
    format = metric.format || "currency",
    key = metric.key,
  ) => onInspect({ definition: { key, label, format }, point });
  const isBalance = metric.category === "balance";
  return (
    <section className={base.panel} aria-label="Growth and fiscal seasonality">
      <div className={styles.heading}>
        <div>
          <p className={base.eyebrow}>Growth laboratory</p>
          <h2>Separate growth from the season</h2>
        </div>
        <label>
          Measure
          <select
            value={metric.key}
            onChange={(event) =>
              onPatch
                ? onPatch({ growthMetric: event.target.value })
                : setChosen(event.target.value)
            }
          >
            {candidates.map((item: any) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={base.muted}>
        Compare the same fiscal season, inspect the full growth path, and see
        where coverage runs out. Every amount and calculated growth rate opens
        its SEC inputs.
      </p>
      <div className={styles.stats}>
        <article>
          <span>Same season last year</span>
          <button
            className={styles.number}
            onClick={() =>
              inspect(
                pair.point,
                metric.label + " · same-season growth",
                "percent",
                "sameSeasonGrowth",
              )
            }
          >
            {analysisValue(pair.point.value, "percent")}
          </button>
          <small>{pair.before?.period?.end || pair.point.reason}</small>
        </article>
        {[three, five].map((item) => (
          <article key={item.years}>
            <span>{item.years}-year endpoint CAGR</span>
            <button
              className={styles.number}
              onClick={() =>
                inspect(
                  item.point,
                  metric.label + " · " + item.years + "-year endpoint CAGR",
                  "percent",
                  "endpointCagr",
                )
              }
            >
              {analysisValue(item.point.value, "percent")}
            </button>
            <small>
              {item.point.value == null
                ? item.point.reason
                : item.before.period.end + " → " + data.periods[index].end}
            </small>
            <small>
              {item.count} / {item.expected} same-season observations checked
            </small>
          </article>
        ))}
        <article>
          <span>Growth coverage</span>
          <strong className={styles.plainNumber}>
            {history.growthAvailable} / {history.total}
          </strong>
          <small>
            Displayed periods with a calculable growth rate; {history.observed}{" "}
            have an amount and {history.comparable} have compatible
            current/prior inputs.
          </small>
        </article>
      </div>
      <div
        className={styles.tableWrap}
        tabIndex={0}
        aria-label="Growth history table; scroll horizontally if needed"
      >
        <table className={styles.table}>
          <caption>
            {metric.label} · same-season history ending{" "}
            {data.periods[index]?.end}
          </caption>
          <thead>
            <tr>
              <th scope="col">Fiscal period</th>
              <th scope="col">Amount</th>
              <th scope="col">Prior-year amount</th>
              <th scope="col">Growth</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {history.rows.map((row: any) => (
              <tr key={row.period.end}>
                <th scope="row">
                  {row.period.fp} {row.period.fy}
                  <small>{row.period.end}</small>
                </th>
                <td>
                  <button
                    className={styles.cell}
                    onClick={() => inspect(row.current)}
                  >
                    {analysisValue(
                      row.current?.value,
                      metric.format,
                      settings.units,
                    )}
                  </button>
                </td>
                <td>
                  {row.before ? (
                    <button
                      className={styles.cell}
                      onClick={() => inspect(row.before)}
                    >
                      {analysisValue(
                        row.before.value,
                        metric.format,
                        settings.units,
                      )}
                      <small>{row.before.period.end}</small>
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <button
                    className={styles.cell}
                    onClick={() =>
                      inspect(
                        row.point,
                        metric.label + " · same-season growth",
                        "percent",
                        "sameSeasonGrowth",
                      )
                    }
                  >
                    {analysisValue(row.point.value, "percent")}
                  </button>
                </td>
                <td className={styles.explanation}>
                  {row.point.reason || "Comparable same-season inputs"}
                  {row.current?.classification === "calculated" && (
                    <small>
                      Current amount is calculated from reported inputs.
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.heading}>
        <div>
          <p className={base.eyebrow}>Fiscal seasonality</p>
          <h3>
            {isBalance
              ? "Quarter-end balances by fiscal year"
              : "Standalone quarters by fiscal year"}
          </h3>
        </div>
        {data.basis !== "quarter" && onPatch && (
          <button onClick={() => onPatch({ basis: "quarter" })}>
            Switch to standalone quarters
          </button>
        )}
      </div>
      {seasons.reason ? (
        <p className={base.notice}>
          {seasons.reason} The selected filing cutoff is retained when
          switching.
        </p>
      ) : (
        <div
          className={styles.tableWrap}
          tabIndex={0}
          aria-label="Fiscal quarter matrix; scroll horizontally if needed"
        >
          <table className={styles.table}>
            <caption>
              {isBalance
                ? "Instant balances are not added across quarters."
                : "Issuer fiscal quarters, with actual reporting dates; unavailable quarters remain visible."}
            </caption>
            <thead>
              <tr>
                <th scope="col">Fiscal year</th>
                {[1, 2, 3, 4].map((quarter) => (
                  <th scope="col" key={quarter}>
                    Q{quarter}
                  </th>
                ))}
                <th scope="col">Available</th>
              </tr>
            </thead>
            <tbody>
              {seasons.rows.map((row: any) => (
                <tr key={row.year}>
                  <th scope="row">FY {row.year}</th>
                  {row.cells.map((cell: any, slot: number) => (
                    <td key={slot}>
                      {cell ? (
                        <>
                          <button
                            className={styles.cell}
                            onClick={() => inspect(cell.point)}
                          >
                            {analysisValue(
                              cell.point?.value,
                              metric.format,
                              settings.units,
                            )}
                            <small>{cell.period.end}</small>
                          </button>
                          {cell.point?.classification === "calculated" && (
                            <small>Calculated quarter</small>
                          )}
                          {cell.duplicate && (
                            <small>
                              Multiple period labels: inspect the dates.
                            </small>
                          )}
                        </>
                      ) : (
                        <span className={styles.absent}>No period</span>
                      )}
                    </td>
                  ))}
                  <td>
                    {row.available} / 4
                    <small>
                      {row.observed} reporting periods in this selection
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary>How to interpret these comparisons</summary>
        <p className={base.muted}>
          Growth matches fiscal-period labels with prior-year reporting ends
          350–380 days earlier, and rejects flow durations differing by more
          than 14 days. Percentage growth requires a positive prior-year amount.
          CAGR uses actual elapsed time and every same-season observation in its
          horizon, including the intervening evidence; it summarizes endpoints
          and does not imply a steady growth path.
        </p>
        <p className={base.muted}>
          This matrix follows the issuer's fiscal calendar. A 53-week year,
          acquisition, disposal, changed accounting policy, or different source
          concept can affect comparability. A calculated quarter can come from
          subtracting cumulative reports; open the amount to see both filings.
          No calendar quarter, missing value, or zero is invented.
        </p>
      </details>
    </section>
  );
}
