import { analysisBaseline, analysisChange } from "./analysisResearch.js";
import { labCalculatedPoint, labInput } from "./analysisFormula.js";
import {
  analysisSourceCoherence,
  uniqueAnalysisSources,
} from "./analysisSources.js";

export const RULE_MODES = {
  above: "Value above",
  below: "Value below",
  changeAbove: "Change above",
  changeBelow: "Change below",
};
export const RULE_BASES = {
  annual: "Annual",
  quarter: "Standalone quarter",
  ytd: "Year to date",
  ttm: "Trailing twelve months",
};
export function validateAnalysisRules(rules) {
  if (!Array.isArray(rules) || rules.length > 20)
    throw new Error("Save at most 20 financial thresholds per company.");
  const ids = new Set();
  for (const r of rules) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.id !== "string" ||
      !r.id ||
      r.id.length > 100 ||
      ids.has(r.id) ||
      typeof r.label !== "string" ||
      !r.label.trim() ||
      r.label.length > 160 ||
      !/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(r.metric || "") ||
      !Object.hasOwn(RULE_BASES, r.basis) ||
      !Object.hasOwn(RULE_MODES, r.mode) ||
      !["year", "previous"].includes(r.baseline) ||
      !["currency", "shares", "eps", "percent", "decimal", "days"].includes(
        r.format,
      ) ||
      !Number.isFinite(r.threshold) ||
      typeof r.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(r.updatedAt))
    )
      throw new Error("A saved financial threshold is invalid.");
    ids.add(r.id);
  }
  return rules;
}

function inputReason(data, key, index, asOf) {
  const point = data.metrics?.[key]?.[index];
  const period = data.periods?.[index];
  if (!Number.isFinite(point?.value))
    return (
      point?.reason || "A required figure is unavailable; missing is not zero."
    );
  if (
    !period ||
    point.period?.end !== period.end ||
    point.period?.kind !== period.kind ||
    point.period?.start !== period.start
  )
    return "The figure does not share the selected reporting period.";
  const sources = uniqueAnalysisSources(point);
  const coherence = analysisSourceCoherence(point, asOf);
  if (
    !sources.length ||
    coherence.incomplete ||
    coherence.conflictingDates ||
    coherence.afterCutoff
  )
    return "Complete, consistent filing evidence within the selected cutoff is required.";
  if (
    sources.some(
      (s) =>
        !s.end || !Number.isFinite(Date.parse(s.end)) || s.end > period.end,
    )
  )
    return "A source reporting date is invalid or falls after the selected period.";
  if (
    !(point.classification === "calculated" && point.formula) &&
    sources.some(
      (source) =>
        source.start &&
        (!period.start ||
          !Number.isFinite(Date.parse(source.start)) ||
          Math.abs(Date.parse(source.start) - Date.parse(period.start)) >
            14 * 86400000 ||
          Math.abs(Date.parse(source.end) - Date.parse(period.end)) >
            14 * 86400000),
    )
  )
    return "The reported source duration does not match the selected reporting duration.";
  const definition = data.definitions.find((d) => d.key === key);
  if (definition?.format === "currency")
    return labInput(data, key, index).reason;
  return analysisChange(point, point, definition?.format).delta == null
    ? "The source reporting durations are invalid."
    : null;
}

export function evaluateAnalysisRule(data, settings, index, rule) {
  const definition = data.definitions?.find((d) => d.key === rule.metric);
  const point = data.metrics?.[rule.metric]?.[index];
  const period = data.periods?.[index];
  const changes = rule.mode.startsWith("change");
  const format =
    changes && rule.format === "percent" ? "percentagePoints" : rule.format;
  const base = {
    rule,
    definition,
    point,
    period,
    asOf: settings.asOf || "",
    format,
    threshold: rule.threshold,
    measuredValue: null,
    status: "unavailable",
    reason: "",
  };
  let reason =
    rule.basis !== settings.basis
      ? `Switch to ${RULE_BASES[rule.basis]} to evaluate this saved threshold.`
      : !definition || definition.format !== rule.format
        ? "This metric or its units are unavailable in the current industry lens."
        : inputReason(data, rule.metric, index, settings.asOf);
  if (reason) return { ...base, reason };
  let measuredValue = point.value,
    measuredPoint = point,
    beforePoint = null;
  if (changes) {
    const beforeIndex = analysisBaseline(data.periods, index, rule.baseline);
    if (beforeIndex < 0)
      return {
        ...base,
        reason:
          "A compatible comparison period is unavailable. Year-to-date checks require the same fiscal season.",
      };
    beforePoint = data.metrics[rule.metric]?.[beforeIndex];
    reason = inputReason(data, rule.metric, beforeIndex, settings.asOf);
    const change = analysisChange(point, beforePoint, rule.format);
    if (reason || change.delta == null)
      return { ...base, beforePoint, reason: reason || change.reason };
    measuredValue = change.delta;
    measuredPoint = labCalculatedPoint(
      period,
      [point, beforePoint],
      measuredValue,
      `${definition.label} (${period.end}) − ${definition.label} (${beforePoint.period.end})`,
      "Absolute change, not percentage growth. Percentage-valued metrics change in percentage points.",
    );
  }
  const matched = ["above", "changeAbove"].includes(rule.mode)
    ? measuredValue > rule.threshold
    : measuredValue < rule.threshold;
  return {
    ...base,
    beforePoint,
    measuredValue,
    status: matched ? "matched" : "clear",
    reason: "",
    selection: {
      definition: {
        ...definition,
        key: `threshold:${rule.metric}`,
        label: `${rule.label}: ${changes ? "change in " : ""}${definition.label}`,
        format,
      },
      point: measuredPoint,
      analysisSettings: { ...settings, end: period.end },
      notes: `Personal research threshold: ${RULE_MODES[rule.mode]} ${rule.threshold} (${format}); ${RULE_BASES[rule.basis]}; ${rule.baseline} comparison. ${matched ? "Condition met" : "Condition not met"}. This is an analyst-defined check, not a risk rating or covenant test.`,
    },
  };
}
export function evaluateAnalysisRules(data, settings, index, rules = []) {
  return rules.map((rule) => evaluateAnalysisRule(data, settings, index, rule));
}
