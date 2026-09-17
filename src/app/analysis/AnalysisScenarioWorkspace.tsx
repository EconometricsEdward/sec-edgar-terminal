"use client";
import { useMemo, useState, useEffect, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
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
import { buildScenarioCalibration } from "../../utils/analysisScenarioCalibration.js";
import AnalysisScenarioContext from "./AnalysisScenarioContext";
import AnalysisScenarioLab from "./AnalysisScenarioLab";
const AnalysisScenarioSensitivity = dynamic(() => import("./AnalysisScenarioSensitivity"));
const AnalysisGoalSeek = dynamic(() => import("./AnalysisGoalSeek"));
const AnalysisScenarioBaselineReview = dynamic(() => import("./AnalysisScenarioBaselineReview"));
import styles from "./AnalysisScenarioWorkspace.module.css";

const tabs = [
  ["model", "Model & results"],
  ["sensitivity", "Drivers & sensitivity"],
  ["targets", "Solve a target"],
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
  cftcEnabled = false,
  marketContext,
  onClearMarketContext,
}: any) {
  const assumptionKey = JSON.stringify(normalizeScenarioSettings(settings));
  const scenario = useMemo(
    () => buildAnalysisScenario(data, JSON.parse(assumptionKey), index),
    [data, assumptionKey, index],
  );
  const calibration = useMemo(
    () => buildScenarioCalibration(data, { basis: settings.basis, asOf: settings.asOf }, index),
    [data, index, settings.basis, settings.asOf],
  );
  const [reviewOpen, setReviewOpen] = useState(Boolean(settings.scenarioCase));
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
      "Reported baseline changed. Applied assumptions now use this period; assumption edit history was cleared. Retained baseline snapshots are preserved.",
    );
  }, [context]);
  const tab = tabs.some(([key]) => key === settings.scenarioTab) ? settings.scenarioTab : "model";
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
  const marketPath = marketContext
    ? marketContext.marketPath || `/market?${new URLSearchParams({
        tab: "positioning",
        family: marketContext.family,
        contract: marketContext.contract,
        date: marketContext.reportDate,
      })}`
    : "";
  const sections: any = {
    model: (
      <>
        <AnalysisScenarioLab
          settings={settings}
          scenario={scenario}
          calibration={calibration}
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
        <AnalysisScenarioContext
          data={data}
          settings={settings}
          index={index}
          scenario={scenario}
          onPatch={commit}
          onInspect={inspect}
        />
        <details className={styles.baselineReview} open={reviewOpen}
          onToggle={(event) => setReviewOpen(event.currentTarget.open)}>
          <summary>Compare new filings <span>Keep the original. Separate data changes from assumption changes.</span></summary>
          {reviewOpen && <AnalysisScenarioBaselineReview
            data={data} settings={settings} index={index} scenario={scenario}
            cases={cases} onSaveCases={onSaveCases} onPatch={commit}
            onInspect={inspect} draftsPending={dirty} ready={ready}
          />}
        </details>
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
              Change the assumptions. Follow the effects.
            </h2>
            <p className={styles.muted}>
              Explore how operating performance, cash and financial strength respond to your assumptions.
            </p>
          </div>
          <span className={styles.badge}>
            Hypothetical · {scenario.period?.label || scenario.period?.end}
          </span>
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
          <Link href="/analysis/scenarios" prefetch={false} className={styles.guide}>How these models work ↗</Link>
        </div>
      </header>
      {cftcEnabled && (
        <details className={styles.marketContext}>
          <summary>{marketContext ? `${marketContext.label} · CFTC context · ${marketContext.reportDate}` : "Optional market context"}<span>SEC connections & CFTC positioning</span></summary>
          <div className={styles.marketBody}>
          <div className={styles.heading}>
            <div>
              <p className={styles.eyebrow}>Research behind your assumptions</p>
              <h3 id="scenario-market-context-heading">
                {marketContext ? `${marketContext.label} · CFTC context` : "Add market context to your scenario"}
              </h3>
            </div>
            {marketContext && (
              <span className={styles.badge}>Positions as of {marketContext.reportDate}</span>
            )}
          </div>
          <p className={styles.muted}>
            {marketContext
              ? "A dated market observation is attached to this workbench. Inspect its source snapshot and decide how it relates to the assumptions you want to test."
              : "Review positioning in the commodity, currency, or rate markets relevant to this company, then bring a dated observation back to this workbench."}
          </p>
          {marketContext && (
            <details className={styles.marketEvidence}>
              <summary>Inspect attached observation and filing sources</summary>
              <p>{marketContext.summary}</p>
            </details>
          )}
          <p className={styles.muted}>
            CFTC positioning is market-wide research context. Choose your own
            revenue, margin, funding, or asset-loss assumptions below; a
            positioning change does not determine a price or earnings shock.
          </p>
          {marketContext && (
            <p className={styles.muted}>
              This observation is attached for this session
              {marketContext.asOf ? ` with SEC filings through ${marketContext.asOf}` : ""}.
              {marketContext.asOf && marketContext.reportDate > marketContext.asOf
                ? " The CFTC observation postdates that SEC cutoff and is current market context."
                : ""}
            </p>
          )}
          <div className={styles.marketActions}>
            <button type="button" onClick={() => onPatch({ view: "cftc" })}>
              {marketContext ? "Review CFTC context" : "Explore CFTC context"}
            </button>
            {marketContext && (
              <>
                <Link href={marketPath} prefetch={false}>
                  Open contract history
                </Link>
                <button type="button" onClick={onClearMarketContext}>
                  Clear context
                </button>
              </>
            )}
          </div>
          </div>
        </details>
      )}
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
