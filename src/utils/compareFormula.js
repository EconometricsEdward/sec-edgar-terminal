import { COMPARE_METRICS, median } from "./compareResearch.js";
import { comparePointQuality } from "./compareQuality.js";
import { evidenceCalculations, evidenceSources } from "./researchEvidence.js";
import { daysBetween } from "./xbrlPeriods.js";

const BALANCES = new Set([
  "totalAssets",
  "stockholdersEquity",
  "cash",
  "deposits",
  "loans",
]);
export const COMPARE_FORMULA_INPUTS = COMPARE_METRICS.filter(
  (metric) => metric.format === "currency",
).map((metric) => ({
  ...metric,
  interval: BALANCES.has(metric.key) ? "balance" : "flow",
}));
const INPUT_BY_KEY = Object.assign(
  Object.create(null),
  Object.fromEntries(
    COMPARE_FORMULA_INPUTS.map((metric) => [metric.key, metric]),
  ),
);
export const DEFAULT_COMPARE_FORMULA = {
  formulaA: "cash",
  formulaB: "totalAssets",
  formulaC: "totalAssets",
  formulaOp: "divide",
  formulaScale: "percent",
  formulaLabel: "",
};
export const COMPARE_FORMULA_OPERATIONS = [
  { key: "divide", label: "A ÷ B", inputs: 2 },
  { key: "subtract", label: "A − B", inputs: 2 },
  { key: "differenceRatio", label: "(A − B) ÷ C", inputs: 3 },
  { key: "sumRatio", label: "(A + B) ÷ C", inputs: 3 },
];

/** Definitions contain only known operands and operations, never executable text. */
export function normalizeCompareFormula(input = {}) {
  const metric = (key) =>
    INPUT_BY_KEY[input[key]] ? input[key] : DEFAULT_COMPARE_FORMULA[key];
  return {
    formulaA: metric("formulaA"),
    formulaB: metric("formulaB"),
    formulaC: metric("formulaC"),
    formulaOp: COMPARE_FORMULA_OPERATIONS.some(
      (operation) => operation.key === input.formulaOp,
    )
      ? input.formulaOp
      : DEFAULT_COMPARE_FORMULA.formulaOp,
    formulaScale: input.formulaScale === "multiple" ? "multiple" : "percent",
    formulaLabel:
      typeof input.formulaLabel === "string"
        ? input.formulaLabel.trim().slice(0, 80)
        : "",
  };
}

export function compareFormulaOperands(settings = {}) {
  const definition = normalizeCompareFormula(settings);
  return [
    "formulaA",
    "formulaB",
    ...(["sumRatio", "differenceRatio"].includes(definition.formulaOp)
      ? ["formulaC"]
      : []),
  ].map((key, index) => ({
    slot: String.fromCharCode(65 + index),
    key: definition[key],
    metric: INPUT_BY_KEY[definition[key]],
  }));
}

export function validateCompareFormula(input = {}) {
  const supplied = { ...DEFAULT_COMPARE_FORMULA, ...input };
  const activeKeys = [
    "formulaA",
    "formulaB",
    ...(["sumRatio", "differenceRatio"].includes(supplied.formulaOp)
      ? ["formulaC"]
      : []),
  ];
  if (
    !COMPARE_FORMULA_OPERATIONS.some(
      (operation) => operation.key === supplied.formulaOp,
    )
  )
    return "Choose one of the supported arithmetic operations.";
  if (activeKeys.some((key) => !INPUT_BY_KEY[supplied[key]]))
    return "Use monetary inputs only. Existing percentages and multiples cannot be treated as USD amounts.";
  if (
    new Set(activeKeys.map((key) => INPUT_BY_KEY[supplied[key]].interval))
      .size > 1
  )
    return "Combine balance-sheet amounts with balances, or reporting-period flows with flows. Mixing income with an ending balance would require an explicit averaging and annualization policy.";
  return null;
}

export function compareFormulaMetric(input = {}) {
  const definition = normalizeCompareFormula(input);
  const a = INPUT_BY_KEY[definition.formulaA].label;
  const b = INPUT_BY_KEY[definition.formulaB].label;
  const c = INPUT_BY_KEY[definition.formulaC].label;
  const expression =
    definition.formulaOp === "subtract"
      ? `${a} − ${b}`
      : definition.formulaOp === "differenceRatio"
        ? `(${a} − ${b}) / ${c}`
        : definition.formulaOp === "sumRatio"
          ? `(${a} + ${b}) / ${c}`
          : `${a} / ${b}`;
  const ratio = definition.formulaOp !== "subtract";
  return {
    key: "customFormula",
    label: definition.formulaLabel || expression,
    category: "Custom calculation",
    format: ratio
      ? definition.formulaScale === "percent"
        ? "percent"
        : "decimal"
      : "currency",
    formula: `${expression}${ratio && definition.formulaScale === "percent" ? " × 100" : ""}`,
    formulaSettings: definition,
  };
}

