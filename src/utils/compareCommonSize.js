import { METRIC_BY_KEY } from "./compareResearch.js";
import { comparePointQuality } from "./compareQuality.js";
import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";

const BALANCE_KEYS = [
  "totalAssets",
  "stockholdersEquity",
  "cash",
  "deposits",
  "loans",
];
const INCOME_KEYS = [
  "revenue",
  "bankRevenue",
  "netInterestIncome",
  "noninterestIncome",
  "operatingIncome",
  "netIncome",
];

export function commonSizeMetrics(entries, mode = "balance") {
  const lenses = new Set(
    entries.map((entry) => entry.data?.lens).filter(Boolean),
  );
  return (mode === "income" ? INCOME_KEYS : BALANCE_KEYS)
    .map((key) => METRIC_BY_KEY[key])
    .filter(
      (metric) =>
        !lenses.size ||
        [...lenses].some((lens) => metric.lenses.includes(lens)),
    );
}

export function commonSizeDenominator(entry, mode = "balance") {
  if (mode === "balance")
    return {
      key: "totalAssets",
      label: "Total assets",
      definition:
        "The reported USD balance of total assets at the selected reporting endpoint.",
    };
  if (entry.data?.lens === "corporate")
    return {
      key: "revenue",
      label: "Revenue",
      definition:
        "Reported USD revenue for the selected income-statement duration. Inspect the source concept for each issuer's revenue definition.",
    };
  if (entry.data?.lens === "banking")
    return {
      key: "bankRevenue",
      label: "Net interest + noninterest income",
      definition:
        "Net interest income before provision plus noninterest income for the same duration. This is not gross interest income or corporate sales.",
    };
  return {
    key: null,
    label: "No compatible income denominator",
    definition:
      "The current insurance lens does not provide a complete, recognized total-income denominator. Premiums and investment income alone are not substituted for total income.",
  };
}

export function commonSizeCell(entry, key, mode = "balance") {
  const metric = METRIC_BY_KEY[key];
  const denominator = commonSizeDenominator(entry, mode);
  const point =
    entry.index >= 0 ? entry.data?.metrics?.[key]?.[entry.index] : null;
  const denominatorPoint =
    entry.index >= 0 && denominator.key
      ? entry.data?.metrics?.[denominator.key]?.[entry.index]
      : null;
  const quality = comparePointQuality(point, key, entry.period);
  const denominatorQuality = comparePointQuality(
    denominatorPoint,
    denominator.key || "revenue",
    entry.period,
  );
  const allowed = (mode === "income" ? INCOME_KEYS : BALANCE_KEYS).includes(
    key,
  );
  const reason =
    !allowed || metric?.format !== "currency"
      ? "Only compatible monetary statement lines can be normalized. Ratios and cash-flow metrics are excluded."
      : !metric.lenses.includes(entry.data?.lens)
        ? `This line is not applicable to the ${entry.data?.lens || "unresolved"} lens.`
        : entry.error
          ? "The company request failed; retry it before interpreting coverage."
          : entry.loading
            ? "Company data is loading."
            : !denominator.key
              ? denominator.definition
              : !quality.valid
                ? quality.reason
                : !denominatorQuality.valid
                  ? `Denominator unavailable: ${denominatorQuality.reason}`
                  : denominatorPoint.value <= 0
                    ? "The denominator must be positive. Zero or negative totals cannot support a meaningful common-size percentage."
                    : quality.flow !== denominatorQuality.flow
                      ? "A flow cannot be normalized by a balance-sheet stock in this statement view."
                      : null;
  const value = reason ? null : (point.value / denominatorPoint.value) * 100;
  const formula = `${metric?.label || key} / ${denominator.label} × 100`;
  const calculatedPoint = {
    period: entry.period,
    value,
    classification: value == null ? "unavailable" : "calculated",
    reason,
    formula,
    note: `${denominator.definition} Common-size lines are selected observations, not a complete statement, and need not add to 100%.`,
    sources: [...evidenceSources(point), ...evidenceSources(denominatorPoint)],
    calculations: [
      ...evidenceCalculations(point),
      ...evidenceCalculations(denominatorPoint),
      ...(point?.formula
        ? [{ formula: point.formula, value: point.value, ...point.period }]
        : []),
      ...(denominatorPoint?.formula
        ? [
            {
              formula: denominatorPoint.formula,
              value: denominatorPoint.value,
              ...denominatorPoint.period,
            },
          ]
        : []),
      {
        formula,
        value,
        start: entry.period?.start,
        end: entry.period?.end,
        unit: "%",
      },
    ],
  };
  return {
    ticker: entry.ticker,
    name: entry.data?.name,
    cik: entry.data?.cik,
    period: entry.period,
    point,
    denominatorPoint,
    denominator,
    calculatedPoint,
    value,
    reason,
    issues: [...quality.issues, ...denominatorQuality.issues],
  };
}
