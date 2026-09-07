"use client";
import { useMemo, useState, useEffect, useRef } from "react";
import { FlaskConical, Undo2, Redo2, RotateCcw } from "lucide-react";
import {
  buildAnalysisScenario,
  normalizeScenarioSettings,
  SCENARIO_DEFAULTS,
} from "../../utils/analysisScenarios.js";
import {
  validateScenarioDrafts,
  scenarioAssumptionsEqual,
} from "../../utils/analysisScenarioEditing.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import AnalysisScenarioContext from "./AnalysisScenarioContext";
import AnalysisScenarioLab from "./AnalysisScenarioLab";
import AnalysisScenarioSensitivity from "./AnalysisScenarioSensitivity";
import AnalysisGoalSeek from "./AnalysisGoalSeek";
import AnalysisScenarioCases from "./AnalysisScenarioCases";
import styles from "./AnalysisScenarioWorkspace.module.css";

const tabs = [
  ["model", "Model & results"],
  ["sensitivity", "Drivers & sensitivity"],
  ["targets", "Solve a target"],
  ["cases", "Cases & briefs"],
];
export default function AnalysisScenarioWorkspace(props: any) {
  const context = `${props.data.ticker}:${props.settings.basis}:${props.settings.asOf}:${props.data.periods?.[props.index]?.end}`;
  return <ScenarioWorkbench context={context} {...props} />;
}
function ScenarioWorkbench({
  context,
  data,
  settings,
  index,
  onPatch,
  onInspect,
  cases,
  onSaveCases,
  ready,
}: any) {
  const scenario = useMemo(
    () => buildAnalysisScenario(data, settings, index),
    [data, settings, index],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [past, setPast] = useState<any[]>([]);
  const [future, setFuture] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const [visited, setVisited] = useState<string[]>([settings.scenarioTab]);
  const lastContext = useRef(context);
  useEffect(() => {
    if (lastContext.current === context) return;
    lastContext.current = context;
    setDrafts({});
    setPast([]);
    setFuture([]);
    setMessage(
      "Reported baseline changed. Applied assumptions now use this period; assumption edit history was cleared. Saved case snapshots are preserved.",
    );
  }, [context]);
  const tab = settings.scenarioTab;
  const validation = validateScenarioDrafts(drafts);
  const dirty = Object.keys(drafts).length > 0;
  function commit(next: any, fromEditor = false) {
    const assumptionChange = Object.keys(next).some((key) =>
      Object.hasOwn(SCENARIO_DEFAULTS, key),
    );
    const contextChange = ["basis", "end", "asOf"].some(
      (key) => Object.hasOwn(next, key) && next[key] !== settings[key],
    );
    if (dirty && !fromEditor && (assumptionChange || contextChange)) {
      setMessage(
        "Apply or discard your assumption edits in Model & results before loading another case, preset, cell or target.",
      );
      return false;
    }
    if (assumptionChange) {
      const checked = validateScenarioDrafts(
        Object.fromEntries(
          Object.entries(next).filter(([key]) =>
            Object.hasOwn(SCENARIO_DEFAULTS, key),
          ),
        ),
      );
      if (!checked.valid) {
        setMessage(Object.values(checked.errors).join(" "));
        return false;
      }
      if (!scenarioAssumptionsEqual(settings, { ...settings, ...next })) {
        setPast((old) =>
          [...old, normalizeScenarioSettings(settings)].slice(-20),
        );
        setFuture([]);
      }
    }
    onPatch(next);
    if (fromEditor) setDrafts({});
    setMessage(
      assumptionChange
        ? "Assumptions applied. Results and source calculations are updated."
        : "",
    );
    return true;
  }
  function applyDrafts() {
    if (!validation.valid) {
      setMessage(
        "Review the highlighted assumptions. No edits have been applied.",
      );
      return;
    }
    commit(validation.values, true);
  }
  function travel(direction: "undo" | "redo") {
    if (dirty) {
      setMessage(
        "Apply or discard your assumption edits before using undo or redo.",
      );
      return;
    }
    const stack = direction === "undo" ? past : future;
    if (!stack.length) return;
    if (direction === "undo") {
      setPast(stack.slice(0, -1));
      setFuture((old) => [...old, normalizeScenarioSettings(settings)]);
    } else {
      setFuture(stack.slice(0, -1));
      setPast((old) => [...old, normalizeScenarioSettings(settings)]);
    }
    onPatch(stack[stack.length - 1]);
    setMessage(
      direction === "undo"
        ? "Previous assumptions restored."
        : "Assumption change restored.",
    );
  }
  const inspect = (selection: any) =>
    onInspect({
      ...selection,
      analysisSettings: Object.hasOwn(selection, "analysisSettings")
        ? selection.analysisSettings
        : {
            ...settings,
            end: selection.point?.period?.end || scenario.period?.end,
            basis: selection.point?.period?.kind || settings.basis,
            view: "scenarios",
          },
    });
  const value = (amount: any, format = "currency") =>
    analysisValue(amount, format, settings.units);
  const operating = scenario.operating?.rows.find(
    (row: any) => row.key === "OperatingIncome",
  );
  const equity = scenario.balance.rows.find(
    (row: any) => row.key === "EquityAssets",
  );
  const sections: any = {
    model: (
      <>
        <AnalysisScenarioContext
          data={data}
          settings={settings}
          index={index}
          scenario={scenario}
          onPatch={commit}
          onInspect={inspect}
        />
        <AnalysisScenarioLab
          settings={settings}
          scenario={scenario}
          drafts={drafts}
          errors={validation.errors}
          onDraft={(key: string, raw: string) => {
            setDrafts((old) => ({ ...old, [key]: raw }));
            setMessage("");
          }}
          onApply={applyDrafts}
          onDiscard={() => {
            setDrafts({});
            setMessage(
              "Draft edits discarded. Applied assumptions are unchanged.",
            );
          }}
          onInspect={inspect}
        />
      </>
    ),
    sensitivity: (
      <AnalysisScenarioSensitivity
        data={data}
        settings={settings}
        index={index}
        scenario={scenario}
        onPatch={commit}
        onInspect={inspect}
      />
    ),
    targets: (
      <AnalysisGoalSeek
        data={data}
        settings={settings}
        index={index}
        onInspect={inspect}
        onPatch={commit}
        onApply={(next: any) => commit({ ...next, scenarioTab: "model" })}
      />
    ),
    cases: (
      <AnalysisScenarioCases
        data={data}
        settings={settings}
        index={index}
        scenario={scenario}
        cases={cases}
        onSaveCases={ready ? onSaveCases : () => false}
        onPatch={commit}
        onInspect={inspect}
        draftsPending={dirty}
      />
    ),
  };
  return (
    <section
      className={styles.workbench}
      aria-labelledby="scenario-workbench-heading"
    >
      <header className={styles.hero}>
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              <FlaskConical size={14} aria-hidden="true" /> Scenario workbench ·{" "}
              {data.ticker}
            </p>
            <h2 id="scenario-workbench-heading">
              Understand what has to change.
            </h2>
            <p className={styles.muted}>
              Start with reported SEC figures. Test explicit assumptions,
              explain the effects, and keep the evidence with your case.
            </p>
          </div>
          <span className={styles.badge}>
            Hypothetical · {scenario.period?.label || scenario.period?.end}
          </span>
        </div>
        <div className={styles.summary}>
          {scenario.operating && (
            <div>
              <span>Hypothetical operating income</span>
              <strong>{value(operating?.selection.point.value)}</strong>
              <small>
                {scenario.operating.reason ||
                  `Change: ${value(scenario.operating.delta)} · ${scenario.settings.scenarioModel} model`}
              </small>
            </div>
          )}
          <div>
            <span>Hypothetical equity / assets</span>
            <strong>{value(equity?.selection.point.value, "percent")}</strong>
            <small>
              {scenario.balance.reason || "Independent static balance exercise"}
            </small>
          </div>
          {scenario.banking ? (
            <div>
              <span>Unfunded withdrawals</span>
              <strong>
                {scenario.balance.funding?.available
                  ? value(scenario.balance.fundingGap)
                  : "Unavailable"}
              </strong>
              <small>
                Uses your cash availability and borrowing assumptions
              </small>
            </div>
          ) : (
            <div>
              <span>
                {scenario.corporate
                  ? "Applied revenue assumption"
                  : "Applied asset loss assumption"}
              </span>
              <strong>
                {value(
                  scenario.corporate
                    ? scenario.settings.scenarioRevenue
                    : scenario.settings.scenarioLoss,
                  "percent",
                )}
              </strong>
              <small>
                {!scenario.corporate
                  ? "Share of reported baseline assets"
                  : scenario.settings.scenarioModel === "cost"
                    ? `${scenario.settings.scenarioVariableCost}% variable cost share · ${scenario.settings.scenarioCostChange}% cost change`
                    : `${scenario.settings.scenarioMargin} pp operating margin change`}
              </small>
            </div>
          )}
        </div>
        <div className={styles.navigation} aria-label="Scenario sections">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => {
                setVisited((old) => (old.includes(key) ? old : [...old, key]));
                onPatch({ scenarioTab: key });
              }}
            >
              {label}
              {key === "model" && dirty ? " · edits" : ""}
            </button>
          ))}
        </div>
        <div className={styles.toolbar}>
          <button
            type="button"
            disabled={!past.length || dirty}
            onClick={() => travel("undo")}
          >
            <Undo2 size={14} aria-hidden="true" />
            Undo
          </button>
          <button
            type="button"
            disabled={!future.length || dirty}
            onClick={() => travel("redo")}
          >
            <Redo2 size={14} aria-hidden="true" />
            Redo
          </button>
          <button
            type="button"
            onClick={() => {
              commit(SCENARIO_DEFAULTS, true);
              setMessage(
                "All scenario assumptions reset to the reported baseline.",
              );
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Reset all assumptions
          </button>
          <span>
            Saved cases: {Array.isArray(cases) ? cases.length : 0}/8 · stored in
            this browser
          </span>
        </div>
      </header>
      {dirty && (
        <p className={styles.notice}>
          Unapplied assumption edits are waiting in Model & results.
          Calculations and shared URLs still use your committed assumptions.
        </p>
      )}
      {message && (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}
      {tabs.map(
        ([key]) =>
          (visited.includes(key) || tab === key) && (
            <div key={key} hidden={tab !== key} className={styles.panel}>
              {sections[key]}
            </div>
          ),
      )}
    </section>
  );
}
