/** Explicit reporting perspectives shared by requests, saved captures and research tools. */
export const PORTFOLIO_REPORTING_BASES = Object.freeze([
  "annual",
  "quarter",
  "ytd",
  "ttm",
]);
export const PORTFOLIO_REPORTING_OPTIONS = Object.freeze(
  [
    {
      value: "annual",
      label: "Annual",
      description: "The latest complete fiscal year reported by each company.",
    },
    {
      value: "quarter",
      label: "Quarterly",
      description:
        "The latest standalone fiscal quarter; cumulative cash flows are differenced only when compatible inputs exist.",
    },
    {
      value: "ytd",
      label: "Fiscal year to date",
      description:
        "From each company's fiscal year start through its latest interim report. Companies can have different fiscal calendars and elapsed periods.",
    },
    {
      value: "ttm",
      label: "Trailing twelve months",
      description:
        "The latest complete twelve-month window supported by reported evidence.",
    },
  ].map((option) => Object.freeze(option)),
);
export const PORTFOLIO_YTD_LENGTHS = Object.freeze([
  Object.freeze({ value: "3m", label: "3 months" }),
  Object.freeze({ value: "6m", label: "6 months" }),
  Object.freeze({ value: "9m", label: "9 months" }),
  Object.freeze({ value: "12m", label: "Full fiscal year" }),
]);

export const portfolioReportingLabel = (basis) =>
  basis === "instant"
    ? "Point in time"
    : PORTFOLIO_REPORTING_OPTIONS.find((option) => option.value === basis)
        ?.label || "Unknown reporting basis";

const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** A date alone never establishes a compatible duration or a flow window. */
export const portfolioPeriodKey = (period) =>
  period &&
  PORTFOLIO_REPORTING_BASES.includes(period.kind) &&
  validDate(period.start) &&
  validDate(period.end) &&
  period.start <= period.end
    ? [period.kind, period.start, period.end].join("|")
    : "";

/** Exact boundaries keep a three-month YTD observation apart from a six-month one. */
export const samePortfolioPeriod = (a, b) => {
  const key = portfolioPeriodKey(a);
  return Boolean(key && key === portfolioPeriodKey(b));
};

/** Elapsed fiscal YTD length comes from dates, not the fiscal tag of a later filing. */
export const portfolioPeriodLengthGroup = (period) => {
  if (period?.kind !== "ytd" || !portfolioPeriodKey(period)) return null;
  const days =
    (Date.parse(period.end) - Date.parse(period.start)) / 86400000 + 1;
  return (
    [
      { minimum: 60, maximum: 120, value: "3m" },
      { minimum: 150, maximum: 210, value: "6m" },
      { minimum: 240, maximum: 300, value: "9m" },
      { minimum: 330, maximum: 400, value: "12m" },
    ].find(({ minimum, maximum }) => days >= minimum && days <= maximum)
      ?.value || null
  );
};

export const portfolioFiscalQuarter = (period) => {
  if (!portfolioPeriodKey(period)) return null;
  if (period.kind === "ytd") {
    const length = portfolioPeriodLengthGroup(period);
    return { "3m": "Q1", "6m": "Q2", "9m": "Q3", "12m": "Q4" }[length] || null;
  }
  if (period.kind !== "quarter") return null;
  if (/^Q[1-4]$/.test(period.fp || "")) return period.fp;
  const quarter = Number(period.quarter);
  return Number.isInteger(quarter) && quarter >= 1 && quarter <= 4
    ? `Q${quarter}`
    : null;
};

export const portfolioPeriodLabel = (period) => {
  if (typeof period === "string")
    return period || "Reporting period unavailable";
  if (!period || !validDate(period.end)) return "Reporting period unavailable";
  if (period.kind === "instant") return `As of ${period.end}`;
  return portfolioPeriodKey(period)
    ? `${portfolioReportingLabel(period.kind)}: ${period.start} to ${period.end}`
    : `Period ending ${period.end}; start or basis unavailable`;
};
