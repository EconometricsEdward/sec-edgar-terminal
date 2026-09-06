"use client";
import { FlaskConical, ArrowUpRight, RotateCcw } from "lucide-react";
import {
  buildAnalysisScenario,
  SCENARIO_DEFAULTS,
} from "../../utils/analysisScenarios.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./labs.module.css";

export default function AnalysisScenarioLab({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const scenario = buildAnalysisScenario(data, settings, index);
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const control = (
    key: string,
    title: string,
    min: number,
    max: number,
    suffix: string,
    help: string,
  ) => (
    <div className={styles.assumption}>
      <label htmlFor={`lab-${key}`}>
        {title}
        <span className={styles.controlValue}>
          {scenario.settings[key] > 0 ? "+" : ""}
          {scenario.settings[key]}
          {suffix}
        </span>
      </label>
      <input
        id={`lab-${key}`}
        type="range"
        min={min}
        max={max}
        step={0.25}
        value={scenario.settings[key]}
        onChange={(e) => onPatch({ [key]: Number(e.target.value) })}
        aria-valuetext={`${scenario.settings[key]} ${suffix === " pp" ? "percentage points" : "percent"}`}
      />
      <label className={styles.exactInput}>
        Exact assumption ({suffix.trim()})
        <input
          type="number"
          min={min}
          max={max}
          step={0.25}
          value={scenario.settings[key]}
          onChange={(e) =>
            onPatch({
              [key]: e.target.value === "" ? 0 : Number(e.target.value),
            })
          }
        />
      </label>
      <p className={styles.small}>{help}</p>
    </div>
  );
  const resultTable = (rows: any[]) => (
    <div className={styles.tableScroll}>
      <table>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Baseline</th>
            <th scope="col">Hypothetical result</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{value(row.baseline, row.format)}</td>
              <td>
                <button
                  onClick={() => onInspect(row.selection)}
                  aria-label={`Inspect hypothetical ${row.label.toLowerCase()}`}
                >
                  {value(row.selection.point.value, row.format)}
                  <ArrowUpRight size={13} />
                </button>
              </td>
              <td>
                {Number.isFinite(row.selection.point.value) &&
                Number.isFinite(row.baseline)
                  ? row.format === "percent"
                    ? `${row.selection.point.value - row.baseline >= 0 ? "+" : ""}${(row.selection.point.value - row.baseline).toFixed(2)} pp`
                    : value(
                        row.selection.point.value - row.baseline,
                        row.format,
                      )
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const sources = (inputs: any[]) => (
    <details className={styles.method}>
      <summary>Inspect reported baseline inputs</summary>
      <div className={styles.inputCards}>
        {inputs.map((input) => (
          <article key={input.key}>
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
                    value: null,
                    period: scenario.period,
                    reason: input.reason,
                    sources: [],
                  },
                })
              }
            >
              {value(input.point?.value)}
              <ArrowUpRight size={13} />
            </button>
            {input.reason && <p className={styles.small}>{input.reason}</p>}
          </article>
        ))}
      </div>
    </details>
  );
  return (
    <section className={styles.lab} aria-labelledby="scenario-lab-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            <FlaskConical size={14} /> Transparent sensitivity lab
          </p>
          <h2 id="scenario-lab-heading">What would move the numbers?</h2>
        </div>
        <button onClick={() => onPatch(SCENARIO_DEFAULTS)}>
          <RotateCcw size={14} /> Reset assumptions
        </button>
      </div>
      <p className={styles.intro}>
        Start from {data.ticker}'s reported{" "}
        {scenario.period?.label || scenario.period?.end} figures. Change a few
        explicit assumptions and see their mechanical effect. Open any
        hypothetical result to preserve the calculation and source evidence.
      </p>
      <p className={styles.notice}>
        Hypothetical sensitivities, not forecasts. These exercises do not model
        probability, taxes, regulatory capital, management actions, or secondary
        effects.
      </p>
      {scenario.operating && (
        <section
          className={styles.exercise}
          aria-labelledby="operating-sensitivity-heading"
        >
          <div className={styles.heading}>
            <div>
              <p className={styles.eyebrow}>
                Exercise 01 · Operating sensitivity
              </p>
              <h3 id="operating-sensitivity-heading">
                Revenue × operating margin
              </h3>
            </div>
            <span className={styles.badge}>Selected reporting duration</span>
          </div>
          <div className={styles.assumptions}>
            {control(
              "scenarioRevenue",
              "Revenue change",
              -50,
              50,
              "%",
              "Relative change from reported revenue. No price/volume attribution is assumed.",
            )}
            {control(
              "scenarioMargin",
              "Operating margin change",
              -20,
              20,
              " pp",
              "Added to reported operating income / revenue. Costs are implied; net income and cash flow are not modeled.",
            )}
          </div>
          {scenario.operating.reason ? (
            <p className={styles.notice} role="status">
              {scenario.operating.reason}
            </p>
          ) : (
            resultTable(scenario.operating.rows)
          )}
          {sources(scenario.operating.inputs)}
        </section>
      )}
      <section
        className={styles.exercise}
        aria-labelledby="balance-sensitivity-heading"
      >
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              Exercise {scenario.corporate ? "02" : "01"} · Balance sensitivity
            </p>
            <h3 id="balance-sensitivity-heading">
              {scenario.banking
                ? "Asset loss and cash-funded deposit withdrawals"
                : "Incremental asset loss and shareholder equity"}
            </h3>
          </div>
          <span className={styles.badge}>Static ending balances</span>
        </div>
        <div className={styles.assumptions}>
          {control(
            "scenarioLoss",
            "Incremental loss / baseline assets",
            0,
            20,
            "%",
            "A new noncash asset write-down charged fully to shareholder equity. No tax benefit or absorption by existing allowances.",
          )}
          {scenario.banking &&
            control(
              "scenarioFunding",
              "Deposit withdrawal",
              0,
              50,
              "%",
              "Share of reported deposits paid entirely from reported cash. No securities sales, new funding, or withdrawal probabilities are assumed.",
            )}
        </div>
        {(scenario.balance.loss !== null || scenario.banking) && (
          <div className={styles.assumptionTotals}>
            <span>
              Assumed loss <strong>{value(scenario.balance.loss)}</strong>
            </span>
            {scenario.banking && (
              <span>
                Assumed cash payment{" "}
                <strong>{value(scenario.balance.withdrawal)}</strong>
              </span>
            )}
          </div>
        )}
        {scenario.balance.reason ? (
          <div className={styles.notice} role="status">
            <p>{scenario.balance.reason}</p>
            {(scenario.balance.fundingGap ?? 0) > 0 && (
              <p>
                Cash shortfall under this assumption:{" "}
                <strong>{value(scenario.balance.fundingGap)}</strong>.
                Hypothetical ending balances are withheld.
              </p>
            )}
          </div>
        ) : (
          resultTable(scenario.balance.rows)
        )}
        <p className={styles.small}>{scenario.balance.note}</p>
        {sources(scenario.balance.inputs)}
      </section>
      <details className={styles.method}>
        <summary>Assumptions, limits, and how to use these results</summary>
        <p>
          Each exercise is independent. Operating sensitivity does not flow into
          the balance sheet exercise. No balance is replenished automatically,
          and a missing input never becomes zero. Negative hypothetical equity
          is displayed as arithmetic, not translated into a default probability
          or solvency determination.
        </p>
        <p>
          The shareholder equity / assets ratio uses the same reported balances
          as the baseline and is not a regulatory capital calculation. Reported
          cash is an upper-bound input to this simple exercise; the model does
          not verify that the full amount is unrestricted or available for
          withdrawals. Saved evidence explicitly retains the hypothetical label,
          assumptions, selected period, and original SEC inputs.
        </p>
      </details>
    </section>
  );
}
