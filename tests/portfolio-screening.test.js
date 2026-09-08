import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  buildPortfolioCoverageMatrix,
  buildPortfolioScreen,
  portfolioScreenCsv,
  portfolioCoverageCsv,
  PORTFOLIO_SCREEN_PRESETS,
} from "../src/utils/portfolioScreening.js";

const cik = (value) => String(value).padStart(10, "0");
const directory = {
  A: { cik: "1", name: "Alpha Company" },
  B: { cik: "2", name: "Beta Company" },
  C: { cik: "3", name: "Gamma Company" },
  BANK: { cik: "4", name: "A Bank" },
  FOREIGN: { cik: "5", name: "Foreign Corporation" },
  FUND: { cik: "6", name: "Example Fund", isFund: true },
  "A.B": { cik: "1", name: "Alpha Company" },
};
const point = (value, unit = "%", extra = {}) => ({
  value,
  unit,
  classification: "reported",
  period: { end: "2025-12-31" },
  sources: [
    { documentUrl: "https://www.sec.gov/Archives/edgar/data/1/example.htm" },
  ],
  ...extra,
});
const company = (id, metrics, extra = {}) => ({
  cik: cik(id),
  name: directory[["A", "B", "C", "BANK", "FOREIGN", "FUND"][id - 1]].name,
  kind: "company",
  lens: "corporate",
  status: "ready",
  period: { kind: "annual", end: "2025-12-31" },
  sicDescription: id === 4 ? "Banks" : "Manufacturing",
  metrics,
  ...extra,
});
function fixture() {
  const companies = [
    company(1, {
      revenueGrowth: point(10),
      operatingMargin: point(20),
      currentRatio: point(1, "x"),
    }),
    company(2, {
      revenueGrowth: point(0),
      operatingMargin: point(-1),
      currentRatio: point(0.9, "x"),
    }),
    company(3, { revenueGrowth: point(25), netIncome: point(10, "USD") }),
    company(
      4,
      { loanDeposits: point(60), roa: point(1.2) },
      { lens: "banking" },
    ),
    company(
      5,
      { revenueGrowth: point(15), operatingMargin: point(8) },
      { kind: "foreign" },
    ),
  ];
  const rows = resolvePortfolioRows(
    createPortfolioRows(
      ["A", "B", "C", "BANK", "FOREIGN", "FUND"].map((ticker) => ({ ticker })),
    ),
    directory,
  );
  return {
    companies,
    rows,
    report: buildPortfolioAnalytics(rows, { basis: "none" }, companies),
  };
}

test("AND screens use inclusive bounds with separate measured, missing and not-applicable denominators", () => {
  const { report, companies } = fixture();
  const result = buildPortfolioScreen(
    report,
    companies,
    PORTFOLIO_SCREEN_PRESETS[0].rules,
  );
  assert.equal(result.valid, true);
  assert.equal(result.scopeCount, 6);
  assert.equal(result.eligibleCount, 4);
  assert.equal(result.measuredCount, 3);
  assert.equal(result.missingCount, 1);
  assert.equal(result.notApplicableCount, 2);
  assert.equal(result.matchCount, 2);
  assert.deepEqual(
    result.matches.map((row) => row.cik),
    [cik(1), cik(5)],
  );
  assert.equal(result.knownMatchedWeightPct, null);
  const zero = buildPortfolioScreen(report, companies, [
    { metricId: "revenueGrowth", min: "0", max: "0" },
  ]);
  assert.equal(zero.matchCount, 1);
  assert.equal(zero.matches[0].cik, cik(2));
});

