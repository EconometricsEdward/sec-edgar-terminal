import { canonicalPortfolioCik } from "./portfolioModel.js";
import { csvString } from "./portfolioFiles.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const EMPTY = [];
const LEGACY_LENSES = {
  revenueGrowth: ["corporate"],
  netMargin: ["corporate"],
  operatingMargin: ["corporate"],
  debtAssets: ["corporate", "insurance"],
  currentRatio: ["corporate"],
  loanDeposits: ["banking"],
};

export const PORTFOLIO_SCREEN_PRESETS = [
  {
    id: "growth-margin",
    label: "Growth & margin ≥ 0",
    description:
      "Reported revenue growth and operating margin are both nonnegative.",
    rules: [
      { metricId: "revenueGrowth", min: "0", max: "" },
      { metricId: "operatingMargin", min: "0", max: "" },
    ],
  },
  {
    id: "debt-assets",
    label: "Debt / assets ≥ 50%",
    description:
      "Reported debt is at least 50% of assets, where this measure applies.",
    rules: [{ metricId: "debtAssets", min: "50", max: "" }],
  },
  {
    id: "current-ratio",
    label: "Current ratio ≤ 1×",
    description:
      "Reported current assets are no more than current liabilities.",
    rules: [{ metricId: "currentRatio", min: "", max: "1" }],
  },
];

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const parsed = Date.parse(value);
  return finite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function secUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function metricStatus(issuer, company, metric, observation) {
  if (observation && finite(observation.value)) return "available";
  if (issuer.kind !== "company") return "not-applicable";
  if (Array.isArray(metric.notApplicableCiks)) {
    return metric.notApplicableCiks.some(
      (cik) => canonicalPortfolioCik(cik) === issuer.cik,
    )
      ? "not-applicable"
      : "missing";
  }
  // Older captured reports lack applicability identities. Financial values still
  // come only from the canonical report observations, never from this fallback.
  const point = company?.metrics?.[metric.id];
  const lenses = LEGACY_LENSES[metric.id];
  return point?.classification === "not_applicable" ||
    point?.status === "not_applicable" ||
    (company?.lens && lenses && !lenses.includes(company.lens))
    ? "not-applicable"
    : "missing";
}

function knownWeight(rows, report) {
  if (!report?.weighted || !finite(report.concentration?.knownWeightPct))
    return null;
  const values = rows.map((row) => row.weightPct).filter(finite);
  return values.length
    ? values.reduce((a, b) => a + b, 0)
    : rows.length
      ? null
      : 0;
}

