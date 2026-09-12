import {
  portfolioPeriodKey,
  portfolioPeriodLengthGroup,
} from "./portfolioReporting.js";
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
import { SECTOR_NOT_COVERED } from "./companyClassification.js";

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
    maximumFractionDigits: point.unit === "USD" && !compact ? 0 : 2,
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
export const metricPeriodKey = (point) => portfolioPeriodKey(point?.period);
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

/** Earlier captures sometimes labeled administrative expense alone as total SG&A. */
export const portfolioMetricScopeValid = (key, point) =>
  !(
    key === "sga" &&
    point?.sources?.length &&
    point.sources.every(
      (source) => source.tag === "GeneralAndAdministrativeExpense",
    )
  );

/** The same eligibility contract powers choices, ranks and comparisons. */
export function portfolioMetricState(company, definition, period = "all") {
  const point = company?.metrics?.[definition?.key];
  if (!company?.lens || company.lens === "unknown")
    return "unavailable";
  if (
    !metricApplies(definition, company.lens) ||
    point?.classification === "not_applicable"
  )
    return "not-applicable";
  if (!companyAvailable(company)) return "unavailable";
  if (
    !portfolioMetricScopeValid(definition?.key, point) ||
    !finiteFinancialMetric(point) ||
    point.unit !== metricUnit(definition?.format)
  )
    return "unavailable";
  if (!metricPeriodKey(point)) return "unknown-period";
  if (period !== "all" && metricPeriodKey(point) !== period)
    return "outside-period";
  return "available";
}

export function portfolioAvailableMetrics(
  companies,
  { period = "all", requireAll = false } = {},
) {
  if (!companies.length) return [];
  return PORTFOLIO_METRIC_CATALOG.flatMap((definition) => {
    const availableCount = companies.filter(
      (company) =>
        portfolioMetricState(company, definition, period) === "available",
    ).length;
    return availableCount &&
      (!requireAll || availableCount === companies.length)
      ? [{ ...definition, availableCount }]
      : [];
  });
}

/** Peer choices use metric eligibility, independently of a company-name search. */
export function portfolioMetricPeerOptions(
  issuers,
  { sector = "all", metricId = "", period = "all", durationGroup = "all" } = {},
) {
  const definition = metricId ? portfolioMetricDefinitionFor(metricId) : null;
  const peers = issuers.filter(
    (issuer) =>
      issuer.kind !== "fund" &&
      (durationGroup === "all" ||
        portfolioPeriodLengthGroup(
          issuer.company?.metrics?.[metricId]?.period || issuer.company?.period,
        ) === durationGroup) &&
      (!metricId ||
        (definition &&
          portfolioMetricState(issuer.company, definition, period) ===
            "available")),
  );
  const options = (rows, field, missingLabel) => {
    const counts = new Map();
    for (const row of rows) {
      const label = row[field] || missingLabel;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts]
      .map(([label, count]) => ({ value: label, label, count }))
      .sort(
        (a, b) =>
          Number(a.value === missingLabel) - Number(b.value === missingLabel) ||
          a.label.localeCompare(b.label),
      );
  };
  return {
    // Keep every eligible sector reachable when switching an existing peer group.
    sectors: options(peers, "sector", SECTOR_NOT_COVERED),
    industries: options(
      peers.filter(
        (issuer) =>
          sector === "all" || (issuer.sector || SECTOR_NOT_COVERED) === sector,
      ),
      "industry",
      "Unclassified",
    ),
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

/** Find a company within an existing ranking without changing its peer ranks. */
export function filterPortfolioRankingRows(rows, query = "") {
  const search = query.trim().toLowerCase();
  if (!search) return rows;
  return rows.filter((row) =>
    `${row.ticker || ""} ${row.name || ""} ${row.cik || ""}`
      .toLowerCase()
      .includes(search),
  );
}

export function rankPortfolioMetric(
  report,
  companies,
  {
    metricId = "netMargin",
    lens = "all",
    sector = "all",
    industry = "all",
    period = "all",
    durationGroup = "all",
    query = "",
    direction = "desc",
  } = {},
) {
  const definition =
    portfolioMetricDefinitionFor(metricId) || PORTFOLIO_METRIC_CATALOG[0];
  const universe = portfolioResearchIssuers(report, companies);
  const rows = universe
    .filter(
      (i) =>
        (lens === "all" || i.lens === lens) &&
        (sector === "all" || (i.sector || SECTOR_NOT_COVERED) === sector) &&
        (industry === "all" || i.industry === industry) &&
        (durationGroup === "all" ||
          portfolioPeriodLengthGroup(
            i.company?.metrics?.[definition.key]?.period || i.company?.period,
          ) === durationGroup) &&
        `${i.ticker} ${i.name}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .map((i) => {
      const point = i.company?.metrics?.[definition.key];
      const state = portfolioMetricState(i.company, definition, period);
      return { ...i, point, state, rank: null };
    });
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
    rows: [...available, ...rows.filter((r) => r.state !== "available")],
    interpretation:
      "Ranks order numerical values within the selected saved company group; ties share a rank. Higher does not mean better. Each company counts once. Reporting dates, accounting scope and business models may differ; unavailable values are never ranked or imputed.",
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
        : `No eligible companies have the complete, compatible inputs needed for this comparison. Refresh research or inspect missing evidence; an unmeasured result is not evidence that the condition is absent.`,
    query,
    keys,
  });
  const groups = [
    group(
      "cash-uses",
      "Does operating cash cover investment and shareholder returns?",
      cash,
      deficit,
      `${deficit.length} of ${cash.length} operating companies with complete inputs used more cash on PP&E, dividends and common-share repurchases than operations generated. Cash reserves, asset sales or financing can bridge the difference; inspect the cash-flow statement.`,
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
      `${growthLoss.length} of ${growth.length} paired operating companies reported growing revenue and a net loss. Check margins, operating costs, financing costs and unusual items; growth alone does not establish profitability.`,
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
          ? `At least four ${lens} companies with all three ROE drivers are required for a within-group comparison; ${paired.length} are available.`
          : `${leveraged.length} of ${high.length} companies above their ${lens} group's median explained ROE also have an above-median equity multiplier. Higher ROE can reflect margins, asset use or a smaller equity base. Compare the three drivers before drawing a conclusion.`,
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
      "Descriptive connections from compatible captured observations. Business types are separated; missing inputs are excluded. Counts are company counts, not ownership-weighted cash flows, returns or risk ratings.",
  };
}
