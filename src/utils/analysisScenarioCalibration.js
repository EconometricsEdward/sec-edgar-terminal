import { scenarioHistoricalCalibration } from "./analysisScenarioContext.js";
import { labCalculatedPoint } from "./analysisFormula.js";
import { analysisChange } from "./analysisResearch.js";

const finite = Number.isFinite;
const note = "Observed changes in comparable reported periods, not forecasts or suggested assumptions. Filing evidence follows the selected cutoff and may include restatements.";

function summarize(key, label, unit, observations, boundaryReason) {
  const available = observations.filter((row) => finite(row.value) && !row.reason);
  const sorted = available.map((row) => row.value).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    key, label, unit, observations, count: available.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median: sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
    omitted: observations.length - available.length,
    reason: available.length ? null : observations.find((row) => row.reason)?.reason || boundaryReason || "No comparable reported changes are available.",
    boundaryReason,
  };
}

/** Small, assumption-independent calibration. Call once per reported baseline,
 * never for each slider edit. Existing source/date/concept guards are retained. */
export function buildScenarioCalibration(data, settings = {}, index = 0) {
  if (data.lens !== "corporate") return { revenue: null, margin: null, note };
  const history = scenarioHistoricalCalibration(data, { asOf: settings.asOf }, index);
  const revenue = history.rows.map((row) => ({
    period: row.period,
    before: row.growthDenominator?.point?.period,
    value: row.revenueGrowth?.point?.value ?? null,
    reason: row.revenueGrowth?.point?.reason || null,
    selection: row.revenueGrowth,
  }));
  const margin = history.rows.slice(0, -1).map((row, i) => {
    const before = history.rows[i + 1];
    const currentMargin = row.operatingMargin?.point?.value;
    const priorMargin = before.operatingMargin?.point?.value;
    const comparisonReasons = ["revenue", "operatingIncome"].map((key) => {
      const change = analysisChange(row[key]?.point, before[key]?.point, "currency");
      return change.delta === null ? change.reason : null;
    });
    const reason = row.operatingReason || before.operatingReason || comparisonReasons.find(Boolean) ||
      (!finite(currentMargin) || !finite(priorMargin) ? "Both observations require comparable revenue and operating income." : null);
    const value = reason ? null : currentMargin - priorMargin;
    const selection = {
      definition: { key: "scenarioHistoryMarginChange", label: "Observed operating-margin change", format: "percentagePoints" },
      point: {
        ...labCalculatedPoint(row.period, [row.operatingMargin, before.operatingMargin], value,
          "(Current reported operating income / revenue − prior same-season reported operating income / revenue) × 100 percentage points", note),
        reason,
      },
    };
    return { period: row.period, before: before.period, value, reason, selection };
  });
  return {
    revenue: summarize("scenarioRevenue", "Reported revenue change", "%", revenue, history.boundaryReason),
    margin: summarize("scenarioMargin", "Reported margin change", "pp", margin, history.boundaryReason),
    period: history.period,
    boundaryReason: history.boundaryReason,
    note,
  };
}
