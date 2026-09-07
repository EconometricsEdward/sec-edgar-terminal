import {
  analysisBaseline,
  analysisChange,
  calculateAnalysisPoint,
} from "./analysisResearch.js";
import { evidenceSources } from "./researchEvidence.js";
import { labInput } from "./analysisFormula.js";
import { analysisSourceCoherence } from "./analysisSources.js";

const finite = (point) => Number.isFinite(point?.value);
const pointAt = (data, key, index) => data.metrics[key]?.[index];
const validDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

function inputReason(data, key, index, asOf) {
  const input = labInput(data, key, index);
  if (input.reason) return input.reason;
  const sources = evidenceSources(input.point);
  if (
    input.basis !== "period flow" ||
    sources.some(
      (source) =>
        !source.taxonomy ||
        !source.tag ||
        !Number.isFinite(source.value) ||
        !validDate(source.start) ||
        !validDate(source.end) ||
        !validDate(source.filed),
    )
  )
    return "Every earnings input requires a reported USD flow with complete SEC concept, amount, reporting dates and filing metadata.";
  const coherence = analysisSourceCoherence(input.point, asOf);
  if (
    coherence.incomplete ||
    coherence.conflictingDates ||
    coherence.afterCutoff
  )
    return "Complete, consistent filing evidence within the selected cutoff is required for every earnings input.";
  return null;
}

// A directly reported flow uses its actual SEC dates. Derived quarters and
// trailing years have several raw input windows and use their output period.
function flowWindow(point) {
  const sources = evidenceSources(point).filter((source) => source.start);
  if (!sources.length) return point?.period;
  return sources.every(
    (source) =>
      source.start === sources[0].start && source.end === sources[0].end,
  )
    ? sources[0]
    : point.period;
}

function withinPeriodReason(points) {
  for (const point of points.slice(1)) {
    const check = analysisChange(point, points[0], "currency");
    if (check.delta == null) return check.reason;
    const window = flowWindow(point),
      anchor = flowWindow(points[0]);
    if (window?.start !== anchor?.start || window?.end !== anchor?.end)
      return "The earnings inputs do not cover the same actual reporting dates within a period. A reconciliation would combine different windows.";
  }
  return null;
}

const unavailable = (period, reason) => ({
  period,
  value: null,
  classification: "unavailable",
  sources: [],
  reason,
});

