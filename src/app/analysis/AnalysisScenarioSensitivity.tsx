"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, GitBranch, Grid2X2 } from "lucide-react";
import {
  buildAnalysisSensitivity,
  buildScenarioDriverBridge,
} from "../../utils/analysisScenarioSensitivity.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./AnalysisScenarioSensitivity.module.css";

const exactNumber = (value: number, format = "currency") =>
  Number.isFinite(value)
    ? `${value.toLocaleString("en-US", { maximumSignificantDigits: 21 })}${format === "currency" ? " USD" : "%"}`
    : "Unavailable";
const assumption = (value: number, axis: any) =>
  `${value > 0 && axis.min < 0 ? "+" : ""}${value}${axis.unit === "pp" ? " pp" : "%"}`;

function DriverBridge({ scenario, settings, onInspect }: any) {
  const bridge = buildScenarioDriverBridge(scenario);
  const value = (number: number) =>
    analysisValue(number, "currency", settings.units);
  if (!scenario.operating) return null;
  const levels = bridge.rows.flatMap((row: any) => [row.from, row.to]);
  const low = Math.min(0, ...levels),
    high = Math.max(0, ...levels);
  const scale = Math.max(1, Math.abs(low), Math.abs(high));
  const span = high / scale - low / scale || 1;
  const y = (number: number) =>
    204 - ((number / scale - low / scale) / span) * 155;
  const width = 840,
    slot = (width - 44) / Math.max(1, bridge.rows.length);
  const wrap = (label: string) => {
    const lines: string[] = [];
    for (const word of label.split(" ")) {
      if (!lines.length || lines[lines.length - 1].length + word.length > 21)
        lines.push(word);
      else lines[lines.length - 1] += ` ${word}`;
    }
    return lines.slice(0, 3);
  };
  return (
    <section className={styles.panel} aria-labelledby="scenario-bridge-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            <GitBranch size={14} aria-hidden="true" /> Explain the change
          </p>
          <h3 id="scenario-bridge-heading">Operating-income driver bridge</h3>
        </div>
        {!bridge.reason && (
          <span className={styles.badge}>
            {bridge.reconciled
              ? "Equation reconciles"
              : "Reconciliation mismatch"}
          </span>
        )}
      </div>
      {bridge.reason ? (
        <p className={styles.notice}>{bridge.reason}</p>
      ) : (
        <>
          <p className={styles.small}>{bridge.method}</p>
          <div className={styles.chartScroll}>
            <svg
              className={styles.bridgeChart}
              viewBox={`0 0 ${width} 285`}
              role="img"
              aria-labelledby="scenario-bridge-title scenario-bridge-description"
            >
              <title id="scenario-bridge-title">
                Reported operating income, isolated driver effects, and
                hypothetical operating income
              </title>
              <desc id="scenario-bridge-description">
                Each effect starts where the previous amount ended. The table
                below gives every value and its source calculation.
              </desc>
              <line
                x1="16"
                x2={width - 16}
                y1={y(0)}
                y2={y(0)}
                className={styles.zeroLine}
              />
              {bridge.rows.map((row: any, rowIndex: number) => {
                const x = 22 + slot * rowIndex + slot / 2;
                const top = Math.min(y(row.from), y(row.to));
                return (
                  <g key={row.key}>
                    {rowIndex > 0 && row.kind === "effect" && (
                      <line
                        x1={x - slot + 34}
                        x2={x - 34}
                        y1={y(row.from)}
                        y2={y(row.from)}
                        className={styles.connector}
                      />
                    )}
                    <rect
                      x={x - 34}
                      y={top}
                      width="68"
                      height={Math.max(1.5, Math.abs(y(row.to) - y(row.from)))}
                      rx="3"
                      className={
                        row.kind === "total"
                          ? styles.totalBar
                          : row.value >= 0
                            ? styles.increaseBar
                            : styles.decreaseBar
                      }
                    >
                      <title>
                        {row.label}: {exactNumber(row.value)}
                      </title>
                    </rect>
                    <text
                      x={x}
                      y={Math.max(21, top - 10)}
                      textAnchor="middle"
                      className={styles.chartValue}
                    >
                      {row.kind === "effect" && row.value > 0 ? "+" : ""}
                      {value(row.value)}
                    </text>
                    {wrap(row.label).map((line, lineIndex) => (
                      <text
                        key={lineIndex}
                        x={x}
                        y={226 + lineIndex * 15}
                        textAnchor="middle"
                        className={styles.chartLabel}
                      >
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <p className={styles.equation}>
            {value(bridge.baseline!)} {bridge.effectTotal! < 0 ? "−" : "+"}{" "}
            {value(Math.abs(bridge.effectTotal!))} = {value(bridge.final!)}
            <span>
              {bridge.reconciled
                ? "Reconciled before display rounding."
                : "The effect components do not reconcile; review the calculations."}
            </span>
          </p>
          <div className={styles.tableScroll}>
            <table>
              <caption>
                Driver attribution in selected display units. Inspect a value to
                see its exact formula and reported SEC inputs.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Driver</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Running operating income</th>
                </tr>
              </thead>
              <tbody>
                {bridge.rows.map((row: any) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>
                      {row.selection ? (
                        <button
                          type="button"
                          title={exactNumber(row.value)}
                          onClick={() => onInspect(row.selection)}
                          aria-label={`Inspect ${row.label.toLowerCase()}, ${exactNumber(row.value)}`}
                        >
                          {row.kind === "effect" && row.value > 0 ? "+" : ""}
                          {value(row.value)}
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                      ) : (
                        value(row.value)
                      )}
                    </td>
                    <td title={exactNumber(row.to)}>{value(row.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default function AnalysisScenarioSensitivity(props: any) {
  const { data, settings, index } = props;
  const period = data.periods?.[index];
  const context = [
    data.ticker,
    data.lens,
    period?.kind,
    period?.start,
    period?.end,
    data.asOf,
    settings.scenarioModel,
  ].join(":");
  return <SensitivityExplorer key={context} {...props} />;
}

function SensitivityExplorer({
  data,
  settings,
  index,
  scenario,
  onPatch,
  onInspect,
}: any) {
  const [exercise, setExercise] = useState(
    data.lens === "corporate" ? "operating" : "balance",
  );
  const [outcome, setOutcome] = useState("");
  const [steps, setSteps] = useState<Record<string, number>>({});
  const [applied, setApplied] = useState("");
  const axesKey =
    exercise === "operating"
      ? settings.scenarioModel === "cost"
        ? "cost"
        : "margin"
      : "balance";
  const grid = useMemo(
    () =>
      buildAnalysisSensitivity(data, settings, index, {
        exercise,
        outcome,
        xStep: steps[`${axesKey}:x`],
        yStep: steps[`${axesKey}:y`],
      }),
    [data, settings, index, exercise, outcome, steps, axesKey],
  );
  const format = grid.outcome.format;
  const value = (number: any) => analysisValue(number, format, settings.units);
  const delta = (number: any) =>
    Number.isFinite(number)
      ? `${number > 0 ? "+" : ""}${analysisValue(number, format === "percent" ? "percentagePoints" : "currency", settings.units)}`
      : "Unavailable";
  const apply = (cell: any) => {
    if (cell.reason) return;
    if (onPatch(cell.patch) === false) return;
    setApplied(
      `Applied ${grid.x.label.toLowerCase()} ${assumption(cell.x, grid.x)}${grid.y ? ` and ${grid.y.label.toLowerCase()} ${assumption(cell.y, grid.y)}` : ""}. The grid is centered on these assumptions.`,
    );
  };
  const label = (cell: any) =>
    `${grid.x.label} ${assumption(cell.x, grid.x)}${grid.y ? `; ${grid.y.label} ${assumption(cell.y, grid.y)}` : ""}; ${cell.reason ? `unavailable: ${cell.reason}` : `${grid.outcome.label} ${exactNumber(cell.value, format)}. ${cell.current ? "Current assumptions." : "Apply these assumptions."}`}`;
  const shade = (cell: any) => {
    if (!Number.isFinite(cell.value)) return undefined;
    const scale = Math.max(
      1,
      Math.abs(grid.maximum ?? 0),
      Math.abs(grid.minimum ?? 0),
    );
    const extent = (grid.maximum ?? 0) / scale - (grid.minimum ?? 0) / scale;
    const fraction =
      extent > 0 ? (cell.value / scale - grid.minimum! / scale) / extent : 0.5;
    return {
      background: `color-mix(in srgb, var(--analysis-accent) ${8 + 30 * fraction}%, var(--analysis-panel))`,
    };
  };
  const interval = (axis: any, coordinate: string) => (
    <label key={axis.key}>
      {axis.label} interval
      <select
        value={axis.step}
        onChange={(event) =>
          setSteps((current) => ({
            ...current,
            [`${axesKey}:${coordinate}`]: Number(event.target.value),
          }))
        }
      >
        {axis.steps.map((step: number) => (
          <option key={step} value={step}>
            {step}
            {axis.unit === "pp" ? " pp" : "%"}
          </option>
        ))}
      </select>
      <small>
        Bounds: {axis.min} to {axis.max}
        {axis.unit === "pp" ? " pp" : "%"}
      </small>
    </label>
  );
  return (
    <div className={styles.exploration}>
      <DriverBridge
        scenario={scenario}
        settings={settings}
        onInspect={onInspect}
      />
      <section
        className={styles.panel}
        aria-labelledby="scenario-matrix-heading"
      >
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              <Grid2X2 size={14} aria-hidden="true" /> Explore nearby
              assumptions
            </p>
            <h3 id="scenario-matrix-heading">
              {grid.y ? "Two-driver sensitivity" : "Asset-loss sensitivity"}
            </h3>
          </div>
          <span className={styles.badge}>
            {grid.cells.length} combinations · same calculation model
          </span>
        </div>
        <p className={styles.small}>
          Select a cell to apply its assumptions together. Every result uses the
          reported baseline and the same formula as the model. The outlined cell
          marks your committed assumptions.
        </p>
        <div className={styles.controls}>
          {data.lens === "corporate" && (
            <label>
              Exercise
              <select
                value={exercise}
                onChange={(event) => {
                  setExercise(event.target.value);
                  setOutcome("");
                  setApplied("");
                }}
              >
                <option value="operating">Operating sensitivity</option>
                <option value="balance">Balance sensitivity</option>
              </select>
            </label>
          )}
          <label>
            Outcome
            <select
              value={grid.outcome.key}
              onChange={(event) => setOutcome(event.target.value)}
            >
              {grid.outcomes.map((item: any) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {interval(grid.x, "x")}
          {grid.y && interval(grid.y, "y")}
        </div>
        <p className={styles.small}>
          {grid.exercise === "operating" && settings.scenarioModel === "cost"
            ? `The variable-cost share stays fixed at ${grid.settings.scenarioVariableCost}% of baseline implied costs. `
            : ""}
          {data.lens === "banking"
            ? `Usable cash (${grid.settings.scenarioCashAvailable}% of reported cash) and replacement funding (${grid.settings.scenarioReplacementFunding}% of baseline deposits) stay fixed. `
            : ""}
          {!grid.y
            ? "This balance model has one independent driver: asset loss. "
            : ""}
          {grid.clipped
            ? "Values are clipped to the model bounds and duplicates are removed, so this grid has fewer than five values on at least one axis."
            : "Each axis shows two intervals on either side of the current assumption."}
        </p>
        <div className={styles.currentResult}>
          <span>Current {grid.outcome.label.toLowerCase()}</span>
          {grid.current.selection ? (
            <button
              type="button"
              onClick={() => onInspect(grid.current.selection)}
              aria-label={`Inspect current hypothetical ${grid.outcome.label.toLowerCase()}`}
              title={exactNumber(grid.current.value!, format)}
            >
              {value(grid.current.value)}
              <ArrowUpRight size={15} aria-hidden="true" />
            </button>
          ) : (
            <strong>Unavailable</strong>
          )}
        </div>
        {grid.current.reason && (
          <p className={styles.notice}>
            Current assumptions: {grid.current.reason}
          </p>
        )}
        <div className={styles.matrixScroll}>
          <table className={styles.matrix}>
            <caption>
              {grid.outcome.label} · columns: {grid.x.label.toLowerCase()}
              {grid.y ? ` · rows: ${grid.y.label.toLowerCase()}` : ""}. Cell
              change is relative to the current result.
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  {grid.y
                    ? `${grid.y.label} ↓ / ${grid.x.label} →`
                    : grid.x.label}
                </th>
                {grid.x.values.map((x: number) => (
                  <th key={x} scope="col">
                    {assumption(x, grid.x)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(grid.y?.values || [null]).map((y: any) => (
                <tr key={y ?? "single"}>
                  <th scope="row">
                    {grid.y ? assumption(y, grid.y) : grid.outcome.label}
                  </th>
                  {grid.cells
                    .filter((cell: any) => cell.y === y)
                    .map((cell: any) => (
                      <td key={cell.id}>
                        <button
                          type="button"
                          className={styles.cell}
                          style={shade(cell)}
                          data-current={cell.current || undefined}
                          aria-pressed={cell.current}
                          aria-label={label(cell)}
                          title={label(cell)}
                          disabled={!!cell.reason}
                          onClick={() => apply(cell)}
                        >
                          <strong>
                            {cell.reason ? "Unavailable" : value(cell.value)}
                          </strong>
                          <small>
                            {cell.reason
                              ? "See reason below"
                              : cell.current
                                ? "Current"
                                : Number.isFinite(cell.delta)
                                  ? `${delta(cell.delta)} change`
                                  : "No current comparison"}
                          </small>
                        </button>
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {grid.minimum !== null && (
          <div className={styles.legend}>
            <span>{value(grid.minimum)}</span>
            <span className={styles.legendScale} aria-hidden="true" />
            <span>{value(grid.maximum)}</span>
            <p>
              Shading shows lower to higher numerical outcomes. It does not
              represent likelihood or risk.
            </p>
          </div>
        )}
        <p className={styles.status} role="status" aria-live="polite">
          {applied}
        </p>
        {grid.invalidCount > 0 && (
          <div className={styles.notice}>
            <strong>
              {grid.invalidCount} of {grid.cells.length} combinations are
              unavailable.
            </strong>
            <ul>
              {grid.reasons.map((reason: string) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p>
              Unavailable cells cannot be applied. Their values are not treated
              as zero.
            </p>
          </div>
        )}
        <details className={styles.details}>
          <summary>Numeric results and source calculations</summary>
          <div className={styles.tableScroll}>
            <table>
              <caption>
                All combinations; amounts use the selected display units.
                Inspect any available result to preserve its assumptions and SEC
                evidence.
              </caption>
              <thead>
                <tr>
                  <th scope="col">{grid.x.label}</th>
                  {grid.y && <th scope="col">{grid.y.label}</th>}
                  <th scope="col">{grid.outcome.label}</th>
                  <th scope="col">Change from current</th>
                  <th scope="col">Action or reason</th>
                </tr>
              </thead>
              <tbody>
                {grid.cells.map((cell: any) => (
                  <tr key={cell.id} data-current={cell.current || undefined}>
                    <th scope="row">{assumption(cell.x, grid.x)}</th>
                    {grid.y && <td>{assumption(cell.y, grid.y)}</td>}
                    <td>
                      {cell.selection ? (
                        <button
                          type="button"
                          title={exactNumber(cell.value, format)}
                          aria-label={`Inspect ${label(cell)}`}
                          onClick={() => onInspect(cell.selection)}
                        >
                          {value(cell.value)}
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                      ) : (
                        "Unavailable"
                      )}
                    </td>
                    <td>{cell.reason ? "—" : delta(cell.delta)}</td>
                    <td>
                      {cell.reason ? (
                        <span className={styles.cellReason}>{cell.reason}</span>
                      ) : cell.current ? (
                        "Current assumptions"
                      ) : (
                        <button
                          type="button"
                          onClick={() => apply(cell)}
                          aria-label={`Apply ${grid.x.label.toLowerCase()} ${assumption(cell.x, grid.x)}${grid.y ? ` and ${grid.y.label.toLowerCase()} ${assumption(cell.y, grid.y)}` : ""}`}
                        >
                          Apply
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}
