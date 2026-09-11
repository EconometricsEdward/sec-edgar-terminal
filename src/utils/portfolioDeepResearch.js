import { ANALYSIS_VERSION } from "./analysisVersion.js";
import {
  PORTFOLIO_METRIC_CATALOG,
  portfolioMetricDefinitionFor,
} from "./portfolioMetricCatalog.js";
import {
  canonicalPortfolioCik,
  companyAvailable,
  finiteFinancialMetric,
} from "./portfolioModel.js";
import { analysisMetricGuide } from "./analysisMetricGuide.js";

export const metricUnit = (format) =>
  ({
    currency: "USD",
    percent: "%",
    decimal: "x",
    eps: "USD/shares",
    shares: "shares",
  })[format] || "USD";
export function metricDisplay(point, compact = true) {
  if (!finiteFinancialMetric(point))
    return point?.classification === "not_applicable"
      ? "Not applicable"
      : "Unavailable";
  const value = point.value.toLocaleString("en-US", {
    maximumFractionDigits: point.unit === "USD" ? 0 : 2,
    ...(compact && ["USD", "shares"].includes(point.unit)
      ? { notation: "compact" }
      : {}),
  });
  return point.unit === "USD"
    ? `$${value}`
    : `${value}${point.unit === "%" ? "%" : point.unit ? ` ${point.unit}` : ""}`;
}
export function portfolioResearchIssuers(report, companies) {
  const byCik = new Map(
    companies.map((c) => [canonicalPortfolioCik(c.cik), c]),
  );
  return report.concentration.issuers
    .filter((i) => i.kind !== "fund")
    .map((i) => ({
      ...i,
      ticker: i.tickers.join(" / "),
      company: byCik.get(i.cik),
      lens: byCik.get(i.cik)?.lens || "unknown",
    }));
}
const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export const metricPeriodKey = (point) => {
  const p = point?.period;
  return p &&
    ["annual", "ttm"].includes(p.kind) &&
    validDate(p.start) &&
    validDate(p.end) &&
    p.start <= p.end
    ? [p.kind, p.start, p.end].join("|")
    : "";
};
const metricApplies = (definition, lens) =>
  lens === "common"
    ? ["income", "balance", "cashflow"].includes(definition?.category) ||
      [
        "roe",
        "roa",
        "equityAssets",
        "cashAssets",
        "debt",
        "revenueGrowth",
      ].includes(definition?.key)
    : definition?.lenses?.includes(lens);

const captureRetrieved = company => Boolean(company) && ["ready", "partial", "ok", "success", "cached", "stale"].includes(company.status);

// One eligibility contract for selectors, rankings, comparisons and coverage.
// A missing field in an older capture is different from an explicitly null result.
export function portfolioMetricObservation(issuer, definition, period = "all") {
  const company = issuer.company;
  const point = company?.metrics?.[definition?.key];
  const excluded = (state, reasonCode, reason) => ({
    point,
    state,
    reasonCode,
    reason,
  });
  if (!captureRetrieved(company) || issuer.lens === "unknown")
    return excluded(
      "unavailable",
      "company-unavailable",
      "Financial evidence has not been retrieved successfully for this issuer. Refresh research or review its filings.",
    );
  if (
    !metricApplies(definition, issuer.lens) ||
    point?.classification === "not_applicable"
  )
    return excluded(
      "not-applicable",
      "not-applicable",
      "This measure does not apply to the selected business model.",
    );
  if (!point)
    return excluded(
      "unavailable",
      "not-captured",
      "This measure is not in the saved capture. Refresh research to request the expanded financial catalog.",
    );
  // Historical captures can contain the old G&A-only fallback. Do not rank it as combined SG&A.
  if (
    definition.key === "sga" &&
    point.sources?.length &&
    point.sources.every((s) => s.tag === "GeneralAndAdministrativeExpense")
  )
    return excluded(
      "unavailable",
      "incomplete-scope",
      "This older capture contains general and administrative expense alone, not combined SG&A. Refresh to request both selling and administrative components.",
    );
  if (!finiteFinancialMetric(point))
    return excluded(
      "unavailable",
      "missing-inputs",
      point.reason ||
        "The captured SEC evidence does not contain the compatible inputs needed for this measure. Review the filing; refreshing may not resolve a reporting gap.",
    );
  if (point.unit !== metricUnit(definition.format))
    return excluded(
      "unavailable",
      "incompatible-unit",
      "The reported unit does not match this measure, so the value cannot be compared.",
    );
  if (!metricPeriodKey(point))
    return excluded(
      "unknown-period",
      "unknown-period",
      "A complete, supported reporting period is missing. The value is withheld from comparisons.",
    );
  if (period !== "all" && metricPeriodKey(point) !== period)
    return excluded(
      "outside-period",
      "outside-period",
      "The captured value belongs to a different reporting period than the selected filter.",
    );
  return { point, state: "available", reasonCode: null, reason: null };
}
export function filterPortfolioMetricIssuers(
  issuers,
  { lens = "all", industry = "all", query = "" } = {},
) {
  const needle = query.trim().toLowerCase();
  return issuers.filter(
    (i) =>
      (lens === "all" || i.lens === lens) &&
      (industry === "all" || i.industry === industry) &&
      `${i.ticker} ${i.name}`.toLowerCase().includes(needle),
  );
}
export const PORTFOLIO_COVERAGE_REASONS = {
  "not-captured": "Not in this saved capture",
  "incomplete-scope": "Incomplete metric scope — refresh needed",
  "missing-inputs": "Missing or incompatible SEC inputs",
  "not-applicable": "Not applicable to this business model",
  "company-unavailable": "Issuer evidence needs review",
  "incompatible-unit": "Incompatible reported unit",
  "unknown-period": "Incomplete reporting period",
  "outside-period": "Outside the selected period",
};
export function portfolioMetricCoverage(issuers, { period = "all" } = {}) {
  return PORTFOLIO_METRIC_CATALOG.map((definition) => {
    let available = 0;
    const reasons = {};
    for (const issuer of issuers) {
      const observation = portfolioMetricObservation(
        issuer,
        definition,
        period,
      );
      if (observation.state === "available") available++;
      else
        reasons[observation.reasonCode] =
          (reasons[observation.reasonCode] || 0) + 1;
    }
    return { ...definition, available, population: issuers.length, reasons };
  });
}
export function portfolioCaptureCoverage(issuers) {
  return {
    legacy: issuers.filter(
      (i) => captureRetrieved(i.company) && !i.company.analysisVersion,
    ).length,
    outdated: issuers.filter(
      (i) =>
        captureRetrieved(i.company) &&
        i.company.analysisVersion &&
        i.company.analysisVersion !== ANALYSIS_VERSION,
    ).length,
    population: issuers.length,
  };
}

