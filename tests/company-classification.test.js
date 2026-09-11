import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveCompanyClassification,
  classificationGroups,
  FUND_CLASSIFICATION,
} from "../src/utils/companyClassification.js";
import { createDemoPortfolio } from "../src/utils/portfolioDemo.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildPortfolioOverview } from "../src/utils/portfolioOverview.js";
import {
  buildPortfolioResearchPackage,
  portfolioCsv,
  portfolioAnalyticsCsv,
} from "../src/utils/portfolioExports.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
  allocationSummary,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioScenario } from "../src/utils/portfolioScenario.js";

const demo = createDemoPortfolio(
  JSON.parse(
    readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
    ),
  ),
);
const companies = unpackPortfolioSnapshot(demo.snapshot).companies;

test("sector identity uses canonical SEC IDs, never ticker/name guesses, and carries its own source date", () => {
  const apple = resolveCompanyClassification({
    cik: 320193,
    ticker: "WRONG",
    sic: 3571,
  });
  assert.equal(apple.sector, "Information Technology");
  assert.equal(apple.industry, "ELECTRONIC COMPUTERS");
  assert.equal(apple.sectorSource.asOf, "2026-09-08");
  assert.equal(apple.sectorSource.fund, "IVV");
  assert.match(apple.sectorSource.url, /^https:\/\/www\.ishares\.com\//);
  for (const cik of [undefined, "garbage", "320193x", "-320193", 9999999999])
    assert.equal(
      resolveCompanyClassification({ cik, ticker: "AAPL", name: "Apple" })
        .sector,
      null,
    );
  assert.equal(
    resolveCompanyClassification({ identity: { cik: "0000320193" } }).sector,
    apple.sector,
  );
});

test("exact SIC fallback handles leading zeros and legacy metadata without inventing a sector", () => {
  assert.equal(
    resolveCompanyClassification({ sic: 100 }).industry,
    "AGRICULTURAL PRODUCTION-CROPS",
  );
  assert.equal(
    resolveCompanyClassification({ sic: "3571x" }).industry,
    "Unclassified",
  );
  assert.equal(
    resolveCompanyClassification({
      sicDescription: "Unclassified",
      classification: { sic: "3571" },
    }).industry,
    "ELECTRONIC COMPUTERS",
  );
  const legacy = resolveCompanyClassification({
    identity: { sicDescription: "National Commercial Banks" },
  });
  assert.equal(legacy.sic, "6021");
  assert.equal(legacy.sector, null);
  assert.equal(
    resolveCompanyClassification({
      sic: 3812,
      sicDescription: "Navigation equipment",
    }).industry,
    "Navigation equipment",
  );
  assert.equal(
    resolveCompanyClassification({ sic: 9995 }).industry,
    "NON-OPERATING ESTABLISHMENTS",
  );
});

test("funds never acquire an operating company's sector or look-through classification", () => {
  const fund = resolveCompanyClassification({
    cik: "320193",
    kind: "fund",
    sic: 3571,
  });
  assert.equal(fund.industry, FUND_CLASSIFICATION);
  assert.equal(fund.sector, null);
  assert.equal(fund.sic, null);
});

test("demo shows all 11 sectors and all 100 companies without a catch-all or financial refresh", () => {
  const before = JSON.stringify(companies);
  for (const settings of [{ basis: "none" }, demo.allocation]) {
    const report = buildPortfolioAnalytics(demo.rows, settings, companies);
    const overview = buildPortfolioOverview(report);
    assert.equal(overview.sectorCompanyCount, 100);
    assert.equal(overview.industryCompanyCount, 100);
    assert.equal(overview.industryCount, 56);
    assert.equal(overview.mix.length, 11);
    assert.equal(overview.mixDimension, "sector");
    assert.ok(
      Math.abs(overview.mix.reduce((sum, row) => sum + row.value, 0) - 100) <
        1e-8,
    );
    assert.ok(
      !overview.mix.some((row) =>
        /Other|Unclassified|not covered/.test(row.label),
      ),
    );
    assert.equal(
      report.concentration.issuers.find((row) => row.cik === "0000320193")
        .industry,
      companies.find((row) => row.cik === "0000320193").sicDescription,
    );
  }
  assert.equal(JSON.stringify(companies), before);
});

test("uncovered sectors, fund allocations and partial weights retain distinct original denominators", () => {
  const groups = classificationGroups(
    [
      {
        cik: "1",
        sector: "Financials",
        kind: "company",
        weightPct: 30,
        rowIds: ["a", "b"],
      },
      { cik: "2", sector: null, kind: "company", weightPct: 20 },
      { cik: "3", kind: "fund", weightPct: 40 },
      { cik: "4", sector: null, kind: "company", weightPct: null },
    ],
    "sector",
    true,
  );
  assert.equal(groups.find((row) => row.label === "Financials").count, 1);
  assert.equal(
    groups.find((row) => row.label === "Sector not covered").count,
    2,
  );
  assert.equal(
    groups.find((row) => row.label === "Sector not covered").weightPct,
    20,
  );
  assert.equal(
    groups.find((row) => row.label === FUND_CLASSIFICATION).weightPct,
    40,
  );
  assert.equal(
    groups.reduce((sum, row) => sum + row.weightPct, 0),
    90,
  );
});

test("code-only industry recovery is identical for allocation, analytics and price scenarios", () => {
  const rows = resolvePortfolioRows(
    createPortfolioRows([{ ticker: "AAPL", weight_pct: 100 }]),
    { AAPL: { cik: "320193", name: "Apple" } },
  );
  const evidence = [{ cik: "0000320193", sic: "3571", kind: "company" }];
  const allocation = allocationSummary(
    rows,
    { basis: "weights" },
    { "0000320193": evidence[0] },
  );
  const analytics = buildPortfolioAnalytics(
    rows,
    { basis: "weights" },
    evidence,
  );
  const scenario = buildPortfolioScenario(rows, { basis: "weights" }, evidence);
  assert.equal(
    analytics.concentration.issuers[0].industry,
    "ELECTRONIC COMPUTERS",
  );
  assert.equal(scenario.issuers[0].industry, "ELECTRONIC COMPUTERS");
  assert.ok(JSON.stringify(allocation).includes("ELECTRONIC COMPUTERS"));
});

test("research exports preserve the SEC industry and add separately dated sector evidence", () => {
  const bundle = buildPortfolioResearchPackage(
    {
      ...demo,
      snapshot: { ...unpackPortfolioSnapshot(demo.snapshot), companies },
    },
    { includeAllocations: true },
  );
  const apple = bundle.companies.find(
    (company) => company.cik === "0000320193",
  );
  assert.equal(apple.companyClassification.sector, "Information Technology");
  assert.equal(apple.companyClassification.industry, apple.sicDescription);
  const csv = portfolioCsv(bundle);
  assert.match(csv, /sector_source_fund,sector_as_of,sector_source_url/);
  assert.match(csv, /Information Technology,IVV,2026-09-08/);
  assert.match(portfolioAnalyticsCsv(bundle), /sector_exposure/);
});

test("sector concentration retains unresolved weight without calling it a company", () => {
  const rows = resolvePortfolioRows(
    createPortfolioRows([
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "NOTFOUND", weight_pct: 40 },
    ]),
    { AAPL: { cik: "320193", name: "Apple" } },
  );
  const report = buildPortfolioAnalytics(rows, { basis: "weights" }, []);
  assert.equal(
    report.concentration.sectors.find(
      (row) => row.label === "Unresolved positions",
    ).weightPct,
    40,
  );
  assert.equal(
    report.concentration.sectors.reduce((sum, row) => sum + row.weightPct, 0),
    100,
  );
  const overview = buildPortfolioOverview(report);
  assert.equal(overview.complete, false);
  assert.equal(overview.mixTotal, 1);
  assert.deepEqual(overview.mix, [
    { label: "Information Technology", value: 1 },
  ]);
});
