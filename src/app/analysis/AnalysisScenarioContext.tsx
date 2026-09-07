"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Database, History, Sparkles } from "lucide-react";
import {
  scenarioBaselineContext,
  scenarioHistoricalCalibration,
  scenarioStarterCases,
} from "../../utils/analysisScenarioContext.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./AnalysisScenarioContext.module.css";

export default function AnalysisScenarioContext({
  data,
  settings,
  index,
  scenario,
  onPatch,
  onInspect,
}: any) {
  const [applied, setApplied] = useState("");
  const baseline = useMemo(
    () => scenarioBaselineContext(data, settings, index, scenario),
    [data, settings, index, scenario],
  );
  const history = useMemo(
    () => scenarioHistoricalCalibration(data, settings, index),
    [data, settings, index],
  );
  const starters = scenarioStarterCases(data, settings);
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const cell = (selection: any, label?: string) =>
    selection ? (
      <button
        type="button"
        className={styles.sourceValue}
        onClick={() => onInspect(selection)}
        aria-label={`Inspect ${label || selection.definition.label} for ${selection.point?.period?.end || "this period"}`}
      >
        {value(selection.point?.value, selection.definition?.format)}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    ) : (
      <span>—</span>
    );
  return (
    <section
      className={styles.context}
      aria-label="Scenario baseline, historical context, and starter cases"
    >
      <div className={styles.baseline}>
        <div className={styles.title}>
          <p>
            <Database size={14} aria-hidden="true" /> Reported baseline
          </p>
          <strong>
            {baseline.ticker} ·{" "}
            {baseline.period?.label ||
              baseline.period?.end ||
              "No selected period"}
          </strong>
        </div>
        <dl className={styles.metadata}>
          <div>
            <dt>Actual period</dt>
            <dd>
              {baseline.period?.kind || "Unavailable"}
              {baseline.period?.fp && baseline.period.kind !== "annual"
                ? ` · ${baseline.period.fp}`
                : ""}
            </dd>
          </div>
          <div>
            <dt>Reporting window</dt>
            <dd>
              {baseline.period?.start || "Start unavailable"} →{" "}
              {baseline.period?.end || "End unavailable"}
            </dd>
          </div>
          <div>
            <dt>Filing cutoff</dt>
            <dd>{baseline.cutoff || "Latest available"}</dd>
          </div>
          <div>
            <dt>Data observed</dt>
            <dd>{baseline.observedAt || "Observation time unavailable"}</dd>
          </div>
        </dl>
        <details className={styles.readiness}>
          <summary>
            Inspect reported baseline · {baseline.ready} of {baseline.total}{" "}
            inputs ready
          </summary>
          <p className={styles.note}>
            These are the exact inputs used by the selected model. Open a value
            to inspect its original SEC concepts, dates, and calculation
            evidence.
          </p>
          <div className={styles.inputs}>
            {baseline.inputs.map((input: any) => (
              <article key={input.key}>
                <div className={styles.inputTitle}>
                  <h4>{input.definition?.label || input.key}</h4>
                  <span
                    className={input.ready ? styles.ready : styles.unavailable}
                  >
                    {input.ready ? "Ready" : "Unavailable"}
                  </span>
                </div>
                {cell(input.selection)}
                <small>
                  {input.basis} · {input.sources.length} reported source
                  {input.sources.length === 1 ? "" : "s"}
                </small>
                {input.windows.map((window: string) => (
                  <small key={window}>{window}</small>
                ))}
                {input.reason && (
                  <p className={styles.reason}>{input.reason}</p>
                )}
              </article>
            ))}
          </div>
        </details>
        {baseline.groups
          .filter((group: any) => group.reason)
          .map((group: any) => (
            <p key={group.key} className={styles.reason}>
              <strong>{group.label}:</strong> {group.reason}
            </p>
          ))}
      </div>

      <details className={styles.panel}>
        <summary>
          <span>
            <History size={14} aria-hidden="true" /> Compare the same
            assumptions with prior reported periods
          </span>
          <small>
            {history.checked} prior observation
            {history.checked === 1 ? "" : "s"} checked
          </small>
        </summary>
        <div className={styles.panelBody}>
          <p className={styles.note}>{history.note}</p>
          <p className={styles.coverage}>
            {scenario.corporate && (
              <span>
                Operating inputs:{" "}
                <strong>
                  {history.operatingCount} / {history.checked}
                </strong>{" "}
                usable · revenue growth:{" "}
                <strong>
                  {history.growthCount} / {history.checked}
                </strong>
              </span>
            )}
            <span>
              Balance inputs:{" "}
              <strong>
                {history.balanceCount} / {history.checked}
              </strong>{" "}
              usable
            </span>
          </p>
          {scenario.corporate && history.rows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Operating comparison · last up to five aligned prior annual or
                  same-season observations
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Prior period</th>
                    <th scope="col">Reported revenue growth</th>
                    <th scope="col">Reported operating margin</th>
                    <th scope="col">Reported operating income</th>
                    <th scope="col">Same assumptions: operating income</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((row: any) => (
                    <tr key={row.period.end}>
                      <th scope="row">
                        {row.period.label || row.period.end}
                        <small>
                          {row.period.start} → {row.period.end}
                        </small>
                      </th>
                      <td>
                        {cell(row.revenueGrowth)}
                        <small>
                          Prior-year revenue denominator:{" "}
                          {row.growthDenominator
                            ? cell(row.growthDenominator)
                            : "unavailable"}
                        </small>
                        {row.revenueGrowth?.point.reason && (
                          <small>{row.revenueGrowth.point.reason}</small>
                        )}
                      </td>
                      <td>
                        {cell(row.operatingMargin)}
                        <small>Revenue denominator: {cell(row.revenue)}</small>
                      </td>
                      <td>
                        {cell(row.operatingIncome)}
                        {row.operatingReason && (
                          <small>{row.operatingReason}</small>
                        )}
                      </td>
                      <td>
                        {cell(row.operatingResult)}
                        {row.operatingResultReason && (
                          <small>{row.operatingResultReason}</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.rows.length > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  Balance comparison · equity means reported shareholder equity,
                  not regulatory capital
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Prior period</th>
                    <th scope="col">Reported equity / assets</th>
                    <th scope="col">Same assumptions: equity / assets</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.map((row: any) => (
                    <tr key={row.period.end}>
                      <th scope="row">
                        {row.period.label || row.period.end}
                        <small>Ending balances at {row.period.end}</small>
                      </th>
                      <td>
                        {cell(row.equityRatio)}
                        <small>
                          Reported assets denominator: {cell(row.assets)}
                        </small>
                        {row.balanceReason && (
                          <small>{row.balanceReason}</small>
                        )}
                      </td>
                      <td>
                        {cell(row.balanceResult)}
                        {row.balanceResultReason && (
                          <small>{row.balanceResultReason}</small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.boundaryReason && (
            <p className={styles.note}>{history.boundaryReason}</p>
          )}
          <p className={styles.note}>
            Missing or incompatible observations stay visible and do not become
            zero. Input availability counts describe this comparison only; they
            are not event frequencies or probabilities.
          </p>
        </div>
      </details>

      <details className={styles.panel}>
        <summary>
          <span>
            <Sparkles size={14} aria-hidden="true" /> Start with an illustrative
            case
          </span>
          <small>{starters.length} editable assumption sets</small>
        </summary>
        <div className={styles.panelBody}>
          <p className={styles.note}>
            These examples are deliberately specified assumptions. They are not
            forecasts, probabilities, or targets inferred from history. Applying
            a case resets every scenario assumption, including controls in other
            models, to the stated case and defaults.
          </p>
          <div className={styles.cases}>
            {starters.map((starter: any) => (
              <article key={starter.id}>
                <h4>{starter.label}</h4>
                <p className={styles.caseAssumptions}>{starter.assumptions}</p>
                <p className={styles.note}>{starter.explanation}</p>
                <button
                  type="button"
                  onClick={() => {
                    if (onPatch(starter.patch) !== false)
                      setApplied(
                        `${starter.label} applied. All scenario assumptions reset to this case and defaults.`,
                      );
                    else setApplied("");
                  }}
                >
                  Apply {starter.label.toLowerCase()}
                </button>
              </article>
            ))}
          </div>
          <p role="status" className={styles.applied}>
            {applied}
          </p>
        </div>
      </details>
    </section>
  );
}
