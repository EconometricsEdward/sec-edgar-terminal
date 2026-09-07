import {
  SCENARIO_LIMITS,
  normalizeScenarioSettings,
} from "./analysisScenarios.js";

export const SCENARIO_FIELDS = {
  scenarioRevenue: { label: "Revenue change", unit: "%" },
  scenarioMargin: { label: "Operating margin change", unit: "pp" },
  scenarioLoss: { label: "Incremental loss / baseline assets", unit: "%" },
  scenarioFunding: { label: "Deposit withdrawal", unit: "%" },
  scenarioVariableCost: {
    label: "Variable share of baseline costs",
    unit: "%",
  },
  scenarioCostChange: { label: "Cost change after volume", unit: "%" },
  scenarioCashAvailable: {
    label: "Reported cash available for withdrawals",
    unit: "%",
  },
  scenarioReplacementFunding: {
    label: "Replacement borrowing / baseline deposits",
    unit: "%",
  },
};

// Drafts are deliberately separate from committed assumptions. Blank, partial,
// nonfinite and out-of-range edits never silently turn into a different value.
export function validateScenarioDrafts(drafts = {}) {
  const values = {},
    errors = {};
  for (const [key, raw] of Object.entries(drafts)) {
    if (key === "scenarioModel") {
      if (["margin", "cost"].includes(raw)) values[key] = raw;
      else errors[key] = "Choose a supported operating model.";
      continue;
    }
    if (!Object.hasOwn(SCENARIO_LIMITS, key)) continue;
    const text = String(raw).trim();
    const value = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
      ? Number(text)
      : NaN;
    const [min, max] = SCENARIO_LIMITS[key];
    if (!Number.isFinite(value))
      errors[key] =
        `Enter a complete number for ${SCENARIO_FIELDS[key].label.toLowerCase()}.`;
    else if (value < min || value > max)
      errors[key] =
        `Use ${min} to ${max} ${SCENARIO_FIELDS[key].unit}. Your entry has not been changed.`;
    else values[key] = value;
  }
  return { values, errors, valid: Object.keys(errors).length === 0 };
}

export function scenarioAssumptionsEqual(a, b) {
  return (
    JSON.stringify(normalizeScenarioSettings(a)) ===
    JSON.stringify(normalizeScenarioSettings(b))
  );
}
