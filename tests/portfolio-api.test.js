import { packPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePortfolioRequest,
  readPortfolioRequestBody,
  runPortfolioResearch,
  buildPortfolioCompany,
  loadFreshPortfolioCompany,
  loadCachedPortfolioCompany,
  portfolioCompanyKind,
  PORTFOLIO_BODY_BYTES,
} from "../src/utils/portfolioResearchServer.js";
import { buildCompareCompany } from "../src/utils/compareResearch.js";
import { allocationSummary } from "../src/utils/portfolioModel.js";

const request = (holdings, extra = {}) => ({
  schema_version: "edgar.portfolio.v1",
  holdings,
  allocation: { basis: "none", normalize: false },
  research: { basis: "annual" },
  ...extra,
});
const pad = (value) => String(value).padStart(10, "0");
const directory = {
  AAPL: { cik: pad(320193), name: "Apple Inc." },
  MSFT: { cik: pad(789019), name: "Microsoft Corp." },
  "BRK-A": { cik: pad(1067983), name: "Berkshire Hathaway Inc." },
  "BRK-B": { cik: pad(1067983), name: "Berkshire Hathaway Inc." },
  ETF: { cik: pad(999999), name: "Sample fund", isFund: true },
};
const fact = (value, year, instant = false) => ({
  val: value,
  end: `${year}-12-31`,
  ...(instant ? {} : { start: `${year}-01-01` }),
  fy: year,
  fp: "FY",
  form: "10-K",
  filed: `${year + 1}-02-01`,
  accn: `0000000001-${String(year + 1).slice(-2)}-000001`,
});
const tags = {
  RevenueFromContractWithCustomerExcludingAssessedTax: [
    fact(100, 2024),
    fact(120, 2025),
  ],
  Assets: [fact(1000, 2024, true), fact(1200, 2025, true)],
  StockholdersEquity: [fact(100, 2024, true), fact(140, 2025, true)],
  NetIncomeLoss: [fact(24, 2025)],
  OperatingIncomeLoss: [fact(30, 2025)],
  NetCashProvidedByUsedInOperatingActivities: [fact(40, 2025)],
  PaymentsToAcquirePropertyPlantAndEquipment: [fact(10, 2025)],
  LongTermDebtCurrent: [fact(10, 2025, true)],
  LongTermDebtNoncurrent: [fact(90, 2025, true)],
};
const facts = {
  "us-gaap": Object.fromEntries(
    Object.entries(tags).map(([key, values]) => [
      key,
      { units: { USD: values } },
    ]),
  ),
};
const company = (overrides = {}) => ({
  cik: pad(1),
  ticker: "TEST",
  companyName: "Test Company",
  sic: "3571",
  kind: "company",
  facts,
  filings: [
    {
      accession: "0000000001-26-000001",
      documentUrl:
        "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm",
    },
  ],
  ...overrides,
});
const loader = async (identity, basis) =>
  buildPortfolioCompany(company({ ...identity, companyName: identity.name }), {
    basis,
    retrievedAt: "2026-09-07T12:00:00.000Z",
  });

test("portfolio API admission enforces version, size, rows, cells, action and coherent reporting basis", async () => {
  assert.throws(
    () => validatePortfolioRequest({ holdings: [] }),
    /schema_version/,
  );
  assert.throws(
    () =>
      validatePortfolioRequest(
        request(Array.from({ length: 101 }, () => ({ ticker: "AAPL" }))),
      ),
    /100/,
  );
  assert.throws(
    () => validatePortfolioRequest(request([{ notes: "x".repeat(2001) }])),
    /2000/,
  );
  assert.throws(
    () => validatePortfolioRequest(request([], { action: "invent-a-job" })),
    /action/,
  );
  assert.throws(
    () =>
      validatePortfolioRequest(request([], { research: { basis: "quarter" } })),
    /annual or ttm/,
  );
  const badType = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  await assert.rejects(
    readPortfolioRequestBody(badType),
    (error) => error.status === 415,
  );
  const tooLarge = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(PORTFOLIO_BODY_BYTES + 1),
  });
  await assert.rejects(
    readPortfolioRequestBody(tooLarge),
    (error) => error.status === 413,
  );
  const invalid = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  await assert.rejects(
    readPortfolioRequestBody(invalid),
    (error) => error.status === 400,
  );
});

test("ticker-only research preserves a universe and keeps invalid rows reviewable", async () => {
  const result = await runPortfolioResearch(
    request([
      { ticker: "AAPL" },
      { ticker: "UNKNOWN" },
      { company_name: "Microsoft" },
      { ticker: "AAPL", cik: pad(789019) },
    ]),
    { directory, loadCompany: loader },
  );
  assert.equal(result.companies.length, 1);
  assert.equal(result.companies[0].cik, pad(320193));
  assert.deepEqual(
    result.rows.map((row) => row.resolution.status),
    ["resolved", "unresolved", "review", "conflict"],
  );
  assert.equal(result.allocation.basis, "none");
  assert.equal(result.allocation.allocatedWeight, null);
  assert.equal(result.coverage.unresolvedRows, 3);
});

