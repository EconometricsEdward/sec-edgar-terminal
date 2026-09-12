import { canonicalPortfolioCik } from "./portfolioModel.js";
import { csvString } from "./portfolioFiles.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const EMPTY = [];
export const PORTFOLIO_SECTOR_UNCOVERED = "Sector not covered";
const sectorLabel = (row) => row.sector || PORTFOLIO_SECTOR_UNCOVERED;
const matchesSector = (row, sector) =>
  !sector || (row.kind === "company" && sectorLabel(row) === sector);
const compareIssuerNames = (a, b) =>
  a.name.localeCompare(b.name) || a.cik.localeCompare(b.cik);
const LEGACY_LENSES = {
  revenueGrowth: ["corporate"],
  netMargin: ["corporate"],
  operatingMargin: ["corporate"],
  debtAssets: ["corporate", "insurance"],
  currentRatio: ["corporate"],
  loanDeposits: ["banking"],
};

const presetSignatures = new Set();
function defineScreenPreset(definition) {
  const metricIds = definition.rules.map((rule) => rule.metricId);
  if (
    metricIds.length < 1 ||
    metricIds.length > 4 ||
    new Set(metricIds).size !== metricIds.length
  )
    throw new Error(
      `Portfolio screen preset "${definition.id}" must contain one to four distinct measures.`,
    );
  const signature = definition.rules
    .map(
      (rule) =>
        `${rule.metricId}:${String(rule.min ?? "")}:${String(rule.max ?? "")}`,
    )
    .sort()
    .join("|");
  if (presetSignatures.has(signature))
    throw new Error(
      `Portfolio screen preset "${definition.id}" duplicates another rule set.`,
    );
  presetSignatures.add(signature);
  return definition;
}

export const PORTFOLIO_SCREEN_PRESETS = [
  defineScreenPreset({
    id: "growth-margin",
    label: "Growth & margin ≥ 0",
    description:
      "Reported revenue growth and operating margin are both nonnegative.",
    rules: [
      { metricId: "revenueGrowth", min: "0", max: "" },
      { metricId: "operatingMargin", min: "0", max: "" },
    ],
  }),
  defineScreenPreset({
    id: "debt-assets",
    label: "Debt / assets ≥ 50%",
    description:
      "Reported debt is at least 50% of assets, where this measure applies.",
    rules: [{ metricId: "debtAssets", min: "50", max: "" }],
  }),
  defineScreenPreset({
    id: "current-ratio",
    label: "Current ratio ≤ 1×",
    description:
      "Reported current assets are no more than current liabilities.",
    rules: [{ metricId: "currentRatio", min: "", max: "1" }],
  }),
  defineScreenPreset({
    id: "cash-earnings",
    label: "Net income & operating cash flow ≥ 0",
    description:
      "Reported net income and operating cash flow are both nonnegative.",
    rules: [
      { metricId: "netIncome", min: "0", max: "" },
      { metricId: "operatingCashFlow", min: "0", max: "" },
    ],
  }),
  defineScreenPreset({
    id: "positive-returns",
    label: "ROA & ROE ≥ 0",
    description:
      "Returns on average reported assets and equity are both nonnegative.",
    rules: [
      { metricId: "roa", min: "0", max: "" },
      { metricId: "roe", min: "0", max: "" },
    ],
  }),
  defineScreenPreset({
    id: "cash-flow-margins",
    label: "Cash-flow margins ≥ 0",
    description:
      "Operating cash flow margin and the defined free cash flow margin are both nonnegative.",
    rules: [
      { metricId: "operatingCashFlowMargin", min: "0", max: "" },
      { metricId: "freeCashFlowMargin", min: "0", max: "" },
    ],
  }),
  defineScreenPreset({
    id: "liquidity-ratios",
    label: "Current ratio ≥ 1× & cash ratio ≥ 0.1×",
    description:
      "Reported current assets equal or exceed current liabilities, and cash equals at least 10% of current liabilities.",
    rules: [
      { metricId: "currentRatio", min: "1", max: "" },
      { metricId: "cashRatio", min: "0.1", max: "" },
    ],
  }),
  defineScreenPreset({
    id: "bank-funding",
    label: "Net loans / deposits ≤ 100%",
    description:
      "Reported net loans do not exceed reported deposits where the banking measure applies.",
    rules: [{ metricId: "loanDeposits", min: "", max: "100" }],
  }),
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
      const normalized = {
        ...issuer,
        cik,
        sector:
          typeof issuer.sector === "string" && issuer.sector.trim()
            ? issuer.sector.trim()
            : null,
        rowId: issuer.rowIds?.[0] || null,
      };
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
          periodKey:
            status === "available" ? observation.periodKey || null : null,
          definition:
            status === "available" ? observation.definition || null : null,
          evidence:
            status === "available" ? observation.evidence || null : null,
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
        lens: company?.lens || issuer.lens || "unknown",
        availableCount,
        missingCount,
        notApplicableCount: cells.length - availableCount - missingCount,
        eligibleCount: availableCount + missingCount,
      };
    })
    .filter(
      (row) => row.cik && (!filters.companiesOnly || row.kind === "company"),
    );
  const scopedRows = allRows.filter(
    (row) =>
      matchesSector(row, filters.sector) &&
      (!filters.industry || row.industry === filters.industry) &&
      (!filters.lens || row.lens === filters.lens) &&
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
        compareIssuerNames(a, b),
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
    sectors: [
      ...new Set(
        allRows.filter((row) => row.kind === "company").map(sectorLabel),
      ),
    ].sort(),
    filters: {
      query: String(filters.query || ""),
      industry: String(filters.industry || ""),
      sector: String(filters.sector || ""),
      lens: String(filters.lens || ""),
      metricId: String(filters.metricId || ""),
      gapsOnly: Boolean(filters.gapsOnly),
    },
  };
}

