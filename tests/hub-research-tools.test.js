import test from "node:test";
import assert from "node:assert/strict";
import {
  filterHubPortfolios,
  nextWatchlistBatch,
} from "../src/utils/hubResearchTools.js";
import { searchHubResearch } from "../src/utils/researchHubOverview.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  portfolioComparisonProfile,
  comparePortfolioProfiles,
} from "../src/utils/portfolioComparison.js";
import { buildCashEarnings } from "../src/utils/portfolioCashEarnings.js";

const directory = {
  A: { cik: "1", name: "A" },
  B: { cik: "2", name: "B" },
  C: { cik: "3", name: "C" },
  D: { cik: "4", name: "D" },
  AA: { cik: "1", name: "A class 2" },
};
const rows = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const period = { kind: "annual", start: "2025-01-01", end: "2025-12-31" };
const url = "https://www.sec.gov/Archives/edgar/data/1/annual.htm";
const point = (value, unit = "USD", extra = {}) => ({
  value,
  unit,
  classification: "reported",
  period: { ...period },
  sources: [
    {
      documentUrl: url,
      accession: "0000000001-26-000001",
      taxonomy: "us-gaap",
      tag: "NetIncomeLoss",
    },
  ],
  ...extra,
});
const company = (id, income = 1, cash = 1, extra = {}) => ({
  cik: String(id).padStart(10, "0"),
  kind: "company",
  lens: "corporate",
  status: "ready",
  sic: "3571",
  period: { ...period },
  metrics: {
    netIncome: point(income),
    operatingCashFlow: point(cash),
    netMargin: point(10, "%", { formula: "net income / revenue * 100" }),
  },
  ...extra,
});
const doc = (id, holdings, companies, settings = { basis: "none" }) => ({
  id,
  name: id,
  rows: rows(holdings),
  research: { basis: "annual" },
  allocation: settings,
  updatedAt: "2026-09-01T12:00:00Z",
  snapshot: {
    basis: "annual",
    generated_at: "2026-09-01T12:00:00Z",
    companies,
  },
});
const compare = (a, b) =>
  comparePortfolioProfiles(
    portfolioComparisonProfile(a),
    portfolioComparisonProfile(b),
  );
const cashResult = (holdings, companies, settings = { basis: "none" }) =>
  buildCashEarnings(
    buildPortfolioAnalytics(rows(holdings), settings, companies),
    companies,
  );

test("watchlist batches progress beyond 20, retry only failures and preserve results", () => {
  const companies = Array.from({ length: 45 }, (_, i) => ({ ticker: `T${i}` }));
  const results = Object.fromEntries(
    companies.slice(0, 20).map((c) => [c.ticker, { count: 0 }]),
  );
  results.T5 = { error: "retry" };
  const before = JSON.stringify(results);
  assert.deepEqual(
    nextWatchlistBatch(companies, results).map((c) => c.ticker),
    companies.slice(20, 40).map((c) => c.ticker),
  );
  assert.deepEqual(
    nextWatchlistBatch(companies, results, "failed").map((c) => c.ticker),
    ["T5"],
  );
  assert.equal(nextWatchlistBatch(companies, {}, "unchecked", 999).length, 20);
  assert.equal(JSON.stringify(results), before);
});

test("portfolio discovery filters independently without changing saved order", () => {
  const list = [
    {
      name: "Beta",
      hasSnapshot: true,
      incomplete: 1,
      coveragePct: 50,
      updatedAt: "2026-01-01",
    },
    {
      name: "Alpha",
      hasSnapshot: false,
      incomplete: 1,
      coveragePct: null,
      updatedAt: "2026-02-01",
    },
    { name: "Gamma", hasSnapshot: true, incomplete: 0, coveragePct: 100 },
  ];
  assert.deepEqual(
    filterHubPortfolios(list, { status: "unresearched" }).map((p) => p.name),
    ["Alpha"],
  );
  assert.deepEqual(
    filterHubPortfolios(list, { status: "captured" }).map((p) => p.name),
    ["Gamma"],
  );
  assert.deepEqual(
    filterHubPortfolios(list, { query: " ALP ", sort: "name" }).map(
      (p) => p.name,
    ),
    ["Alpha"],
  );
  assert.deepEqual(
    filterHubPortfolios(list, { sort: "coverage" }).map((p) => p.name),
    ["Alpha", "Beta", "Gamma"],
  );
  assert.equal(list[0].name, "Beta");
});