test("blank, nonfinite, malformed, reversed and excessive rules block matches and CSV export", () => {
  const { report, companies } = fixture();
  const invalid = [
    [],
    null,
    Array.from({ length: 5 }, () => ({ metricId: "roe", min: "0" })),
    [{ metricId: "revenueGrowth", min: "", max: " " }],
    [{ metricId: "revenueGrowth", min: "Infinity" }],
    [{ metricId: "revenueGrowth", min: NaN }],
    [{ metricId: "revenueGrowth", min: false }],
    [{ metricId: "revenueGrowth", min: "0x10" }],
    [{ metricId: "revenueGrowth", min: "10%" }],
    [{ metricId: "revenueGrowth", min: "10", max: "5" }],
    [{ metricId: "unknown", min: "0" }],
  ];
  for (const rules of invalid) {
    const result = buildPortfolioScreen(report, companies, rules);
    assert.equal(result.valid, false);
    assert.equal(result.measuredCount, null);
    assert.equal(result.matchCount, null);
    assert.equal(result.matches.length, 0);
    assert.throws(() => portfolioScreenCsv(result), /invalid screening rules/);
  }
});

test("ratio units remain ratios and percent values remain percentage points", () => {
  const { report, companies } = fixture();
  const ratio = buildPortfolioScreen(report, companies, [
    { metricId: "currentRatio", min: "", max: "1" },
  ]);
  assert.deepEqual(
    ratio.matches.map((row) => row.cik),
    [cik(1), cik(2)],
  );
  assert.equal(ratio.matches[0].cells[0].value, 1);
  assert.equal(ratio.matches[0].cells[0].unit, "x");
  const percent = buildPortfolioScreen(report, companies, [
    { metricId: "revenueGrowth", min: "1e1", max: "+15.0" },
  ]);
  assert.deepEqual(
    percent.matches.map((row) => row.cik),
    [cik(1), cik(5)],
  );
});

test("industry scopes recompute eligibility but never renormalize original issuer weights", () => {
  const { rows, companies } = fixture();
  const weightedRows = resolvePortfolioRows(
    createPortfolioRows([
      { ticker: "A", weight_pct: 30 },
      { ticker: "BANK", weight_pct: 40 },
      { ticker: "FOREIGN", weight_pct: 30 },
    ]),
    directory,
  );
  const report = buildPortfolioAnalytics(
    weightedRows,
    { basis: "weights" },
    companies,
  );
  const result = buildPortfolioScreen(
    report,
    companies,
    [{ metricId: "revenueGrowth", min: "0" }],
    { industry: "Manufacturing", sortBy: "revenueGrowth", direction: "desc" },
  );
  assert.equal(result.scopeCount, 2);
  assert.equal(result.knownMatchedWeightPct, 60);
  assert.deepEqual(
    result.matches.map((row) => row.cik),
    [cik(5), cik(1)],
  );
  assert.ok(result.matches.every((row) => row.weightPct === 30));
  assert.equal(rows.length, 6);
});

test("share classes and supported foreign companies have one canonical observation per issuer", () => {
  const { companies } = fixture();
  const rows = resolvePortfolioRows(
    createPortfolioRows([
      { ticker: "A", weight_pct: 20 },
      { ticker: "A.B", weight_pct: 30 },
      { ticker: "FOREIGN", weight_pct: 50 },
    ]),
    directory,
  );
  const report = buildPortfolioAnalytics(rows, { basis: "weights" }, companies);
  const screen = buildPortfolioScreen(report, companies, [
    { metricId: "revenueGrowth", min: "0" },
  ]);
  const matrix = buildPortfolioCoverageMatrix(report, companies);
  assert.equal(screen.matchCount, 2);
  assert.equal(matrix.rows.length, 2);
  assert.equal(screen.knownMatchedWeightPct, 100);
  assert.equal(screen.matches.find((row) => row.cik === cik(1)).weightPct, 50);
  assert.equal(
    screen.matches.find((row) => row.cik === cik(1)).rowIds.length,
    2,
  );
  assert.equal(
    screen.matches.find((row) => row.cik === cik(5)).cells[0].status,
    "available",
  );
});

