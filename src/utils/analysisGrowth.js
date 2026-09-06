import {
  analysisBaseline,
  analysisChange,
  calculateAnalysisPoint,
} from "./analysisResearch.js";
import { daysBetween } from "./xbrlPeriods.js";
import { evidenceSources } from "./researchEvidence.js";

const finite = (point) => Number.isFinite(point?.value);
const unavailable = (period, reason) => ({
  period,
  value: null,
  sources: [],
  classification: "unavailable",
  reason,
});
const definition = (data, key) =>
  data.definitions.find((item) => item.key === key);
const pointAt = (data, key, index) => data.metrics[key]?.[index];

// Direct observations can differ from inferred periods. Cumulative inputs to
// derived standalone quarters must not be mistaken for their output duration.
function flowWindow(point) {
  const sources = evidenceSources(point).filter((source) => source.start);
  if (!sources.length) return null;
  if (
    sources.every(
      (source) =>
        source.start === sources[0].start && source.end === sources[0].end,
    )
  )
    return { start: sources[0].start, end: sources[0].end };
  return point.period;
}

export function growthCompatibility(current, before, format = "currency") {
  const change = analysisChange(current, before, format);
  if (change.delta == null) return change;
  const windows = [flowWindow(current), flowWindow(before)];
  if (windows.some(Boolean)) {
    if (!windows.every((window) => window?.start && window?.end))
      return {
        delta: null,
        percent: null,
        reason: "Both observations need a known flow duration.",
      };
    const durations = windows.map(
      (window) => daysBetween(window.start, window.end) + 1,
    );
    if (
      durations.some(
        (duration) => !Number.isFinite(duration) || duration <= 0,
      ) ||
      Math.abs(durations[0] - durations[1]) > 14
    )
      return {
        delta: null,
        percent: null,
        reason:
          "The actual reported flow durations differ by more than 14 days.",
      };
  }
  return change;
}

export function growthPair(data, key, index) {
  const current = pointAt(data, key, index);
  const beforeIndex = analysisBaseline(data.periods, index, "year");
  const before = beforeIndex >= 0 ? pointAt(data, key, beforeIndex) : null;
  const format = definition(data, key)?.format || "currency";
  const change = growthCompatibility(current, before, format);
  let point = unavailable(
    current?.period,
    change.reason || "A positive comparable prior-year value is required.",
  );
  if (change.percent != null)
    point = calculateAnalysisPoint(
      current.period,
      [current, before],
      "(Current value / comparable same-season prior-year value − 1) × 100",
      (a, b) => (b > 0 ? (a / b - 1) * 100 : null),
    );
  return { current, before, beforeIndex, change, point };
}

export function endpointCagr(data, key, index, years = 3) {
  const current = pointAt(data, key, index);
  const period = data.periods[index];
  const result = (reason, extra = {}) => ({
    point: unavailable(period, reason),
    years,
    count: 0,
    expected: years + 1,
    ...extra,
  });
  if (!period || !Number.isInteger(years) || years < 1 || years > 10)
    return result("Select a valid observation and a one-to-ten-year horizon.");
  if (
    !["currency", "eps", "shares"].includes(
      definition(data, key)?.format || "currency",
    )
  )
    return result(
      "Compound growth is reserved for amounts and per-share or share-count observations.",
    );
  const indices = [index];
  for (let offset = 0; offset < years; offset += 1) {
    const beforeIndex = analysisBaseline(data.periods, indices.at(-1), "year");
    if (beforeIndex < 0)
      return result(
        "A same-season annual observation is missing; CAGR does not skip the gap.",
        { count: indices.filter((i) => finite(pointAt(data, key, i))).length },
      );
    indices.push(beforeIndex);
  }
  const points = indices.map((i) => pointAt(data, key, i));
  const count = points.filter(finite).length;
  if (count !== points.length)
    return result(
      "Every same-season observation in the horizon must be available; missing values are not skipped.",
      { count, indices },
    );
  for (let i = 0; i < points.length - 1; i += 1) {
    const pair = growthCompatibility(points[i], points[i + 1]);
    if (pair.delta == null) return result(pair.reason, { count, indices });
  }
  const before = points.at(-1);
  if (current.value <= 0 || before.value <= 0)
    return result("CAGR requires positive beginning and ending values.", {
      count,
      indices,
      before,
    });
  const elapsedYears = daysBetween(before.period.end, period.end) / 365.25;
  const point = calculateAnalysisPoint(
    period,
    points,
    "(Ending value / beginning value)^(1 / elapsed years) − 1, × 100; elapsed years = " +
      elapsedYears.toFixed(6) +
      ". All " +
      points.length +
      " same-season observations are available.",
    (...values) =>
      (Math.pow(values[0] / values.at(-1), 1 / elapsedYears) - 1) * 100,
  );
  point.note =
    "Endpoint compound growth describes the start and end values, not a steady path between them. Intermediate observations are retained for coverage and evidence.";
  return {
    point,
    years,
    elapsedYears,
    count,
    expected: years + 1,
    indices,
    before,
  };
}

