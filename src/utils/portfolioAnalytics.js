import {
  allocationSummary,
  canonicalPortfolioCik,
  companyAvailable,
  finiteFinancialMetric,
} from "./portfolioModel.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unique = (values) => [...new Set(values)];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const text = (value) => (typeof value === "string" ? value.trim() : "");
const DAY = 86400000;

// Boundaries are inclusive at the lower end and exclusive at the upper end.
const METRICS = [
  {
    id: "revenueGrowth",
    label: "Revenue growth",
    unit: "%",
    lenses: ["corporate"],
    description:
      "Comparable year-over-year revenue growth for operating companies.",
    bounds: [0, 10, 25],
  },
  {
    id: "netMargin",
    label: "Net margin",
    unit: "%",
    lenses: ["corporate"],
    description: "Net income as a percentage of company revenue.",
    bounds: [0, 10, 20],
  },
  {
    id: "operatingMargin",
    label: "Operating margin",
    unit: "%",
    lenses: ["corporate"],
    description: "Operating income as a percentage of company revenue.",
    bounds: [0, 10, 20],
  },
  {
    id: "roe",
    label: "Return on average equity",
    unit: "%",
    description:
      "Company returns on average reported equity; business models and capital structures differ.",
    bounds: [0, 10, 20],
  },
  {
    id: "roa",
    label: "Return on average assets",
    unit: "%",
    description:
      "Company returns on average reported assets; compare companies with similar business models.",
    bounds: [0, 1, 5],
  },
  {
    id: "debtAssets",
    label: "Reported debt / assets",
    unit: "%",
    lenses: ["corporate", "insurance"],
    description:
      "Reported current and noncurrent debt divided by company assets; banking and common financial lenses are excluded.",
    bounds: [0, 25, 50, 75],
  },
  {
    id: "currentRatio",
    label: "Current ratio",
    unit: "x",
    lenses: ["corporate"],
    description:
      "Current assets divided by current liabilities for operating companies.",
    bounds: [0, 1, 2],
  },
  {
    id: "loanDeposits",
    label: "Net loans / deposits",
    unit: "%",
    lenses: ["banking"],
    description:
      "Reported net loans divided by deposits for companies using the banking lens.",
    bounds: [0, 60, 80, 100],
  },
];

const CONDITIONS = [
  {
    id: "negativeNetIncome",
    metric: "netIncome",
    label: "Negative net income",
    description:
      "Companies reporting a net loss in the selected reporting period.",
    unit: "USD",
  },
  {
    id: "negativeOperatingCashFlow",
    metric: "operatingCashFlow",
    label: "Negative operating cash flow",
    description:
      "Operating companies whose reported cash used in operations exceeds cash generated in the selected period.",
    unit: "USD",
    lenses: ["corporate"],
  },
  {
    id: "negativeFreeCashFlow",
    metric: "freeCashFlow",
    label: "Negative free cash flow",
    description:
      "Operating cash flow less reported purchases of property, plant and equipment is negative; both inputs must be available.",
    unit: "USD",
    lenses: ["corporate"],
  },
  {
    id: "negativeEquity",
    metric: "stockholdersEquity",
    label: "Negative reported equity",
    description:
      "Companies with negative reported equity at the selected reporting date.",
    unit: "USD",
  },
  {
    id: "revenueDecline",
    metric: "revenueGrowth",
    label: "Declining revenue",
    description:
      "Operating companies with negative comparable year-over-year revenue growth.",
    unit: "%",
    lenses: ["corporate"],
  },
];

function industryLabel(company, kind) {
  if (kind === "fund") return "Funds (company metrics not applicable)";
  return (
    text(company?.sicDescription) ||
    text(company?.industry?.label) ||
    text(company?.industry) ||
    text(company?.classification?.sicDescription) ||
    text(company?.sic_description) ||
    "Unclassified"
  );
}

function periodEnd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return finite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function sourceUrl(point) {
  for (const source of point?.sources || []) {
    try {
      const url = new URL(source.documentUrl);
      if (
        url.protocol === "https:" &&
        ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.port
      )
        return url.href;
    } catch {
      // Only verified SEC links can accompany a derived observation.
    }
  }
  return null;
}

function metricState(issuer, company, definition) {
  const point = company?.metrics?.[definition.metric || definition.id];
  const incompatibleLens =
    definition.lenses &&
    company?.lens &&
    !definition.lenses.includes(company.lens);
  if (
    issuer.kind === "fund" ||
    incompatibleLens ||
    point?.classification === "not_applicable" ||
    point?.status === "not_applicable"
  )
    return "not-applicable";
  return companyAvailable(company) &&
    finiteFinancialMetric(point) &&
    point.unit === definition.unit
    ? "available"
    : "missing";
}

