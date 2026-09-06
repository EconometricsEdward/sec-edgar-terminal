import {
  buildMetricRow,
  extractAnnualPeriods,
  extractQuarterlyPeriods,
  withPeriodKind,
} from "./xbrlParser.js";
import {
  daysBetween,
  FINANCIAL_DATA_VERSION,
  sourceDocumentUrl,
} from "./xbrlPeriods.js";
import { evidenceSources, evidenceCalculations } from "./researchEvidence.js";
import { classifyIndustry } from "./industry.js";

export const COMPARE_VERSION = `compare-v1:${FINANCIAL_DATA_VERSION}`;
export const MAX_COMPARE_COMPANIES = 5;
const raw = (key, label, lenses, category = "Scale") => ({
  key,
  label,
  lenses,
  category,
  format: "currency",
});
const ratio = (
  key,
  label,
  inputs,
  formula,
  lenses,
  category = "Profitability",
  format = "percent",
) => ({ key, label, inputs, formula, lenses, category, format });
const all = ["common", "corporate", "banking", "insurance"];
export const COMPARE_METRICS = [
  raw("totalAssets", "Total assets", all),
  raw("stockholdersEquity", "Equity", all),
  raw("netIncome", "Net income", all),
  ratio(
    "roe",
    "Return on average equity",
    ["netIncome", "stockholdersEquity"],
    "Net income / average beginning and ending equity × annualization factor × 100",
    all,
  ),
  ratio(
    "roa",
    "Return on average assets",
    ["netIncome", "totalAssets"],
    "Net income / average beginning and ending assets × annualization factor × 100",
    all,
  ),
  ratio(
    "equityAssets",
    "Equity / assets",
    ["stockholdersEquity", "totalAssets"],
    "Equity / total assets × 100",
    all,
    "Capital",
  ),
  raw("revenue", "Revenue", ["corporate"]),
  raw("operatingIncome", "Operating income", ["corporate"]),
  ratio(
    "operatingMargin",
    "Operating margin",
    ["operatingIncome", "revenue"],
    "Operating income / revenue × 100",
    ["corporate"],
  ),
  ratio(
    "netMargin",
    "Net margin",
    ["netIncome", "revenue"],
    "Net income / revenue × 100",
    ["corporate"],
  ),
  raw("cash", "Reported cash", all, "Liquidity"),
  raw("operatingCashFlow", "Operating cash flow", ["corporate"], "Cash flow"),
  ratio(
    "freeCashFlow",
    "Free cash flow",
    ["operatingCashFlow", "capex"],
    "Operating cash flow − reported purchases of property, plant and equipment",
    ["corporate"],
    "Cash flow",
    "currency",
  ),
  ratio(
    "cashAssets",
    "Cash / assets",
    ["cash", "totalAssets"],
    "Reported cash / total assets × 100",
    all,
    "Liquidity",
  ),
  ratio(
    "currentRatio",
    "Current ratio",
    ["currentAssets", "currentLiabilities"],
    "Current assets / current liabilities",
    ["corporate"],
    "Liquidity",
    "decimal",
  ),
  ratio(
    "debtAssets",
    "Reported debt / assets",
    ["shortTermDebt", "longTermDebt", "totalAssets"],
    "(Reported current debt + noncurrent debt) / assets × 100; both debt components required",
    ["corporate", "insurance"],
    "Capital",
  ),
  raw("netInterestIncome", "Net interest income", ["banking"]),
  raw("noninterestIncome", "Noninterest income", ["banking"]),
  ratio(
    "bankRevenue",
    "Net interest + noninterest income",
    ["netInterestIncome", "noninterestIncome"],
    "Net interest income before provision + noninterest income",
    ["banking"],
    "Scale",
    "currency",
  ),
  raw("deposits", "Deposits", ["banking"], "Funding"),
  raw("loans", "Reported net loans", ["banking"], "Credit"),
  ratio(
    "loanDeposits",
    "Net loans / deposits",
    ["loans", "deposits"],
    "Reported net loans / deposits × 100",
    ["banking"],
    "Funding",
  ),
  ratio(
    "allowanceLoans",
    "Allowance / net loans",
    ["allowanceForLoanLoss", "loans"],
    "Reported allowance for credit losses / net loans × 100",
    ["banking"],
    "Credit",
  ),
  ratio(
    "provisionLoans",
    "Provision / net loans",
    ["provisionForLoanLoss", "loans"],
    "Credit loss provision / ending net loans × annualization factor × 100",
    ["banking"],
    "Credit",
  ),
  ratio(
    "efficiency",
    "Efficiency ratio",
    ["noninterestExpense", "netInterestIncome", "noninterestIncome"],
    "Noninterest expense / (net interest income before provision + noninterest income) × 100",
    ["banking"],
  ),
  raw("premiumsEarned", "Net premiums earned", ["insurance"]),
  raw("investmentIncome", "Investment income", ["insurance"]),
];
export const METRIC_BY_KEY = Object.fromEntries(
  COMPARE_METRICS.map((m) => [m.key, m]),
);