export function growthHistory(data, key, index, limit = 8) {
  const rows = data.periods
    .slice(index, index + Math.max(1, Math.min(41, limit)))
    .map((period, offset) => ({
      period,
      index: index + offset,
      ...growthPair(data, key, index + offset),
    }));
  return {
    rows,
    observed: rows.filter((row) => finite(row.current)).length,
    comparable: rows.filter((row) => row.change.delta != null).length,
    growthAvailable: rows.filter((row) => finite(row.point)).length,
    total: rows.length,
  };
}

export function fiscalSeasonality(data, key, index, yearLimit = 6) {
  if (data.basis !== "quarter")
    return {
      rows: [],
      reason:
        "The fiscal matrix requires standalone quarters. YTD and overlapping TTM values are not seasonal quarters.",
    };
  const groups = new Map();
  data.periods.slice(index).forEach((period, offset) => {
    if (!/^Q[1-4]$/.test(period.fp || "")) return;
    const year = String(period.fy);
    if (!groups.has(year))
      groups.set(year, { year, cells: [null, null, null, null] });
    const group = groups.get(year);
    const slot = Number(period.fp.slice(1)) - 1;
    if (group.cells[slot]) group.cells[slot].duplicate = true;
    else
      group.cells[slot] = {
        index: index + offset,
        period,
        point: pointAt(data, key, index + offset),
        duplicate: false,
      };
  });
  const rows = [...groups.values()]
    .slice(0, yearLimit)
    .map((row) => ({
      ...row,
      available: row.cells.filter((cell) => finite(cell?.point)).length,
      observed: row.cells.filter(Boolean).length,
    }));
  return { rows, reason: null };
}

export function profitChangeBridge(
  data,
  index,
  profitKey = "netIncome",
  baseline = "year",
) {
  const period = data.periods[index];
  const beforeIndex = analysisBaseline(data.periods, index, baseline);
  const beforePeriod = data.periods[beforeIndex];
  const fail = (reason) => ({
    period,
    beforePeriod,
    beforeIndex,
    reason,
    components: [],
  });
  const revenueKey = data.revenueKey;
  if (!revenueKey || data.lens === "insurance")
    return fail(
      "This industry extract does not define a comparable total-revenue denominator. A revenue–margin bridge would invent a relationship, so it is unavailable.",
    );
  if (beforeIndex < 0)
    return fail(
      "A compatible comparison period is required. Choose the same period last year or another comparable reporting period.",
    );
  const currentProfit = pointAt(data, profitKey, index),
    previousProfit = pointAt(data, profitKey, beforeIndex);
  const currentRevenue = pointAt(data, revenueKey, index),
    previousRevenue = pointAt(data, revenueKey, beforeIndex);
  const inputs = [
    currentProfit,
    currentRevenue,
    previousProfit,
    previousRevenue,
  ];
  if (!inputs.every(finite))
    return fail(
      "Both periods require reported profit and the matching revenue definition. Missing inputs are not estimated.",
    );
  for (const pair of [
    [currentProfit, previousProfit],
    [currentRevenue, previousRevenue],
    [currentProfit, currentRevenue],
    [previousProfit, previousRevenue],
  ]) {
    const check = growthCompatibility(...pair);
    if (check.delta == null) return fail(check.reason);
  }
  if (currentRevenue.value <= 0 || previousRevenue.value <= 0)
    return fail(
      "Both revenue denominators must be positive to define comparable profit margins.",
    );
  const derived = (formula, compute) =>
    calculateAnalysisPoint(period, inputs, formula, compute);
  const revenueEffect = derived(
    "(Current revenue − prior revenue) × (current profit margin + prior profit margin) / 2",
    (p1, r1, p0, r0) => (r1 - r0) * ((p1 / r1 + p0 / r0) / 2),
  );
  const marginEffect = derived(
    "(Current profit margin − prior profit margin) × (current revenue + prior revenue) / 2",
    (p1, r1, p0, r0) => (p1 / r1 - p0 / r0) * ((r1 + r0) / 2),
  );
  const change = derived(
    "Current profit − prior profit",
    (p1, _r1, p0) => p1 - p0,
  );
  return {
    period,
    beforePeriod,
    beforeIndex,
    reason: null,
    revenueKey,
    profitKey,
    currentProfit,
    previousProfit,
    currentRevenue,
    previousRevenue,
    currentMargin: calculateAnalysisPoint(
      period,
      [currentProfit, currentRevenue],
      "Current profit / current revenue × 100",
      (p, r) => (p / r) * 100,
    ),
    previousMargin: calculateAnalysisPoint(
      beforePeriod,
      [previousProfit, previousRevenue],
      "Prior profit / prior revenue × 100",
      (p, r) => (p / r) * 100,
    ),
    change,
    residual: change.value - revenueEffect.value - marginEffect.value,
    components: [
      {
        key: "revenueEffect",
        label: "Revenue scale contribution",
        point: revenueEffect,
      },
      {
        key: "marginEffect",
        label: "Profit margin contribution",
        point: marginEffect,
      },
    ],
  };
}
