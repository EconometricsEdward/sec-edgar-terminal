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

const XOM_CURRENT_CIK = pad(2115436);
const XOM_PREDECESSOR_CIK = pad(34088);
const xomObservation = ({
  value,
  start,
  end,
  form,
  filed,
  accession,
  fy,
  fp,
}) => ({ val: value, start, end, form, filed, accn: accession, fy, fp });
const xomConcept = (observations) => ({ units: { USD: observations } });
const xomAnnualFacts = {
  "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: xomConcept([
      xomObservation({
        value: 100,
        start: "2024-01-01",
        end: "2024-12-31",
        form: "10-K",
        filed: "2025-02-28",
        accession: "0000034088-25-000010",
        fy: 2024,
        fp: "FY",
      }),
      xomObservation({
        value: 120,
        start: "2025-01-01",
        end: "2025-12-31",
        form: "10-K",
        filed: "2026-02-27",
        accession: "0000034088-26-000010",
        fy: 2025,
        fp: "FY",
      }),
    ]),
    Assets: xomConcept([
      xomObservation({
        value: 1000,
        end: "2024-12-31",
        form: "10-K",
        filed: "2025-02-28",
        accession: "0000034088-25-000010",
        fy: 2024,
        fp: "FY",
      }),
      xomObservation({
        value: 1100,
        end: "2025-12-31",
        form: "10-K",
        filed: "2026-02-27",
        accession: "0000034088-26-000010",
        fy: 2025,
        fp: "FY",
      }),
      xomObservation({
        value: 1110,
        end: "2026-03-31",
        form: "10-Q",
        filed: "2026-05-04",
        accession: "0000034088-26-000050",
        fy: 2026,
        fp: "Q1",
      }),
    ]),
    NetIncomeLoss: xomConcept([
      xomObservation({
        value: 20,
        start: "2025-01-01",
        end: "2025-12-31",
        form: "10-K",
        filed: "2026-02-27",
        accession: "0000034088-26-000010",
        fy: 2025,
        fp: "FY",
      }),
    ]),
  },
};
const xomCurrentFacts = {
  "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: xomConcept([
      xomObservation({
        value: 130,
        start: "2026-01-01",
        end: "2026-06-30",
        form: "10-Q",
        filed: "2026-08-03",
        accession: "0000034088-26-000093",
        fy: 2026,
        fp: "Q2",
      }),
      xomObservation({
        value: 70,
        start: "2026-04-01",
        end: "2026-06-30",
        form: "10-Q",
        filed: "2026-08-03",
        accession: "0000034088-26-000093",
        fy: 2026,
        fp: "Q2",
      }),
    ]),
    Assets: xomConcept([
      xomObservation({
        value: 1150,
        end: "2026-06-30",
        form: "10-Q",
        filed: "2026-08-03",
        accession: "0000034088-26-000093",
        fy: 2026,
        fp: "Q2",
      }),
    ]),
  },
};
const xomRecent = (rows) => ({
  accessionNumber: rows.map((row) => row.accession),
  form: rows.map((row) => row.form),
  filingDate: rows.map((row) => row.filingDate),
  reportDate: rows.map((row) => row.reportDate),
  primaryDocument: rows.map((row) => row.primaryDocument),
  primaryDocDescription: rows.map((row) => row.description),
});
const xomSubmissions = ({ current = true } = {}) => ({
  cik: Number(current ? XOM_CURRENT_CIK : XOM_PREDECESSOR_CIK),
  name: current ? "ExxonMobil Holdings Corp" : "Exxon Mobil Corporation",
  tickers: current ? ["XOM"] : [],
  sic: "2911",
  sicDescription: "Petroleum Refining",
  filings: {
    recent: xomRecent(
      current
        ? [
            {
              accession: "0002115436-26-000001",
              form: "8-K",
              filingDate: "2026-07-01",
              reportDate: "2026-07-01",
              primaryDocument: "xom-current.htm",
              description: "Current registrant report",
            },
            {
              accession: "0000034088-26-000093",
              form: "10-Q",
              filingDate: "2026-08-03",
              reportDate: "2026-06-30",
              primaryDocument: "xom-20260630.htm",
              description: "Joint quarterly report",
            },
          ]
        : [
            {
              accession: "0000034088-26-000093",
              form: "10-Q",
              filingDate: "2026-08-03",
              reportDate: "2026-06-30",
              primaryDocument: "xom-20260630.htm",
              description: "Joint quarterly report",
            },
            {
              accession: "0000034088-26-000050",
              form: "10-Q",
              filingDate: "2026-05-04",
              reportDate: "2026-03-31",
              primaryDocument: "xom-20260331.htm",
              description: "Quarterly report",
            },
            {
              accession: "0000034088-26-000010",
              form: "10-K",
              filingDate: "2026-02-27",
              reportDate: "2025-12-31",
              primaryDocument: "xom-20251231.htm",
              description: "Annual report",
            },
            {
              accession: "0000034088-25-000010",
              form: "10-K",
              filingDate: "2025-02-28",
              reportDate: "2024-12-31",
              primaryDocument: "xom-20241231.htm",
              description: "Annual report",
            },
          ],
    ),
  },
});
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

