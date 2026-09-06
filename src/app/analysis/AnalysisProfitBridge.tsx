"use client";
import { useState } from "react";
import { profitChangeBridge } from "../../utils/analysisGrowth.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import base from "./analysis.module.css";
import styles from "./analysisGrowth.module.css";

export default function AnalysisProfitBridge({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const candidates = [
    "netIncome",
    ...(data.lens === "corporate" ? ["operatingIncome", "grossProfit"] : []),
  ]
    .map((key) => data.definitions.find((item: any) => item.key === key))
    .filter(Boolean);
  const [chosen, setChosen] = useState("netIncome");
  const metric =
    candidates.find(
      (item: any) => item.key === (settings.profitMetric || chosen),
    ) || candidates[0];
  const bridge: any = profitChangeBridge(
    data,
    index,
    metric?.key,
    settings.baseline || "year",
  );
  const revenueLabel =
    data.definitions.find((item: any) => item.key === data.revenueKey)?.label ||
    "Revenue";
  const inspect = (
    point: any,
    label: string,
    key: string,
    format = "currency",
  ) => onInspect({ definition: { key, label, format }, point });
  const scale = Math.max(
    1,
    ...bridge.components.map((item: any) => Math.abs(item.point.value)),
  );
  const signed = (value: number) =>
    (value > 0 ? "+" : "") + analysisValue(value, "currency", settings.units);
  return (
    <section className={base.panel} aria-label="Profit change attribution">
      <div className={styles.heading}>
        <div>
          <p className={base.eyebrow}>Profit change bridge</p>
          <h2>Explain the movement in profit</h2>
        </div>
        {metric && (
          <label>
            Profit measure
            <select
              value={metric.key}
              onChange={(event) =>
                onPatch
                  ? onPatch({ profitMetric: event.target.value })
                  : setChosen(event.target.value)
              }
            >
              {candidates.map((item: any) => (
                <option value={item.key} key={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className={base.muted}>
        Split the change into revenue scale and profit margin using the average
        of both periods. This exact arithmetic identity assigns their
        interaction evenly, so the result does not depend on calculation order.
      </p>
      {bridge.reason ? (
        <p className={base.notice}>{bridge.reason}</p>
      ) : (
        <>
          <div className={styles.profitEnds}>
            <article>
              <span>
                {metric.label} · {bridge.beforePeriod.end}
              </span>
              <button
                className={styles.number}
                onClick={() =>
                  inspect(bridge.previousProfit, metric.label, metric.key)
                }
              >
                {analysisValue(
                  bridge.previousProfit.value,
                  "currency",
                  settings.units,
                )}
              </button>
            </article>
            <article>
              <span>Change in {metric.label.toLowerCase()}</span>
              <button
                className={styles.number}
                onClick={() =>
                  inspect(
                    bridge.change,
                    "Change in " + metric.label,
                    "profitChange",
                  )
                }
              >
                {signed(bridge.change.value)}
              </button>
            </article>
            <article>
              <span>
                {metric.label} · {bridge.period.end}
              </span>
              <button
                className={styles.number}
                onClick={() =>
                  inspect(bridge.currentProfit, metric.label, metric.key)
                }
              >
                {analysisValue(
                  bridge.currentProfit.value,
                  "currency",
                  settings.units,
                )}
              </button>
            </article>
          </div>
          <div
            className={styles.bridge}
            aria-label="Contributions to the profit change"
          >
            {bridge.components.map((item: any) => (
              <div className={styles.bridgeRow} key={item.key}>
                <span>{item.label}</span>
                <div className={styles.signedTrack} aria-hidden="true">
                  <span className={styles.zeroLine} />
                  <span
                    className={
                      item.point.value >= 0
                        ? styles.positiveBar
                        : styles.negativeBar
                    }
                    style={{
                      width: (Math.abs(item.point.value) / scale) * 50 + "%",
                    }}
                  />
                </div>
                <button
                  className={styles.cell}
                  onClick={() =>
                    inspect(
                      item.point,
                      metric.label + " · " + item.label,
                      item.key,
                    )
                  }
                >
                  {signed(item.point.value)}
                </button>
              </div>
            ))}
          </div>
          <p className={base.muted}>
            Bars share a zero midpoint; their signed contributions sum to the
            profit change. Numerical residual:{" "}
            {analysisValue(Math.abs(bridge.residual), "currency", "raw")}. Click
            a contribution to inspect all four source inputs.
          </p>
          <div
            className={styles.tableWrap}
            tabIndex={0}
            aria-label="Profit bridge source inputs; scroll horizontally if needed"
          >
            <table className={styles.table}>
              <caption>The reported inputs behind the bridge</caption>
              <thead>
                <tr>
                  <th scope="col">Input</th>
                  <th scope="col">{bridge.beforePeriod.end}</th>
                  <th scope="col">{bridge.period.end}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">{revenueLabel}</th>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(
                          bridge.previousRevenue,
                          revenueLabel,
                          data.revenueKey,
                        )
                      }
                    >
                      {analysisValue(
                        bridge.previousRevenue.value,
                        "currency",
                        settings.units,
                      )}
                    </button>
                  </td>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(
                          bridge.currentRevenue,
                          revenueLabel,
                          data.revenueKey,
                        )
                      }
                    >
                      {analysisValue(
                        bridge.currentRevenue.value,
                        "currency",
                        settings.units,
                      )}
                    </button>
                  </td>
                </tr>
                <tr>
                  <th scope="row">{metric.label}</th>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(bridge.previousProfit, metric.label, metric.key)
                      }
                    >
                      {analysisValue(
                        bridge.previousProfit.value,
                        "currency",
                        settings.units,
                      )}
                    </button>
                  </td>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(bridge.currentProfit, metric.label, metric.key)
                      }
                    >
                      {analysisValue(
                        bridge.currentProfit.value,
                        "currency",
                        settings.units,
                      )}
                    </button>
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    {metric.label} / {revenueLabel.toLowerCase()}
                  </th>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(
                          bridge.previousMargin,
                          metric.label + " margin",
                          "bridgeMargin",
                          "percent",
                        )
                      }
                    >
                      {analysisValue(bridge.previousMargin.value, "percent")}
                    </button>
                  </td>
                  <td>
                    <button
                      className={styles.cell}
                      onClick={() =>
                        inspect(
                          bridge.currentMargin,
                          metric.label + " margin",
                          "bridgeMargin",
                          "percent",
                        )
                      }
                    >
                      {analysisValue(bridge.currentMargin.value, "percent")}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {data.lens === "banking" && (
            <p className={base.notice}>
              Bank revenue is net interest income before provision plus
              noninterest income. Its scale contribution reflects that combined
              measure; it is not a loan-volume or interest-rate attribution.
            </p>
          )}
        </>
      )}
      <details>
        <summary>Formulas and interpretation</summary>
        <p className={base.muted}>
          Revenue scale contribution = change in revenue × average profit
          margin. Profit margin contribution = change in margin × average
          revenue. The margins use the selected profit measure divided by the
          same positive revenue definition in each period.
        </p>
        <p className={base.muted}>
          These are accounting contributions, not identified economic causes.
          Pricing, volumes, credit provisions, tax, currency, acquisitions, and
          one-off items can affect either input. Review the filings before
          attributing the movement to any of them. Missing inputs, incompatible
          durations, and unavailable revenue definitions keep the bridge
          unavailable.
        </p>
      </details>
    </section>
  );
}