/** Linear interpolation at (n - 1) × p; no weighting or invented observations. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low] * (1 - fraction) + sorted[high] * fraction;
}

function weightSum(issuers, knownWeights) {
  if (!knownWeights) return null;
  const values = issuers.map((issuer) => issuer.weightPct).filter(finite);
  return values.length ? sum(values) : issuers.length ? null : 0;
}

function concentrationReason(summary, complete) {
  if (complete) return null;
  if (summary.mode === "universe")
    return "Choose an explicit allocation basis to measure issuer concentration. Company counts do not imply portfolio weights.";
  if (!summary.holdingCount)
    return "Add positions before measuring concentration.";
  if (summary.unresolvedCount)
    return "Resolve every included position before measuring complete-portfolio issuer concentration.";
  if (!summary.allocationComplete)
    return "Complete valid weights and duplicate review for every included position. Known exposures remain visible.";
  if (Math.abs((summary.allocatedWeight ?? 0) - 100) > 0.000001)
    return "Complete-portfolio concentration requires weights totaling 100%. Original supplied weights remain unchanged.";
  return "Resolve the allocation review issues before measuring complete-portfolio issuer concentration.";
}

/**
 * Derived from a captured research snapshot. Nothing is persisted, fetched, or
 * reweighted. A ticker-only universe stays a company-count universe.
 * @param {any[]} rows
 * @param {any} settings
 * @param {any[]} companies
 * @param {{capturedAt?: string | null}} options
 */
