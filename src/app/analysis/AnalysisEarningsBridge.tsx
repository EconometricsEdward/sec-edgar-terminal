"use client";
import { earningsChangeBridge } from "../../utils/analysisEarningsBridge.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import base from "./analysis.module.css";
import shared from "./analysisGrowth.module.css";
import styles from "./analysisEarningsBridge.module.css";

export default function AnalysisEarningsBridge({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const bridge: any = earningsChangeBridge(
    data,
    index,
    settings.baseline || "year",
    settings.asOf ?? data.asOf ?? "",
  );
  const format = (value: number, kind = "currency") =>
    analysisValue(value, kind, settings.units);
  const signed = (value: number) => `${value > 0 ? "+" : ""}${format(value)}`;
  const inspect = (point: any, label: string, key: string, kind = "currency") =>
    onInspect({
      definition: { key, label, format: kind },
      point,
      notes:
        "An arithmetic earnings reconciliation. Differences between SEC concept scopes remain explicit; no component establishes an economic cause.",
    });
  const scale = Math.max(
    1,
    ...bridge.components.map((component: any) =>
      Math.abs(component.point.value),
    ),
  );
  return (
    <section className={base.panel} aria-label="Earnings reconciliation">
      <p className={base.eyebrow}>Earnings reconciliation</p>
      <h2>What sits between the business result and net income?</h2>
      <p className={base.muted}>
        {bridge.useOperating
          ? "Trace the change through operating income, the difference below operating income, taxes, and the remaining net-income scope difference."
          : "Trace the change through pre-tax income, taxes, and the remaining net-income scope difference. This industry lens starts with pre-tax income because a comparable operating result is not defined here."}{" "}
        Each contribution is an arithmetic change in reported amounts, with its
        sources available to inspect.
      </p>
      {bridge.reason ? (
        <p className={base.notice}>{bridge.reason}</p>
      ) : (
        <>
          <div className={shared.profitEnds}>
            <article>
              <span>Net income · {bridge.beforePeriod.end}</span>
              <button
                className={shared.number}
                onClick={() =>
                  inspect(bridge.previousNet, "Net income", "netIncome")
                }
              >
                {format(bridge.previousNet.value)}
              </button>
            </article>
            <article>
              <span>Change in net income</span>
              <button
                className={shared.number}
                onClick={() =>
                  inspect(
                    bridge.change,
                    "Change in net income",
                    "earningsBridge:netChange",
                  )
                }
              >
                {signed(bridge.change.value)}
              </button>
            </article>
            <article>
              <span>Net income · {bridge.period.end}</span>
              <button
                className={shared.number}
                onClick={() =>
                  inspect(bridge.currentNet, "Net income", "netIncome")
                }
              >
                {format(bridge.currentNet.value)}
              </button>
            </article>
          </div>
          <div
            className={shared.bridge}
            aria-label="Signed contributions to the net income change"
          >
            {bridge.components.map((component: any) => (
              <div className={shared.bridgeRow} key={component.key}>
                <span>{component.label}</span>
                <div className={shared.signedTrack} aria-hidden="true">
                  <span className={shared.zeroLine} />
                  <span
                    className={
                      component.point.value >= 0
                        ? shared.positiveBar
                        : shared.negativeBar
                    }
                    style={{
                      width: `${(Math.abs(component.point.value) / scale) * 50}%`,
                    }}
                  />
                </div>
                <button
                  className={shared.cell}
                  onClick={() =>
                    inspect(component.point, component.label, component.key)
                  }
                >
                  {signed(component.point.value)}
                </button>
              </div>
            ))}
          </div>
          <p className={styles.identity}>
            {bridge.useOperating
              ? "Δ net income = Δ operating income + Δ (pre-tax − operating) − Δ tax + Δ scope residual"
              : "Δ net income = Δ pre-tax income − Δ tax + Δ scope residual"}
          </p>
          <p className={base.muted}>
            A lower tax expense contributes positively to net-income change. The
            scope residual is retained rather than forced to zero; inspect the
            filing before attributing it to noncontrolling interests,
            discontinued operations, or other items. Numerical rounding
            difference:{" "}
            {analysisValue(
              Math.abs(bridge.roundingResidual),
              "currency",
              "raw",
            )}
            .
          </p>
          <details className={styles.details}>
            <summary>Inspect the reported amounts and tax rates</summary>
            <div
              className={shared.tableWrap}
              tabIndex={0}
              role="region"
              aria-label="Earnings reconciliation inputs; scroll horizontally if needed"
            >
              <table className={shared.table}>
                <caption>
                  Every number opens its SEC evidence. Calculated remainders
                  retain all their inputs.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col">{bridge.beforePeriod.end}</th>
                    <th scope="col">{bridge.period.end}</th>
                    <th scope="col">How to read it</th>
                  </tr>
                </thead>
                <tbody>
                  {bridge.rows.map((row: any) => (
                    <tr key={row.key}>
                      <th scope="row">{row.label}</th>
                      {[row.previous, row.current].map(
                        (point: any, i: number) => (
                          <td key={i}>
                            {Number.isFinite(point.value) ? (
                              <button
                                className={shared.cell}
                                onClick={() =>
                                  inspect(
                                    point,
                                    row.label,
                                    [
                                      "belowOperating",
                                      "scopeResidual",
                                      "effectiveTaxRate",
                                    ].includes(row.key)
                                      ? `earningsBridge:${row.key}`
                                      : row.key,
                                    row.format,
                                  )
                                }
                              >
                                {format(point.value, row.format)}
                              </button>
                            ) : (
                              <span
                                className={shared.absent}
                                title={point.reason}
                              >
                                Unavailable — pre-tax income is not positive
                              </span>
                            )}
                          </td>
                        ),
                      )}
                      <td className={shared.explanation}>{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