export function companyLens(sic) {
  const code = Number(sic);
  // Broker-dealers can have banking subsidiaries. Their actual source coverage
  // is retained; this lens is not a claim of identical business models.
  if (code >= 6000 && code <= 6299) return "banking";
  return classifyIndustry(sic) === "insurance" ? "insurance" : "corporate";
}
export function inferLens(companies) {
  const groups = new Set(
    companies.filter((c) => c.data).map((c) => c.data.lens),
  );
  return groups.size === 1 ? [...groups][0] : "common";
}
export function defaultMetrics(lens) {
  return lens === "banking"
    ? [
        "bankRevenue",
        "netIncome",
        "roe",
        "roa",
        "equityAssets",
        "deposits",
        "loanDeposits",
        "allowanceLoans",
        "provisionLoans",
        "efficiency",
      ]
    : lens === "insurance"
      ? [
          "premiumsEarned",
          "investmentIncome",
          "netIncome",
          "roe",
          "roa",
          "equityAssets",
          "totalAssets",
          "cashAssets",
        ]
      : lens === "corporate"
        ? [
            "revenue",
            "netIncome",
            "operatingMargin",
            "roe",
            "roa",
            "freeCashFlow",
            "currentRatio",
            "debtAssets",
            "cashAssets",
            "totalAssets",
          ]
        : [
            "totalAssets",
            "stockholdersEquity",
            "netIncome",
            "roe",
            "roa",
            "equityAssets",
          ];
}
const dayBefore = (date) =>
  new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
const unavailable = (
  period,
  reason = "No compatible USD fact for this period. Custom tags and other currencies are not substituted.",
) => ({
  period,
  value: null,
  classification: "unavailable",
  reason,
  sources: [],
});
function derived(metric, period, points, beginning) {
  const inputs = beginning ? [...points, beginning] : points;
  if (inputs.some((p) => !Number.isFinite(p?.value)))
    return unavailable(
      period,
      "One or more required reported inputs are missing.",
    );
  const [a, b, c] = points.map((p) => p.value);
  const factor =
    ["quarter", "ytd"].includes(period.kind) && period.start
      ? 365 / (daysBetween(period.start, period.end) + 1)
      : ["quarter", "ytd"].includes(period.kind)
        ? null
        : 1;
  let value;
  if (["roe", "roa"].includes(metric.key)) {
    const average = (b + beginning.value) / 2;
    value = average > 0 && factor != null ? (a / average) * factor * 100 : null;
  } else if (metric.key === "freeCashFlow") value = a - b;
  else if (metric.key === "bankRevenue") value = a + b;
  else if (metric.key === "efficiency")
    value = b + c > 0 ? (a / (b + c)) * 100 : null;
  else if (metric.key === "debtAssets")
    value = c > 0 ? ((a + b) / c) * 100 : null;
  else
    value =
      b > 0
        ? (a / b) *
          (metric.format === "decimal" ? 1 : 100) *
          (metric.key === "provisionLoans" ? (factor ?? NaN) : 1)
        : null;
  if (!Number.isFinite(value))
    return unavailable(
      period,
      "The formula requires a positive denominator and a complete reporting duration.",
    );
  return {
    period,
    value,
    classification: "calculated",
    formula: metric.formula,
    note:
      ["roe", "roa", "provisionLoans"].includes(metric.key) &&
      ["quarter", "ytd"].includes(period.kind)
        ? "Income is annualized using 365 / days in the selected reporting duration."
        : null,
    sources: inputs.flatMap(evidenceSources),
    calculations: inputs.flatMap((p) => [
      ...evidenceCalculations(p),
      ...(p.formula
        ? [
            {
              formula: p.formula,
              value: p.value,
              start: p.period?.start,
              end: p.period?.end,
            },
          ]
        : []),
    ]),
  };
}