/** Compute from the selected observations; raw and intermediate sources survive inspection and pinning. */
export function computeCompareFormula(entry, input = {}) {
  const settings = normalizeCompareFormula(input);
  const metric = compareFormulaMetric(settings);
  const inputs = compareFormulaOperands(settings).map((operand) => ({
    ...operand,
    point:
      entry?.index >= 0
        ? entry.data?.metrics?.[operand.key]?.[entry.index]
        : null,
  }));
  const unavailable = (reason) => ({
    value: null,
    classification: "unavailable",
    period: entry?.period || null,
    reason,
    formula: metric.formula,
    formulaSettings: settings,
    inputs,
    sources: evidenceSources({
      sources: inputs.flatMap(({ point }) => evidenceSources(point)),
    }),
    calculations: [],
  });
  const invalid = validateCompareFormula(input);
  if (invalid) return unavailable(invalid);
  if (entry?.loading)
    return unavailable("The issuer's SEC financial data is still loading.");
  if (entry?.error)
    return unavailable(
      "The issuer could not be fetched. Retry its SEC data before interpreting this calculation.",
    );
  if (!entry?.period || entry.index < 0)
    return unavailable(
      "No matching reporting period is selected for this issuer.",
    );
  if (input.basis && input.basis !== entry.period.kind)
    return unavailable(
      "The selected reporting basis does not match these observations.",
    );
  for (const operand of inputs) {
    if (!Number.isFinite(operand.point?.value))
      return unavailable(
        `${operand.slot} · ${operand.metric.label}: ${operand.point?.reason || "a required input is unavailable."}`,
      );
    const reported = evidenceSources(operand.point);
    if (!reported.length)
      return unavailable(
        `${operand.slot} · ${operand.metric.label}: original reported source evidence is missing.`,
      );
    if (
      reported.some(
        (source) =>
          !Number.isFinite(source.value) ||
          typeof source.tag !== "string" ||
          !source.tag.trim() ||
          typeof source.accession !== "string" ||
          !source.accession.trim(),
      )
    )
      return unavailable(
        `${operand.slot} · ${operand.metric.label}: a reported input is missing its value, XBRL concept, or filing accession.`,
      );
    const quality = comparePointQuality(
      operand.point,
      operand.key,
      entry.period,
    );
    if (!quality.valid)
      return unavailable(
        `${operand.slot} · ${operand.metric.label}: ${quality.reason}`,
      );
  }
  const [a, b, c] = inputs.map(({ point }) => point.value);
  const denominator = settings.formulaOp === "divide" ? b : c;
  if (settings.formulaOp !== "subtract" && !(denominator > 0))
    return unavailable(
      "The denominator must be positive. Zero or negative denominators are not converted into a ratio.",
    );
  const numerator =
    settings.formulaOp === "sumRatio"
      ? a + b
      : ["differenceRatio", "subtract"].includes(settings.formulaOp)
        ? a - b
        : a;
  const value =
    settings.formulaOp === "subtract"
      ? numerator
      : (numerator / denominator) *
        (settings.formulaScale === "percent" ? 100 : 1);
  if (!Number.isFinite(value))
    return unavailable(
      "The calculation is outside the supported numeric range.",
    );
  const sources = evidenceSources({
    sources: inputs.flatMap(({ point }) => evidenceSources(point)),
  });
  const calculations = inputs.flatMap(({ point, slot, metric: operand }) => [
    ...evidenceCalculations(point),
    {
      formula: `${slot} = ${operand.label}${point.formula ? `: ${point.formula}` : " (reported)"}`,
      value: point.value,
      start: point.period?.start,
      end: point.period?.end,
      unit: "USD",
    },
  ]);
  calculations.push({
    formula: metric.formula,
    value,
    start: entry.period.start,
    end: entry.period.end,
    unit:
      metric.format === "percent"
        ? "%"
        : metric.format === "decimal"
          ? "×"
          : "USD",
  });
  return {
    value,
    classification: "calculated",
    period: entry.period,
    formula: metric.formula,
    formulaSettings: settings,
    sources,
    calculations,
    inputs,
    note:
      inputs[0].metric.interval === "balance"
        ? "Uses reported balances at the selected reporting endpoint. No averaging or annualization is applied."
        : "Uses flows over the same selected reporting duration. No annualization is applied.",
    reason: null,
  };
}

