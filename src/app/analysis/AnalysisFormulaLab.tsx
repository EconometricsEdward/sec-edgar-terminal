"use client";
import { Calculator, ArrowUpRight } from "lucide-react";
import {
  buildFormulaHistory,
  buildFormulaPoint,
  formulaDefinitions,
  normalizeFormulaSettings,
} from "../../utils/analysisFormula.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./labs.module.css";

export default function AnalysisFormulaLab({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const normalized = normalizeFormulaSettings(settings);
  const formula =
    normalized.formulaC === "revenue" &&
    !data.definitions.some((d: any) => d.key === "revenue") &&
    data.revenueKey === "bankRevenue"
      ? { ...normalized, formulaC: "bankRevenue" }
      : normalized;
  const result = buildFormulaPoint(data, formula, index);
  const history = buildFormulaHistory(data, formula).slice(
    index,
    index + (settings.years || 8),
  );
  const definitions = formulaDefinitions(data);
  const ratio = ["ratio", "subtractRatio"].includes(formula.formulaOp);
  const pick = (field: string, label: string) => (
    <label>
      {label}
      <select
        value={formula[field]}
        onChange={(event) =>
          onPatch({ ...formula, [field]: event.target.value })
        }
      >
        {!definitions.some((d: any) => d.key === formula[field]) && (
          <option value={formula[field]}>Unavailable: {formula[field]}</option>
        )}
        {definitions.map((d: any) => (
          <option key={d.key} value={d.key}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
  const presets = [
    {
      name: "Cash conversion",
      formulaA: "operatingCashFlow",
      formulaB: "netIncome",
      formulaOp: "ratio",
      formulaScale: "percent",
    },
    ...(data.lens === "corporate"
      ? [
          {
            name: "Free cash flow margin",
            formulaA: "operatingCashFlow",
            formulaB: "capex",
            formulaC: "revenue",
            formulaOp: "subtractRatio",
            formulaScale: "percent",
          },
        ]
      : []),
    ...(data.lens === "banking"
      ? [
          {
            name: "Pre-provision operating margin",
            formulaA: "bankRevenue",
            formulaB: "noninterestExpense",
            formulaC: "bankRevenue",
            formulaOp: "subtractRatio",
            formulaScale: "percent",
          },
        ]
      : []),
    {
      name: "Cash / total liabilities",
      formulaA: "cash",
      formulaB: "totalLiabilities",
      formulaOp: "ratio",
      formulaScale: "percent",
    },
    {
      name: "Assets less liabilities",
      formulaA: "totalAssets",
      formulaB: "totalLiabilities",
      formulaOp: "subtract",
      formulaScale: "percent",
    },
  ];
  return (
    <section className={styles.lab} aria-labelledby="formula-lab-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            <Calculator size={14} /> Build a research metric
          </p>
          <h2 id="formula-lab-heading">Your question. Your formula.</h2>
        </div>
        <span className={styles.badge}>USD source inputs</span>
      </div>
      <p className={styles.intro}>
        Combine reported amounts into a custom metric, follow it through time,
        and open every input in the evidence inspector. The formula travels with
        shared links and saved views.
      </p>
      <div className={styles.presets} aria-label="Formula presets">
        {presets.map(({ name, ...preset }) => (
          <button key={name} onClick={() => onPatch({ ...formula, ...preset })}>
            {name}
          </button>
        ))}
      </div>
      <div className={styles.controls}>
        <label>
          Calculation
          <select
            value={formula.formulaOp}
            onChange={(e) => onPatch({ ...formula, formulaOp: e.target.value })}
          >
            <option value="subtractRatio">(A − B) / C</option>
            <option value="ratio">A / B</option>
            <option value="subtract">A − B</option>
            <option value="add">A + B</option>
          </select>
        </label>
        {pick("formulaA", "A · first amount")}
        {pick("formulaB", "B · second amount")}
        {formula.formulaOp === "subtractRatio" &&
          pick("formulaC", "C · denominator")}
        {ratio && (
          <label>
            Ratio display
            <select
              value={formula.formulaScale}
              onChange={(e) =>
                onPatch({ ...formula, formulaScale: e.target.value })
              }
            >
              <option value="percent">Percentage (× 100)</option>
              <option value="multiple">Multiple (×)</option>
            </select>
          </label>
        )}
      </div>
      <div className={styles.result} aria-live="polite">
        <div>
          <span className={styles.eyebrow}>
            {data.periods[index]?.label || data.periods[index]?.end} · Custom
            calculation
          </span>
          <p className={styles.expression}>{result.point.formula}</p>
        </div>
        <button
          className={styles.bigNumber}
          onClick={() => onInspect(result)}
          aria-label="Inspect custom formula result"
        >
          {analysisValue(
            result.point.value,
            result.definition.format,
            settings.units,
          )}
          <ArrowUpRight size={18} />
        </button>
      </div>
      {result.point.reason && (
        <p className={styles.notice} role="status">
          {result.point.reason}
        </p>
      )}
      <div className={styles.inputCards}>
        {result.inputs.map((input: any, i: number) => (
          <article key={`${input.key}-${i}`}>
            <span className={styles.eyebrow}>
              {String.fromCharCode(65 + i)} · {input.basis}
            </span>
            <h3>{input.definition?.label || input.key}</h3>
            <button
              onClick={() =>
                onInspect({
                  definition: input.definition || {
                    key: input.key,
                    label: input.key,
                    format: "currency",
                  },
                  point: input.point || {
                    period: data.periods[index],
                    value: null,
                    reason: input.reason,
                    sources: [],
                  },
                })
              }
            >
              {analysisValue(input.point?.value, "currency", settings.units)}
              <ArrowUpRight size={13} />
            </button>
            {input.reason && <p className={styles.small}>{input.reason}</p>}
          </article>
        ))}
      </div>
      <p className={styles.small}>{result.point.note}</p>
      <div className={styles.tableScroll}>
        <table>
          <caption>
            Same formula across available reporting periods. Missing inputs
            remain unavailable.
          </caption>
          <thead>
            <tr>
              <th scope="col">Reporting period</th>
              <th scope="col">Custom result</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry: any, i: number) => (
              <tr
                key={`${entry.point.period?.end}-${i}`}
                data-selected={
                  entry.point.period?.end === data.periods[index]?.end
                }
              >
                <th scope="row">
                  {entry.point.period?.label || entry.point.period?.end}
                  <small>
                    {entry.point.period?.start || "As of"} →{" "}
                    {entry.point.period?.end}
                  </small>
                </th>
                <td>
                  <button
                    onClick={() => onInspect(entry)}
                    aria-label={`Inspect custom formula for ${entry.point.period?.end}`}
                  >
                    {analysisValue(
                      entry.point.value,
                      entry.definition.format,
                      settings.units,
                    )}
                    <ArrowUpRight size={12} />
                  </button>
                </td>
                <td>
                  {entry.point.reason || "All required USD inputs available"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className={styles.method}>
        <summary>How this builder keeps calculations comparable</summary>
        <p>
          Only USD amount metrics are eligible. Addition and subtraction require
          the same measurement basis; ratios can deliberately combine a period
          flow with a balance. All operands must use the selected reporting
          period and basis. Ratios require a positive denominator. No
          annualization, missing-value substitution, or arbitrary code execution
          occurs.
        </p>
        <p>
          Average and ending balances are distinct. A subtraction such as assets
          less liabilities does not certify that the result equals
          parent-company shareholder equity. Review consolidation scope and the
          original filing.
        </p>
      </details>
    </section>
  );
}