test("saved research filters type before counting and supports recent ordering", () => {
  const index = [
    {
      id: "a",
      title: "cash",
      kind: "Note",
      searchText: "cash",
      date: "2025-01-01",
    },
    {
      id: "b",
      title: "cash evidence",
      kind: "Evidence",
      searchText: "cash evidence",
      date: "2026-01-01",
    },
  ];
  assert.equal(
    searchHubResearch(index, "cash", 12, { kind: "Evidence" }).total,
    1,
  );
  assert.equal(
    searchHubResearch(index, "cash", 12, { sort: "recent" }).results[0].id,
    "b",
  );
  assert.equal(searchHubResearch(index, "cash").results[0].id, "a");
});

test("portfolio overlap counts shared issuers once and preserves exact saved allocations", () => {
  const a = doc(
    "A",
    [
      { ticker: "A", weight_pct: 20 },
      { ticker: "AA", weight_pct: 30 },
      { ticker: "B", weight_pct: 50 },
    ],
    [company(1), company(2)],
    { basis: "weights" },
  );
  const b = doc(
    "B",
    [
      { ticker: "A", weight_pct: 20 },
      { ticker: "C", weight_pct: 80 },
    ],
    [company(1), company(3)],
    { basis: "weights" },
  );
  const before = JSON.stringify([a, b]);
  const result = compare(a, b);
  assert.deepEqual(result.membership, {
    left: 2,
    right: 2,
    shared: 1,
    leftOnly: 1,
    rightOnly: 1,
    union: 3,
    jaccardPct: 100 / 3,
  });
  assert.equal(result.allocation.overlapPct, 20);
  assert.equal(
    result.members.find((r) => r.membership === "shared").difference,
    -30,
  );
  assert.equal(result.financial.pairedCount, 1);
  assert.equal(result.financial.medianDifference, 0);
  assert.equal(result.financial.pairs[0].leftSource, url);
  assert.equal(JSON.stringify([a, b]), before);
});

test("allocation differences are withheld for lists, incomplete or unresolved allocations", () => {
  const a = doc(
    "A",
    [{ ticker: "A", weight_pct: 60 }, { ticker: "B" }],
    [company(1), company(2)],
    { basis: "weights" },
  );
  const b = doc("B", [{ ticker: "A" }], [company(1)]);
  const result = compare(a, b);
  assert.equal(result.allocation.available, false);
  assert.equal(result.allocation.overlapPct, null);
  assert.ok(result.members.every((row) => row.difference === null));
  assert.equal(
    compare(doc("Empty", [], []), doc("Empty2", [], [])).membership.jaccardPct,
    null,
  );
});

test("explicit normalization is identified as saved model allocation", () => {
  const a = doc(
    "A",
    [
      { ticker: "A", weight_pct: 60 },
      { ticker: "B", weight_pct: 20 },
    ],
    [company(1), company(2)],
    { basis: "weights", normalize: true },
  );
  const b = doc("B", [{ ticker: "A", weight_pct: 100 }], [company(1)], {
    basis: "weights",
  });
  const result = compare(a, b);
  assert.equal(result.allocation.leftNormalized, true);
  assert.equal(result.allocation.overlapPct, 75);
});

