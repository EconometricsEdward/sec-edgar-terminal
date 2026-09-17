import { CFTC_HISTORY_WINDOWS, cftcDate, cftcGroup, isCftcContractCode, isCftcFamily } from "./cftc.js";
import { scenarioMarketHistory } from "./portfolioScenarioMarket.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Use the same identity and request as the existing selected-market drilldown. */
export function marketComparisonKey(candidate) {
  return isCftcFamily(candidate?.family) &&
    cftcGroup(candidate?.family, candidate?.group) &&
    isCftcContractCode(candidate?.contract)
    ? `${candidate.family}:${candidate.contract}:${candidate.group}`
    : null;
}

export function marketComparisonHistoryPath(candidate, reportDate = "latest") {
  if (!marketComparisonKey(candidate) ||
    (reportDate !== "latest" && (typeof reportDate !== "string" || cftcDate(reportDate) !== reportDate))) return null;
  return `/api/v1/cftc/history?${new URLSearchParams({
    family: candidate.family,
    contract: candidate.contract,
    group: candidate.group,
    window: "1y",
    date: reportDate,
  })}`;
}

/**
 * Compact, comparable CFTC context. The existing validator binds the report to
 * its official dataset, contract, trader group, futures-only scope and dates,
 * and recomputes each net/OI value from long, short and open interest.
 *
 * The range covers available valid observations in the selected report's
 * trailing 52-week window, including the selected report. Its position is
 * linear placement between the observed minimum and maximum, not a percentile.
 * Missing observations and incomplete history are never filled or extrapolated.
 */
export function summarizePortfolioMarketHistory(
  history,
  candidate,
  now = new Date(),
) {
  const key = marketComparisonKey(candidate);
  if (!key) return null;
  const normalized = scenarioMarketHistory(history, candidate, now);
  if (!normalized) return null;

  // A selected snapshot, when supplied, must describe the very same report
  // observation used for the comparison. Do not prefer either conflicting copy.
  const selectedPoint = history.history.find(
    (point) => point?.reportDate === normalized.reportDate,
  );
  if (selectedPoint && normalized.current) {
    const selected = history.selected;
    for (const [source, name] of [
      [selected.selectedGroup, "long"],
      [selected.selectedGroup, "short"],
      [selected, "openInterest"],
    ]) {
      if (Object.hasOwn(source, name) && source[name] !== selectedPoint[name])
        return null;
    }
  }

  const observations = normalized.points.filter((point) =>
    finite(point.netPctOi),
  );
  const netPctOi = finite(normalized.current?.netPctOi)
    ? normalized.current.netPctOi
    : null;
  const values = observations.map((point) => point.netPctOi);
  const start = observations[0]?.reportDate || null;
  const end = observations.at(-1)?.reportDate || null;
  const observedDays = start && end
    ? (Date.parse(end) - Date.parse(start)) / 86_400_000
    : 0;
  // The 1y response retains 52 reports, including current, so its normal span
  // is 51 weeks. Allow one day for officially shifted report calendars.
  const incompleteWindow = observations.length < CFTC_HISTORY_WINDOWS["1y"] ||
    observedDays < (CFTC_HISTORY_WINDOWS["1y"] - 1) * 7 - 1;
  const min = values.length >= 2 ? Math.min(...values) : null;
  const max = values.length >= 2 ? Math.max(...values) : null;
  const range =
    values.length >= 2
      ? {
          min,
          max,
          position:
            netPctOi !== null && max > min
              ? Math.min(100, Math.max(0, (100 * (netPctOi - min)) / (max - min)))
              : null,
          count: values.length,
          start,
          end,
        }
      : null;

  return {
    key,
    family: candidate.family,
    contract: candidate.contract,
    group: candidate.group,
    groupLabel: cftcGroup(candidate.family, candidate.group).label,
    reportDate: normalized.reportDate,
    netPctOi,
    weeklyChangePp:
      normalized.weekly.available && finite(normalized.weekly.netPctChange)
        ? normalized.weekly.netPctChange
        : null,
    priorDate: normalized.weekly.priorDate || null,
    range,
    observationCount: observations.length,
    historyStart: start,
    historyEnd: end,
    ageDays: normalized.ageDays,
    stale: normalized.stale,
    incomplete: normalized.incomplete || incompleteWindow,
    sourceUrl: normalized.sourceUrl,
    marketPath: normalized.marketPath,
  };
}
