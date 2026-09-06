import {
  analysisBaseline,
  calculateAnalysisPoint,
} from "./analysisResearch.js";
import { growthCompatibility } from "./analysisGrowth.js";
import { daysBetween } from "./xbrlPeriods.js";

const finite = (value) => Number.isFinite(value);
const unavailable = (period, reason) => ({
  period,
  value: null,
  sources: [],
  classification: "unavailable",
  reason,
});

/** Resolve saved chart selections against this company's actual metric schema. */
export function resolveChartKeys(data, settings = {}) {
  const definitions = data?.definitions || [];
  const available = new Set(
    definitions
      .filter((item) => Array.isArray(data?.metrics?.[item.key]))
      .map((item) => item.key),
  );
  const requested = Array.isArray(settings.chart) ? settings.chart : [];
  /** @type {string[]} */
  const keys = [];
  const discarded = [];
  for (const key of requested) {
    const reason = !available.has(key)
      ? "Unavailable in this company's metric schema."
      : keys.includes(key)
        ? "Duplicate selection."
        : keys.length >= 3
          ? "A chart displays at most three metrics."
          : null;
    if (reason) discarded.push({ key, reason });
    else keys.push(key);
  }
  const usedFallback = keys.length === 0;
  if (usedFallback) {
    const defaults = [
      data?.revenueKey,
      data?.lens === "insurance" ? "premiumsEarned" : null,
      "netIncome",
      ...(data?.highlights || []),
      ...definitions.map((item) => item.key),
    ];
    for (const key of defaults) {
      if (available.has(key) && !keys.includes(key)) keys.push(key);
      if (keys.length === 2) break;
    }
  }
  return {
    keys,
    discarded,
    discardedKeys: discarded.map((item) => item.key),
    usedFallback,
  };
}

/** Newest first, with original metric indices preserved. YTD uses one season. */
export function analysisChartWindow(data, index = 0, limit = 8) {
  if (!Number.isInteger(index) || index < 0 || !data?.periods?.[index])
    return [];
  const selected = data.periods[index];
  const sameSeason = (data.basis || selected.kind) === "ytd";
  const count = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(41, Math.floor(Number(limit))))
    : 8;
  return data.periods
    .slice(index)
    .map((period, offset) => ({ period, index: index + offset }))
    .filter(({ period }) => !sameSeason || period.fp === selected.fp)
    .slice(0, count);
}

function transformedDefinition(definition, mode) {
  const format = definition.format || "currency";
  if (mode === "reported") return definition;
  if (mode === "indexed")
    return {
      ...definition,
      key: `${definition.key}:chart:indexed`,
      label: `${definition.label} · indexed to 100`,
      format: "index",
    };
  const suffix =
    format === "percent"
      ? "same-season change (percentage points)"
      : format === "decimal"
        ? "same-season change (multiples)"
        : format === "days"
          ? "same-season change (days)"
          : "same-season growth";
  return {
    ...definition,
    key: `${definition.key}:chart:yearChange`,
    label: `${definition.label} · ${suffix}`,
    format:
      format === "percent"
        ? "percentagePoints"
        : ["decimal", "days"].includes(format)
          ? format
          : "percent",
  };
}

export function chartYearChangePoint(data, key, index) {
  const definition = data.definitions.find((item) => item.key === key);
  const current = data.metrics[key]?.[index];
  const beforeIndex = analysisBaseline(data.periods, index, "year");
  const before = beforeIndex >= 0 ? data.metrics[key]?.[beforeIndex] : null;
  const period = data.periods[index];
  const change = growthCompatibility(current, before, definition?.format);
  if (change.delta == null)
    return unavailable(
      period,
      change.reason || "No compatible same-season prior-year observation.",
    );
  const deltaFormat = ["percent", "decimal", "days"].includes(
    definition?.format,
  );
  if (!deltaFormat && change.percent == null)
    return unavailable(
      period,
      change.reason ||
        "Percentage growth requires a positive prior-year amount.",
    );
  const unit =
    definition?.format === "percent"
      ? "percentage points"
      : definition?.format === "decimal"
        ? "multiples"
        : "days";
  const point = calculateAnalysisPoint(
    period,
    [current, before],
    deltaFormat
      ? `Current value − comparable same-season prior-year value (${unit})`
      : "(Current value / comparable same-season prior-year value − 1) × 100",
    (a, b) => (deltaFormat ? a - b : b > 0 ? (a / b - 1) * 100 : null),
  );
  point.note = `Compared with the fiscal ${before.period.fp} observation ending ${before.period.end}. ${deltaFormat ? "This is an absolute change in the ratio's units, not percentage growth." : "A positive prior-year amount is required; negative current amounts remain visible."}`;
  return point;
}

