import { METRIC_BY_KEY, median, metricComparison } from "./compareResearch.js";
import { daysBetween } from "./xbrlPeriods.js";
import { comparePointQuality } from "./compareQuality.js";

const issuerId = (cell) => {
  const cik = String(cell.cik || cell.data?.cik || "").replace(/^0+/, "");
  return cik ? `cik:${cik}` : `ticker:${String(cell.ticker).toUpperCase()}`;
};

function observationCells(entries, key) {
  const seen = new Map();
  return entries.map((entry) => {
    const point =
      entry.index >= 0 ? entry.data?.metrics?.[key]?.[entry.index] : null;
    const cell = {
      ticker: entry.ticker,
      cik: entry.data?.cik,
      name: entry.data?.name,
      period: entry.period,
      point,
      quality: comparePointQuality(point, key, entry.period),
      status: entry.error
        ? "fetch failed"
        : entry.loading
          ? "loading"
          : entry.period
            ? "reviewed"
            : "period unavailable",
      duplicateOf: null,
    };
    const id = issuerId(cell);
    if (seen.has(id)) cell.duplicateOf = seen.get(id);
    else seen.set(id, entry.ticker);
    return cell;
  });
}

/** The same conservative date limits as the comparison table, with explicit kinds. */
export function benchmarkPeriodReason(cells) {
  if (!cells.length) return "No observations are available.";
  const periods = cells.map((cell) => cell.point?.period || cell.period);
  if (periods.some((p) => !p?.end || !Number.isFinite(Date.parse(p.end))))
    return "A reporting end is unavailable.";
  if (new Set(periods.map((p) => p.kind || "unknown")).size > 1)
    return "Reporting bases differ; annual, quarterly and trailing-year values cannot be pooled.";
  const ends = periods.map((p) => p.end).sort();
  if (daysBetween(ends[0], ends.at(-1)) > 45)
    return "Reporting ends differ by more than 45 days.";
  const durations = cells
    .map((cell, index) =>
      cell.quality
        ? cell.quality.durationDays
        : periods[index].start
          ? daysBetween(periods[index].start, periods[index].end) + 1
          : null,
    )
    .filter(Number.isFinite);
  if (durations.some((days) => days <= 0))
    return "A reporting duration is invalid.";
  if (
    durations.length > 1 &&
    Math.max(...durations) - Math.min(...durations) > 14
  )
    return "Reporting durations differ by more than 14 days.";
  return null;
}

function missingReason(cell) {
  if (cell.duplicateOf)
    return `Same SEC issuer as ${cell.duplicateOf}; counted once.`;
  if (cell.status !== "reviewed") return cell.status;
  if (!Number.isFinite(cell.point?.value))
    return cell.point?.reason || "The selected metric has no usable value.";
  if (cell.quality && !cell.quality.valid) return cell.quality.reason;
  return benchmarkPeriodReason([cell]);
}

function peerStudy(entries, key, settings = {}) {
  const cells = observationCells(entries, key);
  const requested = settings.focus || cells[0]?.ticker || "";
  const requestedCell = cells.find((cell) => cell.ticker === requested);
  const focus = requestedCell
    ? cells.find(
        (cell) =>
          !cell.duplicateOf && issuerId(cell) === issuerId(requestedCell),
      )
    : null;
  const focusIssue = focus
    ? missingReason(focus)
    : "The focus company is not in the selected peer set.";
  const cohort = cells.map((cell) => {
    const isFocus = Boolean(focus && issuerId(cell) === issuerId(focus));
    const reason =
      missingReason(cell) ||
      (isFocus
        ? "Focus issuer; excluded from its own peer benchmark."
        : focusIssue
          ? "A usable focus observation is required to check peer compatibility."
          : benchmarkPeriodReason([focus, cell]));
    return { ...cell, isFocus, included: !reason, reason };
  });
  const peers = cohort.filter((cell) => cell.included);
  const reason =
    focusIssue ||
    benchmarkPeriodReason([focus, ...peers].filter(Boolean)) ||
    (peers.length < 2
      ? "At least two compatible other issuers are required; the focus company never counts toward that minimum."
      : null);
  const definitionsDiffer =
    new Set(
      [focus, ...peers]
        .filter(Boolean)
        .map((cell) => cell.quality.concepts.join("|")),
    ).size > 1;
  const definitionNote = definitionsDiffer
    ? "Source concepts differ across these issuers. Review the linked definitions; compatible reporting dates do not establish identical accounting scope."
    : null;
  return {
    cells,
    focus,
    focusTicker: requested,
    cohort,
    peers,
    reason,
    definitionsDiffer,
    definitionNote,
  };
}

