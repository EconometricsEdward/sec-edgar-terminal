import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";

export const FORMULA_DEFAULTS = {
  formulaA: "operatingCashFlow",
  formulaB: "capex",
  formulaC: "revenue",
  formulaOp: "subtractRatio",
  formulaScale: "percent",
};
export const FORMULA_OPERATIONS = ["ratio", "add", "subtract", "subtractRatio"];
export function normalizeFormulaSettings(input = {}) {
  const out = { ...FORMULA_DEFAULTS };
  for (const key of ["formulaA", "formulaB", "formulaC"])
    if (
      typeof input[key] === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(input[key])
    )
      out[key] = input[key];
  if (FORMULA_OPERATIONS.includes(input.formulaOp))
    out.formulaOp = input.formulaOp;
  if (["percent", "multiple"].includes(input.formulaScale))
    out.formulaScale = input.formulaScale;
  return out;
}

// Currency-only operands avoid quietly adding percentages, shares, and dollar amounts.
export function formulaDefinitions(data) {
  return (data.definitions || []).filter((d) => d.format === "currency");
}

export function labInput(data, key, index) {
  const definition = (data.definitions || []).find((d) => d.key === key);
  const point = data.metrics?.[key]?.[index];
  const period = data.periods?.[index];
  const sources = evidenceSources(point);
  let reason = null;
  if (!definition || definition.format !== "currency")
    reason = "Select an available USD amount.";
  else if (!Number.isFinite(point?.value))
    reason =
      point?.reason ||
      "A required reported input is unavailable; it is not assumed to be zero.";
  else if (
    !period ||
    !point.period ||
    point.period.end !== period.end ||
    point.period.kind !== period.kind ||
    (point.period.start || null) !== (period.start || null)
  )
    reason =
      "The input does not share the selected reporting period and basis.";
  else if (!sources.length || sources.some((s) => s.unit !== "USD"))
    reason = "Every input requires reviewable USD source evidence.";
  else if (
    sources.some(
      (s) =>
        !s.end || !Number.isFinite(Date.parse(s.end)) || s.end > period.end,
    )
  )
    reason =
      "A source date is missing, invalid, or falls after the selected reporting date.";
  else if (
    !(point.classification === "calculated" && point.formula) &&
    sources.some(
      (s) =>
        s.start &&
        (!period.start ||
          !Number.isFinite(Date.parse(s.start)) ||
          !Number.isFinite(Date.parse(s.end)) ||
          Math.abs(Date.parse(s.start) - Date.parse(period.start)) >
            14 * 86400000 ||
          Math.abs(Date.parse(s.end) - Date.parse(period.end)) > 14 * 86400000),
    )
  )
    reason =
      "The reported source duration does not match the selected reporting duration within 14 days.";
  const instants = sources.length > 0 && sources.every((s) => !s.start);
  const opening =
    period?.start && Number.isFinite(Date.parse(period.start))
      ? new Date(Date.parse(period.start) - 86400000).toISOString().slice(0, 10)
      : null;
  const basis = ["averageAssets", "averageEquity"].includes(key)
    ? "average balance"
    : instants
      ? sources.every((s) => s.end === period?.end)
        ? "ending balance"
        : opening && sources.every((s) => s.end === opening)
          ? "opening balance"
          : new Set(sources.map((s) => s.end)).size === 1
            ? "prior balance"
            : "mixed-date balance"
      : "period flow";
  if (!reason && ["prior balance", "mixed-date balance"].includes(basis))
    reason =
      "A balance must use the selected ending date or its opening date. Unspecified prior or mixed dates cannot be combined.";
  return { key, definition, point, basis, reason };
}

export function labCalculatedPoint(period, inputs, value, formula, note = "") {
  return {
    period,
    value: Number.isFinite(value) ? value : null,
    classification: Number.isFinite(value) ? "calculated" : "unavailable",
    formula,
    note,
    sources: evidenceSources({
      sources: inputs.flatMap((i) => evidenceSources(i.point || i)),
    }),
    calculations: inputs.flatMap((i) => {
      const p = i.point || i;
      return [
        ...evidenceCalculations(p),
        ...(p.formula
          ? [
              {
                formula: p.formula,
                value: p.value,
                start: p.period?.start,
                end: p.period?.end,
              },
            ]
          : []),
      ];
    }),
  };
}

export function buildFormulaPoint(data, input, index) {
  const settings = normalizeFormulaSettings(input);
  const keys =
    settings.formulaOp === "subtractRatio"
      ? [settings.formulaA, settings.formulaB, settings.formulaC]
      : [settings.formulaA, settings.formulaB];
  const inputs = keys.map((key) => labInput(data, key, index));
  const names = inputs.map((i) => i.definition?.label || i.key);
  const ratio = ["ratio", "subtractRatio"].includes(settings.formulaOp);
  const format = ratio
    ? settings.formulaScale === "percent"
      ? "percent"
      : "decimal"
    : "currency";
  const formula =
    settings.formulaOp === "add"
      ? `${names[0]} + ${names[1]}`
      : settings.formulaOp === "subtract"
        ? `${names[0]} − ${names[1]}`
        : `${settings.formulaOp === "subtractRatio" ? `(${names[0]} − ${names[1]}) / ${names[2]}` : `${names[0]} / ${names[1]}`}${settings.formulaScale === "percent" ? " × 100" : ""}`;
  const period = data.periods?.[index];
  let reason = inputs.find((i) => i.reason)?.reason || null;
  if (
    !reason &&
    settings.formulaOp !== "ratio" &&
    inputs[0].basis !== inputs[1].basis
  )
    reason =
      "Addition and subtraction require the same measurement basis: period flows, ending balances, or average balances.";
  const denominator = inputs[inputs.length - 1].point?.value;
  if (!reason && ratio && !(denominator > 0))
    reason =
      "A ratio requires a strictly positive denominator. Zero or negative denominators are not interpreted as a meaningful ratio.";
  const mixed = ratio && inputs[0].basis !== inputs[inputs.length - 1].basis;
  const note = `Custom research calculation; USD inputs. ${mixed ? `${inputs[0].basis} divided by ${inputs[inputs.length - 1].basis}. ` : ""}Uses the selected reporting duration without annualization. Inspect the inputs and accounting scope before comparing companies.`;
  const values = inputs.map((i) => i.point?.value);
  const raw = reason
    ? null
    : settings.formulaOp === "add"
      ? values[0] + values[1]
      : settings.formulaOp === "subtract"
        ? values[0] - values[1]
        : ((settings.formulaOp === "subtractRatio"
            ? values[0] - values[1]
            : values[0]) /
            denominator) *
          (settings.formulaScale === "percent" ? 100 : 1);
  const point = labCalculatedPoint(period, inputs, raw, formula, note);
  point.reason =
    reason ||
    (!Number.isFinite(raw)
      ? "The result exceeds the supported numerical range."
      : null);
  return {
    definition: { key: "customFormula", label: `Custom: ${formula}`, format },
    point,
    inputs,
    settings,
    mixed,
  };
}

export function buildFormulaHistory(data, settings) {
  return (data.periods || []).map((_, i) =>
    buildFormulaPoint(data, settings, i),
  );
}
