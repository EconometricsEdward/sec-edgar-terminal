"use client";
import { useState } from "react";
import { ArrowUpRight, Droplets, Layers3 } from "lucide-react";
import {
  buildCashQuality,
  buildWorkingCapital,
} from "../../utils/analysisCapital.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./analysisLabs.module.css";

export default function AnalysisCashLab({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const [count, setCount] = useState(4);
  const cash = buildCashQuality(data, index, count);
  const working = buildWorkingCapital(data, index);
  const financial = data.lens !== "corporate";
  const fmt = (point: any, format = "currency") =>
    analysisValue(point?.value, format, settings.units);
  const inspect = (definition: any, point: any) =>
    onInspect({ definition, point });
  const max = Math.max(
    1,
    ...cash.rows
      .slice(0, 2)
      .flatMap((row: any) =>
        row.points.map((point: any) =>
          Number.isFinite(point?.value) ? Math.abs(point.value) : 0,
        ),
      ),
  );
  return (
    <div className={styles.lab}>
      <section className={styles.panel} aria-labelledby="cash-quality-title">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              <Droplets size={14} /> Cash quality
            </p>
            <h2 id="cash-quality-title">Do earnings turn into cash?</h2>
            <p className={styles.description}>
              Trace earnings, operating cash and investment across a complete
              reporting window.
            </p>
          </div>
          <label>
            Periods in window
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={["ytd", "ttm"].includes(data.periods[index]?.kind)}
            >
              {[2, 4, 8, 12].map((value) => (
                <option key={value} value={value}>
                  {value} periods
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={styles.scope}>
          <Layers3 size={16} />
          <span>
            <strong>
              {cash.indices.length}{" "}
              {cash.cumulative ? "consecutive periods" : "selected period"}
            </strong>{" "}
            · {cash.period?.start || "Start unavailable"} → {cash.period?.end}
          </span>
          <span className={styles.badge}>
            {data.periods[index]?.kind} basis
          </span>
        </div>
        {cash.reason && <p className={styles.notice}>{cash.reason}</p>}
        {financial && (
          <p className={styles.notice}>
            For {data.lens === "banking" ? "banks" : "insurers"}, operating cash
            flow includes business-specific asset and liability movements. Cash
            conversion and cash after PP&E are descriptive accounting measures,
            not general tests of solvency, distributable cash or earnings
            quality.
          </p>
        )}
        <div className={styles.cards}>
          {cash.rows.slice(0, 3).map((row: any) => (
            <button
              className={styles.metric}
              key={row.definition.key}
              onClick={() =>
                inspect(
                  {
                    ...row.definition,
                    label: `${cash.cumulative ? "Cumulative " : ""}${row.definition.label.toLowerCase()}`,
                  },
                  row.point,
                )
              }
            >
              <span>
                {cash.cumulative ? "Cumulative " : ""}
                {row.definition.label.toLowerCase()}
              </span>
              <strong>{fmt(row.point)}</strong>
              <small>
                {row.available}/{row.total} periods covered{" "}
                <ArrowUpRight size={13} />
              </small>
            </button>
          ))}
          <button
            className={styles.metric}
            onClick={() =>
              inspect(
                {
                  key: "cumulativeCashConversion",
                  label: "Cash conversion over included periods",
                  format: "percent",
                },
                cash.conversion,
              )
            }
          >
            <span>Operating cash / net income</span>
            <strong>{fmt(cash.conversion, "percent")}</strong>
            <small>
              Requires positive net income <ArrowUpRight size={13} />
            </small>
          </button>
        </div>
        <div className={styles.split}>
          <div className={styles.inset}>
            <h3>Cash and earnings, period by period</h3>
            <p className={styles.legend}>
              <span>
                <i className={styles.cashKey} /> Operating cash flow
              </span>
              <span>
                <i className={styles.incomeKey} /> Net income
              </span>
            </p>
            <div className={styles.chart}>
              {[...cash.indices].reverse().map((i: number) => (
                <div className={styles.chartRow} key={data.periods[i].end}>
                  <span className={styles.chartDate}>
                    {data.periods[i].end}
                  </span>
                  <div className={styles.barPair}>
                    {["operatingCashFlow", "netIncome"].map((key) => {
                      const point = cash.rows.find(
                        (row: any) => row.definition.key === key,
                      )?.points[cash.indices.indexOf(i)];
                      const finite = Number.isFinite(point?.value);
                      return (
                        <button
                          key={key}
                          className={styles.barButton}
                          onClick={() =>
                            inspect(
                              {
                                key,
                                label:
                                  key === "netIncome"
                                    ? "Net income"
                                    : "Operating cash flow",
                                format: "currency",
                              },
                              point,
                            )
                          }
                          aria-label={`${key === "netIncome" ? "Net income" : "Operating cash flow"}, ${data.periods[i].end}: ${fmt(point)}`}
                        >
                          <span className={styles.barTrack} aria-hidden="true">
                            <i
                              className={`${key === "netIncome" ? styles.incomeBar : styles.cashBar} ${point?.value < 0 ? styles.negative : ""}`}
                              style={{
                                width: finite
                                  ? `${Math.max(1, (Math.abs(point.value) / max) * 100)}%`
                                  : "0%",
                              }}
                            />
                          </span>
                          <span>{finite ? fmt(point) : "Missing"}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className={styles.caption}>
              Bar length shows absolute magnitude; negative values are striped
              and retain their sign. Select a value to inspect its SEC inputs.
            </p>
          </div>
          <div className={styles.inset}>
            <h3>Explain the cash gap</h3>
            <button
              className={styles.metric}
              onClick={() =>
                inspect(
                  {
                    key: "cumulativeCashDifference",
                    label:
                      "Operating cash less net income over included periods",
                    format: "currency",
                  },
                  cash.difference,
                )
              }
            >
              <span>Operating cash less net income</span>
              <strong>{fmt(cash.difference)}</strong>
              <small>
                Inspect every input <ArrowUpRight size={13} />
              </small>
            </button>
            <p className={styles.description}>
              The difference combines noncash adjustments and working-capital
              movements. Its sign alone does not identify what changed.
            </p>
            <button
              className={styles.metric}
              onClick={() =>
                inspect(
                  {
                    ...cash.rows[3].definition,
                    label: `${cash.cumulative ? "Cumulative " : ""}operating cash flow less PP&E purchases`,
                  },
                  cash.rows[3].point,
                )
              }
            >
              <span>Operating cash less PP&E purchases</span>
              <strong>{fmt(cash.rows[3].point)}</strong>
              <small>
                {cash.rows[3].available}/{cash.rows[3].total} periods covered{" "}
                <ArrowUpRight size={13} />
              </small>
            </button>
            <p className={styles.description}>
              Excludes acquisitions, asset sales and other investing or
              financing flows. Missing purchases are never treated as zero.
            </p>
          </div>
        </div>
        <details>
          <summary>Review the reporting window and input coverage</summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Only the included periods enter the cumulative calculations. A
                missing or incompatible observation makes that metric’s total
                unavailable.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Reporting duration</th>
                  {cash.rows.map((row: any) => (
                    <th scope="col" key={row.definition.key}>
                      {row.definition.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cash.indices.map((i: number, offset: number) => (
                  <tr key={data.periods[i].end}>
                    <th scope="row">
                      {data.periods[i].start} → {data.periods[i].end}
                    </th>
                    {cash.rows.map((row: any) => (
                      <td key={row.definition.key}>
                        <button
                          onClick={() =>
                            inspect(row.definition, row.points[offset])
                          }
                        >
                          {fmt(row.points[offset])}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <section className={styles.panel} aria-labelledby="working-capital-title">
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>Operating cycle</p>
            <h2 id="working-capital-title">
              Working capital, measured in days
            </h2>
          </div>
          {working.available && (
            <span className={styles.badge}>
              {Number.isFinite(working.days) ? working.days : "Unknown"} days in
              selected period
            </span>
          )}
        </div>
        {!working.available ? (
          <p className={styles.notice}>{working.reason}</p>
        ) : (
          <>
            <p className={styles.description}>
              Uses the average of the balance immediately before the selected
              period starts and its ending balance. YTD and quarterly
              calculations use their actual number of days.
            </p>
            <div className={styles.cards}>
              {working.rows.map((row: any) => (
                <button
                  className={styles.metric}
                  key={row.definition.key}
                  onClick={() => inspect(row.definition, row.point)}
                >
                  <span>{row.definition.label}</span>
                  <strong>{fmt(row.point, "days")}</strong>
                  <small>
                    Opening + ending balance <ArrowUpRight size={13} />
                  </small>
                </button>
              ))}
              <button
                className={styles.metric}
                onClick={() =>
                  inspect(
                    {
                      key: "workingCapitalCycle",
                      label: "Estimated cash conversion cycle",
                      format: "days",
                    },
                    working.cycle,
                  )
                }
              >
                <span>Estimated cash conversion cycle</span>
                <strong>{fmt(working.cycle, "days")}</strong>
                <small>
                  Receivables + inventory − payables <ArrowUpRight size={13} />
                </small>
              </button>
            </div>
            <details>
              <summary>See opening balances and estimate limitations</summary>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Estimate</th>
                      <th scope="col">Opening balance</th>
                      <th scope="col">Ending balance</th>
                      <th scope="col">Calculation and limitations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {working.rows.map((row: any) => (
                      <tr key={row.definition.key}>
                        <th scope="row">{row.definition.label}</th>
                        <td>{fmt(row.opening)}</td>
                        <td>{fmt(row.ending)}</td>
                        <td className={styles.proseCell}>
                          {row.note}
                          {row.point.reason && <p>{row.point.reason}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}