/** Adapter used by every displayed benchmark so the focal issuer never counts itself. */
export function researchMetricComparison(entries, key, settings = {}) {
  if (settings.benchmark !== "peers") {
    const cells = observationCells(entries, key);
    const unique = entries.filter((_, index) => !cells[index].duplicateOf);
    const base = metricComparison(unique, key, settings.benchmark || "median");
    return {
      ...base,
      benchmarkCount: base.eligibleCount,
      benchmarkMembers: base.cells
        .filter((cell) => cell.quality.valid)
        .map((cell) => cell.ticker),
      focusTicker: settings.focus || cells[0]?.ticker || "",
    };
  }
  const study = peerStudy(entries, key, settings);
  const value = study.reason
    ? null
    : median(study.peers.map((cell) => cell.point.value));
  const rankSample = value == null ? [] : [study.focus, ...study.peers];
  return {
    metric: METRIC_BY_KEY[key],
    cells: study.cells.map((cell) => {
      const included = rankSample.some(
        (member) => member.ticker === cell.ticker,
      );
      return {
        ...cell,
        delta: included ? cell.point.value - value : null,
        rank: included
          ? 1 +
            rankSample.filter((member) => member.point.value > cell.point.value)
              .length
          : null,
      };
    }),
    count: study.cells.filter(
      (cell) => !cell.duplicateOf && Number.isFinite(cell.point?.value),
    ).length,
    eligibleCount: rankSample.length,
    excludedCount: study.cells.filter(
      (cell) =>
        !cell.duplicateOf &&
        Number.isFinite(cell.point?.value) &&
        missingReason(cell),
    ).length,
    total: study.cells.filter((cell) => !cell.duplicateOf).length,
    peerMedian: value,
    reference: value,
    reason: study.reason,
    benchmarkCount: study.peers.length,
    benchmarkMembers: study.peers.map((cell) => cell.ticker),
    focusTicker: study.focusTicker,
    cohort: study.cohort,
    rankCount: rankSample.length,
    definitionsDiffer: study.definitionsDiffer,
    definitionNote: study.definitionNote,
  };
}

function quantile(sorted, q) {
  const at = (sorted.length - 1) * q;
  const lower = Math.floor(at);
  return sorted[lower] + (sorted[Math.ceil(at)] - sorted[lower]) * (at - lower);
}

export function benchmarkDistribution(entries, key, settings = {}) {
  const study = peerStudy(entries, key, settings);
  const values = study.peers
    .map((cell) => cell.point.value)
    .sort((a, b) => a - b);
  const center = study.reason ? null : median(values);
  return {
    ...study,
    count: values.length,
    median: center,
    min: center == null ? null : values[0],
    max: center == null ? null : values.at(-1),
    q1: center != null && values.length >= 4 ? quantile(values, 0.25) : null,
    q3: center != null && values.length >= 4 ? quantile(values, 0.75) : null,
    focusDelta: center != null ? study.focus.point.value - center : null,
    sensitivity: study.peers.map((omitted) => {
      const retained = study.peers.filter(
        (cell) => cell.ticker !== omitted.ticker,
      );
      const next =
        center != null && retained.length >= 2
          ? median(retained.map((cell) => cell.point.value))
          : null;
      return {
        omitted: omitted.ticker,
        members: retained.map((cell) => cell.ticker),
        count: retained.length,
        median: next,
        shift: next == null ? null : next - center,
        focusDelta: next == null ? null : study.focus.point.value - next,
        reason:
          next == null ? study.reason || "Fewer than two peers remain." : null,
      };
    }),
  };
}

/** Both median guides come from exactly the same plotted, complete-pair sample. */
export function compatibleMapSample(entries, xKey, yKey) {
  const xCells = observationCells(entries, xKey);
  const yCells = observationCells(entries, yKey);
  const rows = entries.map((entry, index) => {
    const x = xCells[index],
      y = yCells[index];
    const reason =
      missingReason(x) || missingReason(y) || benchmarkPeriodReason([x, y]);
    return { entry, x, y, reason, included: !reason };
  });
  const plotted = rows.filter((row) => row.included);
  const reason =
    plotted.length < 2
      ? "At least two issuers with both usable values are required for median guides."
      : benchmarkPeriodReason(plotted.flatMap((row) => [row.x, row.y]));
  return {
    rows,
    plotted,
    reason,
    count: plotted.length,
    total: rows.filter((row) => !row.x.duplicateOf).length,
    members: plotted.map((row) => row.entry.ticker),
    xMedian: reason ? null : median(plotted.map((row) => row.x.point.value)),
    yMedian: reason ? null : median(plotted.map((row) => row.y.point.value)),
  };
}
