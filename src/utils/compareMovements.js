import { median, METRIC_BY_KEY, periodBucket } from "./compareResearch.js";
import { comparePairQuality, comparePointQuality } from "./compareQuality.js";
import { daysBetween } from "./xbrlPeriods.js";

export function movementBuckets(entries, basis = "annual") {
  return [
    ...new Set(
      entries.flatMap((entry) =>
        (entry.data?.periods || [])
          .filter((period) => entry.period && period.end < entry.period.end)
          .map((period) => periodBucket(period, basis)),
      ),
    ),
  ]
    .sort()
    .reverse();
}

export function movementBaseline(entry, settings) {
  const current = entry.period;
  if (!current)
    return {
      index: -1,
      period: null,
      reason: "The selected current period is unavailable.",
    };
  const periods = entry.data?.periods || [];
  const explicit =
    settings.movementFrom && settings.movementFrom !== "previous";
  const matches = periods
    .map((period, index) => ({ period, index }))
    .filter(({ period }) => {
      if (period.end >= current.end || period.kind !== current.kind)
        return false;
      if (explicit)
        return periodBucket(period, settings.basis) === settings.movementFrom;
      const gap = daysBetween(period.end, current.end);
      // Standalone quarters compare sequentially; YTD and TTM retain the same
      // season one year earlier rather than mixing cumulative/overlapping windows.
      return settings.basis === "quarter"
        ? gap >= 65 && gap <= 115
        : gap >= 345 && gap <= 385;
    })
    .sort((a, b) => b.period.end.localeCompare(a.period.end));
  return (
    matches[0] || {
      index: -1,
      period: null,
      reason: explicit
        ? "No earlier report exists in the selected baseline bucket."
        : settings.basis === "quarter"
          ? "The previous standalone quarter is unavailable."
          : "A comparable reporting period one year earlier is unavailable.",
    }
  );
}

export function movementCell(entry, key, settings) {
  const metric = METRIC_BY_KEY[key];
  const current =
    entry.index >= 0 ? entry.data?.metrics?.[key]?.[entry.index] : null;
  const baseline = movementBaseline(entry, settings);
  const prior =
    baseline.index >= 0 ? entry.data?.metrics?.[key]?.[baseline.index] : null;
  const currentQuality = comparePointQuality(current, key, entry.period);
  const priorQuality = comparePointQuality(prior, key, baseline.period);
  const pair = comparePairQuality(current, prior, key);
  const reason = entry.error
    ? "The company request failed; retry it before comparing."
    : entry.loading
      ? "Company data is loading."
      : baseline.reason || (!pair.valid ? pair.reason : null);
  const absolute = !reason && metric ? current.value - prior.value : null;
  const rate =
    absolute == null || metric?.format !== "currency" || prior.value <= 0
      ? null
      : (absolute / prior.value) * 100;
  return {
    ticker: entry.ticker,
    cik: entry.data?.cik,
    name: entry.data?.name,
    current,
    prior,
    currentPeriod: entry.period,
    priorPeriod: baseline.period,
    currentQuality,
    priorQuality,
    absolute,
    rate,
    valid: absolute != null,
    reason,
    rateReason:
      absolute != null && metric?.format === "currency" && prior.value <= 0
        ? "Percentage change is not meaningful with a zero or negative base; the absolute change remains available."
        : null,
  };
}

function aligned(cells, side, key) {
  const periods = cells.map((cell) => cell[`${side}Period`]);
  const ends = periods.map((period) => period.end).sort();
  const durations = cells
    .map((cell) => comparePointQuality(cell[side], key).durationDays)
    .filter(Number.isFinite);
  return (
    daysBetween(ends[0], ends.at(-1)) <= 45 &&
    (!durations.length || Math.max(...durations) - Math.min(...durations) <= 14)
  );
}

/** Medians use the same issuers on both sides, never separate available samples. */
export function movementComparison(entries, key, settings) {
  const seen = new Set();
  const cells = entries
    .filter((entry) => {
      const identity = entry.data?.cik || entry.ticker;
      if (
        seen.has(identity) ||
        entry.duplicate ||
        settings.excluded?.includes(entry.ticker)
      )
        return false;
      seen.add(identity);
      return true;
    })
    .map((entry) => movementCell(entry, key, settings));
  const paired = cells.filter((cell) => cell.valid);
  const reason =
    paired.length < 2
      ? "At least two issuers with valid current and prior observations are required."
      : !aligned(paired, "current", key) || !aligned(paired, "prior", key)
        ? "Peer changes are withheld: current or prior reporting ends differ by more than 45 days, or durations by more than 14 days."
        : null;
  const metric = METRIC_BY_KEY[key];
  const completeRates = paired.filter((cell) => cell.rate != null);
  return {
    cells,
    pairedCount: paired.length,
    total: cells.length,
    members: paired.map((cell) => cell.ticker),
    reason,
    priorMedian: !reason
      ? median(paired.map((cell) => cell.prior.value))
      : null,
    currentMedian: !reason
      ? median(paired.map((cell) => cell.current.value))
      : null,
    medianChange: !reason ? median(paired.map((cell) => cell.absolute)) : null,
    medianRate:
      !reason &&
      metric?.format === "currency" &&
      completeRates.length === paired.length
        ? median(completeRates.map((cell) => cell.rate))
        : null,
    rateReason:
      !reason &&
      metric?.format === "currency" &&
      completeRates.length !== paired.length
        ? "Percentage-change median is withheld because the paired sample includes a zero or negative base."
        : null,
  };
}
