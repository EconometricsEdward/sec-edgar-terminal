import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCIAL_PROFILE_ALL_SECTORS,
  FINANCIAL_PROFILE_UNCOVERED_SECTOR,
  FINANCIAL_PROFILE_LENSES,
  FINANCIAL_PROFILE_CATEGORY_DEFINITIONS,
  buildPortfolioFinancialProfile,
  normalizeFinancialProfileSector,
} from "../src/utils/portfolioFinancialProfile.js";

const cik = (value) => String(value).padStart(10, "0");
const period = (start = "2025-01-01", end = "2025-12-31") => ({
  kind: "annual",
  start,
  end,
});
const observation = (
  companyCik,
  value,
  {
    lens = "corporate",
    reportingPeriod = period(),
    ticker = `C${Number(companyCik)}`,
    rowId = `r${Number(companyCik)}`,
    sourceUrl = "https://www.sec.gov/Archives/test.htm",
  } = {},
) => ({
  cik: String(companyCik),
  rowId,
  name: `Company ${Number(companyCik)}`,
  ticker,
  lens,
  industry: "Test industry",
  sector: "Test sector",
  value,
  period: reportingPeriod,
  periodEnd: reportingPeriod.end,
  periodKey: `${reportingPeriod.kind}|${reportingPeriod.start}|${reportingPeriod.end}`,
  sourceUrl,
  definition: JSON.stringify({ formula: "Test formula" }),
  evidence: sourceUrl,
});
const metric = (
  id,
  format,
  observations,
  {
    lenses = ["corporate"],
    eligibleCiks = observations.map((row) => row.cik),
    missingCiks = [],
    notApplicableCiks = [],
    formula = `${id} formula`,
  } = {},
) => ({
  id,
  key: id,
  label: id,
  format,
  unit: format === "percent" ? "%" : format === "decimal" ? "x" : "USD",
  category: ["percent", "decimal"].includes(format) ? "ratios" : "income",
  lenses,
  formula,
  availableCount: observations.length,
  observations,
  eligibleCiks,
  missingCiks,
  notApplicableCiks,
});
const issuer = (
  companyCik,
  lens = "corporate",
  weightPct = null,
  extra = {},
) => ({
  cik: String(companyCik),
  kind: "company",
  name: `Company ${Number(companyCik)}`,
  tickers: [`C${Number(companyCik)}`],
  rowIds: [`r${Number(companyCik)}`],
  lens,
  industry: "Test industry",
  sector: "Test sector",
  weightPct,
  weightComplete: Number.isFinite(weightPct),
  ...extra,
});
const report = (issuers, metrics, extra = {}) => ({
  weighted: true,
  fundCount: 0,
  unresolvedCount: 0,
  concentration: { issuers },
  metrics,
  ...extra,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("profile definitions provide curated, lens-specific financial groups", () => {
  assert.deepEqual(
    FINANCIAL_PROFILE_LENSES.map((lens) => lens.id),
    ["corporate", "banking", "insurance", "common"],
  );
  for (const lens of FINANCIAL_PROFILE_LENSES) {
    assert.ok(lens.label && lens.description);
    assert.ok(FINANCIAL_PROFILE_CATEGORY_DEFINITIONS[lens.id].length >= 3);
    assert.ok(
      FINANCIAL_PROFILE_CATEGORY_DEFINITIONS[lens.id].every(
        (group) => group.label && group.description && group.metricIds.length,
      ),
    );
  }
  assert.ok(
    FINANCIAL_PROFILE_CATEGORY_DEFINITIONS.banking
      .flatMap((group) => group.metricIds)
      .includes("loanDeposits"),
  );
  assert.ok(
    !FINANCIAL_PROFILE_CATEGORY_DEFINITIONS.banking
      .flatMap((group) => group.metricIds)
      .includes("currentRatio"),
  );
});

test("banking categories expose available cash conversion with a bank-specific caution", () => {
  const cashConversion = metric(
    "cashConversion",
    "percent",
    [observation(1, 125, { lens: "banking" })],
    {
      lenses: ["banking"],
      eligibleCiks: [cik(1)],
    },
  );
  const profile = buildPortfolioFinancialProfile(
    report([issuer(1, "banking", 100)], [cashConversion]),
    { lens: "banking" },
  );
  const category = profile.categories.find(
    (entry) => entry.id === "cash-conversion",
  );

  assert.ok(category);
  assert.equal(category.label, "Cash conversion");
  assert.match(
    category.description,
    /not a measure of bank liquidity or earnings quality/,
  );
  assert.deepEqual(
    category.metrics.map((entry) => entry.id),
    ["cashConversion"],
  );
  assert.equal(category.metrics[0].measuredCompanyCount, 1);
  assert.equal(category.metrics[0].category, "cash-conversion");
});

test("sector groups expose the full portfolio and keep mixed sectors in separate accounting cohorts", () => {
  const issuers = [
    issuer(1, "corporate", 40, { sector: "Information Technology" }),
    issuer(2, "corporate", 20, { sector: "Energy" }),
    issuer(3, "banking", 15, { sector: "Financials" }),
    issuer(4, "banking", 10, { sector: "Financials" }),
    issuer(5, "common", 5, { sector: "Financials" }),
    issuer(6, "insurance", 10, { sector: "Health Care" }),
  ];
  const netMargin = metric(
    "netMargin",
    "percent",
    [observation(1, 20), observation(2, 8)],
    { lenses: ["corporate"], eligibleCiks: [cik(1), cik(2)] },
  );
  const loanDeposits = metric(
    "loanDeposits",
    "percent",
    [
      observation(3, 82, { lens: "banking" }),
      observation(4, 91, { lens: "banking" }),
    ],
    { lenses: ["banking"], eligibleCiks: [cik(3), cik(4)] },
  );
  const roe = metric(
    "roe",
    "percent",
    [
      observation(5, 11, { lens: "common" }),
      observation(6, 14, { lens: "insurance" }),
    ],
    {
      lenses: ["common", "insurance"],
      eligibleCiks: [cik(5), cik(6)],
    },
  );
  const source = report(issuers, [netMargin, loanDeposits, roe]);
  const all = buildPortfolioFinancialProfile(source);
  const financials = buildPortfolioFinancialProfile(source, {
    sector: "Financials",
  });
  const otherFinancials = buildPortfolioFinancialProfile(source, {
    sector: "Financials",
    lens: "common",
  });

  assert.equal(all.sector, FINANCIAL_PROFILE_ALL_SECTORS);
  assert.equal(all.sectorGroups.length, 5);
  assert.deepEqual(
    new Set(all.sectorGroups.map((group) => group.label)),
    new Set([
      "All sectors",
      "Information Technology",
      "Energy",
      "Financials",
      "Health Care",
    ]),
  );
  assert.equal(all.sectorGroups[0].companyCount, 6);
  assert.equal(all.sectorGroups[0].knownWeightPct, 100);
  assert.equal(financials.sectorCompanyCount, 3);
  assert.equal(financials.sectorKnownWeightPct, 30);
  assert.equal(financials.lens, "banking");
  assert.equal(financials.companyCount, 2);
  assert.deepEqual(
    financials.lensGroups
      .filter((group) => group.companyCount)
      .map((group) => [group.id, group.companyCount]),
    [
      ["banking", 2],
      ["common", 1],
    ],
  );
  assert.deepEqual(
    financials.metricSummaries
      .find((entry) => entry.id === "loanDeposits")
      .observations.map((row) => row.cik),
    [cik(3), cik(4)],
  );
  assert.equal(
    financials.metricSummaries.find((entry) => entry.id === "netMargin")
      .measuredCompanyCount,
    0,
  );
  assert.equal(otherFinancials.companyCount, 1);
  assert.deepEqual(
    otherFinancials.metricSummaries
      .find((entry) => entry.id === "roe")
      .observations.map((row) => row.cik),
    [cik(5)],
  );
});

test("sector metadata stays reviewable and uncovered sectors remain distinct from unknown accounting models", () => {
  const issuers = [
    issuer(1, "corporate", 55, {
      sector: "Industrials",
      sectorSource: {
        provider: "Example fund",
        asOf: "2026-09-08",
        url: "https://example.com/holdings.csv",
      },
    }),
    issuer(2, "corporate", 25, { sector: "" }),
    issuer(3, "unknown", 20, { sector: "" }),
  ];
  const source = report(
    issuers,
    [metric("netMargin", "percent", [observation(1, 12), observation(2, 4)])],
  );
  const all = buildPortfolioFinancialProfile(source);
  const industrials = all.sectorGroups.find(
    (group) => group.id === "Industrials",
  );
  const uncovered = buildPortfolioFinancialProfile(source, {
    sector: FINANCIAL_PROFILE_UNCOVERED_SECTOR,
    lens: "corporate",
  });

  assert.equal(industrials.sectorSourceAsOf, "2026-09-08");
  assert.deepEqual(industrials.sectorSourceProviders, ["Example fund"]);
  assert.equal(uncovered.sectorCompanyCount, 2);
  assert.equal(uncovered.companyCount, 1);
  assert.equal(uncovered.coverage.unknownLensCompanyCount, 1);
  assert.equal(uncovered.exclusions.unknownLensCompanyCount, 1);
  assert.equal(uncovered.sectorDefinition.label, FINANCIAL_PROFILE_UNCOVERED_SECTOR);
});

test("sector labels normalize once and an unknown-only sector never claims a comparable cohort", () => {
  const source = report(
    [
      issuer(1, "unknown", 60, { sector: "  Financials  " }),
      issuer(2, "unknown", 40, { sector: "Financials" }),
    ],
    [],
  );
  const profile = buildPortfolioFinancialProfile(source, {
    sector: "Financials",
  });

  assert.equal(normalizeFinancialProfileSector("  Financials  "), "Financials");
  assert.equal(normalizeFinancialProfileSector(" "), FINANCIAL_PROFILE_UNCOVERED_SECTOR);
  assert.equal(profile.sectorCompanyCount, 2);
  assert.equal(profile.hasCompatibleCohort, false);
  assert.equal(profile.companyCount, 0);
  assert.deepEqual(profile.companyCiks, []);
});

test("canonical CIKs combine share-class allocation and duplicate observations once", () => {
  const issuers = [
    issuer("1", "corporate", 30, { tickers: ["ONE.A"], rowIds: ["a"] }),
    issuer(cik(1), "corporate", 20, {
      tickers: ["ONE.B"],
      rowIds: ["b"],
    }),
    issuer(2, "corporate", 50),
  ];
  const margin = metric("netMargin", "percent", [
    observation("1", 10, { ticker: "ONE.A", rowId: "a" }),
    observation(cik(1), 10, { ticker: "ONE.B", rowId: "b" }),
    observation(2, 20),
  ]);
  const profile = buildPortfolioFinancialProfile(report(issuers, [margin]), {
    lens: "corporate",
  });
  const summary = profile.metricSummaries.find(
    (entry) => entry.id === "netMargin",
  );

  assert.equal(profile.companyCount, 2);
  assert.equal(profile.lensGroups[0].knownWeightPct, 100);
  assert.equal(summary.measuredCompanyCount, 2);
  assert.equal(summary.coveredWeightPct, 100);
  assert.equal(summary.observations[0].weightPct, 50);
  assert.deepEqual(summary.observations[0].tickers, ["ONE.A", "ONE.B"]);
  assert.equal(summary.median, 15);
  assert.equal(summary.weightedMean, 15);
});

test("lens filtering keeps missing and not-applicable populations distinct", () => {
  const issuers = [
    issuer(1, "corporate", 25),
    issuer(2, "corporate", 25),
    issuer(3, "banking", 50),
  ];
  const currentRatio = metric(
    "currentRatio",
    "decimal",
    [observation(1, 1.4)],
    {
      eligibleCiks: [cik(1), cik(2)],
      missingCiks: [cik(2)],
      notApplicableCiks: [cik(3)],
    },
  );
  const loans = metric(
    "loanDeposits",
    "percent",
    [observation(3, 88, { lens: "banking" })],
    {
      lenses: ["banking"],
      eligibleCiks: [cik(3)],
      notApplicableCiks: [cik(1), cik(2)],
    },
  );
  const rawIncome = metric(
    "netIncome",
    "currency",
    [observation(1, 10), observation(3, 20, { lens: "banking" })],
    { lenses: ["corporate", "banking"] },
  );
  const corporate = buildPortfolioFinancialProfile(
    report(issuers, [currentRatio, loans, rawIncome]),
    { lens: "corporate" },
  );
  const banking = buildPortfolioFinancialProfile(
    report(issuers, [currentRatio, loans, rawIncome]),
    { lens: "banking" },
  );
  const corporateCurrent = corporate.metricSummaries.find(
    (entry) => entry.id === "currentRatio",
  );
  const bankCurrent = banking.metricSummaries.find(
    (entry) => entry.id === "currentRatio",
  );

  assert.equal(corporateCurrent.measuredCompanyCount, 1);
  assert.equal(corporateCurrent.eligibleCompanyCount, 2);
  assert.equal(corporateCurrent.missingCompanyCount, 1);
  assert.equal(corporateCurrent.notApplicableCompanyCount, 0);
  assert.equal(bankCurrent.measuredCompanyCount, 0);
  assert.equal(bankCurrent.eligibleCompanyCount, 0);
  assert.equal(bankCurrent.missingCompanyCount, 0);
  assert.equal(bankCurrent.notApplicableCompanyCount, 1);
  assert.equal(banking.companyCount, 1);
  assert.equal(banking.metricCount, 1);
  assert.equal(banking.featuredPillars[2].metricId, "loanDeposits");
  assert.ok(
    banking.categories
      .find((category) => category.id === "funding-credit")
      .metrics.some((entry) => entry.id === "loanDeposits"),
  );
  assert.ok(
    !banking.metricSummaries.some((entry) => entry.id === "netIncome"),
  );
});

test("zero and negative values remain measured in summaries and factual screens", () => {
  const issuers = [
    issuer(1, "corporate", 40),
    issuer(2, "corporate", 30),
    issuer(3, "corporate", 30),
  ];
  const margin = metric("netMargin", "percent", [
    observation(1, -10),
    observation(2, 0),
    observation(3, 20),
  ]);
  const income = metric(
    "netIncome",
    "currency",
    [observation(1, -1), observation(2, 0), observation(3, 1)],
    { lenses: ["corporate"] },
  );
  const profile = buildPortfolioFinancialProfile(
    report(issuers, [margin, income]),
    { lens: "corporate" },
  );
  const summary = profile.metricSummaries.find(
    (entry) => entry.id === "netMargin",
  );
  const loss = profile.attentionConditions.find(
    (entry) => entry.id === "net-loss",
  );
  const profit = profile.breadthScreens.find(
    (entry) => entry.id === "positive-net-income",
  );

  assert.deepEqual(
    summary.observations.map((row) => row.value),
    [-10, 0, 20],
  );
  assert.equal(summary.min, -10);
  assert.equal(summary.median, 0);
  assert.equal(summary.max, 20);
  assert.equal(summary.p25, -5);
  assert.equal(summary.p75, 10);
  assert.equal(summary.weightedMean, 2);
  assert.equal(summary.weightedMedian, 0);
  assert.equal(loss.matchedCompanyCount, 1);
  assert.equal(profit.matchedCompanyCount, 1);
  assert.equal(loss.measuredCompanyCount, 3);
});

test("weighted statistics use positive known source weights and never normalize coverage", () => {
  const observations = [
    observation(1, 10),
    observation(2, 30),
    observation(3, 50),
  ];
  const ratio = metric("netMargin", "percent", observations);
  const partial = buildPortfolioFinancialProfile(
    report(
      [
        issuer(1, "corporate", 60),
        issuer(2, "corporate", null),
        issuer(3, "corporate", 10),
      ],
      [ratio],
    ),
    { lens: "corporate" },
  );
  const partialMetric = partial.metricSummaries.find(
    (entry) => entry.id === "netMargin",
  );
  assert.equal(partial.measuredWeightPct, 70);
  assert.equal(partialMetric.coveredWeightPct, 70);
  assert.equal(partialMetric.weightedCompanyCount, 2);
  assert.equal(partialMetric.weightCoverageComplete, false);
  close(partialMetric.weightedMean, 1100 / 70);
  assert.equal(partialMetric.weightedMedian, 10);
  assert.equal(partialMetric.median, 30);

  const overAllocated = buildPortfolioFinancialProfile(
    report(
      [issuer(1, "corporate", 80), issuer(2, "corporate", 50)],
      [metric("netMargin", "percent", observations.slice(0, 2))],
    ),
    { lens: "corporate" },
  );
  const overMetric = overAllocated.metricSummaries.find(
    (entry) => entry.id === "netMargin",
  );
  assert.equal(overAllocated.measuredWeightPct, 130);
  assert.equal(overAllocated.lensGroups[0].knownWeightPct, 130);
  assert.equal(overMetric.coveredWeightPct, 130);
  close(overMetric.weightedMean, 2300 / 130);
});

test("histograms conserve unique observations and remain deterministic", () => {
  const issuers = [1, 2, 3, 4, 5].map((id) =>
    issuer(id, "corporate", 20),
  );
  const observations = [-2, 0, 4, 8, 16].map((value, index) =>
    observation(index + 1, value),
  );
  const first = buildPortfolioFinancialProfile(
    report(issuers, [metric("netMargin", "percent", observations)]),
    { lens: "corporate" },
  ).metricSummaries[0].histogram;
  const second = buildPortfolioFinancialProfile(
    report(
      [...issuers].reverse(),
      [metric("netMargin", "percent", [...observations].reverse())],
    ),
    { lens: "corporate" },
  ).metricSummaries[0].histogram;

  assert.deepEqual(second, first);
  assert.equal(
    first.bins.reduce((total, bin) => total + bin.count, 0),
    observations.length,
  );
  assert.equal(
    first.bins.reduce((total, bin) => total + bin.rows.length, 0),
    observations.length,
  );
  assert.deepEqual(
    first.bins.flatMap((bin) => bin.ciks).sort(),
    [1, 2, 3, 4, 5].map(cik),
  );
});

test("corporate fingerprint requires canonical CIK and identical full periods", () => {
  const issuers = [1, 2, 3, 4, 5].map((id) =>
    issuer(id, "corporate", 20),
  );
  const periodA = period("2025-01-01", "2025-12-31");
  const periodB = period("2025-01-02", "2025-12-31");
  const growth = metric("revenueGrowth", "percent", [
    observation("1", 5, { reportingPeriod: periodA }),
    observation("0000000002", -2, { reportingPeriod: periodA }),
    observation(3, 3, { reportingPeriod: periodA }),
    observation(4, 4, { reportingPeriod: periodA }),
    observation(5, 0, { reportingPeriod: periodA }),
  ]);
  const margin = metric("netMargin", "percent", [
    observation(cik(1), 10, { reportingPeriod: periodA }),
    observation(2, 8, { reportingPeriod: periodA }),
    observation(3, 9, { reportingPeriod: periodB }),
    observation(4, -4, { reportingPeriod: periodA }),
    observation(5, 0, { reportingPeriod: periodA }),
  ]);
  const freeCashFlow = metric(
    "freeCashFlow",
    "currency",
    [
      observation(1, 100, { reportingPeriod: periodA }),
      observation(2, -10, { reportingPeriod: periodA }),
      observation(3, 20, { reportingPeriod: periodA }),
      observation(5, 0, { reportingPeriod: periodA }),
    ],
    { lenses: ["corporate"] },
  );
  const profile = buildPortfolioFinancialProfile(
    report(issuers, [growth, margin, freeCashFlow]),
    { lens: "corporate" },
  );
  const fingerprint = profile.corporateFingerprint;

  assert.equal(fingerprint.eligibleCompanyCount, 5);
  assert.equal(fingerprint.pairedCompanyCount, 4);
  assert.equal(fingerprint.knownWeightPct, 80);
  assert.equal(fingerprint.periodMismatchCompanyCount, 1);
  assert.equal(fingerprint.missingMetricCompanyCount, 0);
  assert.deepEqual(
    fingerprint.points.map((point) => [point.cik, point.tone, point.quadrant]),
    [
      [cik(1), "positive", "profitable-growth"],
      [cik(2), "negative", "profitable-contraction"],
      [cik(4), "neutral", "loss-making-growth"],
      [cik(5), "neutral", "profitable-growth"],
    ],
  );
  assert.equal(fingerprint.fcfCounts.positive, 1);
  assert.equal(fingerprint.fcfCounts.negative, 1);
  assert.equal(fingerprint.fcfCounts.neutral, 2);
  assert.equal(
    fingerprint.quadrants.reduce(
      (total, quadrant) => total + quadrant.companyCount,
      0,
    ),
    fingerprint.pairedCompanyCount,
  );
});

test("funds and unresolved rows are excluded and the input is never mutated", () => {
  const company = issuer(1, "corporate", 50);
  const fund = issuer(2, "corporate", 30, {
    kind: "fund",
    tickers: ["ETF"],
  });
  const unresolved = issuer(3, "corporate", 20, {
    kind: "unknown",
    tickers: [],
  });
  const ratio = metric("netMargin", "percent", [
    observation(1, 10),
    observation(2, 90),
    observation(3, -90),
  ]);
  const input = report([company, fund, unresolved], [ratio], {
    fundCount: 1,
    unresolvedCount: 1,
  });
  const before = structuredClone(input);
  const profile = buildPortfolioFinancialProfile(input, { lens: "corporate" });

  assert.deepEqual(input, before);
  assert.equal(profile.companyCount, 1);
  assert.equal(profile.measuredCompanyCount, 1);
  assert.equal(profile.measuredWeightPct, 50);
  assert.equal(profile.metricSummaries[0].observations.length, 1);
  assert.equal(profile.exclusions.fundCount, 1);
  assert.equal(profile.exclusions.unresolvedCount, 1);
  assert.equal(profile.exclusions.fundKnownWeightPct, 30);
  assert.equal(profile.exclusions.unresolvedKnownWeightPct, 20);
});

test("unknown-lens companies are disclosed without entering any lens denominator", () => {
  const issuers = [
    issuer(1, "corporate", 40),
    issuer("2", "unknown", 20, {
      tickers: ["TWO.A"],
      rowIds: ["two-a"],
    }),
    issuer(cik(2), "unknown", 15, {
      tickers: ["TWO.B"],
      rowIds: ["two-b"],
    }),
    issuer(3, "unknown", 10, { lens: undefined }),
  ];
  const ratio = metric("netMargin", "percent", [
    observation(1, 10),
    observation(2, 90, { lens: "unknown" }),
    observation(3, -90, { lens: "unknown" }),
  ]);
  const profile = buildPortfolioFinancialProfile(report(issuers, [ratio]), {
    lens: "corporate",
  });

  assert.equal(profile.companyCount, 1);
  assert.equal(profile.measuredCompanyCount, 1);
  assert.equal(profile.measuredWeightPct, 40);
  assert.equal(
    profile.lensGroups.reduce(
      (total, group) => total + group.companyCount,
      0,
    ),
    1,
  );
  assert.equal(profile.coverage.profiledCompanyCount, 1);
  assert.equal(profile.coverage.profiledKnownWeightPct, 40);
  assert.equal(profile.coverage.unknownLensCompanyCount, 2);
  assert.equal(profile.coverage.unknownLensKnownWeightPct, 45);
  assert.equal(profile.coverage.totalResolvedCompanyCount, 3);
  assert.equal(profile.coverage.totalResolvedCompanyKnownWeightPct, 85);
  assert.equal(profile.exclusions.unknownLensCompanyCount, 2);
  assert.equal(profile.exclusions.unknownLensKnownWeightPct, 45);
  assert.deepEqual(profile.exclusions.unknownLensCiks, [cik(2), cik(3)]);
  assert.deepEqual(
    profile.metricSummaries[0].observations.map((row) => row.cik),
    [cik(1)],
  );
});

test("unweighted profiles use company shares and rank attention conditions by breadth", () => {
  const issuers = [
    issuer(1, "corporate"),
    issuer(2, "corporate"),
    issuer(3, "corporate"),
  ];
  const netMargin = metric("netMargin", "percent", [
    observation(1, -4),
    observation(2, -12),
    observation(3, 8),
  ]);
  const netIncome = metric(
    "netIncome",
    "currency",
    [observation(1, -1), observation(2, -3), observation(3, 2)],
    { lenses: ["corporate"] },
  );
  const currentRatio = metric("currentRatio", "decimal", [
    observation(1, 0.8),
    observation(2, 1.2),
    observation(3, 1.4),
  ]);
  const profile = buildPortfolioFinancialProfile(
    report(issuers, [netMargin, netIncome, currentRatio], {
      weighted: false,
    }),
    { lens: "corporate" },
  );
  const margin = profile.metricSummaries.find(
    (entry) => entry.id === "netMargin",
  );

  assert.equal(profile.weighted, false);
  assert.equal(profile.measuredCompanySharePct, 100);
  assert.equal(profile.measuredWeightPct, null);
  assert.equal(margin.companyCoveragePct, 100);
  assert.equal(margin.coveredWeightPct, null);
  assert.equal(profile.attentionConditions[0].id, "net-loss");
  close(
    profile.attentionConditions[0].shareOfMeasuredCompaniesPct,
    200 / 3,
  );
  assert.deepEqual(
    profile.attentionConditions[0].rows.map((row) => row.cik),
    [cik(2), cik(1)],
  );
});