/** Offer measures only when the active company scope contains usable evidence. */
export function availablePortfolioScreenMetrics(
  report,
  companies = EMPTY,
  options = {},
) {
  const matrix = buildPortfolioCoverageMatrix(report, companies, {
    sector: options.sector,
    industry: options.industry,
    lens: options.lens,
    companiesOnly: true,
  });
  const availableIds = new Set(
    matrix.rows.flatMap((row) =>
      row.cells
        .filter(
          (cell) =>
            cell.status === "available" &&
            (!options.matchingPeriodOnly || cell.periodKey),
        )
        .map((cell) => cell.metricId),
    ),
  );
  return matrix.metrics.filter((metric) => availableIds.has(metric.id));
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
    sector: options.sector,
    industry: options.industry,
    lens: options.lens,
    companiesOnly: true,
  });
  const metricById = new Map(
    matrix.metrics.map((metric) => [metric.id, metric]),
  );
  const displayMetricIds = [
    ...new Set(
      (Array.isArray(options.displayMetricIds)
        ? options.displayMetricIds
        : []
      ).filter(
        (metricId) =>
          typeof metricId === "string" && metricById.has(metricId),
      ),
    ),
  ];
  const displayMetrics = displayMetricIds.map((metricId) =>
    metricById.get(metricId),
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
        const displayCells = displayMetricIds.map((metricId) =>
          row.cells.find((cell) => cell.metricId === metricId),
        );
        const hasNotApplicable = cells.some(
          (cell) => cell.status === "not-applicable",
        );
        const hasMissing = cells.some((cell) => cell.status === "missing");
        const mismatched =
          options.matchingPeriodOnly &&
          cells.every((cell) => cell.status === "available") &&
          (cells.some((cell) => !cell.periodKey) ||
            new Set(cells.map((cell) => cell.periodKey)).size !== 1);
        const status = hasNotApplicable
          ? "not-applicable"
          : hasMissing
            ? "missing"
            : mismatched
              ? "period-mismatch"
              : cells.every(
                    (cell, index) =>
                      (validatedRules[index].min === null ||
                        cell.value >= validatedRules[index].min) &&
                      (validatedRules[index].max === null ||
                        cell.value <= validatedRules[index].max),
                  )
                ? "match"
                : "outside-rules";
        const failures = validatedRules.flatMap((rule, index) =>
          cells[index].status === "available" &&
          ((rule.min !== null && cells[index].value < rule.min) ||
            (rule.max !== null && cells[index].value > rule.max))
            ? [rule.label]
            : [],
        );
        return { ...row, cells, displayCells, status, failures };
      })
    : [];
  const matches = resultRows.filter((row) => row.status === "match");
  const missing = resultRows.filter((row) => row.status === "missing");
  const notApplicable = resultRows.filter(
    (row) => row.status === "not-applicable",
  );
  const mismatched = resultRows.filter(
    (row) => row.status === "period-mismatch",
  );
  const outside = resultRows.filter((row) => row.status === "outside-rules");
  const measuredCount =
    resultRows.length -
    missing.length -
    notApplicable.length -
    mismatched.length;
  const sortBy = options.sortBy || "name";
  const direction = options.direction === "desc" ? -1 : 1;
  matches.sort((a, b) => {
    if (sortBy === "name") return direction * compareIssuerNames(a, b);
    const av =
      sortBy === "weight"
        ? a.weightPct
        : [...a.cells, ...a.displayCells].find(
            (cell) => cell.metricId === sortBy,
          )?.value;
    const bv =
      sortBy === "weight"
        ? b.weightPct
        : [...b.cells, ...b.displayCells].find(
            (cell) => cell.metricId === sortBy,
          )?.value;
    if (!finite(av) || !finite(bv))
      return finite(av) ? -1 : finite(bv) ? 1 : compareIssuerNames(a, b);
    return direction * (av - bv) || compareIssuerNames(a, b);
  });
  return {
    valid,
    errors,
    rules: validatedRules,
    displayMetrics,
    capturedAt: report?.capturedAt || null,
    weighted: Boolean(report?.weighted),
    unresolvedCount: report?.unresolvedCount || 0,
    industries: matrix.industries,
    sectors: matrix.sectors,
    industry: String(options.industry || ""),
    sector: String(options.sector || ""),
    scopeCount: matrix.rows.length,
    eligibleCount: valid ? resultRows.length - notApplicable.length : null,
    measuredCount: valid ? measuredCount : null,
    missingCount: valid ? missing.length : null,
    notApplicableCount: valid ? notApplicable.length : null,
    matchCount: valid ? matches.length : null,
    knownMatchedWeightPct: valid ? knownWeight(matches, report) : null,
    incompleteMatchedWeightCount: matches.filter((row) => !row.weightComplete)
      .length,
    lens: options.lens || "",
    matchingPeriodOnly: Boolean(options.matchingPeriodOnly),
    mismatched,
    outside,
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
      "sector_filter",
      "business_model",
      "matching_full_periods_required",
      "period_mismatch_companies",
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
      "sector",
      "known_original_weight_pct",
      "weight_complete",
      ...screen.rules.flatMap((rule) => [
        `${rule.metricId}_value`,
        `${rule.metricId}_unit`,
        `${rule.metricId}_period_end`,
        `${rule.metricId}_full_period`,
        `${rule.metricId}_definition`,
        `${rule.metricId}_sec_source`,
      ]),
    ],
    ...screen.matches.map((row) => [
      screen.capturedAt,
      screen.industry || "All SEC industries",
      screen.sector || "All sectors",
      screen.lens || "All business models",
      screen.matchingPeriodOnly,
      screen.mismatched?.length || 0,
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
      sectorLabel(row),
      screen.weighted ? row.weightPct : null,
      screen.weighted ? row.weightComplete : null,
      ...row.cells.flatMap((cell) => [
        cell.value,
        cell.unit,
        cell.periodEnd,
        cell.periodKey,
        cell.definition,
        cell.evidence || cell.sourceUrl,
      ]),
    ]),
  ]);
}

export function portfolioCoverageCsv(matrix) {
  return csvString([
    [
      "captured_at",
      "industry_filter",
      "sector_filter",
      "company_filter",
      "gaps_only",
      "cik",
      "company",
      "tickers",
      "sec_industry",
      "sector",
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
        matrix.filters.sector || "All sectors",
        matrix.filters.query,
        matrix.filters.gapsOnly,
        row.cik,
        row.name,
        row.tickers.join("; "),
        row.industry,
        row.kind === "company" ? sectorLabel(row) : "Not applicable",
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
