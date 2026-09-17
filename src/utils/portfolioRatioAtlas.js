import { buildPortfolioFinancialProfile } from "./portfolioFinancialProfile.js";
import { PORTFOLIO_METRIC_CATALOG } from "./portfolioMetricCatalog.js";
import { canonicalPortfolioCik } from "./portfolioModel.js";
import { portfolioPeriodKey, portfolioPeriodLabel } from "./portfolioReporting.js";
import { analysisMetricGuide } from "./analysisMetricGuide.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const validWeight = (value) => finite(value) && value >= 0;
const text = (value) => (typeof value === "string" ? value : "");
const unique = (values) => [...new Set(values.filter(Boolean))];
const category = (id, label, description, metricIds) =>
  Object.freeze({ id, label, description, metricIds: Object.freeze(metricIds) });

/** Curated ratio families, including measures with no available observations. */
export const PORTFOLIO_RATIO_ATLAS_CATEGORIES = Object.freeze({
  corporate: Object.freeze([
    category("profitability", "Profitability", "How revenue becomes earnings, before and after operating costs and taxes.", ["grossMargin", "operatingMargin", "pretaxMargin", "netMargin", "effectiveTaxRate"]),
    category("liquidity", "Liquidity", "Reported cash and current assets relative to near-term obligations and the asset base.", ["currentRatio", "cashRatio", "cashAssets"]),
    category("leverage", "Leverage", "Debt, liabilities and equity supporting the business, alongside interest-servicing capacity.", ["debtAssets", "reportedDebtEquity", "liabilitiesAssets", "equityAssets", "operatingInterestCoverage"]),
    category("cash-generation", "Cash generation", "Cash conversion, cash margins and reinvestment relative to company revenue.", ["operatingCashFlowMargin", "freeCashFlowMargin", "cashConversion", "capexRevenue", "researchRevenue"]),
    category("drivers", "Returns & efficiency", "Returns on assets and equity, and the operating drivers that connect them.", ["roe", "roa", "assetTurnover", "equityMultiplier", "dupontRoe"]),
    category("growth", "Growth", "Revenue change over comparable company reporting periods.", ["revenueGrowth"]),
  ]),
  banking: Object.freeze([
    category("profitability", "Profitability & efficiency", "Bank earnings, operating efficiency and returns on the asset and equity base.", ["bankNetMargin", "efficiency", "roe", "roa", "effectiveTaxRate"]),
    category("funding-credit", "Funding & credit", "Deposit funding, loan intensity, credit reserves and provision coverage.", ["loanDeposits", "allowanceLoans", "provisionLoans"]),
    category("capital-liquidity", "Capital & liquidity", "Reported equity, liabilities and cash relative to bank assets; these are not regulatory capital or liquidity ratios.", ["equityAssets", "liabilitiesAssets", "cashAssets"]),
    category("cash-conversion", "Cash conversion", "Operating cash flow relative to positive net income. This statement relationship is not a measure of bank liquidity or earnings quality.", ["cashConversion"]),
    category("drivers", "Return drivers", "Asset utilization and leverage components underlying reported bank returns.", ["assetTurnover", "equityMultiplier", "dupontRoe"]),
  ]),
  insurance: Object.freeze([
    category("returns", "Returns", "Reported earnings relative to the insurer asset and equity base.", ["roe", "roa", "effectiveTaxRate"]),
    category("capital", "Capital structure", "Reported equity, liabilities and selected debt relative to assets and equity; these are not regulatory solvency ratios.", ["equityAssets", "liabilitiesAssets", "debtAssets", "reportedDebtEquity"]),
    category("liquidity", "Liquidity & cash conversion", "Reported cash relative to assets and operating cash flow relative to positive earnings.", ["cashAssets", "cashConversion"]),
  ]),
  common: Object.freeze([
    category("returns", "Returns", "Reported returns on assets and equity for this accounting model.", ["roe", "roa"]),
    category("capital-liquidity", "Capital & liquidity", "A conservative view of reported equity and cash relative to assets.", ["equityAssets", "cashAssets"]),
    category("growth", "Growth", "Comparable company revenue change where supported by the reporting evidence.", ["revenueGrowth"]),
  ]),
});

const catalogById = new Map(PORTFOLIO_METRIC_CATALOG.map((entry) => [entry.key, entry]));

function parsedDefinition(value) {
  if (value && typeof value === "object") return value;
  try {
    const result = JSON.parse(value || "null");
    return result && typeof result === "object" ? result : {};
  } catch {
    return {};
  }
}

function secUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "sec.gov" || url.hostname.endsWith(".sec.gov")) &&
      !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function allocationFor(companies, weighted) {
  if (!weighted) return null;
  if (!companies.length) return 0;
  const known = companies.filter((company) => validWeight(company.weightPct));
  return known.length
    ? known.reduce((total, company) => total + company.weightPct, 0)
    : null;
}

