import { normalizeScenarioSettings } from "./analysisScenarios.js";
import { normalizeAnalysisSettings } from "./analysisNotebook.js";
import {
  goalSeekInput,
  solveAssetLossGoal,
  solveOperatingGoal,
} from "./analysisGoalSeek.js";

export const SCENARIO_CASE_LIMIT = 8;
export const SCENARIO_CASE_VERSION = 1;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const requireValid = (ok, message) => {
  if (!ok) throw new Error(message);
};
const copy = (v) => JSON.parse(JSON.stringify(v));
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const timestamp = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(v) &&
  Number.isFinite(Date.parse(v));
const boundedText = (v, max) => typeof v === "string" && v.length <= max;

/** Stable serialization makes comparisons independent of property insertion order. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Store full, immutable evidence; restoring assumptions never overwrites these inputs. */
export function createScenarioCase({
  data,
  settings,
  index,
  scenario,
  name,
  notes = "",
  id = "",
  now = new Date().toISOString(),
}) {
  const period = data.periods?.[index] || scenario.period;
  const entry = copy({
    version: SCENARIO_CASE_VERSION,
    id:
      id ||
      `scenario_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
    name: String(name || "").trim(),
    notes: String(notes),
    createdAt: now,
    updatedAt: now,
    context: {
      ticker: data.ticker,
      name: data.name || data.ticker,
      cik: String(data.cik || ""),
      lens: data.lens || "",
      basis: data.basis || period?.kind || settings.basis,
      asOf: data.asOf ?? settings.asOf ?? "",
      period,
      dataVersion: String(data.version || ""),
      observedAt: data.observedAt || "",
    },
    settings: normalizeAnalysisSettings({
      ...settings,
      ...scenario.settings,
      basis: data.basis || period?.kind || settings.basis,
      end: period?.end,
      asOf: data.asOf ?? settings.asOf ?? "",
      view: "scenarios",
    }),
    snapshot: scenario,
  });
  const goalInput = goalSeekInput(data, index, entry.settings);
  entry.goalSnapshots = [];
  if (entry.settings.goalOperatingSolved) {
    const goal = solveOperatingGoal(data, goalInput, index, "raw");
    entry.goalSnapshots.push(
      copy({
        kind: "operating",
        label: "Operating-income target",
        reason: goal.reason,
        rows: goal.selection ? [goal.selection] : [],
      }),
    );
  }
  if (entry.settings.goalAssetSolved) {
    const goal = solveAssetLossGoal(data, goalInput, index);
    entry.goalSnapshots.push(
      copy({
        kind: "assetLoss",
        label: "Asset-loss boundary",
        reason: goal.reason,
        rows: goal.rows || [],
      }),
    );
  }
  validateScenarioCase(entry);
  return entry;
}

function validatePoint(point, validateEvidencePoint) {
  requireValid(
    object(point),
    "Scenario evidence is missing its financial point.",
  );
  requireValid(
    point.value === null ||
      (typeof point.value === "number" && Number.isFinite(point.value)),
    "Scenario evidence contains an invalid value.",
  );
  requireValid(
    object(point.period) && date(point.period.end),
    "Scenario evidence has an invalid reporting period.",
  );
  for (const key of ["formula", "note", "reason", "classification"])
    requireValid(
      point[key] == null || boundedText(point[key], 40000),
      `Scenario evidence ${key} is invalid.`,
    );
  for (const key of ["sources", "calculations"]) {
    requireValid(
      point[key] === undefined ||
        (Array.isArray(point[key]) && point[key].length <= 1000),
      `Scenario evidence ${key} must be a bounded list.`,
    );
    for (const source of point[key] || []) {
      requireValid(object(source), "A scenario source is invalid.");
      requireValid(
        source.value == null ||
          (typeof source.value === "number" && Number.isFinite(source.value)),
        "A scenario source value is invalid.",
      );
    }
  }
  if (validateEvidencePoint) validateEvidencePoint(point);
}

export function validateScenarioCase(entry, validateEvidencePoint) {
  requireValid(
    object(entry) && entry.version === SCENARIO_CASE_VERSION,
    "This scenario case format is not supported.",
  );
  requireValid(
    typeof entry.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(entry.id),
    "Scenario case identity is invalid.",
  );
  requireValid(
    boundedText(entry.name, 120) && entry.name.trim().length > 0,
    "Give the scenario a name of up to 120 characters.",
  );
  requireValid(
    boundedText(entry.notes, 8000),
    "Scenario notes support up to 8,000 characters.",
  );
  requireValid(
    timestamp(entry.createdAt) && timestamp(entry.updatedAt),
    "Scenario save dates are invalid.",
  );
  const context = entry.context;
  requireValid(
    object(context) && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(context.ticker || ""),
    "Scenario company is invalid.",
  );
  requireValid(
    ["annual", "quarter", "ytd", "ttm"].includes(context.basis),
    "Scenario reporting basis is invalid.",
  );
  requireValid(
    object(context.period) &&
      date(context.period.end) &&
      (context.period.start == null || date(context.period.start)),
    "Scenario cases need a resolved reporting period.",
  );
  requireValid(
    context.asOf === "" || date(context.asOf),
    "Scenario filing cutoff is invalid.",
  );
  for (const key of ["name", "cik", "lens", "dataVersion", "observedAt"])
    requireValid(
      boundedText(context[key], 1000),
      `Scenario context ${key} is invalid.`,
    );
  requireValid(
    context.observedAt === "" || timestamp(context.observedAt),
    "Scenario observation date is invalid.",
  );
  requireValid(
    object(entry.settings) &&
      stable(entry.settings) ===
        stable(normalizeAnalysisSettings(entry.settings)),
    "Scenario settings are invalid or outside supported bounds.",
  );
  requireValid(
    entry.settings.basis === context.basis &&
      entry.settings.end === context.period.end &&
      entry.settings.asOf === context.asOf,
    "Scenario settings do not match the saved reporting context.",
  );
  requireValid(
    object(entry.snapshot) && object(entry.snapshot.balance),
    "Scenario result snapshot is invalid.",
  );
  requireValid(
    stable(entry.snapshot.settings) ===
      stable(normalizeScenarioSettings(entry.settings)),
    "Scenario result assumptions do not match the saved assumptions.",
  );
  requireValid(
    stable(entry.snapshot.period) === stable(context.period),
    "Scenario result period does not match the saved period.",
  );
  for (const section of [
    entry.snapshot.operating,
    entry.snapshot.balance,
  ].filter(Boolean)) {
    requireValid(
      object(section) &&
        Array.isArray(section.inputs) &&
        section.inputs.length <= 20 &&
        Array.isArray(section.rows) &&
        section.rows.length <= 30,
      "Scenario exercises require bounded inputs and results.",
    );
    requireValid(
      section.reason == null || boundedText(section.reason, 40000),
      "Scenario status is invalid.",
    );
    for (const input of section.inputs) {
      requireValid(
        object(input) && boundedText(input.key, 100),
        "Scenario baseline input is invalid.",
      );
      if (input.point) validatePoint(input.point, validateEvidencePoint);
    }
    if (section.bridge !== undefined)
      requireValid(
        Array.isArray(section.bridge) && section.bridge.length <= 20,
        "Scenario bridge is invalid.",
      );
    for (const row of [...section.rows, ...(section.bridge || [])]) {
      requireValid(
        object(row) &&
          boundedText(row.key, 100) &&
          boundedText(row.label, 200) &&
          boundedText(row.format, 50),
        "Scenario result metadata is invalid.",
      );
      requireValid(
        row.baseline == null ||
          (typeof row.baseline === "number" && Number.isFinite(row.baseline)),
        "Scenario result baseline is invalid.",
      );
      requireValid(
        object(row.selection) && object(row.selection.definition),
        "Scenario result selection is invalid.",
      );
      requireValid(
        boundedText(row.selection.definition.label, 200) &&
          boundedText(row.selection.definition.format, 50),
        "Scenario result definition is invalid.",
      );
      validatePoint(row.selection.point, validateEvidencePoint);
    }
  }
  if (entry.goalSnapshots !== undefined) {
    requireValid(
      Array.isArray(entry.goalSnapshots) && entry.goalSnapshots.length <= 2,
      "Saved goal results are invalid.",
    );
    for (const goal of entry.goalSnapshots) {
      requireValid(
        object(goal) &&
          ["operating", "assetLoss"].includes(goal.kind) &&
          boundedText(goal.label, 200) &&
          (goal.reason == null || boundedText(goal.reason, 40000)) &&
          Array.isArray(goal.rows) &&
          goal.rows.length <= 10,
        "Saved goal metadata is invalid.",
      );
      for (const selection of goal.rows) {
        requireValid(
          object(selection) &&
            object(selection.definition) &&
            boundedText(selection.definition.label, 200) &&
            boundedText(selection.definition.format, 50),
          "Saved goal selection is invalid.",
        );
        validatePoint(selection.point, validateEvidencePoint);
      }
    }
  }
  return entry;
}

export function validateScenarioCases(cases, validateEvidencePoint) {
  requireValid(
    Array.isArray(cases) && cases.length <= SCENARIO_CASE_LIMIT,
    "A company supports up to eight saved scenario cases.",
  );
  const ids = new Set();
  for (const entry of cases) {
    validateScenarioCase(entry, validateEvidencePoint);
    requireValid(
      !ids.has(entry.id),
      "Scenario case identities must be unique.",
    );
    ids.add(entry.id);
  }
  return cases;
}

export const scenarioCaseRevision = (entry) => (entry ? stable(entry) : "");

/** Mutations run against fresh storage and reject conflicts without dropping drafts. */
export function updateScenarioCases(cases, action) {
  try {
    validateScenarioCases(cases);
  } catch (error) {
    return { ok: false, cases, reason: error.message };
  }
  const current = cases.find((entry) => entry.id === action.id);
  if (!["add", "update", "remove"].includes(action.type))
    return { ok: false, cases, reason: "Unknown scenario action." };
  if (
    action.type !== "add" &&
    (!current || scenarioCaseRevision(current) !== action.expectedRevision)
  )
    return {
      ok: false,
      cases,
      reason:
        "This case changed in another tab. Your draft is kept. Load the saved version before editing again.",
    };
  if (action.type === "remove")
    return {
      ok: true,
      cases: cases.filter((entry) => entry.id !== action.id),
      reason: "Scenario case removed.",
    };
  if (action.type === "add" && (current || cases.length >= SCENARIO_CASE_LIMIT))
    return {
      ok: false,
      cases,
      reason: current
        ? "This case is already saved."
        : "Eight cases are already saved. Remove a case before adding another; existing cases are kept.",
    };
  try {
    validateScenarioCase(action.entry);
    requireValid(
      action.entry.id === action.id,
      "Scenario case identity does not match.",
    );
    if (current) {
      requireValid(
        stable(action.entry.context) === stable(current.context) &&
          stable(action.entry.settings) === stable(current.settings) &&
          stable(action.entry.snapshot) === stable(current.snapshot) &&
          stable(action.entry.goalSnapshots) ===
            stable(current.goalSnapshots) &&
          action.entry.createdAt === current.createdAt,
        "Saved scenario evidence is immutable. Save current results as a new case.",
      );
    }
  } catch (error) {
    return { ok: false, cases, reason: error.message };
  }
  return {
    ok: true,
    cases:
      action.type === "add"
        ? [...cases, copy(action.entry)]
        : cases.map((entry) =>
            entry.id === action.id ? copy(action.entry) : entry,
          ),
    reason: "Scenario case saved.",
  };
}

function inputSignature(entry) {
  return stable(
    [entry.snapshot.operating, entry.snapshot.balance]
      .filter(Boolean)
      .map((section) =>
        section.inputs
          .map((input) => ({
            key: input.key,
            basis: input.basis || "",
            reason: input.reason || "",
            point: input.point || null,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      ),
  );
}

export function scenarioCaseCompatibility(reference, candidate) {
  const a = reference.context,
    b = candidate.context;
  if (a.ticker !== b.ticker || a.lens !== b.lens)
    return {
      compatible: false,
      status: "Different company or accounting lens",
    };
  if (
    a.basis !== b.basis ||
    a.period.kind !== b.period.kind ||
    a.period.start !== b.period.start ||
    a.period.end !== b.period.end
  )
    return { compatible: false, status: "Different reporting period or basis" };
  if (a.asOf !== b.asOf)
    return { compatible: false, status: "Different filing cutoff" };
  if (a.dataVersion !== b.dataVersion)
    return { compatible: false, status: "Different financial data version" };
  if (inputSignature(reference) !== inputSignature(candidate))
    return {
      compatible: false,
      status: "Different reported baseline or source inputs",
    };
  return { compatible: true, status: "Matching reported baseline and sources" };
}

export function scenarioCaseSelection(entry, selection) {
  return {
    ...copy(selection),
    analysisSettings: {
      ...copy(entry.settings),
      view: "scenarios",
      basis: entry.context.basis,
      end: entry.context.period.end,
      asOf: entry.context.asOf,
    },
  };
}

export function scenarioCaseRestoreSettings(entry) {
  return {
    ...entry.settings,
    basis: entry.context.basis,
    end: entry.context.period.end,
    asOf: entry.context.asOf,
    view: "scenarios",
    scenarioCase: entry.id,
    scenarioTab: "cases",
  };
}

export function scenarioCaseRows(entry) {
  return [
    ...(entry.snapshot.operating?.rows || []).map((row) => ({
      ...row,
      exercise: "Operating sensitivity",
      comparisonKey: `operating:${row.key}`,
    })),
    ...(entry.snapshot.balance?.rows || []).map((row) => ({
      ...row,
      exercise: "Balance sensitivity",
      comparisonKey: `balance:${row.key}`,
    })),
  ];
}