const quantile = (values, p) => {
  if (!values.length) return null;
  const i = (values.length - 1) * p;
  return (
    values[Math.floor(i)] +
    (values[Math.ceil(i)] - values[Math.floor(i)]) * (i - Math.floor(i))
  );
};
export function rankPortfolioMetric(
  report,
  companies,
  {
    metricId = "netMargin",
    lens = "all",
    industry = "all",
    period = "all",
    query = "",
    direction = "desc",
  } = {},
) {
  const definition =
    portfolioMetricDefinitionFor(metricId) || PORTFOLIO_METRIC_CATALOG[0];
  const universe = portfolioResearchIssuers(report, companies);
  const rows = filterPortfolioMetricIssuers(universe, {
    lens,
    industry,
    query,
  }).map((i) => ({
    ...i,
    ...portfolioMetricObservation(i, definition, period),
    rank: null,
  }));
  const available = rows
    .filter((r) => r.state === "available")
    .sort(
      (a, b) =>
        (direction === "asc"
          ? a.point.value - b.point.value
          : b.point.value - a.point.value) || a.ticker.localeCompare(b.ticker),
    );
  let rank = 0,
    prior;
  available.forEach((row, index) => {
    if (index === 0 || row.point.value !== prior) rank = index + 1;
    row.rank = rank;
    prior = row.point.value;
  });
  const values = available.map((r) => r.point.value).sort((a, b) => a - b);
  const periods = [...new Set(available.map((r) => metricPeriodKey(r.point)))];
  return {
    definition,
    guide: analysisMetricGuide(
      definition,
      {},
      lens === "all"
        ? definition.lenses?.length === 1
          ? definition.lenses[0]
          : "corporate"
        : lens,
    ),
    population: rows.length,
    available: available.length,
    excluded: rows.length - available.length,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    periodCount: periods.length,
    reasons: rows.reduce((counts, row) => {
      if (row.reasonCode)
        counts[row.reasonCode] = (counts[row.reasonCode] || 0) + 1;
      return counts;
    }, {}),
    rows: [...available, ...rows.filter((r) => r.state !== "available")],
    interpretation:
      "Ranks order numerical values within the selected saved issuer group; ties share a rank. Higher does not mean better. Each issuer counts once. Reporting dates, accounting scope and business models may differ; unavailable values are never ranked or imputed.",
  };
}

const validPoint = (company, key) =>
  companyAvailable(company) &&
  finiteFinancialMetric(company.metrics?.[key]) &&
  company.metrics[key].unit ===
    metricUnit(portfolioMetricDefinitionFor(key)?.format) &&
  Boolean(metricPeriodKey(company.metrics[key]));