/** Compact, provenance-preserving response: the browser never downloads entire companyfacts files. */
export function buildCompareCompany(
  company,
  { basis = "annual", asOf = "" } = {},
) {
  const facts = company.facts;
  const lens = companyLens(company.sic);
  const periods = (
    basis === "annual"
      ? extractAnnualPeriods(facts, asOf)
      : withPeriodKind(extractQuarterlyPeriods(facts, asOf), basis)
  ).slice(0, basis === "annual" ? 11 : 41);
  const cache = new Map();
  const get = (key, period) => {
    const id = `${key}:${period.end}:${period.start}:${period.kind}`;
    if (!cache.has(id))
      cache.set(
        id,
        buildMetricRow(
          facts,
          key,
          key,
          [period],
          "currency",
          lens === "banking" ? "banking" : company.sic,
        ).values[0],
      );
    return cache.get(id);
  };
  const metrics = Object.fromEntries(
    COMPARE_METRICS.map((metric) => [
      metric.key,
      periods.map((period) => {
        if (!metric.lenses.includes(lens))
          return unavailable(
            period,
            `Not applicable to this company's ${lens} lens.`,
          );
        if (basis === "ttm" && !period.start)
          return unavailable(
            period,
            "Four consecutive standalone quarters are required for this trailing-year period.",
          );
        let point;
        if (!metric.inputs) point = get(metric.key, period);
        else {
          const inputs = metric.inputs.map((key) => get(key, period));
          const beginning = ["roe", "roa"].includes(metric.key)
            ? period.start
              ? get(metric.inputs[1], {
                  ...period,
                  end: dayBefore(period.start),
                })
              : unavailable(period)
            : null;
          point = derived(metric, period, inputs, beginning);
        }
        const sources = evidenceSources(point).map((s) => ({
          ...s,
          documentUrl:
            company.filings?.find((f) => f.accession === s.accession)
              ?.documentUrl || sourceDocumentUrl(company.cik, s),
        }));
        return {
          ...point,
          period,
          sources,
          source: undefined,
          reason:
            point?.value == null
              ? point.reason || point.note || unavailable(period).reason
              : null,
        };
      }),
    ]),
  );
  return {
    version: COMPARE_VERSION,
    ticker: company.ticker,
    name: company.companyName,
    cik: company.cik,
    sic: company.sic,
    lens,
    basis,
    asOf,
    observedAt: new Date().toISOString(),
    periods,
    metrics,
    note: "USD only. Latest available reported context within the selected filing cutoff; subsequent comparative filings can revise earlier periods. Missing custom-tag data remains unavailable.",
  };
}

