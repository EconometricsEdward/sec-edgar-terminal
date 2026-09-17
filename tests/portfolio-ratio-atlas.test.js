import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPortfolioRatioAtlas,
  PORTFOLIO_RATIO_ATLAS_CATEGORIES,
} from "../src/utils/portfolioRatioAtlas.js";
import { buildPortfolioFinancialProfile } from "../src/utils/portfolioFinancialProfile.js";
import { createDemoPortfolio } from "../src/utils/portfolioDemo.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { buildCatalogReport } from "../src/utils/portfolioEnrichment.js";

const cik = (value) => String(value).padStart(10, "0");
const period = (start = "2025-01-01", end = "2025-12-31", kind = "annual") => ({ kind, start, end });
const issuer = (id, extra = {}) => ({
  cik: cik(id), kind: "company", name: `Company ${id}`, tickers: [`C${id}`],
  rowIds: [`row-${id}`], lens: "corporate", sector: "Technology",
  weightPct: null, weightComplete: false, ...extra,
});
const observation = (id, value, extra = {}) => ({
  cik: cik(id), rowId: `row-${id}`, ticker: `C${id}`, lens: "corporate", value,
  period: period(), periodKey: "annual|2025-01-01|2025-12-31",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/annual.htm",
  definition: JSON.stringify({ formula: "Net income / revenue × 100", classification: "calculated" }),
  ...extra,
});
const metric = (observations = [], extra = {}) => ({
  id: "netMargin", key: "netMargin", label: "Net margin", format: "percent", unit: "%",
  category: "ratios", lenses: ["corporate"], formula: "Net income / revenue × 100",
  observations, eligibleCiks: observations.map((row) => row.cik), notApplicableCiks: [], ...extra,
});
const report = (issuers, metrics = [], extra = {}) => ({
  weighted: true, concentration: { issuers }, metrics, ...extra,
});
const cell = (atlas, id, metricId = "netMargin") => atlas.companies.find((company) => company.cik === cik(id)).cells[metricId];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("all scoped companies and curated ratios remain visible when every value is missing", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2)]));
  assert.equal(atlas.companyCount, 2);
  assert.equal(atlas.availableCompanyCount, 0);
  assert.deepEqual(atlas.categories.map((group) => group.id), ["profitability", "liquidity", "leverage", "cash-generation", "drivers", "growth"]);
  assert.equal(atlas.metrics.length, 24);
  assert.equal(atlas.metrics.find((entry) => entry.id === "currentRatio").unit, "x");
  assert.equal(atlas.metrics.find((entry) => entry.id === "reportedDebtEquity").unit, "%");
  for (const company of atlas.companies) {
    assert.equal(Object.keys(company.cells).length, 24);
    assert.ok(Object.values(company.cells).every((entry) => entry.status === "missing" && entry.value === null));
  }
  assert.equal(atlas.knownAllocationPct, null);
  assert.equal(atlas.weightCoverageComplete, false);
});

test("company scope honors selected sector and accounting model and combines share classes once", () => {
  const source = report([
    issuer(1, { tickers: ["AA"], rowIds: ["r1"], weightPct: 10, weightComplete: true }),
    issuer(1, { tickers: ["AB"], rowIds: ["r2"], weightPct: 20, weightComplete: true }),
    issuer(2, { lens: "banking", weightPct: 25, weightComplete: true }),
    issuer(3, { sector: "Energy", weightPct: 30, weightComplete: true }),
    issuer(4, { kind: "fund", weightPct: 15, weightComplete: true }),
    issuer(5, { lens: "unknown" }),
  ], [metric([observation(1, 5), observation(3, 20)])]);
  const profile = buildPortfolioFinancialProfile(source, { sector: "Technology", lens: "corporate" });
  const atlas = buildPortfolioRatioAtlas(source, { profile });
  assert.equal(atlas.companyCount, 1);
  assert.equal(atlas.companies[0].ticker, "AA / AB");
  assert.deepEqual(atlas.companies[0].rowIds, ["r1", "r2"]);
  assert.equal(atlas.companies[0].weightPct, 30);
  assert.equal(atlas.knownAllocationPct, 30);
  assert.equal(atlas.weightCoverageComplete, true);
});