export function portfolioConnections(report, companies) {
  const issuers = portfolioResearchIssuers(report, companies);
  const corporate = issuers.filter(
    (i) => i.lens === "corporate" && Number(i.company?.sic) !== 6798,
  );
  const cash = corporate.filter((i) =>
    validPoint(i.company, "cashAfterReturns"),
  );
  const deficit = cash.filter(
    (i) => i.company.metrics.cashAfterReturns.value < 0,
  );
  const growth = corporate.filter(
    (i) =>
      ["revenueGrowth", "netMargin"].every((k) => validPoint(i.company, k)) &&
      metricPeriodKey(i.company.metrics.revenueGrowth) ===
        metricPeriodKey(i.company.metrics.netMargin),
  );
  const growthLoss = growth.filter(
    (i) =>
      i.company.metrics.revenueGrowth.value > 0 &&
      i.company.metrics.netMargin.value < 0,
  );
  const banks = issuers.filter(
    (i) => i.lens === "banking" && validPoint(i.company, "loanDeposits"),
  );
  const loanExcess = banks.filter(
    (i) => i.company.metrics.loanDeposits.value > 100,
  );
  const group = (id, title, eligible, members, reading, query, keys) => ({
    id,
    title,
    eligible: eligible.length,
    count: members.length,
    ciks: members.map((i) => i.cik),
    rowIds: members.map((i) => i.rowIds[0]),
    reading:
      eligible.length || id.startsWith("roe-")
        ? reading
        : `No eligible issuers have the complete, compatible inputs needed for this comparison. Refresh research or inspect missing evidence; an unmeasured result is not evidence that the condition is absent.`,
    query,
    keys,
  });
  const groups = [
    group(
      "cash-uses",
      "Does operating cash cover investment and shareholder returns?",
      cash,
      deficit,
      `${deficit.length} of ${cash.length} corporate issuers with complete inputs used more cash on PP&E, dividends and common-share repurchases than operations generated. Cash reserves, asset sales or financing can bridge the difference; inspect the cash-flow statement.`,
      '"capital resources" OR "share repurchase" OR "debt issuance"',
      [
        "operatingCashFlow",
        "capex",
        "dividendsPaid",
        "stockRepurchased",
        "cashAfterReturns",
      ],
    ),
    group(
      "growth-loss",
      "Is revenue growth reaching the bottom line?",
      growth,
      growthLoss,
      `${growthLoss.length} of ${growth.length} paired corporate issuers reported growing revenue and a net loss. Check margins, operating costs, financing costs and unusual items; growth alone does not establish profitability.`,
      '"operating expenses" OR restructuring OR impairment',
      ["revenueGrowth", "netMargin", "operatingMargin", "netIncome"],
    ),
    group(
      "bank-funding",
      "How much lending is supported by deposits?",
      banks,
      loanExcess,
      `${loanExcess.length} of ${banks.length} measured banks reported net loans above deposits. This points to the funding mix, not a liquidity shortfall: other funding and liquid assets also matter.`,
      '"wholesale funding" OR "deposit outflows" OR "liquidity resources"',
      ["loans", "deposits", "loanDeposits", "allowanceLoans", "provisionLoans"],
    ),
  ];
  for (const lens of ["corporate", "banking"]) {
    const paired = issuers.filter(
      (i) =>
        i.lens === lens &&
        [
          "dupontRoe",
          "equityMultiplier",
          "assetTurnover",
          lens === "banking" ? "bankNetMargin" : "netMargin",
        ].every((k) => validPoint(i.company, k)) &&
        new Set(
          [
            "dupontRoe",
            "equityMultiplier",
            "assetTurnover",
            lens === "banking" ? "bankNetMargin" : "netMargin",
          ].map((k) => metricPeriodKey(i.company.metrics[k])),
        ).size === 1,
    );
    const medianRoe = quantile(
      paired
        .map((i) => i.company.metrics.dupontRoe.value)
        .sort((a, b) => a - b),
      0.5,
    );
    const medianLeverage = quantile(
      paired
        .map((i) => i.company.metrics.equityMultiplier.value)
        .sort((a, b) => a - b),
      0.5,
    );
    const high =
      paired.length >= 4
        ? paired.filter((i) => i.company.metrics.dupontRoe.value > medianRoe)
        : [];
    const leveraged = high.filter(
      (i) => i.company.metrics.equityMultiplier.value > medianLeverage,
    );
    groups.push({
      ...group(
        `roe-${lens}`,
        `What supports ${lens === "banking" ? "bank" : "corporate"} return on equity?`,
        high,
        leveraged,
        paired.length < 4
          ? `At least four ${lens} issuers with all three ROE drivers are required for a within-group comparison; ${paired.length} are available.`
          : `${leveraged.length} of ${high.length} issuers above their ${lens} group's median explained ROE also have an above-median equity multiplier. Higher ROE can reflect margins, asset use or a smaller equity base. Compare the three drivers before drawing a conclusion.`,
        '"return on equity" OR leverage OR "capital management"',
        [
          lens === "banking" ? "bankNetMargin" : "netMargin",
          "assetTurnover",
          "equityMultiplier",
          "dupontRoe",
        ],
      ),
      paired: paired.length,
      medianRoe,
      medianLeverage,
    });
  }
  return {
    version: "1.0.0",
    issuerCount: issuers.length,
    groups,
    interpretation:
      "Descriptive connections from compatible captured observations. Business types are separated; missing inputs are excluded. Counts are issuer counts, not ownership-weighted cash flows, returns or risk ratings.",
  };
}
