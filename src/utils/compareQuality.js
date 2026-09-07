import { evidenceSources } from "./researchEvidence.js";
import { daysBetween } from "./xbrlPeriods.js";

const DAY = 86400000;
const INSTANT_METRICS = new Set([
  "totalAssets",
  "stockholdersEquity",
  "equityAssets",
  "cash",
  "cashAssets",
  "currentRatio",
  "debtAssets",
  "deposits",
  "loans",
  "loanDeposits",
  "allowanceLoans",
  "shortTermDebt",
  "longTermDebt",
  "currentAssets",
  "currentLiabilities",
  "allowanceForLoanLoss",
]);
const FLOW_METRICS = new Set([
  "netIncome",
  "roe",
  "roa",
  "revenue",
  "operatingIncome",
  "operatingMargin",
  "netMargin",
  "operatingCashFlow",
  "freeCashFlow",
  "capex",
  "netInterestIncome",
  "noninterestIncome",
  "bankRevenue",
  "provisionLoans",
  "efficiency",
  "premiumsEarned",
  "investmentIncome",
  "provisionForLoanLoss",
  "noninterestExpense",
]);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const adjacentDay = (value, offset) =>
  date(value)
    ? new Date(Date.parse(value) + offset * DAY).toISOString().slice(0, 10)
    : null;
const signature = (source) =>
  [source.taxonomy || "", source.tag || "", source.unit || ""].join(":");

/** A derived quarter can subtract YTD observations and a TTM can sum those
 * quarters. Every concept's reported intervals must connect the requested
 * endpoints; merely accepting a 300–400 day source is insufficient. */
function connectsDuration(sources, period) {
  const groups = new Map();
  for (const source of sources) {
    const key = signature(source);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([source.start, adjacentDay(source.end, 1)]);
  }
  return [...groups.values()].every((intervals) => {
    const starts = [
      period.start,
      ...intervals
        .flat()
        .filter((value) => Math.abs(daysBetween(period.start, value)) <= 3),
    ];
    const seen = new Set(starts);
    const pending = [...seen];
    while (pending.length) {
      const current = pending.shift();
      for (const [start, end] of intervals) {
        const next = start === current ? end : end === current ? start : null;
        if (next && !seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
    return seen.has(adjacentDay(period.end, 1));
  });
}

/** Numerical/source compatibility, not an assessment of investment merit.
 * Original values remain inspectable even when they cannot enter benchmarks. */
export function comparePointQuality(point, metricKey, period = point?.period) {
  const issues = [];
  const sources = evidenceSources(point);
  const flows = sources.filter((source) => source.start != null);
  const flow =
    !INSTANT_METRICS.has(metricKey) &&
    (flows.length > 0 || FLOW_METRICS.has(metricKey) || sources.length === 0);
  const durationDays =
    flow && date(period?.start) && date(period?.end)
      ? daysBetween(period.start, period.end) + 1
      : null;
  const concepts = [...new Set(sources.map(signature))].sort();
  const result = (reason = null) => ({
    valid: !reason,
    reason,
    issues,
    durationDays,
    flow,
    concepts,
  });
  if (!Number.isFinite(point?.value))
    return result(
      point?.reason || "A reported or calculated value is unavailable.",
    );
  if (
    !date(period?.end) ||
    (period.start != null && (!date(period.start) || period.start > period.end))
  )
    return result("The selected reporting dates are incomplete or invalid.");
  if (
    point.period &&
    (point.period.end !== period.end ||
      point.period.kind !== period.kind ||
      (point.period.start || null) !== (period.start || null))
  )
    return result(
      "The observation does not belong to this selected reporting period.",
    );
  if (!sources.length) {
    if (point.classification)
      return result(
        "Reported source evidence is missing; this value cannot enter benchmarks.",
      );
    issues.push(
      "Legacy observation: only reporting-period metadata is available.",
    );
  }
  if (
    sources.some(
      (source) =>
        !date(source.end) ||
        source.end > period.end ||
        (source.start != null &&
          (!date(source.start) || source.start > source.end)),
    )
  )
    return result(
      "A reported input has invalid dates or extends beyond the selected reporting endpoint.",
    );
  if (sources.some((source) => source.unit !== "USD"))
    return result(
      "Every monetary input must use USD; currencies are not substituted.",
    );
  if (
    period.asOf &&
    sources.some((source) => !date(source.filed) || source.filed > period.asOf)
  )
    return result("An input was not filed by the selected filing cutoff.");
  if (sources.some((source) => source.revised))
    issues.push(
      "A source context has different filed values. Inspect its filings before attributing the difference to a restatement.",
    );
  if (flow) {
    if (!durationDays)
      return result(
        "A complete reporting duration is required for flow comparisons.",
      );
    if (sources.length && !flows.length)
      return result(
        "A flow metric requires duration evidence rather than only balance-sheet dates.",
      );
    if (flows.length && !connectsDuration(flows, period))
      return result(
        "The actual reported flow durations do not support the selected start and end dates.",
      );
  } else if (flows.length) {
    return result(
      "A balance-sheet metric contains duration inputs and needs definition review.",
    );
  }
  const allowedBalanceEnds = new Set([period.end]);
  if (["roe", "roa"].includes(metricKey) && date(period.start))
    allowedBalanceEnds.add(adjacentDay(period.start, -1));
  if (
    sources.some(
      (source) => source.start == null && !allowedBalanceEnds.has(source.end),
    )
  )
    return result(
      "A balance input is not at the selected endpoint or the required opening balance date.",
    );
  return result();
}

/** Temporal compatibility only; callers select the intended annual/quarterly
 * baseline before applying this check. Source-definition changes require review. */
export function comparePairQuality(current, prior, metricKey) {
  const a = comparePointQuality(current, metricKey);
  const b = comparePointQuality(prior, metricKey);
  if (!a.valid || !b.valid)
    return { valid: false, reason: a.reason || b.reason };
  if (current.period?.kind !== prior.period?.kind)
    return { valid: false, reason: "The reporting bases differ." };
  if (
    a.flow !== b.flow ||
    (a.flow && Math.abs(a.durationDays - b.durationDays) > 14)
  )
    return {
      valid: false,
      reason: "The reporting durations differ by more than 14 days.",
    };
  if (
    a.concepts.length &&
    b.concepts.length &&
    a.concepts.join("|") !== b.concepts.join("|")
  )
    return {
      valid: false,
      reason:
        "The reported source concepts differ between periods; review their definitions before comparing changes.",
    };
  return { valid: true, reason: null };
}