test("matched financial comparisons reject period, basis and definition differences", () => {
  const a = doc("A", [{ ticker: "A" }], [company(1)]);
  const b = doc("B", [{ ticker: "A" }], [company(1)]);
  b.snapshot.companies[0].metrics.netMargin.value = 14;
  assert.equal(compare(a, b).financial.medianDifference, 4);
  b.snapshot.companies[0].metrics.netMargin.period.start = "2025-04-01";
  assert.equal(compare(a, b).financial.pairedCount, 0);
  b.snapshot.companies[0].metrics.netMargin.period = { ...period };
  b.snapshot.companies[0].metrics.netMargin.formula =
    "net income / assets * 100";
  assert.match(compare(a, b).financial.excluded[0].reason, /definition/);
  b.snapshot.basis = "ttm";
  assert.equal(compare(a, b).financial.compatible, false);
  assert.equal(compare(a, b).financial.medianDifference, null);
});

test("cash and earnings signs preserve zero and denominator is profitable paired issuers", () => {
  const companies = [
    company(1, 10, 3),
    company(2, 10, 0),
    company(3, 0, 4),
    company(4, -1, -2),
  ];
  const result = cashResult(
    ["A", "B", "C", "D"].map((ticker) => ({ ticker })),
    companies,
  );
  assert.equal(result.count, 4);
  assert.equal(result.profitable, 2);
  assert.equal(result.confirmed, 1);
  assert.equal(result.confirmationPct, 50);
  assert.deepEqual(
    result.cells.map((cell) => cell.observations.length),
    [1, 1, 1, 1],
  );
  assert.equal(result.cells[1].observations[0].operatingCashFlow, 0);
  assert.equal(
    result.cells[0].observations[0].incomeEvidence[0].accession,
    "0000000001-26-000001",
  );
  assert.equal(result.cells[0].observations[0].cashSource, url);
});

test("cash comparison excludes REITs, financial lenses, missing values and unmatched full periods", () => {
  const companies = [
    company(1, 1, 1, { sic: "6798" }),
    company(2, 1, 1, { lens: "banking" }),
    company(3),
    company(4),
  ];
  companies[2].metrics.operatingCashFlow.value = null;
  companies[3].metrics.operatingCashFlow.period.start = "2025-04-01";
  const result = cashResult(
    ["A", "B", "C", "D"].map((ticker) => ({ ticker })),
    companies,
  );
  assert.equal(result.count, 0);
  assert.equal(result.confirmationPct, null);
  assert.deepEqual(result.excluded, { businessType: 2, missing: 1, period: 1 });
});

test("unknown dates, invalid USD values and untrusted evidence are handled explicitly", () => {
  const c = company(1);
  delete c.period.start;
  delete c.metrics.netIncome.period.start;
  delete c.metrics.operatingCashFlow.period.start;
  assert.equal(cashResult([{ ticker: "A" }], [c]).excluded.period, 1);
  const bad = company(1);
  bad.metrics.netIncome.unit = "EUR";
  assert.equal(cashResult([{ ticker: "A" }], [bad]).excluded.missing, 1);
  const unsafe = company(1);
  unsafe.metrics.netIncome.sources = [
    { documentUrl: "https://evil.example/pretend-sec" },
  ];
  const result = cashResult([{ ticker: "A" }], [unsafe]);
  assert.equal(result.cells[0].observations[0].incomeSource, null);
  assert.deepEqual(result.cells[0].observations[0].incomeEvidence, []);
});

test("cash matrix deduplicates share classes, keeps unknown weights null and never renormalizes a subset", () => {
  const companies = [company(1), company(2, 1, -1)];
  const holdings = [
    { ticker: "A", weight_pct: 20 },
    { ticker: "AA", weight_pct: 30 },
    { ticker: "B" },
  ];
  const before = JSON.stringify({ companies, holdings });
  const result = cashResult(holdings, companies, {
    basis: "weights",
    normalize: true,
  });
  assert.equal(result.count, 2);
  assert.equal(result.cells[0].knownWeightPct, 50);
  assert.equal(result.cells[1].knownWeightPct, null);
  assert.equal(result.cells[1].missingWeightCount, 1);
  assert.equal(JSON.stringify({ companies, holdings }), before);
});