function allWeightsKnown(companies, weighted) {
  return weighted && companies.every((company) =>
    validWeight(company.weightPct) && company.weightComplete,
  );
}

function scopedCompanies(report, profile) {
  const ciks = new Set(profile.companyCiks);
  const result = new Map();
  for (const issuer of report.concentration?.issuers || []) {
    const cik = canonicalPortfolioCik(issuer?.cik);
    if (issuer?.kind !== "company" || !cik || !ciks.has(cik)) continue;
    const current = result.get(cik);
    const hasWeight = profile.weighted && validWeight(issuer.weightPct);
    if (!current) {
      result.set(cik, {
        cik,
        name: text(issuer.name),
        ticker: "",
        tickers: unique(issuer.tickers || []).sort(),
        rowIds: unique(issuer.rowIds || []).sort(),
        lens: profile.lens,
        sector: issuer.sector || "Sector not covered",
        industry: text(issuer.industry),
        weightPct: hasWeight ? issuer.weightPct : null,
        weightComplete: Boolean(hasWeight && issuer.weightComplete !== false),
      });
    } else {
      current.tickers = unique([...current.tickers, ...(issuer.tickers || [])]).sort();
      current.rowIds = unique([...current.rowIds, ...(issuer.rowIds || [])]).sort();
      if (hasWeight) current.weightPct = (current.weightPct ?? 0) + issuer.weightPct;
      current.weightComplete = current.weightComplete && hasWeight && issuer.weightComplete !== false;
    }
  }
  return [...result.values()].map((company) => ({
    ...company,
    ticker: company.tickers.join(" / "),
    rowId: company.rowIds[0] || null,
    cells: {},
  })).sort((a, b) =>
    (a.ticker || a.name || a.cik).localeCompare(b.ticker || b.name || b.cik) || a.cik.localeCompare(b.cik),
  );
}

