import { analysisBaseline, analysisChecks } from "./analysisResearch.js";
import { growthCompatibility } from "./analysisGrowth.js";

/** Rank like-unit movements; magnitude is a review order, never a risk score. */
export function analysisMovements(data, index, options = {}) {
  const beforeIndex = analysisBaseline(
    data.periods,
    index,
    options.baseline || "year",
  );
  const scope = options.movementScope || "income";
  const mode = options.movementSort || "absolute";
  const threshold = Math.max(0, Number(options.movementThreshold) || 0);
  const rows = data.definitions
    .filter((d) => d.category === scope)
    .map((definition) => {
      const point = data.metrics[definition.key]?.[index];
      const before = data.metrics[definition.key]?.[beforeIndex];
      const change = growthCompatibility(point, before, definition.format);
      const eligible =
        mode === "growth"
          ? change.percent !== null
          : scope === "ratios"
            ? definition.format === "percent"
            : definition.format === "currency";
      const magnitude = eligible
        ? Math.abs(
            mode === "growth" ? (change.percent ?? 0) : (change.delta ?? 0),
          )
        : null;
      return { definition, point, before, change, magnitude, beforeIndex };
    });
  const comparable = rows.filter(
    (r) => r.magnitude !== null && r.change.delta !== null,
  );
  return {
    beforeIndex,
    considered: rows.length,
    comparable: comparable.length,
    rows: comparable
      .filter((r) => r.magnitude >= threshold)
      .sort(
        (a, b) =>
          b.magnitude - a.magnitude ||
          a.definition.label.localeCompare(b.definition.label),
      ),
    excluded: rows.length - comparable.length,
  };
}

export function analysisOverview(data, index) {
  const checks = analysisChecks(data, index);
  const primary =
    data.lens === "banking"
      ? [
          "bankRevenue",
          "netIncome",
          "roe",
          "equityAssets",
          "deposits",
          "loanDeposits",
        ]
      : data.lens === "insurance"
        ? [
            "premiumsEarned",
            "investmentIncome",
            "netIncome",
            "roe",
            "equityAssets",
            "cashAssets",
          ]
        : [
            "revenue",
            "netIncome",
            "operatingMargin",
            "operatingCashFlow",
            "freeCashFlow",
            "roe",
          ];
  const sources = primary.flatMap(
    (k) => data.metrics[k]?.[index]?.sources || [],
  );
  const filed = sources
    .map((s) => s.filed)
    .filter(Boolean)
    .sort();
  return {
    checks,
    primary: primary.filter((k) => data.definitions.some((d) => d.key === k)),
    firstFiled: filed[0],
    lastFiled: filed.at(-1),
    reports: new Set(sources.map((s) => s.accession).filter(Boolean)).size,
  };
}