/** One row per canonical resolved issuer. No mutation, fetching or reweighting. */
export function buildPortfolioCoverageMatrix(
  report,
  companies = EMPTY,
  filters = {},
) {
  const companyByCik = new Map(
    companies.map((company) => [canonicalPortfolioCik(company?.cik), company]),
  );
  const metrics = (report?.metrics || []).filter(
    (metric) => !filters.metricId || metric.id === filters.metricId,
  );
  const observations = new Map(
    metrics.map((metric) => [
      metric.id,
      new Map(
        (metric.observations || []).map((observation) => [
          canonicalPortfolioCik(observation.cik),
          observation,
        ]),
      ),
    ]),
  );
  const query = String(filters.query || "")
    .trim()
    .toLowerCase();
  const allRows = (report?.concentration?.issuers || [])
    .map((issuer) => {
      const cik = canonicalPortfolioCik(issuer.cik);
      const normalized = { ...issuer, cik, rowId: issuer.rowIds?.[0] || null };
      const company = companyByCik.get(cik);
      const cells = metrics.map((metric) => {
        const observation = observations.get(metric.id).get(cik);
        const status = metricStatus(normalized, company, metric, observation);
        return {
          metricId: metric.id,
          label: metric.label,
          unit: metric.unit,
          status,
          value: status === "available" ? observation.value : null,
          periodEnd:
            status === "available" ? validDate(observation.periodEnd) : null,
          sourceUrl:
            status === "available" ? secUrl(observation.sourceUrl) : null,
        };
      });
      const availableCount = cells.filter(
        (cell) => cell.status === "available",
      ).length;
      const missingCount = cells.filter(
        (cell) => cell.status === "missing",
      ).length;
      return {
        ...normalized,
        cells,
        availableCount,
        missingCount,
        notApplicableCount: cells.length - availableCount - missingCount,
        eligibleCount: availableCount + missingCount,
      };
    })
    .filter((row) => row.cik);
  const scopedRows = allRows.filter(
    (row) =>
      (!filters.industry || row.industry === filters.industry) &&
      (!query ||
        [row.name, row.cik, ...(row.tickers || [])]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  const rows = scopedRows
    .filter((row) => !filters.gapsOnly || row.missingCount > 0)
    .sort(
      (a, b) =>
        (filters.gapsOnly ? b.missingCount - a.missingCount : 0) ||
        a.name.localeCompare(b.name),
    );
  return {
    capturedAt: report?.capturedAt || null,
    weighted: Boolean(report?.weighted),
    unresolvedCount: report?.unresolvedCount || 0,
    metrics,
    rows,
    totalIssuerCount: allRows.length,
    scopedIssuerCount: scopedRows.length,
    visibleIssuerCount: rows.length,
    availableCount: rows.reduce((count, row) => count + row.availableCount, 0),
    missingCount: rows.reduce((count, row) => count + row.missingCount, 0),
    notApplicableCount: rows.reduce(
      (count, row) => count + row.notApplicableCount,
      0,
    ),
    industries: [...new Set(allRows.map((row) => row.industry))].sort(),
    filters: {
      query: String(filters.query || ""),
      industry: String(filters.industry || ""),
      metricId: String(filters.metricId || ""),
      gapsOnly: Boolean(filters.gapsOnly),
    },
  };
}

function bound(value) {
  if (
    value === "" ||
    value == null ||
    (typeof value === "string" && !value.trim())
  )
    return { empty: true, value: null };
  if (typeof value !== "string" && typeof value !== "number")
    return { error: true, value: null };
  if (
    typeof value === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
  )
    return { error: true, value: null };
  const parsed = Number(value);
  return finite(parsed) ? { value: parsed } : { error: true, value: null };
}

export function buildPortfolioScreen(
  report,
  companies = EMPTY,
  rules = EMPTY,
  options = {},
) {
  const matrix = buildPortfolioCoverageMatrix(report, companies, {
    industry: options.industry,
  });
  const metricById = new Map(
    matrix.metrics.map((metric) => [metric.id, metric]),
  );
  const errors = [];
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > 4)
    errors.push("Choose between one and four rules.");
  const validatedRules = (Array.isArray(rules) ? rules.slice(0, 4) : []).map(
    (rule, index) => {
      const metric = metricById.get(rule?.metricId);
      const min = bound(rule?.min);
      const max = bound(rule?.max);
      if (!metric)
        errors.push(`Rule ${index + 1}: choose a supported measure.`);
      if (min.error || max.error)
        errors.push(`Rule ${index + 1}: enter finite numeric bounds.`);
      if (min.empty && max.empty)
        errors.push(`Rule ${index + 1}: enter a minimum or maximum.`);
      if (
        !min.empty &&
        !max.empty &&
        !min.error &&
        !max.error &&
        min.value > max.value
      )
        errors.push(
          `Rule ${index + 1}: the minimum cannot exceed the maximum.`,
        );
      return {
        metricId: rule?.metricId,
        label: metric?.label || "Unknown measure",
        unit: metric?.unit || "",
        min: min.value,
        max: max.value,
      };
    },
  );
  const valid = errors.length === 0;
  const resultRows = valid
    ? matrix.rows.map((row) => {
        const cells = validatedRules.map((rule) =>
          row.cells.find((cell) => cell.metricId === rule.metricId),
        );
        const hasNotApplicable = cells.some(
          (cell) => cell.status === "not-applicable",
        );
        const hasMissing = cells.some((cell) => cell.status === "missing");
        const status = hasNotApplicable
          ? "not-applicable"
          : hasMissing
            ? "missing"
            : cells.every(
                  (cell, index) =>
                    (validatedRules[index].min === null ||
                      cell.value >= validatedRules[index].min) &&
                    (validatedRules[index].max === null ||
                      cell.value <= validatedRules[index].max),
                )
              ? "match"
              : "outside-rules";
        return { ...row, cells, status };
      })
    : [];
  const matches = resultRows.filter((row) => row.status === "match");
  const missing = resultRows.filter((row) => row.status === "missing");
  const notApplicable = resultRows.filter(
    (row) => row.status === "not-applicable",
  );
  const measuredCount =
    resultRows.length - missing.length - notApplicable.length;
  const sortBy = options.sortBy || "name";
  const direction = options.direction === "desc" ? -1 : 1;
  matches.sort((a, b) => {
    if (sortBy === "name") return direction * a.name.localeCompare(b.name);
    const av =
      sortBy === "weight"
        ? a.weightPct
        : a.cells.find((cell) => cell.metricId === sortBy)?.value;
    const bv =
      sortBy === "weight"
        ? b.weightPct
        : b.cells.find((cell) => cell.metricId === sortBy)?.value;
    if (!finite(av) || !finite(bv))
      return finite(av) ? -1 : finite(bv) ? 1 : a.name.localeCompare(b.name);
    return direction * (av - bv) || a.name.localeCompare(b.name);
  });
  return {
    valid,
    errors,
    rules: validatedRules,
    capturedAt: report?.capturedAt || null,
    weighted: Boolean(report?.weighted),
    unresolvedCount: report?.unresolvedCount || 0,
    industries: matrix.industries,
    industry: String(options.industry || ""),
    scopeCount: matrix.rows.length,
    eligibleCount: valid ? resultRows.length - notApplicable.length : null,
    measuredCount: valid ? measuredCount : null,
    missingCount: valid ? missing.length : null,
    notApplicableCount: valid ? notApplicable.length : null,
    matchCount: valid ? matches.length : null,
    knownMatchedWeightPct: valid ? knownWeight(matches, report) : null,
    incompleteMatchedWeightCount: matches.filter((row) => !row.weightComplete)
      .length,
    matches,
    missing,
    notApplicable,
  };
}

export function portfolioScreenCsv(screen) {
  if (!screen?.valid)
    throw new Error("Correct invalid screening rules before exporting.");
  const ruleText = screen.rules
    .map(
      (rule) =>
        `${rule.label}: ${rule.min === null ? "no minimum" : `>= ${rule.min}${rule.unit}`}; ${rule.max === null ? "no maximum" : `<= ${rule.max}${rule.unit}`}`,
    )
    .join(" AND ");
  return csvString([
    [
      "captured_at",
      "industry_scope",
      "rules_inclusive_and",
      "scope_issuers",
      "eligible_issuers",
      "measured_issuers",
      "missing_issuers",
      "not_applicable_issuers",
      "cik",
      "company",
      "tickers",
      "sec_industry",
      "known_original_weight_pct",
      "weight_complete",
      ...screen.rules.flatMap((rule) => [
        `${rule.metricId}_value`,
        `${rule.metricId}_unit`,
        `${rule.metricId}_period_end`,
        `${rule.metricId}_sec_source`,
      ]),
    ],
    ...screen.matches.map((row) => [
      screen.capturedAt,
      screen.industry || "All SEC industries",
      ruleText,
      screen.scopeCount,
      screen.eligibleCount,
      screen.measuredCount,
      screen.missingCount,
      screen.notApplicableCount,
      row.cik,
      row.name,
      row.tickers.join("; "),
      row.industry,
      screen.weighted ? row.weightPct : null,
      screen.weighted ? row.weightComplete : null,
      ...row.cells.flatMap((cell) => [
        cell.value,
        cell.unit,
        cell.periodEnd,
        cell.sourceUrl,
      ]),
    ]),
  ]);
}

export function portfolioCoverageCsv(matrix) {
  return csvString([
    [
      "captured_at",
      "industry_filter",
      "company_filter",
      "gaps_only",
      "cik",
      "company",
      "tickers",
      "sec_industry",
      "metric",
      "status",
      "value",
      "unit",
      "period_end",
      "sec_source",
      "known_original_weight_pct",
      "weight_complete",
    ],
    ...matrix.rows.flatMap((row) =>
      row.cells.map((cell) => [
        matrix.capturedAt,
        matrix.filters.industry || "All SEC industries",
        matrix.filters.query,
        matrix.filters.gapsOnly,
        row.cik,
        row.name,
        row.tickers.join("; "),
        row.industry,
        cell.label,
        cell.status,
        cell.value,
        cell.unit,
        cell.periodEnd,
        cell.sourceUrl,
        matrix.weighted ? row.weightPct : null,
        matrix.weighted ? row.weightComplete : null,
      ]),
    ),
  ]);
}
