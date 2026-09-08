import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoPortfolio,
  saveDemoPortfolio,
  validatePortfolioDemo,
} from "../src/utils/portfolioDemo.js";
import {
  allocationSummary,
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import {
  createPortfolio,
  PORTFOLIOS_KEY,
  readPortfolios,
  writePortfolio,
} from "../src/utils/portfolioStorage.js";

const capturedAt = "2026-09-08T01:00:00.000Z";
const now = "2026-09-09T02:00:00.000Z";
const sourceUrl =
  "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm";

function demo() {
  const holdings = Array.from({ length: 100 }, (_, index) => ({
    ticker: `SAMPLE${index}`,
  }));
  const directory = Object.fromEntries(
    holdings.map(({ ticker }, index) => [
      ticker,
      {
        cik: String(index + 1).padStart(10, "0"),
        name: `Fixture company ${index}`,
      },
    ]),
  );
  const rows = resolvePortfolioRows(createPortfolioRows(holdings), directory);
  const companies = rows.map((row, index) => ({
    cik: row.resolution.cik,
    ticker: row.input.ticker,
    name: row.resolution.name,
    kind: "company",
    status: "ready",
    refreshStatus: "checked",
    basis: "annual",
    retrievedAt: capturedAt,
    cache: { status: "fresh", storedAt: capturedAt },
    period: { end: "2025-12-31", kind: "annual" },
    metrics: {
      revenue: {
        value: 100 + index,
        unit: "USD",
        classification: "reported",
        sources: [{ documentUrl: sourceUrl }],
      },
    },
    filings: [
      {
        accession: "0000000001-26-000001",
        form: "10-K",
        filingDate: "2026-02-01",
        documentUrl: sourceUrl,
      },
    ],
  }));
  return {
    schema_version: "edgar.portfolio.demo.v1",
    title: "Deterministic test capture",
    description:
      "Synthetic fixture only; these are not live financial results.",
    capture_started_at: "2026-09-08T00:00:00.000Z",
    captured_at: capturedAt,
    input: {
      schema_version: "edgar.portfolio.v1",
      holdings,
      allocation: { basis: "none", normalize: false },
      research: { basis: "annual" },
    },
    rows,
    snapshot: {
      schema_version: "edgar.portfolio.v1",
      generated_at: capturedAt,
      basis: "annual",
      companies,
    },
    coverage: {
      inputRows: 100,
      resolvedRows: 100,
      uniqueIssuers: 100,
      researchedIssuers: 100,
      ready: 100,
      partial: 0,
      failed: 0,
      unsupported: 0,
      staleCached: 0,
      financialEvidence: 100,
      financialEvidencePct: 100,
      filingCount: 100,
      reportingEnds: ["2025-12-31"],
      mismatchedPeriods: false,
      filingScope: "Synthetic fixture filing coverage",
    },
    methodology: {
      source: "Deterministic test fixture",
      freshness: "Fixed fixture timestamps",
      requests: [
        {
          started_at: "2026-09-08T00:00:00.000Z",
          completed_at: capturedAt,
          generated_at: capturedAt,
          tickers: holdings.map((row) => row.ticker),
        },
      ],
    },
  };
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function updateCoverage(capture) {
  const companies = capture.snapshot.companies;
  const coverage = allocationSummary(
    capture.rows,
    capture.input.allocation,
    Object.fromEntries(companies.map((company) => [company.cik, company])),
  ).coverage;
  for (const status of ["ready", "partial", "failed", "unsupported"])
    capture.coverage[status] = companies.filter(
      (company) => company.status === status,
    ).length;
  capture.coverage.staleCached = companies.filter(
    (company) =>
      company.cache.status === "stale" || company.refreshStatus === "stale",
  ).length;
  capture.coverage.financialEvidence = coverage.availableCompanies;
  capture.coverage.financialEvidencePct = coverage.companyPct;
}

test("the 100-ticker example opens as an independent unweighted portfolio with its original evidence dates", () => {
  const capture = demo();
  const portfolio = createDemoPortfolio(capture, { id: "demo-copy", now });
  assert.equal(portfolio.rows.length, 100);
  assert.equal(portfolio.name, "100-company demo · captured 2026-09-08");
  assert.deepEqual(portfolio.allocation, { basis: "none", normalize: false });
  assert.deepEqual(portfolio.research, { basis: "annual" });
  assert.equal(portfolio.createdAt, now);
  assert.equal(portfolio.snapshot.generated_at, capturedAt);
  assert.equal(portfolio.snapshot.companies[0].retrievedAt, capturedAt);
  assert.equal(portfolio.lastCheckedAt, capturedAt);
  assert.equal(portfolio.previousCheckedAt, null);
  assert.equal(portfolio.comparisonBaseline, null);
  portfolio.rows[0].input.notes = "My local annotation";
  portfolio.snapshot.companies[0].metrics.revenue.value = 999;
  assert.equal(capture.rows[0].input.notes, "");
  assert.equal(capture.snapshot.companies[0].metrics.revenue.value, 100);
});

test("opening copies fresh browser data and never overwrites existing or edited research", () => {
  const browser = storage();
  const original = createPortfolio({
    id: "my-research",
    name: "Private research",
    rows: createPortfolioRows([{ ticker: "AAPL", notes: "Keep my writing" }]),
    now,
  });
  writePortfolio(browser, { mode: "create", portfolio: original, now });
  const saved = saveDemoPortfolio(browser, demo(), { id: "first-demo", now });
  assert.equal(saved.portfolio.id, "first-demo");
  assert.equal(saved.store.activeId, "first-demo");
  assert.deepEqual(
    saved.store.portfolios.find((item) => item.id === original.id),
    original,
  );
  writePortfolio(browser, {
    mode: "rename",
    id: "first-demo",
    name: "My edited demo",
    now,
  });
  saveDemoPortfolio(browser, demo(), { id: "second-demo", now });
  const after = readPortfolios(browser.getItem(PORTFOLIOS_KEY));
  assert.equal(after.portfolios.length, 3);
  assert.equal(
    after.portfolios.find((item) => item.id === "first-demo").name,
    "My edited demo",
  );
  const preserved = browser.getItem(PORTFOLIOS_KEY);
  assert.throws(
    () => saveDemoPortfolio(browser, demo(), { id: "first-demo", now }),
    /already exists/,
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), preserved);
});

test("failed or stale capture results retain their true status and cannot claim a complete check", () => {
  for (const change of [
    (company) => {
      company.status = "failed";
      company.refreshStatus = "failed";
      company.metrics = {};
    },
    (company) => {
      company.cache.status = "stale";
      company.refreshStatus = "stale";
    },
    (company) => {
      delete company.refreshStatus;
    },
  ]) {
    const capture = demo();
    change(capture.snapshot.companies[0]);
    updateCoverage(capture);
    const copy = createDemoPortfolio(capture, { now });
    assert.equal(copy.lastCheckedAt, null);
    assert.deepEqual(copy.snapshot, capture.snapshot);
  }
  const capture = demo();
  capture.snapshot.companies[0].ticker = null;
  capture.snapshot.companies[0].status = "partial";
  updateCoverage(capture);
  const copy = createDemoPortfolio(capture, { now });
  assert.equal(
    copy.lastCheckedAt,
    capturedAt,
    "a checked partial issuer is preserved as checked, not relabeled ready",
  );
  assert.equal(copy.snapshot.companies[0].status, "partial");
  assert.equal(copy.snapshot.companies[0].ticker, null);
  assert.equal(copy.rows[0].resolution.ticker, "SAMPLE0");
});

test("a mismatched download, altered identity, allocation assumption, or overstated coverage is rejected", () => {
  const mutations = [
    (value) => value.input.holdings.pop(),
    (value) => {
      value.input.holdings[1].ticker = value.input.holdings[0].ticker;
    },
    (value) => {
      value.rows[0].input.ticker = "DIFFERENT";
    },
    (value) => {
      value.rows[0].input.weight_pct = 1;
    },
    (value) => {
      value.input.holdings[0].notes = "Private writing";
    },
    (value) => {
      value.input.allocation.basis = "equal";
    },
    (value) => {
      value.rows[0].excluded = true;
    },
    (value) => {
      value.rows[0].resolution.status = "unresolved";
    },
    (value) => {
      value.rows[0].resolution.cik = "0009999999";
    },
    (value) => {
      value.snapshot.companies[0].ticker = "DIFFERENT";
    },
    (value) => {
      value.snapshot.companies[1].cik = value.snapshot.companies[0].cik;
    },
    (value) => {
      value.snapshot.generated_at = now;
    },
    (value) => {
      value.snapshot.basis = "ttm";
    },
    (value) => {
      value.coverage.financialEvidence = 99;
    },
    (value) => {
      value.coverage.filingCount = 500;
    },
    (value) => {
      value.coverage.reportingEnds = ["2026-12-31"];
    },
    (value) => {
      value.methodology.requests[0].tickers = ["NOTINDEMO"];
    },
  ];
  for (const mutate of mutations) {
    const capture = demo();
    mutate(capture);
    assert.throws(() => validatePortfolioDemo(capture));
  }
});

test("unsafe sources, prototype fields, non-JSON values, and oversized captures fail before persistence", () => {
  const unsafe = demo();
  unsafe.snapshot.companies[0].metrics.revenue.sources[0].documentUrl =
    "https://example.com/misleading-source";
  assert.throws(() => validatePortfolioDemo(unsafe), /SEC/);
  const prototype = JSON.parse(
    JSON.stringify(demo()).replace(
      '"coverage":{',
      '"coverage":{"__proto__":{"polluted":true},',
    ),
  );
  assert.throws(() => validatePortfolioDemo(prototype), /unsafe field/);
  const notJson = demo();
  notJson.methodology.extra = undefined;
  assert.throws(() => validatePortfolioDemo(notJson), /unsupported value/);
  const oversized = demo();
  oversized.methodology.extra = Array.from({ length: 220 }, () =>
    "x".repeat(20000),
  );
  assert.throws(() => validatePortfolioDemo(oversized), /4 MiB/);
  assert.equal({}.polluted, undefined);
});

test("storage failure and corrupt saved data preserve the existing browser value", () => {
  const browser = storage();
  saveDemoPortfolio(browser, demo(), { id: "existing", now });
  const preserved = browser.getItem(PORTFOLIOS_KEY);
  browser.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.throws(
    () => saveDemoPortfolio(browser, demo(), { id: "new", now }),
    /have not been saved/,
  );
  assert.equal(browser.getItem(PORTFOLIOS_KEY), preserved);
  const corrupted = storage();
  corrupted.setItem(PORTFOLIOS_KEY, "{broken");
  assert.throws(
    () => saveDemoPortfolio(corrupted, demo(), { now }),
    /preserved/,
  );
  assert.equal(corrupted.getItem(PORTFOLIOS_KEY), "{broken");
});