const midpoint = (sorted) => {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function emptyCell(company, metric, status) {
  return {
    cik: company.cik,
    rowId: company.rowId,
    metricId: metric.id,
    status,
    value: null,
    unit: metric.unit,
    format: metric.format,
    formula: metric.formula,
    definition: null,
    scopeNotes: [],
    period: null,
    periodKey: null,
    periodStart: null,
    periodEnd: null,
    periodLabel: "Reporting period unavailable",
    sourceUrl: null,
    evidence: "",
    evidenceUrls: [],
    peerKey: null,
    peerCount: 0,
    peerPositionPct: null,
    peerMin: null,
    peerMax: null,
    peerMedian: null,
    peerPeriodLabel: null,
  };
}

/**
 * Financial values remain company observations. A position is the value's
 * location between the minimum and maximum of the same metric, accounting
 * model, formula and exact reporting period. It is neither a rank nor a
 * quality score. Unknown allocation and unavailable values remain null.
 */
export function buildPortfolioRatioAtlas(catalogReport, options = {}) {
  const report = catalogReport || {};
  const profile = options.profile || buildPortfolioFinancialProfile(report, options);
  const companies = scopedCompanies(report, profile);
  const companyByCik = new Map(companies.map((company) => [company.cik, company]));
  const rawMetrics = new Map((report.metrics || []).map((metric) => [metric.id || metric.key, metric]));
  const summaries = new Map(profile.metricSummaries.map((metric) => [metric.id, metric]));
  const definitions = PORTFOLIO_RATIO_ATLAS_CATEGORIES[profile.lens] || [];
  const metrics = [];

  for (const group of definitions) {
    for (const id of group.metricIds) {
      const registry = catalogById.get(id);
      if (!registry) continue;
      const raw = rawMetrics.get(id);
      const summary = summaries.get(id);
      const guide = analysisMetricGuide(registry, {}, profile.lens);
      const metric = {
        id,
        key: id,
        label: registry.label,
        format: registry.format,
        unit: registry.format === "percent" ? "%" : "x",
        formula: text(raw?.formula) || text(summary?.formula) || text(registry.formula) || null,
        categoryId: group.id,
        categoryLabel: group.label,
        description: guide.meaning,
        caution: guide.caution,
      };
      const notApplicable = new Set((raw?.notApplicableCiks || []).map(canonicalPortfolioCik).filter(Boolean));
      const observations = new Map((summary?.observations || [])
        .filter((row) => finite(row.value) && (!row.lens || row.lens === profile.lens))
        .map((row) => [canonicalPortfolioCik(row.cik), row]));
      const cohorts = new Map();

      for (const company of companies) {
        const row = observations.get(company.cik);
        const cell = emptyCell(company, metric, !row && notApplicable.has(company.cik) ? "not-applicable" : "missing");
        if (row) {
          const definition = parsedDefinition(row.definition);
          const formula = text(definition.formula) || metric.formula;
          const period = row.period && typeof row.period === "object" ? { ...row.period } : null;
          const periodKey = portfolioPeriodKey(period) || null;
          const evidenceUrls = unique([row.sourceUrl, ...text(row.evidence).split(/\s*;\s*/)].map(secUrl));
          const tags = (Array.isArray(definition.tags) ? definition.tags : []).map((tag) => text(tag).split(":").at(-1));
          const scopeNotes = analysisMetricGuide(registry, {
            value: row.value,
            sources: tags.map((tag) => ({ tag })),
          }, profile.lens).scopeNotes;
          // Formula and explicit scope changes do not silently share a range.
          const scope = unique([
            text(row.scope || definition.scope).trim(),
            ...tags.filter((tag) => /RestrictedCash|CashAndDueFromBanks/.test(tag) || tag === "ProfitLoss"),
          ]).sort().join(" | ");
          const peerKey = periodKey
            ? JSON.stringify([profile.lens, id, metric.unit, periodKey, text(formula).trim().replace(/\s+/g, " "), scope])
            : null;
          Object.assign(cell, {
            rowId: row.rowId || company.rowId,
            status: "available",
            value: row.value,
            formula,
            definition,
            scopeNotes,
            period,
            periodKey,
            periodStart: period?.start || null,
            periodEnd: period?.end || null,
            periodLabel: portfolioPeriodLabel(period),
            sourceUrl: secUrl(row.sourceUrl) || evidenceUrls[0] || null,
            evidence: evidenceUrls.join(" ; "),
            evidenceUrls,
            peerKey,
          });
          if (peerKey) {
            const cohort = cohorts.get(peerKey) || { id: peerKey, periodKey, period, formula, scope, cells: [] };
            cohort.cells.push(cell);
            cohorts.set(peerKey, cohort);
          }
        }
        company.cells[id] = cell;
      }

      const cohortSummaries = [...cohorts.values()].map((cohort) => {
        const values = cohort.cells.map((cell) => cell.value).sort((a, b) => a - b);
        const min = values[0];
        const max = values.at(-1);
        const median = midpoint(values);
        for (const cell of cohort.cells) Object.assign(cell, {
          peerCount: values.length,
          peerMin: min,
          peerMax: max,
          peerMedian: median,
          peerPositionPct: values.length < 2 ? null : max === min ? 50 : ((cell.value - min) / (max - min)) * 100,
          peerPeriodLabel: portfolioPeriodLabel(cohort.period),
        });
        return {
          id: cohort.id,
          periodKey: cohort.periodKey,
          period: cohort.period,
          periodLabel: portfolioPeriodLabel(cohort.period),
          formula: cohort.formula,
          scope: cohort.scope || null,
          companyCount: values.length,
          ciks: cohort.cells.map((cell) => cell.cik),
          min,
          max,
          median,
          knownAllocationPct: allocationFor(cohort.cells.map((cell) => companyByCik.get(cell.cik)), profile.weighted),
        };
      }).sort((a, b) => b.companyCount - a.companyCount || a.periodKey.localeCompare(b.periodKey) || a.id.localeCompare(b.id));
      const measured = companies.filter((company) => company.cells[id].status === "available");
      const eligible = companies.filter((company) => company.cells[id].status !== "not-applicable");
      metrics.push({
        ...metric,
        availableCompanyCount: measured.length,
        eligibleCompanyCount: eligible.length,
        missingCompanyCount: eligible.length - measured.length,
        notApplicableCompanyCount: companies.length - eligible.length,
        knownAllocationPct: allocationFor(measured, profile.weighted),
        weightCoverageComplete: allWeightsKnown(measured, profile.weighted),
        cohorts: cohortSummaries,
      });
    }
  }

  const metricsById = new Map(metrics.map((metric) => [metric.id, metric]));
  const categories = definitions.map((group) => {
    const groupMetrics = group.metricIds.map((id) => metricsById.get(id)).filter(Boolean);
    const measured = companies.filter((company) => groupMetrics.some((metric) => company.cells[metric.id].status === "available"));
    return {
      ...group,
      metrics: groupMetrics,
      availableCompanyCount: measured.length,
      knownAllocationPct: allocationFor(measured, profile.weighted),
      availableMetricCount: groupMetrics.filter((metric) => metric.availableCompanyCount > 0).length,
    };
  }).filter((group) => group.metrics.length > 0);
  const measured = companies.filter((company) => Object.values(company.cells).some((cell) => cell.status === "available"));
  return {
    lens: profile.lens,
    lensDefinition: profile.lensDefinition,
    sector: profile.sector,
    weighted: profile.weighted,
    companyCount: companies.length,
    availableCompanyCount: measured.length,
    companies,
    metrics,
    categories,
    knownAllocationPct: allocationFor(companies, profile.weighted),
    measuredAllocationPct: allocationFor(measured, profile.weighted),
    weightCoverageComplete: allWeightsKnown(companies, profile.weighted),
  };
}
