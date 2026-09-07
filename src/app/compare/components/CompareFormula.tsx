"use client";

import { useMemo } from "react";
import { Calculator, Download, RotateCcw, Search } from "lucide-react";
import {
  COMPARE_FORMULA_INPUTS,
  COMPARE_FORMULA_OPERATIONS,
  DEFAULT_COMPARE_FORMULA,
  compareFormulaMetric,
  compareFormulaOperands,
  compareFormulaPresets,
  compareFormulaResults,
  exportCompareFormulaDefinition,
  normalizeCompareFormula,
  validateCompareFormula,
} from "../../../utils/compareFormula.js";
import {
  displayValue,
  downloadFile,
  type CompareEvidence,
  type CompareSettings,
} from "../compareTypes";
import shared from "../compare.module.css";
import styles from "./CompareFormula.module.css";

export default function CompareFormula({
  entries,
  settings,
  update,
  inspect,
}: {
  entries: any[];
  settings: CompareSettings;
  update: (patch: Partial<CompareSettings>) => void;
  inspect: (evidence: CompareEvidence) => void;
}) {
  const definition = normalizeCompareFormula(settings);
  const metric = compareFormulaMetric(definition);
  const operands = compareFormulaOperands(definition);
  const results = useMemo(
    () => compareFormulaResults(entries, settings),
    [entries, settings],
  );
  const presets = useMemo(() => compareFormulaPresets(entries), [entries]);
  const invalid = validateCompareFormula(settings);
  const scaleDisabled = definition.formulaOp === "subtract";

  return (
    <section className={shared.panel} aria-labelledby="compare-formula-title">
      <div className={shared.sectionHead}>
        <div>
          <span className={shared.eyebrow}>
            Your research question / Custom metric
          </span>
          <h2 id="compare-formula-title">Build the comparison you need.</h2>
          <p>
            Combine reported monetary inputs into a calculation for every
            selected issuer. Each result keeps its SEC evidence and your exact
            formula.
          </p>
        </div>
        <Calculator size={24} aria-hidden="true" />
      </div>
      <div className={styles.body}>
        {presets.length > 0 && (
          <div
            className={styles.presets}
            aria-label="Available custom metric presets"
          >
            <span>Start with a calculation supported by this peer set</span>
            <div>
              {presets.map((preset) => (
                <button key={preset.id} onClick={() => update(preset.settings)}>
                  {preset.label}{" "}
                  <small>
                    {preset.count}/{preset.total}
                  </small>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className={styles.builder}>
          <label>
            Calculation name (optional)
            <input
              key={definition.formulaLabel}
              maxLength={80}
              defaultValue={definition.formulaLabel}
              onBlur={(event) => update({ formulaLabel: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder="Give this calculation a research label"
            />
          </label>
          <label>
            Operation
            <select
              value={definition.formulaOp}
              onChange={(event) => update({ formulaOp: event.target.value })}
            >
              {COMPARE_FORMULA_OPERATIONS.map((operation) => (
                <option key={operation.key} value={operation.key}>
                  {operation.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Display result as
            <select
              value={scaleDisabled ? "currency" : definition.formulaScale}
              disabled={scaleDisabled}
              onChange={(event) => update({ formulaScale: event.target.value })}
            >
              {scaleDisabled ? (
                <option value="currency">USD amount</option>
              ) : (
                <>
                  <option value="percent">Percentage (%)</option>
                  <option value="multiple">Multiple (×)</option>
                </>
              )}
            </select>
          </label>
        </div>
        <div className={styles.operands}>
          {operands.map((operand) => (
            <label key={operand.slot}>
              {operand.slot} ·{" "}
              {operand.slot === (operands.length === 3 ? "C" : "B") &&
              !scaleDisabled
                ? "Denominator"
                : "Monetary input"}
              <select
                value={operand.key}
                onChange={(event) =>
                  update({ [`formula${operand.slot}`]: event.target.value })
                }
              >
                <optgroup label="Reported balances at period end">
                  {COMPARE_FORMULA_INPUTS.filter(
                    (input) => input.interval === "balance",
                  ).map((input) => (
                    <option key={input.key} value={input.key}>
                      {input.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Flows over the reporting period">
                  {COMPARE_FORMULA_INPUTS.filter(
                    (input) => input.interval === "flow",
                  ).map((input) => (
                    <option key={input.key} value={input.key}>
                      {input.label}
                      {"inputs" in input && input.inputs ? " (calculated)" : ""}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          ))}
        </div>
        <div className={styles.expression}>
          <span>Formula applied to every issuer</span>
          <code>{metric.formula}</code>
          <small>
            USD inputs · {settings.basis} basis · selected reporting period · no
            annualization
          </small>
        </div>
        {invalid && (
          <p className={styles.issue} role="status">
            {invalid}
          </p>
        )}
        <div className={styles.tools}>
          <p>
            Only balances can be combined with balances, and flows with flows.
            Ratios require a positive denominator. A missing or incompatible
            input leaves that issuer unavailable.
          </p>
          <div>
            <button onClick={() => update({ ...DEFAULT_COMPARE_FORMULA })}>
              <RotateCcw size={14} /> Reset formula
            </button>
            <button
              onClick={() =>
                downloadFile(
                  "edgar-custom-metric-definition.json",
                  exportCompareFormulaDefinition(settings),
                  "application/json",
                )
              }
            >
              <Download size={14} /> Export definition
            </button>
          </div>
        </div>
        <div className={styles.summary} role="status" aria-live="polite">
          <div>
            <small>Complete calculations</small>
            <strong>
              {results.count} / {results.total}
            </strong>
          </div>
          <div>
            <small>Selected-issuer median</small>
            <strong>{displayValue(results.median, metric.format)}</strong>
          </div>
          <p>
            {results.reason ||
              "The median includes selected issuers with complete evidence and comparable reporting dates and durations. It does not indicate which company is preferable."}
          </p>
        </div>
      </div>
      <div
        className={shared.tableScroll}
        role="region"
        tabIndex={0}
        aria-label="Custom metric inputs and results, scroll horizontally for all inputs"
      >
        <table className={`${shared.table} ${styles.table}`}>
          <caption className={styles.caption}>
            {metric.label} · results and exact monetary inputs
          </caption>
          <thead>
            <tr>
              <th scope="col">Issuer / reporting period</th>
              {operands.map((operand) => (
                <th key={operand.slot} scope="col">
                  {operand.slot} · {operand.metric.label}
                  <small>
                    {operand.metric.interval === "balance"
                      ? "Balance at period end"
                      : "Flow for selected duration"}
                  </small>
                </th>
              ))}
              <th scope="col">Calculated result</th>
            </tr>
          </thead>
          <tbody>
            {results.cells.map((cell) => (
              <tr key={cell.ticker}>
                <th scope="row">
                  {cell.ticker}
                  <small>{cell.name}</small>
                  <small>
                    {cell.period?.start || "Balance at"} →{" "}
                    {cell.period?.end || "Unavailable"}
                  </small>
                </th>
                {cell.point.inputs.map((input) => (
                  <td key={input.slot}>
                    <button
                      className={shared.valueButton}
                      disabled={!input.point}
                      onClick={() =>
                        inspect({
                          cell: { ...cell, point: input.point },
                          metric: input.metric,
                        })
                      }
                      aria-label={`Inspect ${cell.ticker} input ${input.slot}: ${input.metric.label}`}
                    >
                      <strong>
                        {displayValue(input.point?.value, "currency")}
                      </strong>
                      <Search size={12} />
                    </button>
                    <small>
                      {input.point?.classification || "Unavailable"}
                    </small>
                  </td>
                ))}
                <td>
                  <button
                    className={shared.valueButton}
                    onClick={() => inspect({ cell, metric })}
                    aria-label={`Inspect ${cell.ticker} custom calculation`}
                  >
                    <strong>
                      {displayValue(cell.point.value, metric.format)}
                    </strong>
                    <Search size={12} />
                  </button>
                  <small>{cell.point.classification}</small>
                  {cell.point.reason && (
                    <small className={styles.issue}>{cell.point.reason}</small>
                  )}
                </td>
              </tr>
            ))}
            {!results.cells.length && (
              <tr>
                <td colSpan={operands.length + 2}>
                  Add an issuer to calculate this metric from its SEC financial
                  data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={shared.panelFoot}>
        Open a calculated result to inspect its formula and original sources,
        then save it to your collection. The shared setup retains this
        definition; saved evidence keeps the calculation as it was reviewed.
      </div>
    </section>
  );
}