function interimFacts({ omitPriorRevenue = false } = {}) {
  const duration = (value, fiscalYear, quarter, cumulative = true) => {
    const end =
      quarter === 1 ? `${fiscalYear - 1}-12-31` : `${fiscalYear}-03-31`;
    return {
      val: value,
      start: cumulative ? `${fiscalYear - 1}-10-01` : `${fiscalYear}-01-01`,
      end,
      fy: fiscalYear,
      fp: `Q${quarter}`,
      form: "10-Q",
      filed: `${fiscalYear}-${quarter === 1 ? "02" : "05"}-01`,
      accn: `0000320193-${String(fiscalYear).slice(-2)}-00000${quarter}`,
    };
  };
  const income = (prior, current) => [
    duration(prior[0], 2025, 1),
    duration(prior[1], 2025, 2),
    duration(prior[2], 2025, 2, false),
    duration(current[0], 2026, 1),
    duration(current[1], 2026, 2),
    duration(current[2], 2026, 2, false),
  ];
  const revenue = income([100, 250, 150], [210, 450, 240]);
  const tags = {
    RevenueFromContractWithCustomerExcludingAssessedTax: omitPriorRevenue
      ? revenue.filter((entry) => entry.fy === 2026)
      : revenue,
    NetIncomeLoss: income([10, 25, 15], [21, 45, 24]),
    OperatingIncomeLoss: income([20, 50, 30], [42, 90, 48]),
    // Cash-flow statements provide cumulative YTD values. Quarter values
    // must be reconstructed using compatible cumulative contexts.
    NetCashProvidedByUsedInOperatingActivities: [
      duration(40, 2025, 1),
      duration(90, 2025, 2),
      duration(70, 2026, 1),
      duration(190, 2026, 2),
    ],
    PaymentsToAcquirePropertyPlantAndEquipment: [
      duration(10, 2025, 1),
      duration(20, 2025, 2),
      duration(20, 2026, 1),
      duration(50, 2026, 2),
    ],
  };
  return {
    "us-gaap": Object.fromEntries(
      Object.entries(tags).map(([tag, entries]) => [
        tag,
        { units: { USD: entries } },
      ]),
    ),
  };
}

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
      validatePortfolioRequest(request([], { research: { basis: "monthly" } })),
    /annual, quarter, ytd or ttm/,
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