test("matrix follows canonical applicability sets without supplemental company snapshots", () => {
  const { report } = fixture();
  const matrix = buildPortfolioCoverageMatrix(report);
  const bank = matrix.rows.find((row) => row.cik === cik(4));
  assert.equal(
    bank.cells.find((cell) => cell.metricId === "revenueGrowth").status,
    "not-applicable",
  );
  assert.equal(
    bank.cells.find((cell) => cell.metricId === "loanDeposits").status,
    "available",
  );
  const fund = matrix.rows.find((row) => row.cik === cik(6));
  assert.equal(fund.eligibleCount, 0);
  assert.equal(fund.missingCount, 0);
  assert.equal(fund.notApplicableCount, 8);
  const alpha = matrix.rows.find((row) => row.cik === cik(1));
  assert.equal(
    alpha.cells.find((cell) => cell.metricId === "revenueGrowth").periodEnd,
    "2025-12-31",
  );
  assert.match(
    alpha.cells.find((cell) => cell.metricId === "revenueGrowth").sourceUrl,
    /^https:\/\/www.sec.gov\//,
  );
});

test("missing observations cannot be supplied from raw snapshots or treated as zero", () => {
  const { report, companies } = fixture();
  const changedCompanies = companies.map((value) =>
    value.cik === cik(3)
      ? { ...value, metrics: { ...value.metrics, operatingMargin: point(999) } }
      : value,
  );
  const result = buildPortfolioScreen(report, changedCompanies, [
    { metricId: "operatingMargin", min: "-1000" },
  ]);
  assert.equal(result.missingCount, 1);
  assert.ok(!result.matches.some((row) => row.cik === cik(3)));
  const matrix = buildPortfolioCoverageMatrix(report, changedCompanies);
  assert.equal(
    matrix.rows
      .find((row) => row.cik === cik(3))
      .cells.find((cell) => cell.metricId === "operatingMargin").value,
    null,
  );
});

test("gap filters apply only to the selected measures and preserve not-applicable exclusions", () => {
  const { report, companies } = fixture();
  const matrix = buildPortfolioCoverageMatrix(report, companies, {
    gapsOnly: true,
    metricId: "operatingMargin",
  });
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].cik, cik(3));
  assert.equal(matrix.missingCount, 1);
  assert.equal(matrix.notApplicableCount, 0);
  const filtered = buildPortfolioCoverageMatrix(report, companies, {
    query: "FOREIGN",
    industry: "Manufacturing",
    metricId: "revenueGrowth",
  });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.availableCount, 1);
  assert.equal(filtered.rows[0].cells[0].value, 15);
});

test("CSV exports match the filtered issuer set and retain sources, dates and formula-safe names", () => {
  const { report, companies } = fixture();
  report.concentration.issuers.find((issuer) => issuer.cik === cik(1)).name =
    '=HYPERLINK("bad")';
  const before = JSON.stringify(report);
  const result = buildPortfolioScreen(report, companies, [
    { metricId: "revenueGrowth", min: "10", max: "10" },
  ]);
  const csv = portfolioScreenCsv(result);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("2025-12-31"));
  assert.ok(
    csv.includes("https://www.sec.gov/Archives/edgar/data/1/example.htm"),
  );
  assert.ok(!csv.includes("Beta Company"));
  const matrix = buildPortfolioCoverageMatrix(report, companies, {
    query: "Gamma",
    metricId: "operatingMargin",
    gapsOnly: true,
  });
  const coverageCsv = portfolioCoverageCsv(matrix);
  assert.ok(coverageCsv.includes("Gamma Company"));
  assert.ok(coverageCsv.includes(",missing,,%,,"));
  assert.ok(!coverageCsv.includes("Alpha Company"));
  assert.equal(JSON.stringify(report), before);
});

test("invalid SEC URLs and impossible dates are not exposed as evidence", () => {
  const { report, companies } = fixture();
  const point = report.metrics
    .find((metric) => metric.id === "revenueGrowth")
    .observations.find((observation) => observation.cik === cik(1));
  point.sourceUrl = "javascript:alert(1)";
  point.periodEnd = "2025-02-30";
  const matrix = buildPortfolioCoverageMatrix(report, companies, {
    query: "Alpha",
    metricId: "revenueGrowth",
  });
  assert.equal(matrix.rows[0].cells[0].sourceUrl, null);
  assert.equal(matrix.rows[0].cells[0].periodEnd, null);
  assert.equal(matrix.rows[0].cells[0].value, 10);
});