test("100-company resolve plus twenty bounded research batches retains every distinct issuer", async (context) => {
  const holdings = Array.from({ length: 100 }, (_, index) => ({
    cik: pad(index + 10000),
  }));
  const resolved = await runPortfolioResearch(
    request(holdings, { action: "resolve" }),
    { directory: {} },
  );
  assert.equal(resolved.rows.length, 100);
  assert.equal(resolved.coverage.resolvedRows, 100);
  assert.equal(resolved.companies.length, 0);
  await assert.rejects(
    runPortfolioResearch(request(holdings), {
      directory: {},
      loadCompany: loader,
    }),
    /at most 5/,
  );
  const calls = [];
  const companies = [];
  let active = 0;
  let highestConcurrency = 0;
  for (let offset = 0; offset < 100; offset += 5) {
    const batch = await runPortfolioResearch(
      request(holdings.slice(offset, offset + 5)),
      {
        directory: {},
        loadCompany: async (identity, basis) => {
          calls.push(identity.cik);
          active++;
          highestConcurrency = Math.max(highestConcurrency, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active--;
          return loader(identity, basis);
        },
      },
    );
    assert.equal(batch.companies.length, 5);
    companies.push(...batch.companies);
  }
  assert.equal(calls.length, 100);
  assert.equal(new Set(calls).size, 100);
  assert.equal(highestConcurrency, 2);
  assert.equal(companies.length, 100);
  // Representative compact fixture snapshots remain comfortably inside the browser portfolio budget.
  const snapshotBytes = Buffer.byteLength(
    JSON.stringify(packPortfolioSnapshot({ companies })),
  );
  assert.ok(snapshotBytes < 4 * 1024 * 1024);
  context.diagnostic(
    `100-company representative fixture snapshot: ${snapshotBytes} bytes.`,
  );
});

test("duplicate securities and share classes retain positions but retrieve an issuer once", async () => {
  const seen = [];
  const result = await runPortfolioResearch(
    request(
      [
        { ticker: "BRK.A", weight_pct: 20 },
        { ticker: "BRK-B", weight_pct: 30 },
        { ticker: "AAPL", weight_pct: 25 },
        { ticker: "AAPL", weight_pct: 25 },
      ],
      {
        allocation: { basis: "weights", normalize: false },
        row_choices: [
          { index: 2, duplicateChoice: "keep" },
          { index: 3, duplicateChoice: "keep" },
        ],
      },
    ),
    {
      directory,
      loadCompany: async (identity, basis) => {
        seen.push(identity.cik);
        return loader(identity, basis);
      },
    },
  );
  assert.equal(result.rows.length, 4);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen).size, 2);
  assert.equal(
    result.allocation.issuers.find((issuer) => issuer.cik === pad(1067983))
      .weightPct,
    50,
  );
  assert.equal(result.allocation.allocatedWeight, 100);
});

test("per-issuer failure preserves other companies and never reweights their allocation", async () => {
  const result = await runPortfolioResearch(
    request(
      [
        { ticker: "AAPL", weight_pct: 60 },
        { ticker: "MSFT", weight_pct: 40 },
      ],
      { allocation: { basis: "weights", normalize: false } },
    ),
    {
      directory,
      loadCompany: async (identity, basis) => {
        if (identity.cik === pad(789019)) throw new Error("Fixture SEC outage");
        return loader(identity, basis);
      },
    },
  );
  assert.equal(result.companies.length, 2);
  assert.equal(result.companies[1].cik, pad(789019));
  assert.equal(result.companies[1].status, "failed");
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.allocation.coverage.availableWeight, 60);
  assert.equal(result.allocation.allocatedWeight, 100);
  assert.deepEqual(
    result.allocation,
    allocationSummary(
      result.rows,
      { basis: "weights", normalize: false },
      Object.fromEntries(result.companies.map((item) => [item.cik, item])),
    ),
  );
});

test("portfolio financials use the existing Compare engine, coherent periods, formula inputs and filing provenance", () => {
  const input = company();
  const compared = buildCompareCompany(input, { basis: "annual" });
  const result = buildPortfolioCompany(input, {
    basis: "annual",
    retrievedAt: "2026-09-07T12:00:00.000Z",
  });
  assert.equal(result.metrics.roe.value, compared.metrics.roe[0].value);
  assert.deepEqual(
    result.metrics.roe.sources.map(
      ({ revisions: _revisions, ...source }) => source,
    ),
    compared.metrics.roe[0].sources,
  );
  assert.equal(result.metrics.freeCashFlow.value, 30);
  assert.equal(result.metrics.capex.value, 10);
  assert.equal(result.metrics.debt.value, 100);
  assert.ok(Math.abs(result.metrics.revenueGrowth.value - 20) < 0.00001);
  assert.equal(result.metrics.revenueGrowth.classification, "calculated");
  assert.equal(result.metrics.revenueGrowth.sources.length, 2);
  assert.equal(result.metrics.netIncome.unit, "USD");
  assert.ok(result.metrics.roe.formula.includes("average"));
  assert.ok(
    Object.values(result.metrics).every(
      (point) => !point.period || point.period.end === result.period.end,
    ),
  );
  assert.ok(
    result.metrics.revenue.sources[0].documentUrl.endsWith("report.htm"),
  );
  const trailing = buildPortfolioCompany(input, { basis: "ttm" });
  assert.equal(trailing.metrics.revenue.value, null);
  assert.notEqual(trailing.period?.kind, "annual");
});

