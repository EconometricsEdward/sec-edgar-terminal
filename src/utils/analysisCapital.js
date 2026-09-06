import {
  calculateAnalysisPoint,
  analysisBaseline,
} from "./analysisResearch.js";
import { daysBetween } from "./xbrlPeriods.js";
import { evidenceSources } from "./researchEvidence.js";

const finite = (point) => Number.isFinite(point?.value);
const unavailable = (period, reason) => ({
  period,
  value: null,
  classification: "unavailable",
  reason,
  sources: [],
});
const definition = (key, label, format = "currency") => ({
  key,
  label,
  format,
});
const pointAt = (data, key, index) => data.metrics[key]?.[index];
const sourceSignature = (point) =>
  [
    ...new Set(
      evidenceSources(point).map((s) => `${s.taxonomy}:${s.tag}:${s.unit}`),
    ),
  ]
    .sort()
    .join("|");
const sameConcept = (a, b) =>
  Boolean(sourceSignature(a)) && sourceSignature(a) === sourceSignature(b);
const nextDay = (date) =>
  Number.isFinite(Date.parse(date))
    ? new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)
    : null;

/** Verify the actual flow contexts, including the operands of quarter/TTM calculations. */
export function supportsAnalysisDuration(point, period) {
  if (!finite(point) || !period?.start || !period?.end) return false;
  const sources = evidenceSources(point);
  if (
    !sources.length ||
    sources.some(
      (s) =>
        !s.start ||
        !s.end ||
        !Number.isFinite(Date.parse(s.start)) ||
        !nextDay(s.end),
    )
  )
    return false;
  if (point.classification === "reported")
    return sources.every(
      (s) => s.start === period.start && s.end === period.end,
    );
  // A derived quarter can subtract two cumulative observations; a TTM can sum
  // four quarters, including such differences. For every reported concept, its
  // source intervals must connect the requested start and end. Treating a
  // cumulative subtraction as two overlapping direct flows would reject valid
  // quarters; accepting any 300–400 day context would admit the wrong duration.
  const groups = new Map();
  for (const s of sources) {
    const key = `${s.taxonomy}:${s.tag}:${s.unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([s.start, nextDay(s.end)]);
  }
  return [...groups.values()].every((intervals) => {
    const seen = new Set([period.start]);
    const pending = [period.start];
    while (pending.length) {
      const date = pending.shift();
      for (const [start, end] of intervals) {
        const adjacent = start === date ? end : end === date ? start : null;
        if (adjacent && !seen.has(adjacent)) {
          seen.add(adjacent);
          pending.push(adjacent);
        }
      }
    }
    return seen.has(nextDay(period.end));
  });
}
const compatibleFlow = (point, period) =>
  !finite(point) || supportsAnalysisDuration(point, period)
    ? point
    : unavailable(
        period,
        "The reported source duration does not support the selected start and end dates. A comparable flow cannot be established.",
      );

/** Select a contiguous window. Rolling TTM and growing YTD series must not add. */
export function cashWindow(data, index = 0, count = 4) {
  const selected = data.periods[index];
  if (!selected)
    return {
      indices: [],
      excluded: 0,
      reason: "No selected reporting period.",
      period: null,
      cumulative: false,
    };
  const limit = Math.max(1, Math.min(12, Math.floor(Number(count) || 4)));
  if (!["annual", "quarter"].includes(selected.kind))
    return {
      indices: [index],
      excluded: 0,
      period: selected,
      cumulative: false,
      reason: `${selected.kind === "ttm" ? "Trailing-year" : "Year-to-date"} observations overlap. This view uses only the selected duration; switch to annual or standalone quarter for cumulative totals.`,
    };
  const candidates = data.periods.slice(index, index + limit);
  const indices = [];
  let reason = "";
  for (let offset = 0; offset < candidates.length; offset++) {
    const p = candidates[offset];
    const duration = p.start ? daysBetween(p.start, p.end) + 1 : NaN;
    const validDuration =
      selected.kind === "annual"
        ? duration >= 300 && duration <= 400
        : duration >= 60 && duration <= 120;
    if (p.kind !== selected.kind || !validDuration) {
      reason =
        "The cumulative window stops where a reporting duration is unknown or incompatible.";
      break;
    }
    if (offset > 0 && daysBetween(p.end, candidates[offset - 1].start) !== 1) {
      reason =
        "The cumulative window stops at a gap or overlap; only consecutive, nonoverlapping periods are included.";
      break;
    }
    indices.push(index + offset);
  }
  return {
    indices,
    excluded: candidates.length - indices.length,
    period: indices.length
      ? { ...selected, start: data.periods[indices.at(-1)].start }
      : selected,
    cumulative: indices.length > 1,
    reason,
  };
}

const CASH_METRICS = [
  definition("operatingCashFlow", "Operating cash flow"),
  definition("netIncome", "Net income"),
  definition("capex", "PP&E purchases"),
  definition("freeCashFlow", "Operating cash flow less PP&E purchases"),
];

export function buildCashQuality(data, index = 0, count = 4) {
  const window = cashWindow(data, index, count);
  const rows = CASH_METRICS.map((def) => {
    const points = window.indices.map((i) =>
      compatibleFlow(pointAt(data, def.key, i), data.periods[i]),
    );
    const available = points.filter(finite).length;
    let point = window.indices.length
      ? calculateAnalysisPoint(
          window.period,
          points,
          `Sum of ${points.length} consecutive nonoverlapping ${data.periods[index].kind} observation${points.length === 1 ? "" : "s"} for ${def.label}; every period required`,
          (...values) => values.reduce((sum, value) => sum + value, 0),
        )
      : unavailable(
          window.period,
          window.reason || "No compatible reporting durations.",
        );
    if (window.indices.length === 1 && finite(points[0])) point = points[0];
    if (!finite(point) && window.indices.length)
      point = {
        ...point,
        reason:
          `${available} of ${points.length} periods have compatible reported inputs. The total is unavailable until every included period is covered. ${points.find((p) => !finite(p))?.reason || ""}`.trim(),
      };
    if (window.cumulative)
      point.note = `Cumulative total from ${window.period.start} through ${window.period.end}; not a single reported period.`;
    return { definition: def, point, available, total: points.length, points };
  });
  const ocf = rows.find((r) => r.definition.key === "operatingCashFlow").point;
  const income = rows.find((r) => r.definition.key === "netIncome").point;
  const conversion = calculateAnalysisPoint(
    window.period,
    [ocf, income],
    "Operating cash flow for the included duration / positive net income for the same duration × 100",
    (a, b) => (b > 0 ? (a / b) * 100 : NaN),
  );
  if (!finite(conversion) && finite(income) && income.value <= 0)
    conversion.reason =
      "Cash conversion is not meaningful when the included net income is zero or negative.";
  const difference = calculateAnalysisPoint(
    window.period,
    [ocf, income],
    "Operating cash flow − net income across the same included periods; this is a residual, not attribution to individual noncash or working-capital drivers",
    (a, b) => a - b,
  );
  return { ...window, rows, conversion, difference };
}

/** Industry-limited operating-cycle estimates, using exact duration opening balances. */
export function buildWorkingCapital(data, index = 0) {
  const period = data.periods[index];
  const days = period?.start ? daysBetween(period.start, period.end) + 1 : NaN;
  if (data.lens !== "corporate")
    return {
      available: false,
      days: null,
      rows: [],
      reason:
        "Receivables, inventory and payables cycles are not applied to banks or insurers. Use their funding and capital disclosures instead.",
    };
  const definitions = [
    {
      key: "receivableDays",
      label: "Receivables days",
      balance: "receivables",
      flow: "revenue",
      labelFlow: "revenue",
      note: "Average current net receivables / revenue × actual period days. Revenue includes cash sales; this is an approximation, not a contractual collection term.",
    },
    {
      key: "inventoryDays",
      label: "Inventory days",
      balance: "inventory",
      flow: "costOfRevenue",
      labelFlow: "cost of revenue",
      note: "Average inventory / cost of revenue × actual period days.",
    },
    {
      key: "payableDays",
      label: "Payables days · cost-of-revenue proxy",
      balance: "accountsPayable",
      flow: "costOfRevenue",
      labelFlow: "cost of revenue",
      note: "Average current accounts payable / cost of revenue × actual period days. Cost of revenue is a proxy for purchases, so this is an estimate.",
    },
  ];
  const rows = definitions.map((d) => {
    const openingKey = `opening${d.balance[0].toUpperCase()}${d.balance.slice(1)}`;
    const opening = pointAt(data, openingKey, index);
    const ending = pointAt(data, d.balance, index);
    const flow = compatibleFlow(pointAt(data, d.flow, index), period);
    let average;
    if (finite(opening) && finite(ending) && !sameConcept(opening, ending))
      average = unavailable(
        period,
        "The opening and ending balances use different reported concepts; a comparable average cannot be established.",
      );
    else
      average = calculateAnalysisPoint(
        period,
        [opening, ending],
        `(Balance immediately before ${period?.start || "the selected start"} + balance at ${period?.end || "the selected end"}) / 2`,
        (a, b) => (a >= 0 && b >= 0 ? (a + b) / 2 : NaN),
      );
    const point = calculateAnalysisPoint(
      period,
      [average, flow],
      `Average ${d.balance} / positive ${d.labelFlow} × ${Number.isFinite(days) ? days : "actual"} period days`,
      (a, b) => (b > 0 && days > 0 && days <= 400 ? (a / b) * days : NaN),
    );
    if (!finite(average)) point.reason = average.reason;
    else if (!finite(flow) && flow?.reason) point.reason = flow.reason;
    point.note = d.note;
    return {
      definition: definition(d.key, d.label, "days"),
      point,
      opening,
      ending,
      average,
      note: d.note,
    };
  });
  const cycle = calculateAnalysisPoint(
    period,
    rows.map((r) => r.point),
    "Receivables days + inventory days − payables days (using cost of revenue as a purchases proxy)",
    (a, b, c) => a + b - c,
  );
  return { available: true, days, rows, cycle, reason: "" };
}

const CORPORATE_ASSETS = [
  ["cash", "Reported cash"],
  ["shortTermInvestments", "Short-term investments"],
  ["receivables", "Current net receivables"],
  ["inventory", "Inventory"],
  ["ppe", "Net property, plant & equipment"],
  ["goodwill", "Goodwill"],
  ["intangibles", "Intangibles excluding goodwill"],
];
const FINANCIAL_ASSETS = [
  ["cash", "Reported cash"],
  ["shortTermInvestments", "Short-term investments"],
  ["loans", "Reported net loans"],
  ["goodwill", "Goodwill"],
  ["intangibles", "Intangibles excluding goodwill"],
];
function capitalChange(current, before, period) {
  if (!finite(current) || !finite(before))
    return unavailable(
      period,
      "Both balance-sheet dates require reported inputs.",
    );
  if (!sameConcept(current, before))
    return unavailable(
      period,
      "The reported concept changes between these dates. Inspect the original sources before comparing.",
    );
  return calculateAnalysisPoint(
    period,
    [current, before],
    "Selected balance − comparison balance; same reported concept and unit",
    (a, b) => a - b,
  );
}

export function buildCapitalLab(data, settings = {}, index = 0) {
  const period = data.periods[index];
  const beforeIndex = analysisBaseline(
    data.periods,
    index,
    settings.baseline || "year",
  );
  const beforePeriod = data.periods[beforeIndex];
  const assets = pointAt(data, "totalAssets", index);
  const makeRow = ([key, label]) => {
    const point =
      pointAt(data, key, index) ||
      unavailable(period, "This reported input is unavailable.");
    const before = pointAt(data, key, beforeIndex);
    const share = calculateAnalysisPoint(
      period,
      [point, assets],
      `${label} / total assets × 100`,
      (a, b) => (b > 0 ? (a / b) * 100 : NaN),
    );
    return {
      definition: definition(key, label),
      point,
      before,
      share,
      change: capitalChange(point, before, period),
    };
  };
  const assetRows = (
    data.lens === "corporate"
      ? CORPORATE_ASSETS
      : FINANCIAL_ASSETS.filter(
          ([key]) => data.lens === "banking" || key !== "loans",
        )
  ).map(makeRow);
  const fundingRows = [
    ...(data.lens === "banking" ? [["deposits", "Deposits"]] : []),
    ["totalLiabilities", "Total liabilities"],
    ["stockholdersEquity", "Reported stockholders’ equity"],
    ["longTermDebt", "Reported long-term debt concept"],
    ["shortTermDebt", "Reported current debt concept"],
  ].map(makeRow);
  const ratio = (key, label, aKey, bKey, note) => ({
    definition: definition(key, label, "percent"),
    point: {
      ...calculateAnalysisPoint(
        period,
        [pointAt(data, aKey, index), pointAt(data, bKey, index)],
        `${aKey} / positive ${bKey} × 100`,
        (a, b) => (b > 0 ? (a / b) * 100 : NaN),
      ),
      note,
    },
  });
  const ratios = [
    ratio(
      "capitalEquityAssets",
      "Book equity / assets",
      "stockholdersEquity",
      "totalAssets",
      "Reported book equity may exclude noncontrolling interests. This is an accounting ratio, not a regulatory capital ratio.",
    ),
    ratio(
      "capitalCashAssets",
      "Reported cash / assets",
      "cash",
      "totalAssets",
      "Cash concept coverage differs by issuer. This does not establish availability, collateral encumbrance or regulatory liquidity.",
    ),
    ratio(
      "capitalLiabilitiesAssets",
      "Liabilities / assets",
      "totalLiabilities",
      "totalAssets",
      "Includes operating and financial liabilities. This is not a debt ratio.",
    ),
  ];
  if (data.lens === "banking")
    ratios.push(
      ratio(
        "capitalLoansDeposits",
        "Net loans / deposits",
        "loans",
        "deposits",
        "Uses reported net loans; allowance treatment must be reviewed when comparing institutions.",
      ),
      ratio(
        "capitalDepositsLiabilities",
        "Deposits / liabilities",
        "deposits",
        "totalLiabilities",
        "Deposit funding share; this does not distinguish uninsured, wholesale or operational deposits.",
      ),
    );
  return {
    period,
    beforeIndex,
    beforePeriod,
    assets,
    assetRows,
    fundingRows,
    ratios,
  };
}