test("peer positions require the same accounting model and exact start, end and reporting basis", () => {
  const source = report([
    issuer(1), issuer(2), issuer(3), issuer(4), issuer(5),
    issuer(6, { lens: "banking" }),
  ], [metric([
    observation(1, -10), observation(2, 10), observation(3, 30),
    observation(4, 100, { period: period("2025-04-01") }),
    observation(5, 200, { period: period(undefined, undefined, "ytd") }),
    observation(6, 500, { lens: "banking" }),
  ])]);
  const atlas = buildPortfolioRatioAtlas(source, { lens: "corporate" });
  assert.equal(atlas.companyCount, 5);
  assert.equal(cell(atlas, 1).peerCount, 3);
  assert.equal(cell(atlas, 1).peerPositionPct, 0);
  assert.equal(cell(atlas, 2).peerPositionPct, 50);
  assert.equal(cell(atlas, 3).peerPositionPct, 100);
  assert.equal(cell(atlas, 3).peerMedian, 10);
  assert.equal(cell(atlas, 4).peerCount, 1);
  assert.equal(cell(atlas, 4).peerPositionPct, null);
  assert.equal(cell(atlas, 5).peerCount, 1);
  assert.equal(atlas.metrics.find((entry) => entry.id === "netMargin").cohorts.length, 3);
});

test("formula and explicit calculation scope changes do not share a peer range", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2), issuer(3), issuer(4)], [metric([
    observation(1, 1), observation(2, 2),
    observation(3, 3, { definition: { formula: "Net income attributable to parent / revenue × 100" } }),
    observation(4, 4, { scope: "Continuing operations" }),
  ])]));
  assert.equal(cell(atlas, 1).peerCount, 2);
  assert.equal(cell(atlas, 3).peerCount, 1);
  assert.equal(cell(atlas, 4).peerCount, 1);
  assert.equal(cell(atlas, 3).formula, "Net income attributable to parent / revenue × 100");
});

test("material source scope differences remain separate and carry the existing ratio guide", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2), issuer(3)], [metric([
    observation(1, 5, { definition: { formula: "Net income / revenue × 100", tags: ["us-gaap:NetIncomeLoss"] } }),
    observation(2, 7, { definition: { formula: "Net income / revenue × 100", tags: ["us-gaap:ProfitLoss"] } }),
    observation(3, 8, { definition: { formula: "Net income / revenue × 100", tags: ["us-gaap:ProfitLoss"] } }),
  ])]));
  assert.equal(cell(atlas, 1).peerCount, 1);
  assert.equal(cell(atlas, 2).peerCount, 2);
  assert.match(cell(atlas, 2).scopeNotes.join(" "), /noncontrolling interests/);
  assert.match(atlas.metrics.find((entry) => entry.id === "netMargin").caution, /exact formula and source scope/);
});

test("zero and negative observations are real values while unavailable and not applicable remain distinct", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2), issuer(3), issuer(4), issuer(5)], [metric([
    observation(1, 0), observation(2, -3), observation(5, Infinity),
  ], { eligibleCiks: [cik(1), cik(2), cik(3), cik(5)], notApplicableCiks: [cik(4)] })]));
  assert.equal(cell(atlas, 1).status, "available");
  assert.equal(cell(atlas, 1).value, 0);
  assert.equal(cell(atlas, 2).value, -3);
  assert.equal(cell(atlas, 3).status, "missing");
  assert.equal(cell(atlas, 4).status, "not-applicable");
  assert.equal(cell(atlas, 4).value, null);
  assert.equal(cell(atlas, 5).status, "missing");
  const net = atlas.metrics.find((entry) => entry.id === "netMargin");
  assert.equal(net.availableCompanyCount, 2);
  assert.equal(net.eligibleCompanyCount, 4);
  assert.equal(net.missingCompanyCount, 2);
  assert.equal(net.notApplicableCompanyCount, 1);
});

test("same-value peer cohorts use a neutral midpoint and single-company cohorts have no position", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2), issuer(3)], [metric([
    observation(1, 0), observation(2, 0), observation(3, 8, { period: period("2024-01-01", "2024-12-31") }),
  ])]));
  assert.equal(cell(atlas, 1).peerPositionPct, 50);
  assert.equal(cell(atlas, 2).peerPositionPct, 50);
  assert.equal(cell(atlas, 3).peerPositionPct, null);
  assert.equal(cell(atlas, 3).peerCount, 1);
});

