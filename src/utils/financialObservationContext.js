import { evidenceSources } from "./researchEvidence.js";

const DAY = 86400000;
const OPENING_METRICS = new Set([
  "openingReceivables",
  "openingInventory",
  "openingAccountsPayable",
]);
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const before = (value) =>
  date(value)
    ? new Date(Date.parse(value) - DAY).toISOString().slice(0, 10)
    : null;

/** A filing can contain several comparative columns. Only the fact context
 * establishes when a reported amount was measured; filed/fy/fp do not. */
export function financialSourcePeriod(source) {
  if (
    !date(source?.end) ||
    (source.start != null && (!date(source.start) || source.start > source.end))
  )
    return null;
  return {
    kind: source.start == null ? "instant" : "duration",
    start: source.start || null,
    end: source.end,
  };
}

export function financialSourcePeriodLabel(source) {
  const period = financialSourcePeriod(source);
  return period
    ? period.kind === "instant"
      ? `As of ${period.end}`
      : `${period.start} to ${period.end}`
    : "Observation dates not supplied";
}

/** Read-time context also repairs the presentation of older saved captures.
 * point.period remains the analytical window used for rankings/calculations.
 * A calculated result retains each raw input date instead of pretending that
 * every source observation covers that same window. */
export function financialObservationContext(
  point,
  metricKey,
  reportingPeriod = point?.period,
) {
  const sources = evidenceSources(point);
  const periods = sources.map(financialSourcePeriod);
  const distinct = new Map(
    periods
      .filter(Boolean)
      .map((period) => [
        `${period.kind}:${period.start || ""}:${period.end}`,
        period,
      ]),
  );
  const single = distinct.size === 1 ? [...distinct.values()][0] : null;
  const calculated = point?.classification === "calculated" || !!point?.formula;
  const opening = OPENING_METRICS.has(metricKey);
  const role = opening
    ? "opening"
    : single?.kind === "instant"
      ? "closing"
      : single?.kind === "duration"
        ? "duration"
        : sources.length
          ? "mixed"
          : "unknown";
  // A quarter derived by subtracting two YTD flows and a TTM assembled from
  // quarters are calculations for the requested window, not for either input.
  const observationPeriod =
    calculated &&
    role !== "closing" &&
    date(reportingPeriod?.start) &&
    date(reportingPeriod?.end)
      ? {
          kind: "duration",
          start: reportingPeriod.start,
          end: reportingPeriod.end,
        }
      : single;
  const label = {
    opening: "Opening balance date",
    closing: "Balance-sheet date",
    duration: calculated ? "Calculation period" : "Observation period",
    mixed: "Calculation period",
    unknown: "Observation date",
  }[role];
  let issue = null;
  if (!Number.isFinite(point?.value)) {
    issue = point?.reason || "A reported or calculated value is unavailable.";
  } else if (!sources.length) {
    issue = "The source observations needed to verify this value are missing.";
  } else if (periods.some((period) => !period)) {
    issue = "A source observation has missing or invalid dates.";
  } else if (
    date(reportingPeriod?.end) &&
    periods.some((period) => period.end > reportingPeriod.end)
  ) {
    issue =
      "A source observation is later than the selected reporting endpoint.";
  } else if (!calculated) {
    if (
      sources.some(
        (source) =>
          !Number.isFinite(source.value) || source.value !== point.value,
      )
    )
      issue =
        "The displayed reported value does not match its cited source observation.";
    else if (
      point.unit &&
      sources.some((source) => source.unit && source.unit !== point.unit)
    )
      issue =
        "The displayed reported unit does not match its cited source observation.";
    else if (!single)
      issue =
        "A reported value is associated with more than one observation period.";
    else if (
      opening &&
      (single.kind !== "instant" ||
        single.end !== before(reportingPeriod?.start))
    )
      issue =
        "The opening balance must be dated immediately before the selected reporting duration.";
    else if (
      !opening &&
      date(reportingPeriod?.end) &&
      single.end !== reportingPeriod.end
    )
      issue =
        "The reported observation is not dated at the selected reporting endpoint.";
    else if (
      single.kind === "duration" &&
      date(reportingPeriod?.start) &&
      Math.abs(Date.parse(single.start) - Date.parse(reportingPeriod.start)) >
        3 * DAY
    )
      issue =
        "The reported observation covers a different duration from the selected reporting period.";
  }
  const averageBalance = ["averageAssets", "averageEquity"].includes(metricKey);
  const explanation =
    averageBalance && role === "mixed"
      ? `Average of the opening and closing balances at ${[...new Set(periods.filter((period) => period?.kind === "instant").map((period) => period.end))].sort().join(" and ")}. This average is calculated for the analytical period; it is not a single balance-sheet column.`
      : role === "opening"
        ? `This is the balance immediately before ${reportingPeriod?.start || "the selected reporting duration"}. A later filing can report this earlier comparative balance; the filing year is not the balance date.`
        : role === "closing"
          ? calculated
            ? `Calculated from reported balances as of ${observationPeriod?.end}. Match each input to that dated column; the result is not a separately reported balance.`
            : "This balance is measured at the period end. Use the column with this balance-sheet date in the cited filing."
          : role === "mixed"
            ? "This result uses inputs with different observation dates. Each source amount and its actual dates are shown below."
            : role === "duration"
              ? "This figure covers the displayed observation dates. A filing may also contain other quarterly, year-to-date, or prior-year columns."
              : "The source observation dates are needed to identify the matching column in the filing.";
  return {
    role,
    observationPeriod,
    reportingPeriod: reportingPeriod || null,
    label,
    periodLabel: financialSourcePeriodLabel(observationPeriod),
    explanation,
    valid: !issue,
    issue,
    sources,
  };
}