export function buildPortfolioAnalytics(
  rows,
  settings = {},
  companies = [],
  { capturedAt = null } = {},
) {
  const byCik = Object.fromEntries(
    companies
      .map((company) => [canonicalPortfolioCik(company?.cik), company])
      .filter(([cik]) => cik),
  );
  const summary = allocationSummary(rows, settings, byCik);
  const weighted = summary.mode === "weighted";
  const knownWeights = weighted && finite(summary.allocatedWeight);
  const issuers = summary.issuers.map((issuer) => ({
    cik: issuer.cik,
    name: issuer.name,
    tickers: issuer.tickers,
    rowIds: issuer.rowIds,
    kind: issuer.kind,
    weightPct: issuer.weightPct,
    weightComplete: issuer.weightComplete,
    industry: industryLabel(byCik[issuer.cik], issuer.kind),
  }));
  const operatingIssuers = issuers.filter(
    (issuer) => issuer.kind === "company",
  );
  const unresolved = summary.allocations.filter(
    (entry) => entry.status !== "resolved",
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const issuerByCik = new Map(issuers.map((issuer) => [issuer.cik, issuer]));
  const industries = new Map();
  for (const issuer of issuers) {
    if (!industries.has(issuer.industry))
      industries.set(issuer.industry, {
        label: issuer.industry,
        count: 0,
        weightPct: null,
        rowIds: [],
        ciks: [],
      });
    const group = industries.get(issuer.industry);
    group.count++;
    if (knownWeights && finite(issuer.weightPct))
      group.weightPct = (group.weightPct ?? 0) + issuer.weightPct;
    group.rowIds.push(...issuer.rowIds);
    group.ciks.push(issuer.cik);
  }
  if (unresolved.length)
    industries.set("Unresolved positions", {
      label: "Unresolved positions",
      count: unresolved.length,
      weightPct: weightSum(unresolved, knownWeights),
      rowIds: unresolved.map((entry) => entry.rowId),
      ciks: [],
    });

  const complete =
    weighted &&
    summary.allocationComplete &&
    !summary.reviewRequired &&
    summary.allocations.every(
      (entry) => entry.eligible && entry.status === "resolved",
    ) &&
    Math.abs((summary.allocatedWeight ?? 0) - 100) <= 0.000001;
  const knownIssuers = issuers.filter((issuer) => finite(issuer.weightPct));
  const hhi = complete
    ? sum(issuers.map((issuer) => issuer.weightPct ** 2))
    : null;
  const concentration = {
    knownWeightPct: summary.allocatedWeight,
    missingWeightRows: summary.allocations.filter(
      (entry) => !finite(entry.weightPct),
    ).length,
    complete,
    reason: concentrationReason(summary, complete),
    largestIssuerWeightPct: knownIssuers[0]?.weightPct ?? null,
    topFiveIssuerWeightPct: knownIssuers.length
      ? sum(knownIssuers.slice(0, 5).map((issuer) => issuer.weightPct))
      : null,
    topTenIssuerWeightPct: knownIssuers.length
      ? sum(knownIssuers.slice(0, 10).map((issuer) => issuer.weightPct))
      : null,
    hhi,
    effectiveIssuerCount: hhi > 0 ? 10000 / hhi : null,
    issuers,
    industries: [...industries.values()].sort(
      (a, b) =>
        (weighted
          ? (b.weightPct ?? -1) - (a.weightPct ?? -1)
          : b.count - a.count) || a.label.localeCompare(b.label),
    ),
  };

  const metrics = METRICS.map((definition) => {
    let notApplicableCount = 0;
    const observations = [];
    const coveredIssuers = [];
    for (const issuer of operatingIssuers) {
      const company = byCik[issuer.cik];
      const state = metricState(issuer, company, definition);
      if (state === "not-applicable") notApplicableCount++;
      if (state !== "available") continue;
      const point = company.metrics[definition.id];
      const rowId = issuer.rowIds[0];
      const row = rowById.get(rowId);
      coveredIssuers.push(issuer);
      observations.push({
        cik: issuer.cik,
        rowId,
        ticker:
          row?.resolution?.ticker ||
          issuer.tickers[0] ||
          text(company.ticker) ||
          "",
        name: issuer.name,
        value: point.value,
        periodEnd:
          periodEnd(point.period?.end) || periodEnd(company.period?.end),
        sourceUrl: sourceUrl(point),
      });
    }
    observations.sort(
      (a, b) => a.value - b.value || a.name.localeCompare(b.name),
    );
    const values = observations.map((observation) => observation.value);
    const eligibleCount = operatingIssuers.length - notApplicableCount;
    const edges = [-Infinity, ...definition.bounds, Infinity];
    const bins = edges.slice(0, -1).map((low, index) => {
      const high = edges[index + 1];
      const matched = observations.filter(
        (observation) => observation.value >= low && observation.value < high,
      );
      const members = matched.map((observation) =>
        issuerByCik.get(observation.cik),
      );
      const label =
        low === -Infinity
          ? `Below ${high}${definition.unit}`
          : high === Infinity
            ? `${low}${definition.unit} and above`
            : `${low}${definition.unit} to <${high}${definition.unit}`;
      return {
        label,
        count: matched.length,
        weightPct: weightSum(members, knownWeights),
        rowIds: members.flatMap((issuer) => issuer.rowIds),
      };
    });
    return {
      id: definition.id,
      label: definition.label,
      unit: definition.unit,
      description: definition.description,
      availableCount: observations.length,
      eligibleCount,
      missingCount: eligibleCount - observations.length,
      notApplicableCount,
      median: quantile(values, 0.5),
      p25: quantile(values, 0.25),
      p75: quantile(values, 0.75),
      min: values[0] ?? null,
      max: values.at(-1) ?? null,
      coveredWeightPct: weightSum(coveredIssuers, knownWeights),
      observations,
      bins,
    };
  });

  const conditions = CONDITIONS.map((definition) => {
    let measuredCount = 0;
    let notApplicableCount = 0;
    const matched = [];
    for (const issuer of operatingIssuers) {
      const company = byCik[issuer.cik];
      const state = metricState(issuer, company, definition);
      if (state === "not-applicable") notApplicableCount++;
      if (state !== "available") continue;
      measuredCount++;
      if (company.metrics[definition.metric].value < 0) matched.push(issuer);
    }
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      matchedCount: matched.length,
      measuredCount,
      missingCount:
        operatingIssuers.length - notApplicableCount - measuredCount,
      notApplicableCount,
      knownMatchedWeightPct: weightSum(matched, knownWeights),
      rowIds: matched.flatMap((issuer) => issuer.rowIds),
    };
  });

  const statusDefinitions = [
    ["ready", "Financial evidence available"],
    ["partial", "Partial financial evidence"],
    ["filings-only", "Filings without financial measures"],
    ["failed", "Financial research unavailable"],
    ["not-researched", "No captured research"],
    ["funds", "Funds — company measures do not apply"],
    ["unresolved", "Unresolved positions"],
  ];
  const statuses = new Map(
    statusDefinitions.map(([id, label]) => [
      id,
      {
        id,
        label,
        count: 0,
        weightPct: null,
        rowIds: [],
      },
    ]),
  );
  const endGroups = new Map();
  const missingRows = [];
  let staleCount = 0;
  const capturedTime =
    typeof capturedAt === "string" ? Date.parse(capturedAt) : NaN;
  for (const issuer of issuers) {
    const company = byCik[issuer.cik];
    const financial = companyAvailable(company);
    const filingCount = Array.isArray(company?.filings)
      ? company.filings.length
      : 0;
    const status =
      issuer.kind === "fund"
        ? "funds"
        : !company
          ? "not-researched"
          : financial
            ? company.status === "ready"
              ? "ready"
              : "partial"
            : ["failed", "unsupported"].includes(company.status)
              ? "failed"
              : filingCount
                ? "filings-only"
                : "not-researched";
    const group = statuses.get(status);
    group.count++;
    if (knownWeights && finite(issuer.weightPct))
      group.weightPct = (group.weightPct ?? 0) + issuer.weightPct;
    group.rowIds.push(...issuer.rowIds);
    if (issuer.kind !== "company") continue;
    const end = periodEnd(company?.period?.end);
    const label = end || "Unavailable";
    if (!endGroups.has(label))
      endGroups.set(label, { end: label, count: 0, rowIds: [] });
    endGroups.get(label).count++;
    endGroups.get(label).rowIds.push(...issuer.rowIds);
    const age =
      end && finite(capturedTime) ? capturedTime - Date.parse(end) : null;
    const threshold = company?.period?.kind === "ttm" ? 200 : 550;
    if (
      company?.cache?.status === "stale" ||
      company?.status === "stale" ||
      company?.refreshStatus === "stale" ||
      (age !== null && age > threshold * DAY)
    )
      staleCount++;
    const missingMetrics = METRICS.filter(
      (definition) => metricState(issuer, company, definition) === "missing",
    );
    const reason = !company
      ? "No company research has been captured."
      : ["failed", "unsupported"].includes(company.status)
        ? "Supported company financial research is unavailable."
        : !financial
          ? filingCount
            ? "Filing references are available; supported financial measures are unavailable."
            : "No supported financial measures are available."
          : missingMetrics.length
            ? `${missingMetrics.length} tracked financial ${missingMetrics.length === 1 ? "measure is" : "measures are"} unavailable: ${missingMetrics.map((definition) => definition.label).join(", ")}.`
            : null;
    if (reason)
      for (const rowId of issuer.rowIds) {
        const row = rowById.get(rowId);
        missingRows.push({
          rowId,
          ticker: row?.resolution?.ticker || text(row?.input?.ticker),
          name: issuer.name,
          reason,
        });
      }
  }
  for (const entry of unresolved) {
    const group = statuses.get("unresolved");
    group.count++;
    if (knownWeights && finite(entry.weightPct))
      group.weightPct = (group.weightPct ?? 0) + entry.weightPct;
    group.rowIds.push(entry.rowId);
    missingRows.push({
      rowId: entry.rowId,
      ticker: entry.ticker,
      name: entry.name,
      reason:
        "Confirm this position's identity before matching company evidence.",
    });
  }
  const distinctEnds = unique(
    metrics.flatMap((metric) =>
      metric.observations
        .map((observation) => observation.periodEnd)
        .filter(Boolean),
    ),
  );
  const warnings = [...summary.warnings, ...summary.assumptions];
  if (distinctEnds.length > 1)
    warnings.push(
      `Financial observations span ${distinctEnds.length} reporting dates. Distribution statistics describe available issuer observations, not a synchronized portfolio period.`,
    );
  if (summary.fundCount)
    warnings.push(
      "Funds remain direct issuer positions in concentration. Underlying fund holdings are not included; company financial diagnostics exclude funds.",
    );
  if (staleCount)
    warnings.push(
      `${staleCount} ${staleCount === 1 ? "issuer uses" : "issuers use"} stale cached evidence or an older reporting period. Freshness is assessed against the captured research date when supplied.`,
    );
  return {
    mode: summary.mode,
    label: summary.label,
    basis: summary.basis,
    weighted,
    holdingCount: summary.holdingCount,
    issuerCount: issuers.length,
    operatingIssuerCount: operatingIssuers.length,
    unresolvedCount: summary.unresolvedCount,
    fundCount: summary.fundCount,
    capturedAt: finite(capturedTime) ? capturedAt : null,
    warnings: unique(warnings),
    concentration,
    metrics,
    conditions,
    coverage: {
      statuses: [...statuses.values()].map((group) => ({
        ...group,
        weightPct: group.count ? group.weightPct : knownWeights ? 0 : null,
      })),
      periodEnds: [...endGroups.values()].sort((a, b) =>
        a.end === "Unavailable"
          ? 1
          : b.end === "Unavailable"
            ? -1
            : b.end.localeCompare(a.end),
      ),
      metricRows: metrics.map(
        ({
          id,
          label,
          availableCount,
          eligibleCount,
          missingCount,
          notApplicableCount,
          coveredWeightPct,
        }) => ({
          id,
          label,
          availableCount,
          eligibleCount,
          missingCount,
          notApplicableCount,
          coveredWeightPct,
        }),
      ),
      missingRows,
      staleCount,
    },
  };
}