test("bank and broker lenses reject ordinary corporate ratios and foreign currencies remain missing", () => {
  const bank = buildPortfolioCompany(company({ sic: "6021" }));
  assert.equal(bank.lens, "banking");
  assert.equal(bank.metrics.revenue.classification, "not_applicable");
  assert.equal(bank.metrics.debt.classification, "not_applicable");
  const broker = buildPortfolioCompany(company({ sic: "6211" }));
  assert.equal(broker.lens, "common");
  assert.equal(broker.metrics.currentRatio.classification, "not_applicable");
  const foreignFacts = {
    "us-gaap": Object.fromEntries(
      Object.entries(tags).map(([key, values]) => [
        key,
        { units: { EUR: values } },
      ]),
    ),
  };
  const foreign = buildPortfolioCompany(
    company({ kind: "foreign", facts: foreignFacts }),
  );
  assert.equal(foreign.metrics.netIncome.value, null);
  assert.ok(
    foreign.warnings.some((warning) => warning.includes("Foreign company")),
  );
});

test("exact CIK verification detects funds before any corporate fact retrieval and limits the feed", async () => {
  const cik = pad(987654);
  const recent = {
    accessionNumber: Array.from(
      { length: 45 },
      (_, index) => `0000987654-26-${String(index + 1).padStart(6, "0")}`,
    ),
    form: Array(45).fill("8-K"),
    filingDate: Array(45).fill("2026-09-01"),
    reportDate: Array(45).fill("2026-08-31"),
    primaryDocument: Array(45).fill("report.htm"),
    primaryDocDescription: Array(45).fill("Current report"),
  };
  const calls = [];
  const result = await loadFreshPortfolioCompany(
    { cik, kind: "company" },
    "annual",
    {
      secJson: async (path) => {
        calls.push(path);
        return {
          cik: 987654,
          name: "Example Investment Fund",
          entityType: "investment",
          sic: "6722",
          filings: { recent },
        };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(result.status, "unsupported");
  assert.equal(result.kind, "fund");
  assert.deepEqual(result.metrics, {});
  assert.equal(result.filings.length, 30);
  assert.equal(result.filingCoverage.matchingRecentCount, 45);
  assert.equal(result.filingCoverage.archivedSubmissionFilesChecked, 0);
  assert.equal(result.filingCoverage.truncated, true);
  await assert.rejects(
    loadFreshPortfolioCompany({ cik }, "annual", {
      secJson: async () => ({ cik: 123, name: "Wrong Company" }),
    }),
    /identity/,
  );
  assert.equal(
    portfolioCompanyKind({ filings: { recent: { form: ["20-F", "6-K"] } } }),
    "foreign",
  );
});

test("public issuer caching deduplicates requests and never stores private portfolio input", async () => {
  const cik = pad(987653);
  const paths = [];
  const options = {
    secJson: async (path) => {
      paths.push(path);
      return path.includes("companyfacts")
        ? { cik: 987653, facts }
        : {
            cik: 987653,
            name: "Public Test Company",
            tickers: ["PUB"],
            sic: "3571",
            filings: { recent: {} },
          };
    },
  };
  const first = await loadCachedPortfolioCompany(
    { cik, notes: "PRIVATE NOTE", weight_pct: 90 },
    "annual",
    options,
  );
  const second = await loadCachedPortfolioCompany(
    { cik, notes: "ANOTHER PRIVATE NOTE", weight_pct: 10 },
    "annual",
    options,
  );
  assert.equal(paths.length, 2);
  assert.equal(first.cache.status, "fresh");
  assert.equal(second.cache.status, "cached");
  assert.equal(first.retrievedAt, second.retrievedAt);
  assert.ok(!JSON.stringify(second).includes("PRIVATE"));
  assert.ok(!JSON.stringify(second).includes("weight_pct"));
});

test("a company-facts failure retains verified filings as partial evidence with an explicit warning", async () => {
  const result = await loadFreshPortfolioCompany({ cik: pad(555) }, "annual", {
    secJson: async (path) => {
      if (path.includes("companyfacts"))
        throw new Error("Fixture facts outage");
      return {
        cik: 555,
        name: "Partial Company",
        sic: "3571",
        filings: { recent: {} },
      };
    },
  });
  assert.equal(result.status, "partial");
  assert.equal(result.factsUnavailable, true);
  assert.equal(result.metrics.revenue.value, null);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("facts could not be retrieved"),
    ),
  );
});