test("quarterly and fiscal YTD API requests retain their basis, correct flow windows and same-quarter prior-year growth", async () => {
  const captured = {};
  for (const basis of ["quarter", "ytd"]) {
    const received = [];
    const result = await runPortfolioResearch(
      request([{ ticker: "AAPL" }], { research: { basis } }),
      {
        directory,
        loadCompany: async (identity, requestedBasis) => {
          received.push(requestedBasis);
          return buildPortfolioCompany(
            company({ ...identity, facts: interimFacts() }),
            {
              basis: requestedBasis,
              retrievedAt: "2026-09-07T12:00:00.000Z",
            },
          );
        },
      },
    );
    assert.deepEqual(received, [basis]);
    assert.equal(result.basis, basis);
    const c = result.companies[0];
    captured[basis] = c;
    assert.equal(c.basis, basis);
    assert.equal(c.period.kind, basis);
    assert.equal(c.period.fp, "Q2");
    assert.equal(
      c.period.start,
      basis === "quarter" ? "2026-01-01" : "2025-10-01",
    );
    assert.equal(c.period.end, "2026-03-31");
    for (const key of [
      "revenue",
      "netIncome",
      "operatingCashFlow",
      "capex",
      "freeCashFlow",
      "revenueGrowth",
    ])
      assert.deepEqual(
        c.metrics[key].period,
        c.period,
        `${key} retains the requested ${basis} window`,
      );
    assert.ok(
      c.metrics.revenueGrowth.sources.some(
        (source) => source.end === "2025-03-31",
      ),
    );
    assert.ok(
      c.metrics.revenueGrowth.sources.some(
        (source) => source.end === "2026-03-31",
      ),
    );
    assert.ok(
      !c.metrics.revenueGrowth.sources.some(
        (source) => source.end === "2025-12-31",
      ),
      "Prior quarter must not replace the comparable prior-year quarter",
    );
  }
  const quarterly = captured.quarter.metrics,
    cumulative = captured.ytd.metrics;
  assert.equal(quarterly.revenue.value, 240);
  assert.equal(cumulative.revenue.value, 450);
  assert.equal(quarterly.netIncome.value, 24);
  assert.equal(cumulative.netIncome.value, 45);
  assert.equal(quarterly.operatingCashFlow.value, 120);
  assert.equal(cumulative.operatingCashFlow.value, 190);
  assert.equal(quarterly.operatingCashFlow.classification, "calculated");
  assert.equal(cumulative.operatingCashFlow.classification, "reported");
  assert.deepEqual(
    quarterly.operatingCashFlow.sources.map((source) => source.end).sort(),
    ["2025-12-31", "2026-03-31"],
  );
  assert.equal(quarterly.capex.value, 30);
  assert.equal(cumulative.capex.value, 50);
  assert.equal(quarterly.freeCashFlow.value, 90);
  assert.equal(cumulative.freeCashFlow.value, 140);
  assert.ok(Math.abs(quarterly.revenueGrowth.value - 60) < 1e-9);
  assert.ok(Math.abs(cumulative.revenueGrowth.value - 80) < 1e-9);
});