test("incomplete or fabricated period keys cannot create apparently comparable cohorts", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2), issuer(3)], [metric([
    observation(1, 4, { period: { kind: "annual", end: "2025-12-31" } }),
    observation(2, 6, { period: { kind: "annual", start: "2025-02-30", end: "2025-12-31" } }),
    observation(3, 9),
  ])]));
  assert.equal(cell(atlas, 1).status, "available");
  assert.equal(cell(atlas, 1).value, 4);
  assert.equal(cell(atlas, 1).periodKey, null);
  assert.equal(cell(atlas, 1).peerCount, 0);
  assert.equal(cell(atlas, 2).periodKey, null);
  assert.equal(cell(atlas, 2).peerPositionPct, null);
  assert.equal(cell(atlas, 3).peerCount, 1);
});

test("latest observation per issuer is used without double-counting older captures", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1), issuer(2)], [metric([
    observation(1, 12, { period: period("2024-01-01", "2024-12-31"), periodKey: "annual|2024-01-01|2024-12-31" }),
    observation(1, 17), observation(2, 20),
  ])]));
  assert.equal(cell(atlas, 1).value, 17);
  assert.equal(cell(atlas, 1).peerCount, 2);
  assert.equal(atlas.metrics.find((entry) => entry.id === "netMargin").availableCompanyCount, 2);
});

test("allocation coverage preserves supplied scale and identifies partially known company weights", () => {
  const atlas = buildPortfolioRatioAtlas(report([
    issuer(1, { weightPct: 12, weightComplete: true }),
    issuer(2, { weightPct: 8, weightComplete: false }),
    issuer(3), issuer(4, { weightPct: 0, weightComplete: true }),
  ], [metric([observation(1, 5), observation(2, 8), observation(3, 10), observation(4, 12)])]));
  assert.equal(atlas.knownAllocationPct, 20);
  assert.equal(atlas.measuredAllocationPct, 20);
  assert.equal(atlas.weightCoverageComplete, false);
  const net = atlas.metrics.find((entry) => entry.id === "netMargin");
  assert.equal(net.knownAllocationPct, 20);
  assert.equal(net.weightCoverageComplete, false);
  assert.equal(net.cohorts[0].knownAllocationPct, 20);
  assert.equal(atlas.companies.find((company) => company.cik === cik(3)).weightPct, null);
});

test("an unweighted portfolio never presents implicit equal weights or zero allocation", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1, { weightPct: 100, weightComplete: true })], [metric([observation(1, 12)])], { weighted: false }));
  assert.equal(atlas.knownAllocationPct, null);
  assert.equal(atlas.measuredAllocationPct, null);
  assert.equal(atlas.companies[0].weightPct, null);
  assert.equal(atlas.metrics.find((entry) => entry.id === "netMargin").knownAllocationPct, null);
  assert.equal(atlas.metrics.find((entry) => entry.id === "netMargin").cohorts[0].knownAllocationPct, null);
});

test("cell evidence preserves actual formula, period and all distinct safe SEC sources", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1)], [metric([observation(1, 7, {
    sourceUrl: "javascript:alert(1)",
    evidence: "https://www.sec.gov/Archives/first.htm ; https://sec.gov/Archives/second.htm ; https://www.sec.gov/Archives/first.htm ; https://sec.gov.attacker.test/x ; http://www.sec.gov/old.htm ; https://u:p@www.sec.gov/private",
    definition: JSON.stringify({ formula: "Actual captured formula", tags: ["us-gaap:NetIncomeLoss"], classification: "calculated" }),
  })])]));
  const result = cell(atlas, 1);
  assert.equal(result.formula, "Actual captured formula");
  assert.equal(result.definition.classification, "calculated");
  assert.equal(result.sourceUrl, "https://www.sec.gov/Archives/first.htm");
  assert.deepEqual(result.evidenceUrls, ["https://www.sec.gov/Archives/first.htm", "https://sec.gov/Archives/second.htm"]);
  assert.equal(result.rowId, "row-1");
  assert.equal(result.periodStart, "2025-01-01");
  assert.equal(result.periodEnd, "2025-12-31");
  assert.match(result.periodLabel, /Annual: 2025-01-01 to 2025-12-31/);
});