/** A reported-amount identity, not an inference about the cause of earnings. */
export function earningsChangeBridge(
  data,
  index,
  baseline = "year",
  asOf = data.asOf || "",
) {
  const period = data.periods[index];
  const beforeIndex = analysisBaseline(data.periods, index, baseline);
  const beforePeriod = data.periods[beforeIndex];
  const useOperating = data.lens === "corporate";
  const fail = (reason) => ({
    period,
    beforePeriod,
    beforeIndex,
    useOperating,
    reason,
    rows: [],
    components: [],
  });
  if (!period || beforeIndex < 0)
    return fail(
      "Choose a compatible comparison period to reconcile the change in earnings.",
    );
  if (
    (asOf && !validDate(asOf)) ||
    (typeof data.asOf === "string" && data.asOf !== asOf)
  )
    return fail(
      "The requested filing cutoff must be valid and match the loaded financial data.",
    );
  const keys = [
    ...(useOperating ? ["operatingIncome"] : []),
    "pretaxIncome",
    "incomeTax",
    "netIncome",
  ];
  const current = Object.fromEntries(
    keys.map((key) => [key, pointAt(data, key, index)]),
  );
  const previous = Object.fromEntries(
    keys.map((key) => [key, pointAt(data, key, beforeIndex)]),
  );
  for (const key of keys) {
    if (!finite(current[key]) || !finite(previous[key])) {
      const label =
        data.definitions.find((definition) => definition.key === key)?.label ||
        key;
      return fail(
        `${label} is unavailable in one or both periods. Every bridge input is required; missing amounts are never assumed to be zero.`,
      );
    }
    for (const periodIndex of [index, beforeIndex]) {
      const reason = inputReason(data, key, periodIndex, asOf);
      if (reason) return fail(reason);
    }
    const check = analysisChange(current[key], previous[key], "currency");
    if (check.delta == null) return fail(check.reason);
  }
  for (const inputs of [Object.values(current), Object.values(previous)]) {
    const reason = withinPeriodReason(inputs);
    if (reason) return fail(reason);
  }
  const coherence = analysisSourceCoherence(
    {
      sources: [...Object.values(current), ...Object.values(previous)].flatMap(
        evidenceSources,
      ),
    },
    asOf,
  );
  if (coherence.conflictingDates)
    return fail(
      "A source accession has inconsistent filing dates across earnings inputs. Review the filing metadata before reconciling these amounts.",
    );
  const derived = (p, inputs, formula, compute) =>
    calculateAnalysisPoint(p, inputs, formula, compute);
  for (const [values, p] of [
    [current, period],
    [previous, beforePeriod],
  ]) {
    if (useOperating)
      values.belowOperating = derived(
        p,
        [values.pretaxIncome, values.operatingIncome],
        "Pre-tax income − operating income",
        (pretax, operating) => pretax - operating,
      );
    values.scopeResidual = derived(
      p,
      [values.netIncome, values.pretaxIncome, values.incomeTax],
      "Net income − (pre-tax income − income tax expense)",
      (net, pretax, tax) => net - (pretax - tax),
    );
    values.effectiveTaxRate =
      values.pretaxIncome.value > 0
        ? derived(
            p,
            [values.incomeTax, values.pretaxIncome],
            "Income tax expense / positive pre-tax income × 100",
            (tax, pretax) => (tax / pretax) * 100,
          )
        : unavailable(
            p,
            "An effective tax rate is shown only when pre-tax income is positive. Tax benefits and reported losses remain visible in the amounts above.",
          );
  }
  const definitions = [
    ...(useOperating
      ? [
          {
            key: "operatingIncome",
            label: "Operating income",
            detail: "Reported operating result.",
          },
          {
            key: "belowOperating",
            label: "Below-operating difference",
            detail:
              "Pre-tax less operating income. An arithmetic remainder; inspect the filing to identify its components.",
          },
        ]
      : []),
    {
      key: "pretaxIncome",
      label: "Pre-tax income",
      detail:
        "The selected SEC pre-tax concept may have a different scope from net income.",
    },
    {
      key: "incomeTax",
      label: "Income tax expense / benefit",
      detail:
        "Positive amounts are expenses; a negative amount is a benefit. The bridge reverses the sign of the change in tax expense.",
    },
    {
      key: "scopeResidual",
      label: "Net-income scope residual",
      detail:
        "Net income less (pre-tax income less tax). It can include scope differences, noncontrolling interests, discontinued operations, or other items; this calculation does not identify a cause.",
    },
    {
      key: "netIncome",
      label: "Net income",
      detail:
        "The selected reported net-income concept, which may differ in scope from EPS earnings.",
    },
    {
      key: "effectiveTaxRate",
      label: "Effective tax rate",
      format: "percent",
      detail:
        "Reported tax expense / positive pre-tax income. This is a reported-period ratio, not a statutory or forward tax rate.",
    },
  ];
  const rows = definitions.map((definition) => ({
    ...definition,
    format: definition.format || "currency",
    current: current[definition.key],
    previous: previous[definition.key],
  }));
  const componentDefinitions = [
    ...(useOperating
      ? [
          { key: "operatingIncome", label: "Operating result change" },
          { key: "belowOperating", label: "Below-operating difference change" },
        ]
      : [{ key: "pretaxIncome", label: "Pre-tax result change" }]),
    { key: "incomeTax", label: "Tax expense / benefit contribution", sign: -1 },
    { key: "scopeResidual", label: "Net-income scope residual change" },
  ];
  const components = componentDefinitions.map(({ key, label, sign = 1 }) => ({
    key: `earningsBridge:${key}:change`,
    label,
    point: derived(
      period,
      [current[key], previous[key]],
      `${sign === -1 ? "−(" : ""}Current ${rows.find((row) => row.key === key).label.toLowerCase()} − prior ${rows.find((row) => row.key === key).label.toLowerCase()}${sign === -1 ? ")" : ""}`,
      (a, b) => sign * (a - b),
    ),
  }));
  const change = derived(
    period,
    [current.netIncome, previous.netIncome],
    "Current net income − prior net income",
    (a, b) => a - b,
  );
  return {
    period,
    beforePeriod,
    beforeIndex,
    useOperating,
    reason: null,
    rows,
    components,
    currentNet: current.netIncome,
    previousNet: previous.netIncome,
    change,
    roundingResidual:
      change.value -
      components.reduce((sum, component) => sum + component.point.value, 0),
  };
}