test("interim portfolio growth stays unavailable without comparable prior-year revenue even when the previous quarter exists", () => {
  for (const basis of ["quarter", "ytd"]) {
    const result = buildPortfolioCompany(
      company({ facts: interimFacts({ omitPriorRevenue: true }) }),
      { basis },
    );
    assert.equal(result.period.kind, basis);
    assert.ok(result.metrics.revenue.value > 0);
    assert.equal(result.metrics.revenueGrowth.value, null);
    assert.equal(result.metrics.revenueGrowth.classification, "unavailable");
    assert.deepEqual(result.metrics.revenueGrowth.sources, []);
  }
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

test("verified XOM continuity retains the current identity and joins annual and quarter evidence with predecessor URLs", async () => {
  const calls = [];
  const secJson = async (path) => {
    calls.push(path);
    if (path === "/submissions/CIK" + XOM_CURRENT_CIK + ".json")
      return xomSubmissions();
    if (path === "/submissions/CIK" + XOM_PREDECESSOR_CIK + ".json")
      return xomSubmissions({ current: false });
    if (
      path ===
      "/api/xbrl/companyfacts/CIK" + XOM_CURRENT_CIK + ".json"
    )
      return { cik: Number(XOM_CURRENT_CIK), facts: xomCurrentFacts };
    if (
      path ===
      "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json"
    )
      return { cik: Number(XOM_PREDECESSOR_CIK), facts: xomAnnualFacts };
    throw new Error("Unexpected SEC fixture path: " + path);
  };

  const annual = await loadFreshPortfolioCompany(
    { cik: XOM_CURRENT_CIK, ticker: "XOM" },
    "annual",
    { secJson },
  );
  assert.equal(annual.cik, XOM_CURRENT_CIK);
  assert.equal(annual.name, "ExxonMobil Holdings Corp");
  assert.equal(annual.ticker, "XOM");
  assert.equal(annual.period.end, "2025-12-31");
  assert.equal(annual.metrics.revenue.value, 120);
  assert.match(
    annual.metrics.revenue.sources[0].documentUrl,
    /\/Archives\/edgar\/data\/34088\/000003408826000010\/xom-20251231\.htm$/,
  );
  assert.equal(
    annual.metrics.revenue.sources[0].sourceCik,
    XOM_PREDECESSOR_CIK,
  );
  assert.ok(Number.isFinite(annual.metrics.revenueGrowth.value));
  assert.ok(
    annual.metrics.revenueGrowth.sources.every(
      (source) => source.sourceCik === XOM_PREDECESSOR_CIK,
    ),
  );
  assert.deepEqual(
    annual.filings.map((filing) => filing.accession),
    [
      "0000034088-26-000093",
      "0002115436-26-000001",
      "0000034088-26-000050",
      "0000034088-26-000010",
      "0000034088-25-000010",
    ],
  );
  assert.equal(
    annual.filings.find(
      (filing) => filing.accession === "0000034088-26-000093",
    ).sourceCik,
    XOM_PREDECESSOR_CIK,
  );
  assert.equal(annual.evidenceContinuity.status, "applied");
  assert.deepEqual(annual.evidenceContinuity.factSourceCiks, [
    XOM_CURRENT_CIK,
    XOM_PREDECESSOR_CIK,
  ]);
  assert.deepEqual(annual.evidenceContinuity.failures, []);
  assert.match(annual.evidenceContinuity.identityPolicy, /current SEC registrant/);
  assert.ok(
    annual.warnings.some((warning) =>
      warning.includes("SEC evidence continuity applied"),
    ),
  );

  const quarter = await loadFreshPortfolioCompany(
    { cik: XOM_CURRENT_CIK, ticker: "XOM" },
    "quarter",
    { secJson },
  );
  assert.equal(quarter.period.end, "2026-06-30");
  assert.equal(quarter.metrics.revenue.value, 70);
  assert.match(
    quarter.metrics.revenue.sources[0].documentUrl,
    /\/Archives\/edgar\/data\/34088\/000003408826000093\/xom-20260630\.htm$/,
  );
  assert.equal(
    quarter.metrics.revenue.sources[0].sourceCik,
    XOM_PREDECESSOR_CIK,
  );
  assert.deepEqual(
    [...new Set(calls)].sort(),
    [
      "/api/xbrl/companyfacts/CIK" + XOM_CURRENT_CIK + ".json",
      "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json",
      "/submissions/CIK" + XOM_CURRENT_CIK + ".json",
      "/submissions/CIK" + XOM_PREDECESSOR_CIK + ".json",
    ].sort(),
  );
});

test("XOM submissions failure still fetches predecessor facts and discloses the partial continuity chain", async () => {
  const paths = [];
  const result = await loadFreshPortfolioCompany(
    { cik: XOM_CURRENT_CIK, ticker: "XOM" },
    "annual",
    {
      secJson: async (path) => {
        paths.push(path);
        if (path === "/submissions/CIK" + XOM_CURRENT_CIK + ".json")
          return xomSubmissions();
        if (path === "/submissions/CIK" + XOM_PREDECESSOR_CIK + ".json")
          throw new Error("Fixture predecessor outage");
        if (
          path ===
          "/api/xbrl/companyfacts/CIK" + XOM_CURRENT_CIK + ".json"
        )
          return { cik: Number(XOM_CURRENT_CIK), facts: xomAnnualFacts };
        if (
          path ===
          "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json"
        )
          return { cik: Number(XOM_PREDECESSOR_CIK), facts: xomAnnualFacts };
        throw new Error("Unexpected SEC fixture path: " + path);
      },
    },
  );

  assert.equal(result.cik, XOM_CURRENT_CIK);
  assert.equal(result.name, "ExxonMobil Holdings Corp");
  assert.equal(result.metrics.revenue.value, 120);
  assert.equal(
    result.metrics.revenue.sources[0].sourceCik,
    XOM_PREDECESSOR_CIK,
  );
  assert.equal(result.factsUnavailable, undefined);
  assert.equal(result.evidenceContinuity.status, "partial");
  assert.deepEqual(result.evidenceContinuity.factSourceCiks, [
    XOM_CURRENT_CIK,
    XOM_PREDECESSOR_CIK,
  ]);
  assert.deepEqual(result.evidenceContinuity.filingSourceCiks, [
    XOM_CURRENT_CIK,
  ]);
  assert.equal(result.evidenceContinuity.failures[0].resource, "submissions");
  assert.match(result.evidenceContinuity.failures[0].message, /outage/);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("SEC evidence continuity is partial"),
    ),
  );
  assert.ok(
    paths.includes(
      "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json",
    ),
  );
});

