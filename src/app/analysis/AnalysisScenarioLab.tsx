"use client";

import type { CSSProperties } from "react";
import { ArrowDown, ArrowUpRight, Check, ChevronDown, GitBranch, Link2, RotateCcw, SlidersHorizontal } from "lucide-react";
import { SCENARIO_LIMITS } from "../../utils/analysisScenarios.js";
import { SCENARIO_FIELDS } from "../../utils/analysisScenarioEditing.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import AnalysisScenarioCalibration from "./AnalysisScenarioCalibration";
import styles from "./AnalysisScenarioLab.module.css";

export default function AnalysisScenarioLab({
  settings,
  scenario,
  calibration,
  drafts,
  errors,
  onDraft,
  onApply,
  onDiscard,
  onInspect,
}: any) {
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const dirty = Object.keys(drafts).length > 0;
  const model = drafts.scenarioModel ?? scenario.settings.scenarioModel;
  const cashMode = drafts.scenarioCashMode ?? scenario.settings.scenarioCashMode;
  const connectedDraft = !!scenario.operating && cashMode === "connected";
  const connected = !!scenario.connected?.enabled;
  const draftValue = (key: string) => drafts[key] ?? scenario.settings[key];
  const operatingIncome = scenario.operating?.rows.find((row: any) => row.key === "OperatingIncome");
  const balanceExercise = connected ? scenario.connected : scenario.balance;
  const balanceRow = (key: string) => balanceExercise?.rows.find((row: any) => row.key === key);
  const featured = [
    operatingIncome,
    ...(connected
      ? [balanceRow("Cash"), balanceRow("Debt"), balanceRow("EquityAssets")]
      : scenario.banking
        ? [balanceRow("Cash"), balanceRow("Deposits"), balanceRow("Equity"), balanceRow("EquityAssets")]
        : [balanceRow("Assets"), balanceRow("Equity"), balanceRow("EquityAssets")]),
  ].filter(Boolean);
  const control = (key: string, help: string, historical?: any) => {
    const field = SCENARIO_FIELDS[key];
    const [min, max] = SCENARIO_LIMITS[key];
    const raw = String(draftValue(key));
    const numeric = Number(raw);
    return (
      <div className={styles.control} key={key}>
        <div className={styles.controlHeading}>
          <label htmlFor={`scenario-${key}`}>{field.label} <span>({field.unit})</span></label>
          <input
            id={`scenario-${key}`}
            type="text"
            inputMode="decimal"
            value={raw}
            onChange={(event) => onDraft(key, event.target.value)}
            aria-invalid={!!errors[key]}
            aria-describedby={`scenario-help-${key}`}
            autoComplete="off"
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={0.25}
          value={Number.isFinite(numeric) && raw.trim() ? Math.min(max, Math.max(min, numeric)) : scenario.settings[key]}
          onChange={(event) => onDraft(key, event.target.value)}
          aria-label={`${field.label} slider`}
          aria-valuetext={`${raw} ${field.unit}`}
          aria-describedby={`scenario-help-${key}`}
        />
        <p id={`scenario-help-${key}`} className={errors[key] ? styles.error : undefined}>{errors[key] || help}</p>
        {errors[key] && <small>Supported range: {min} to {max} {field.unit}.</small>}
        {historical && <AnalysisScenarioCalibration metric={historical} assumption={raw} onInspect={onInspect} />}
      </div>
    );
  };
  const delta = (row: any) => {
    const amount = row.selection.point.value;
    if (!Number.isFinite(row.baseline) || !Number.isFinite(amount)) return "Change unavailable";
    const difference = amount - row.baseline;
    return `${difference > 0 ? "+" : ""}${value(difference, row.format === "percent" ? "percentagePoints" : row.format)} change`;
  };
  const results = (exercise: any) => (
    <>
      {exercise.reason && <p className={styles.notice}>{exercise.reason}</p>}
      {exercise.rows.length > 0 && (
        <div className={styles.tableScroll}>
          <table>
            <caption>Applied assumptions · inspect a result for its equation and SEC inputs</caption>
            <thead><tr><th scope="col">Measure</th><th scope="col">Reported</th><th scope="col">Hypothetical</th><th scope="col">Change</th></tr></thead>
            <tbody>{exercise.rows.map((row: any) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{value(row.baseline, row.format)}</td>
                <td><button type="button" onClick={() => onInspect(row.selection)} aria-label={`Inspect hypothetical ${row.label.toLowerCase()}`}>
                  {value(row.selection.point.value, row.format)}<ArrowUpRight size={12} aria-hidden="true" />
                </button></td>
                <td>{Number.isFinite(row.baseline) && Number.isFinite(row.selection.point.value) ? value(row.selection.point.value - row.baseline, row.format === "percent" ? "percentagePoints" : row.format) : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </>
  );
  const bridge = connected ? scenario.connected.bridge : scenario.operating?.bridge;
  const availableBridge = (bridge || []).filter((row: any) => Number.isFinite(row.selection.point.value));
  const magnitude = Math.max(1, ...availableBridge.map((row: any) => Math.abs(row.selection.point.value)));
  const connectedDiagnostics = connected ? scenario.connected.diagnostics || [] : [];
  const diagnostics = [
    ...(scenario.operating?.diagnostics || []),
    ...(connected ? connectedDiagnostics : scenario.balance.diagnostics || []),
  ].filter((item: any, index: number, items: any[]) => item.status !== "error" && items.findIndex((other: any) => other.key === item.key) === index);
  const hasError = (...keys: string[]) => keys.some((key) => !!errors[key]);
  const gap = connected ? scenario.connected.metrics.fundingGap : scenario.balance.fundingGap;

  return (
    <section className={styles.lab} aria-label="Scenario assumptions and results">
      <div className={styles.compactSummary}>
        <span className={styles.compactStatus}>{dirty ? "Applied results · edits pending" : "Applied results"}</span>
        <div>{featured.slice(0, 3).map((row: any) => (
          <span key={row.key}><small>{row.key === "Cash" && connected ? "Hypothetical cash" : row.label}</small><strong>{value(row.selection.point.value, row.format)}</strong></span>
        ))}</div>
        <a href="#scenario-live-results">View results <ArrowDown size={12} aria-hidden="true" /></a>
      </div>
      <div className={styles.layout}>
        <form className={styles.assumptions} onSubmit={(event) => { event.preventDefault(); onApply(); }}>
          <header className={styles.panelHeading}>
            <div><p className={styles.eyebrow}><SlidersHorizontal size={13} aria-hidden="true" /> Your assumptions</p><h3>What would change?</h3></div>
            <span className={styles.step}>01</span>
          </header>
          {scenario.operating && (
            <fieldset className={styles.fieldset}>
              <legend>Operating performance</legend>
              <label className={styles.modelChoice} htmlFor="scenario-model">Operating model
                <select id="scenario-model" value={model} onChange={(event) => onDraft("scenarioModel", event.target.value)}>
                  <option value="margin">Revenue and operating margin</option>
                  <option value="cost">Fixed and variable operating costs</option>
                </select>
              </label>
              {control("scenarioRevenue", "Change from reported revenue. Price and volume are not separated.", calibration?.revenue)}
              {model === "cost" ? (
                <>
                  {control("scenarioVariableCost", "User assumption: the share of implied operating costs that moves with revenue. Remaining costs stay fixed before inflation.")}
                  {control("scenarioCostChange", "Applies to fixed and volume-adjusted variable costs. The margin-change assumption is inactive.")}
                </>
              ) : control("scenarioMargin", "Percentage points added to reported operating margin; distinct from a percentage change.", calibration?.margin)}
              <div className={styles.connection} data-connected={connectedDraft}>
                <div className={styles.connectionHeading}>
                  <Link2 size={17} aria-hidden="true" />
                  <label id="scenario-cash-mode-label" htmlFor="scenario-cash-mode">Connect earnings to cash</label>
                  <button id="scenario-cash-mode" className={styles.toggle} type="button" role="switch" aria-checked={connectedDraft} aria-labelledby="scenario-cash-mode-label" aria-describedby="scenario-cash-mode-help" onClick={() => onDraft("scenarioCashMode", connectedDraft ? "independent" : "connected")}><span /></button>
                </div>
                <p id="scenario-cash-mode-help">{connectedDraft ? "Model incremental cash and balance-sheet effects with explicit tax, working-capital, investment, and financing assumptions." : "Optional: follow the operating change through cash, debt, and shareholder equity."}</p>
                {drafts.scenarioCashMode !== undefined && drafts.scenarioCashMode !== scenario.settings.scenarioCashMode && <p className={styles.pending}>Apply assumptions to change the results model.</p>}
              </div>
            </fieldset>
          )}
          {connectedDraft ? (
            <div className={styles.connectedControls}>
              <details className={styles.assumptionGroup} open={hasError("scenarioTaxRate", "scenarioWorkingCapital")}>
                <summary><span>Taxes & working capital<small>Tax {draftValue("scenarioTaxRate")}% · Working capital {draftValue("scenarioWorkingCapital")}% of revenue</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
                {control("scenarioTaxRate", "Tax rate applied only to positive incremental earnings after new-borrowing interest. An earnings decline receives no assumed tax relief.")}
                {control("scenarioWorkingCapital", "Additional cash tied up in operating working capital, as a share of reported revenue. A negative value releases cash.")}
              </details>
              <details className={styles.assumptionGroup} open={hasError("scenarioCapexChange", "scenarioBorrowing", "scenarioDebtRepayment", "scenarioBorrowRate")}>
                <summary><span>Investment & financing<small>Capex {draftValue("scenarioCapexChange")}% · New borrowing {draftValue("scenarioBorrowing")}% of revenue</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
                {control("scenarioCapexChange", "Relative change in reported capital spending. Additional spending reduces cash; depreciation from new investment is not estimated.")}
                {control("scenarioBorrowing", "Explicit new debt, as a share of reported revenue. Borrowing capacity and collateral are not assumed available.")}
                {control("scenarioDebtRepayment", "Repay this share of reported debt using cash. The model does not estimate interest savings on existing debt.")}
                {control("scenarioBorrowRate", "Annual interest rate on the assumed new borrowing, prorated to the reporting period and charged for that full period.")}
              </details>
            </div>
          ) : (
            <fieldset className={styles.fieldset}>
              <legend>{scenario.banking ? "Asset loss and bank funding" : "Independent balance-sheet sensitivity"}</legend>
              {scenario.operating && <p className={styles.help}>This exercise is separate from operating performance.</p>}
              {control("scenarioLoss", "A new noncash write-down charged fully to shareholder equity. No tax benefit or allowance absorption is assumed.")}
              {scenario.banking && <>
                {control("scenarioFunding", "Baseline deposits withdrawn. Payment requires enough usable cash plus explicit new borrowing.")}
                <details className={styles.assumptionGroup} open={hasError("scenarioCashAvailable", "scenarioReplacementFunding")}>
                  <summary><span>Cash & replacement funding<small>Usable cash {draftValue("scenarioCashAvailable")}% · Borrowing {draftValue("scenarioReplacementFunding")}% of deposits</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
                  {control("scenarioCashAvailable", "Only this share of reported cash can fund withdrawals. Remaining cash stays on the balance sheet.")}
                  {control("scenarioReplacementFunding", "New borrowing as a share of baseline deposits. It adds cash, assets, and debt. Availability and interest costs are not modeled.")}
                </details>
              </>}
            </fieldset>
          )}
          <div className={styles.applyBar}>
            <button className={styles.primary} type="submit" disabled={!dirty}><Check size={15} aria-hidden="true" /> Apply assumptions</button>
            <button type="button" disabled={!dirty} onClick={onDiscard}><RotateCcw size={14} aria-hidden="true" /> Discard edits</button>
            <p role="status">{dirty ? "Edits are pending. Results still use your last applied assumptions." : "Results use the applied assumptions. Edit a value to test another outcome."}</p>
          </div>
        </form>
        <aside className={styles.resultsColumn} id="scenario-live-results" aria-label="Applied hypothetical scenario results">
          <div className={styles.resultsPanel}>
            <div className={styles.stickyResults}>
            <header className={styles.panelHeading}>
              <div><p className={styles.eyebrow}><GitBranch size={13} aria-hidden="true" /> Follow the effect</p><h3>{connected ? "Earnings → cash → financial strength" : "Your hypothetical results"}</h3></div>
              <span className={styles.step}>02</span>
            </header>
            <div className={styles.resultStatus}><span className={styles.statusDot} data-pending={dirty} /><span>{dirty ? "Applied results · unapplied edits" : "Applied results · up to date"}</span><span>{connected ? "Connected model" : "Independent exercises"}</span></div>
            <div className={styles.featured}>
              {featured.map((row: any) => (
                <button type="button" className={styles.resultCard} key={row.key} onClick={() => onInspect(row.selection)} aria-label={`Inspect hypothetical ${row.label.toLowerCase()} summary`}>
                  <span className={styles.cardLabel}>{connected && row.key === "Cash" ? "Cash before unmodeled funding" : row.label}<ArrowUpRight size={13} aria-hidden="true" /></span>
                  <strong>{value(row.selection.point.value, row.format)}</strong>
                  <span className={styles.baseline}>Reported {value(row.baseline, row.format)}</span>
                  <span className={styles.delta}>{delta(row)}</span>
                  {!Number.isFinite(row.selection.point.value) && <span className={styles.baseline}>Inputs incomplete · inspect why</span>}
                </button>
              ))}
            </div>
            </div>
            {scenario.operating?.reason && <p className={styles.notice}>{scenario.operating.reason}</p>}
            {balanceExercise.reason && <p className={styles.notice}>{balanceExercise.reason}</p>}
            {connected && <p className={styles.help}>Incremental changes to the reported period and ending balances. Cash flow is reconciled separately from operating income.</p>}
            {(gap ?? 0) > 0 && <p className={styles.notice}><strong>Funding shortfall: {value(gap)}.</strong> {connected ? "Cash is negative before any unmodeled funding. Additional financing or a change in assumptions is required; this is not a funded balance sheet." : "Usable cash and assumed borrowing do not cover the deposit payments. Ending balances are unavailable until funding covers the payment."}</p>}
            {bridge?.length > 0 && <section className={styles.miniBridge} aria-label={connected ? "Cash change drivers" : "Operating-income change drivers"}>
              <h4>{connected ? "What moves cash?" : "What moves operating income?"}</h4>
              <p>Individual effects · select an effect to inspect its equation</p>
              <div className={styles.bridgeRows}>{bridge.map((row: any) => {
                const amount = row.selection.point.value;
                return <button type="button" key={row.key} className={styles.bridgeRow} onClick={() => onInspect(row.selection)} aria-label={`Inspect ${row.label.toLowerCase()}: ${value(amount)}`}>
                  <span>{row.label}</span>
                  <span className={styles.bridgeTrack} aria-hidden="true">{Number.isFinite(amount) && <i data-direction={amount < 0 ? "negative" : "positive"} style={{ "--effect-width": `${Math.abs(amount) / magnitude * 50}%` } as CSSProperties} />}</span>
                  <strong>{amount > 0 ? "+" : ""}{value(amount)}</strong>
                </button>;
              })}</div>
            </section>}
            <details className={styles.resultDetails}>
              <summary><span>All results & source calculations</span><ChevronDown size={16} aria-hidden="true" /></summary>
              {scenario.operating && <section><h4>Operating results · {scenario.settings.scenarioModel === "cost" ? "cost model" : "margin model"}</h4>{results(scenario.operating)}
                {scenario.operating.costs && <p className={styles.help}>Baseline fixed costs: {value(scenario.operating.costs.fixed)} · variable costs: {value(scenario.operating.costs.variable)} · hypothetical total costs: {value(scenario.operating.costs.hypothetical)}</p>}
              </section>}
              <section><h4>{connected ? "Cash flow & financial strength" : "Balance-sheet results"}</h4>{results(balanceExercise)}</section>
              {!connected && <p className={styles.help}>Assumed asset loss: {value(scenario.balance.loss)}{scenario.banking && <> · Usable starting cash: {value(scenario.balance.usableCash)} · New borrowing: {value(scenario.balance.borrowing)} · Deposit payments: {value(scenario.balance.withdrawal)}</>}</p>}
              {scenario.banking && !scenario.balance.funding?.available && <p className={styles.help}>{scenario.balance.funding?.reason}</p>}
              <p className={styles.help}>{balanceExercise.note}</p>
            </details>
            {diagnostics.length > 0 && <details className={styles.method}><summary>Input coverage & model notes ({diagnostics.length})</summary>{diagnostics.map((item: any) => <p key={item.key}>{item.message}</p>)}</details>}
            <details className={styles.method}>
              <summary>Modeling boundaries & interpretation</summary>
              {connected ? <p>The connected model carries only incremental changes through reported earnings, cash flows, and ending balances. Tax, working-capital, capital-spending, new-debt, repayment, and interest assumptions are explicit inputs. It does not add an entire period of reported cash flow to ending cash. The independent asset-loss exercise is excluded. Existing nonoperating items and unmodeled cash flows are held constant.</p> : <p>Operating and balance-sheet exercises are independent. Operating income does not flow into the separate balance exercise. These exercises do not estimate net income, cash flow, taxes, or interest expense.</p>}
              <p>These are hypothetical arithmetic exercises, not forecasts or probabilities. Neither model establishes borrowing capacity, collateral needs, management responses, covenant compliance, or regulatory capital. Equity means reported shareholder equity. Unavailable inputs remain unavailable; inspect any result for its equation and SEC sources.</p>
              <p>Control ranges limit the exercise, not the range of possible real outcomes. An increase or decrease is not a quality rating.</p>
            </details>
          </div>
        </aside>
      </div>
    </section>
  );
}