export function periodBucket(period, basis = "annual") {
  return basis === "annual"
    ? period.end.slice(0, 4)
    : `${period.end.slice(0, 4)}-Q${Math.ceil(Number(period.end.slice(5, 7)) / 3)}`;
}
export function uniqueIssuerCompanies(companies) {
  const seen = new Set();
  return companies.map((c) => {
    const cik = c.data?.cik;
    const duplicate = cik && seen.has(cik);
    if (cik) seen.add(cik);
    return { ...c, duplicate: !!duplicate };
  });
}
export function comparisonSelection(companies, settings) {
  const active = uniqueIssuerCompanies(companies).filter(
    (c) => !c.duplicate && !settings.excluded?.includes(c.ticker),
  );
  const ready = active.filter((c) => c.data?.periods?.length);
  const buckets = [
    ...new Set(
      ready.flatMap((c) =>
        c.data.periods.map((p) => periodBucket(p, settings.basis)),
      ),
    ),
  ]
    .sort()
    .reverse();
  const shared = buckets.filter((b) =>
    ready.every((c) =>
      c.data.periods.some((p) => periodBucket(p, settings.basis) === b),
    ),
  );
  const bucket =
    settings.period !== "latest"
      ? settings.period
      : settings.alignment === "common"
        ? shared[0]
        : null;
  const entries = active.map((company) => {
    const index =
      company.data?.periods.findIndex((p) =>
        bucket
          ? periodBucket(p, settings.basis) === bucket
          : settings.alignment === "latest",
      ) ?? -1;
    return {
      ...company,
      index,
      period: index >= 0 ? company.data.periods[index] : null,
    };
  });
  const ends = entries
    .filter((c) => c.period)
    .map((c) => c.period.end)
    .sort();
  const span = ends.length ? daysBetween(ends[0], ends[ends.length - 1]) : null;
  return {
    entries,
    buckets,
    shared,
    bucket,
    span,
    ready: ready.length,
    requested: active.length,
  };
}
export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return !sorted.length
    ? null
    : sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
}
export function metricComparison(entries, key, benchmark = "median") {
  const metric = METRIC_BY_KEY[key];
  const cells = entries.map((c) => ({
    ticker: c.ticker,
    cik: c.data?.cik,
    name: c.data?.name,
    period: c.period,
    point: c.index >= 0 ? c.data.metrics[key]?.[c.index] : null,
    status: c.error
      ? "fetch failed"
      : c.loading
        ? "loading"
        : c.period
          ? "reviewed"
          : "period unavailable",
  }));
  const available = cells.filter((c) => Number.isFinite(c.point?.value));
  const ends = available.map((c) => c.period.end).sort();
  const durations = available
    .map((c) =>
      c.period.start ? daysBetween(c.period.start, c.period.end) + 1 : null,
    )
    .filter(Number.isFinite);
  const periodMismatch =
    ends.length > 1 &&
    (daysBetween(ends[0], ends.at(-1)) > 45 ||
      (durations.length > 1 &&
        Math.max(...durations) - Math.min(...durations) > 14));
  const reason = periodMismatch
    ? "Reporting dates differ by more than 45 days or durations by more than 14 days."
    : available.length < 2
      ? "At least two comparable issuers are required."
      : null;
  const eligible = !reason;
  const peerMedian = eligible
    ? median(available.map((c) => c.point.value))
    : null;
  const reference = eligible
    ? benchmark === "median"
      ? peerMedian
      : (available.find((c) => c.ticker === benchmark)?.point.value ?? null)
    : null;
  return {
    metric,
    cells: cells.map((c) => ({
      ...c,
      delta:
        reference != null && c.point?.value != null
          ? c.point.value - reference
          : null,
      rank:
        eligible && c.point?.value != null
          ? 1 + available.filter((v) => v.point.value > c.point.value).length
          : null,
    })),
    count: available.length,
    total: cells.length,
    peerMedian,
    reference,
    reason:
      reason ||
      (reference == null
        ? "The selected benchmark has no compatible value."
        : null),
  };
}
export function growthBetween(current, prior, format = "currency") {
  if (!Number.isFinite(current?.value) || !Number.isFinite(prior?.value))
    return { value: null, reason: "Both observations are required." };
  if (format === "percent" || format === "decimal")
    return {
      value: current.value - prior.value,
      unit: format === "percent" ? "pp" : "x",
    };
  if (prior.value <= 0)
    return {
      value: null,
      reason:
        "Percentage growth is not meaningful with a zero or negative base.",
    };
  return { value: (current.value / prior.value - 1) * 100, unit: "%" };
}
export function historicGrowth(company, key, index) {
  const points = company.metrics[key] || [];
  const current = points[index];
  if (!current)
    return {
      yoy: { value: null, reason: "No current observation." },
      cagr: null,
    };
  const prior = points.slice(index + 1).find((p) => {
    const gap = daysBetween(p.period.end, current.period.end);
    return gap >= 350 && gap <= 380;
  });
  const years = 3;
  const start = points
    .slice(index + 1)
    .find(
      (p) =>
        Math.abs(
          daysBetween(p.period.end, current.period.end) - years * 365.25,
        ) <= 16,
    );
  const metric = METRIC_BY_KEY[key];
  const elapsed = start
    ? daysBetween(start.period.end, current.period.end) / 365.25
    : null;
  const cagr =
    metric.format === "currency" && start?.value > 0 && current.value > 0
      ? (Math.pow(current.value / start.value, 1 / elapsed) - 1) * 100
      : null;
  return {
    yoy: growthBetween(current, prior, metric.format),
    cagr,
    prior,
    start,
  };
}