/** One source of truth for chart coordinates and the accessible evidence table. */
export function buildAnalysisChart(data, settings = {}, index = 0) {
  const resolved = resolveChartKeys(data, settings);
  const mode = ["reported", "indexed", "yearChange"].includes(
    settings.chartMode,
  )
    ? settings.chartMode
    : settings.indexed
      ? "indexed"
      : "reported";
  const window = analysisChartWindow(data, index, settings.years);
  const chronological = [...window].reverse();
  const series = resolved.keys.map((key) => {
    const definition = data.definitions.find((item) => item.key === key);
    return {
      key,
      definition,
      displayDefinition: transformedDefinition(definition, mode),
    };
  });
  const unit = series[0]?.displayDefinition.format || "currency";
  const withheldKeys =
    mode === "indexed"
      ? []
      : series
          .filter(
            (item) => (item.displayDefinition.format || "currency") !== unit,
          )
          .map((item) => item.key);
  const plottedKeys = resolved.keys.filter(
    (key) => !withheldKeys.includes(key),
  );
  const base =
    mode === "indexed"
      ? chronological.find(({ index: i }) =>
          plottedKeys.every(
            (key) =>
              finite(data.metrics[key]?.[i]?.value) &&
              data.metrics[key][i].value > 0,
          ),
        )
      : null;
  const rows = window.map(({ period, index: i }) => {
    const points = {};
    for (const item of series) {
      const original = data.metrics[item.key]?.[i];
      let point =
        original ||
        unavailable(period, "No reported observation is available.");
      if (withheldKeys.includes(item.key)) {
        point = unavailable(
          period,
          "This series uses a different unit from the chart's shared axis. Select metrics with the same units, or use indexed mode.",
        );
      } else if (mode === "yearChange") {
        point = chartYearChangePoint(data, item.key, i);
      } else if (mode === "indexed") {
        const anchor = base ? data.metrics[item.key]?.[base.index] : null;
        const compatibility = anchor
          ? growthCompatibility(original, anchor, item.definition.format)
          : null;
        const reason = !base
          ? "No displayed period has positive values for every selected metric."
          : period.end < base.period.end
            ? `This observation precedes the shared positive index base at ${base.period.end}.`
            : compatibility?.delta == null
              ? compatibility?.reason
              : null;
        point = reason
          ? unavailable(period, reason)
          : calculateAnalysisPoint(
              period,
              [original, anchor],
              `Current value / value at ${base.period.end} × 100 (shared positive index base)`,
              (a, b) => (b > 0 ? (a / b) * 100 : null),
            );
      }
      points[item.key] = point;
    }
    return { period, index: i, points };
  });
  const annualSpacing =
    (data.basis || data.periods?.[index]?.kind) === "annual" ||
    (data.basis || data.periods?.[index]?.kind) === "ytd";
  const orderedRows = [...rows].reverse();
  const chart = orderedRows.flatMap((row, i) => {
    const result = { end: row.period.end, periodIndex: row.index };
    for (const item of series)
      result[item.key] = finite(row.points[item.key]?.value)
        ? row.points[item.key].value
        : null;
    const gap =
      i > 0 &&
      daysBetween(orderedRows[i - 1].period.end, row.period.end) >
        (annualSpacing ? 400 : 120);
    return gap
      ? [{ end: `Missing period before ${row.period.end}`, gap: true }, result]
      : [result];
  });
  return {
    ...resolved,
    mode,
    unit,
    series,
    plottedKeys,
    withheldKeys,
    base,
    rows,
    chart,
  };
}