test("a partial XOM continuity refresh cannot replace a previously complete cached evidence chain", async () => {
  const originalNow = Date.now;
  let clock = originalNow();
  let predecessorFactsAvailable = true;
  const paths = [];
  const secJson = async (path) => {
    paths.push(path);
    if (path === "/submissions/CIK" + XOM_CURRENT_CIK + ".json")
      return xomSubmissions();
    if (path === "/submissions/CIK" + XOM_PREDECESSOR_CIK + ".json")
      return xomSubmissions({ current: false });
    if (
      path ===
      "/api/xbrl/companyfacts/CIK" + XOM_CURRENT_CIK + ".json"
    )
      return { cik: Number(XOM_CURRENT_CIK), facts: xomCurrentFacts };
    if (
      path ===
      "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json"
    ) {
      if (!predecessorFactsAvailable)
        throw new Error("Fixture predecessor facts outage");
      return { cik: Number(XOM_PREDECESSOR_CIK), facts: xomAnnualFacts };
    }
    throw new Error("Unexpected SEC fixture path: " + path);
  };

  Date.now = () => clock;
  try {
    const complete = await loadCachedPortfolioCompany(
      { cik: XOM_CURRENT_CIK, ticker: "XOM" },
      "annual",
      { secJson },
    );
    assert.equal(complete.cache.status, "fresh");
    assert.equal(complete.evidenceContinuity.status, "applied");
    assert.equal(complete.metrics.revenue.value, 120);

    predecessorFactsAvailable = false;
    clock = Date.parse(complete.retrievedAt) + 6 * 60 * 1000;
    const retained = await loadCachedPortfolioCompany(
      { cik: XOM_CURRENT_CIK, ticker: "XOM" },
      "annual",
      { secJson },
    );
    assert.equal(retained.cache.status, "stale");
    assert.equal(retained.retrievedAt, complete.retrievedAt);
    assert.equal(retained.evidenceContinuity.status, "applied");
    assert.equal(retained.metrics.revenue.value, 120);
    assert.ok(
      retained.warnings.some((warning) =>
        warning.includes("could not be refreshed completely"),
      ),
    );
    assert.equal(
      paths.filter(
        (path) =>
          path ===
          "/api/xbrl/companyfacts/CIK" + XOM_PREDECESSOR_CIK + ".json",
      ).length,
      2,
    );

    const callsAfterPartialRefresh = paths.length;
    clock = Date.parse(complete.retrievedAt) + 1000;
    const cached = await loadCachedPortfolioCompany(
      { cik: XOM_CURRENT_CIK, ticker: "XOM" },
      "annual",
      { secJson },
    );
    assert.equal(cached.cache.status, "cached");
    assert.equal(cached.evidenceContinuity.status, "applied");
    assert.equal(cached.metrics.revenue.value, 120);
    assert.equal(paths.length, callsAfterPartialRefresh);
  } finally {
    Date.now = originalNow;
  }
});