/** Use calendar end buckets, keep actual dates, and never bridge missing observations. */
export function trendSeries(
  entries,
  key,
  { basis = "annual", years = 5, mode = "absolute" } = {},
) {
  const allPoints = entries
    .filter((c) => c.data)
    .map((c) => ({
      ...c,
      points: (c.data.metrics[key] || []).filter(
        (p) => !c.period || p.period.end <= c.period.end,
      ),
    }));
  const observed = [
    ...new Set(
      allPoints.flatMap((c) =>
        c.points.map((p) => periodBucket(p.period, basis)),
      ),
    ),
  ].sort();
  const ordinal = (bucket) =>
    basis === "annual"
      ? Number(bucket)
      : Number(bucket.slice(0, 4)) * 4 + Number(bucket.at(-1)) - 1;
  const label = (n) =>
    basis === "annual" ? String(n) : `${Math.floor(n / 4)}-Q${(n % 4) + 1}`;
  const end = observed.length ? ordinal(observed.at(-1)) : null;
  const begin =
    end == null
      ? null
      : Math.max(
          ordinal(observed[0]),
          end - (basis === "annual" ? years : years * 4) + 1,
        );
  const buckets =
    end == null
      ? []
      : Array.from({ length: end - begin + 1 }, (_, i) => label(begin + i));
  const sharedBase = buckets.find((b) => {
    const points = allPoints.map((c) =>
      c.points.find((p) => periodBucket(p.period, basis) === b),
    );
    if (!points.length || !points.every((p) => p?.value > 0)) return false;
    const dates = points.map((p) => p.period.end).sort();
    return daysBetween(dates[0], dates.at(-1)) <= 45;
  });
  const rows = buckets.map((bucket) => {
    const row = { bucket };
    for (const c of allPoints) {
      const point = c.points.find(
        (p) => periodBucket(p.period, basis) === bucket,
      );
      const base = c.points.find(
        (p) => periodBucket(p.period, basis) === sharedBase,
      );
      row[c.ticker] =
        mode === "indexed"
          ? sharedBase && bucket >= sharedBase && point?.value != null
            ? (point.value / base.value) * 100
            : null
          : (point?.value ?? null);
      row[`${c.ticker}Date`] = point?.period.end;
    }
    return row;
  });
  return {
    rows,
    sharedBase,
    note:
      mode === "indexed"
        ? sharedBase
          ? `100 = ${sharedBase}; first shared positive observation with reporting ends within 45 days. Earlier points are omitted.`
          : "No shared positive base with comparable reporting dates exists; indexing is unavailable."
        : "Gaps remain gaps. Calendar buckets group reporting ends; actual reporting dates appear in the data table.",
  };
}