export function compareFormulaResults(entries, settings = {}) {
  const seen = new Set();
  const cells = entries
    .filter((entry) => {
      const identity = entry.data?.cik || entry.ticker;
      if (entry.duplicate || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map((entry) => ({
      ticker: entry.ticker,
      cik: entry.data?.cik,
      name: entry.data?.name,
      period: entry.period,
      color: entry.color,
      point: computeCompareFormula(entry, settings),
      status: entry.error
        ? "fetch failed"
        : entry.loading
          ? "loading"
          : entry.period
            ? "reviewed"
            : "period unavailable",
    }));
  const available = cells.filter((cell) => Number.isFinite(cell.point.value));
  const ends = available.map((cell) => cell.period.end).sort();
  const duration = available
    .map(
      (cell) => comparePointQuality(cell.point, "customFormula").durationDays,
    )
    .filter(Number.isFinite);
  const kinds = new Set(available.map((cell) => cell.period.kind));
  const definitions = new Set(
    available.map((cell) =>
      cell.point.inputs
        .map(
          (operand) =>
            `${operand.slot}:${comparePointQuality(operand.point, operand.key).concepts.join("|")}`,
        )
        .join(";"),
    ),
  );
  const reason =
    available.length < 2
      ? "At least two issuers with complete inputs are required for a peer median."
      : kinds.size > 1 ||
          daysBetween(ends[0], ends.at(-1)) > 45 ||
          (duration.length > 1 &&
            Math.max(...duration) - Math.min(...duration) > 14)
        ? "The peer median is paused because reporting dates, durations, or bases are not comparable."
        : definitions.size > 1
          ? "The peer median is paused because issuers use different reported input concepts. Inspect the definitions before combining them."
          : null;
  return {
    cells,
    count: available.length,
    total: cells.length,
    median: reason ? null : median(available.map((cell) => cell.point.value)),
    reason,
  };
}

const PRESETS = [
  {
    id: "cash-assets",
    label: "Cash / assets",
    formulaA: "cash",
    formulaB: "totalAssets",
    formulaOp: "divide",
  },
  {
    id: "cash-deposits",
    label: "Cash / deposits",
    formulaA: "cash",
    formulaB: "deposits",
    formulaOp: "divide",
  },
  {
    id: "net-margin",
    label: "Net income / revenue",
    formulaA: "netIncome",
    formulaB: "revenue",
    formulaOp: "divide",
  },
  {
    id: "bank-net-margin",
    label: "Net income / bank income",
    formulaA: "netIncome",
    formulaB: "bankRevenue",
    formulaOp: "divide",
  },
  {
    id: "cash-conversion",
    label: "Operating cash flow / net income",
    formulaA: "operatingCashFlow",
    formulaB: "netIncome",
    formulaOp: "divide",
    formulaScale: "multiple",
  },
  {
    id: "noncash-assets",
    label: "Assets less reported cash",
    formulaA: "totalAssets",
    formulaB: "cash",
    formulaOp: "subtract",
  },
  {
    id: "operating-gap",
    label: "Operating-to-net income gap / revenue",
    formulaA: "operatingIncome",
    formulaB: "netIncome",
    formulaC: "revenue",
    formulaOp: "differenceRatio",
  },
];
export function compareFormulaPresets(entries) {
  return PRESETS.map((preset) => {
    const settings = normalizeCompareFormula({
      ...DEFAULT_COMPARE_FORMULA,
      ...preset,
      formulaLabel: preset.label,
    });
    const results = compareFormulaResults(entries, settings);
    return {
      id: preset.id,
      label: preset.label,
      settings,
      count: results.count,
      total: results.total,
    };
  }).filter((preset) => preset.count > 0);
}

/** A compact definition suitable for a downloaded record or a shared setup. */
export function exportCompareFormulaDefinition(settings = {}) {
  const metric = compareFormulaMetric(settings);
  return JSON.stringify(
    {
      version: 1,
      metric,
      definition: normalizeCompareFormula(settings),
      validation: {
        valid: !validateCompareFormula(settings),
        reason: validateCompareFormula(settings),
      },
      context: {
        basis: settings.basis || null,
        alignment: settings.alignment || null,
        reportingBucket: settings.period || null,
        filingCutoff: settings.asOf || null,
      },
      policy:
        "USD inputs only; same balance or flow type and selected period; positive denominators; no annualization.",
    },
    null,
    2,
  );
}