test("malformed optional definitions do not hide observed values or invent evidence", () => {
  const atlas = buildPortfolioRatioAtlas(report([issuer(1)], [metric([observation(1, 7, { definition: "bad json", sourceUrl: null })])]));
  assert.equal(cell(atlas, 1).status, "available");
  assert.equal(cell(atlas, 1).formula, "Net income / revenue × 100");
  assert.equal(cell(atlas, 1).sourceUrl, null);
});

test("bank, insurer and common accounting models expose only their own appropriate ratio families", () => {
  const banking = buildPortfolioRatioAtlas(report([issuer(1, { lens: "banking" })]), { lens: "banking" });
  assert.ok(banking.metrics.some((entry) => entry.id === "loanDeposits"));
  assert.ok(!banking.metrics.some((entry) => entry.id === "currentRatio"));
  assert.match(banking.categories.find((entry) => entry.id === "cash-conversion").description, /not a measure of bank liquidity/);
  const insurance = buildPortfolioRatioAtlas(report([issuer(1, { lens: "insurance" })]), { lens: "insurance" });
  assert.deepEqual(insurance.categories.map((entry) => entry.id), ["returns", "capital", "liquidity"]);
  assert.ok(!insurance.metrics.some((entry) => entry.id === "assetTurnover"));
  const common = buildPortfolioRatioAtlas(report([issuer(1, { lens: "common" })]), { lens: "common" });
  assert.deepEqual(common.metrics.map((entry) => entry.id), ["roe", "roa", "equityAssets", "cashAssets", "revenueGrowth"]);
  assert.equal(Object.keys(PORTFOLIO_RATIO_ATLAS_CATEGORIES).length, 4);
});

test("building an atlas leaves the report and a reused profile unchanged", () => {
  const source = report([issuer(1), issuer(2)], [metric([observation(1, 3), observation(2, 6)])]);
  const profile = buildPortfolioFinancialProfile(source);
  const beforeReport = JSON.stringify(source);
  const beforeProfile = JSON.stringify(profile);
  buildPortfolioRatioAtlas(source, { profile });
  assert.equal(JSON.stringify(source), beforeReport);
  assert.equal(JSON.stringify(profile), beforeProfile);
});

test("the real demo retains every operating company and matches every available catalog value and unit", () => {
  const demo = JSON.parse(readFileSync(new URL("../public/portfolio/portfolio-demo-100-results.json", import.meta.url), "utf8"));
  const document = createDemoPortfolio(demo);
  const companies = unpackPortfolioSnapshot(document.snapshot).companies;
  const analytics = buildPortfolioAnalytics(document.rows, document.allocation, companies, { capturedAt: document.snapshot.capturedAt });
  const catalog = buildCatalogReport(analytics, companies);
  const atlas = buildPortfolioRatioAtlas(catalog, { lens: "corporate" });
  assert.equal(atlas.companyCount, companies.filter((company) => company.lens === "corporate").length);
  assert.ok(atlas.companyCount > 80);
  for (const company of atlas.companies) {
    for (const [metricId, entry] of Object.entries(company.cells)) {
      if (entry.status !== "available") continue;
      const source = catalog.metrics.find((candidate) => candidate.id === metricId).observations.find((candidate) => candidate.cik === company.cik);
      assert.equal(entry.value, source.value);
      assert.equal(entry.unit, catalog.metrics.find((candidate) => candidate.id === metricId).unit);
      assert.equal(entry.period.start, source.period.start);
      assert.equal(entry.period.end, source.period.end);
      if (entry.peerPositionPct !== null) assert.ok(entry.peerPositionPct >= 0 && entry.peerPositionPct <= 100);
    }
  }
  const currentRatio = atlas.metrics.find((entry) => entry.id === "currentRatio");
  assert.equal(currentRatio.unit, "x");
  close(atlas.knownAllocationPct, analytics.concentration.issuers.filter((issuer) => companies.find((company) => company.cik === issuer.cik)?.lens === "corporate").reduce((total, issuer) => total + issuer.weightPct, 0));
});
