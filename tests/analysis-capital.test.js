import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisCompany,
  packAnalysisCompany,
  unpackAnalysisCompany,
} from "../src/utils/analysisResearch.js";
import {
  cashWindow,
  buildCashQuality,
  buildWorkingCapital,
  buildCapitalLab,
  supportsAnalysisDuration,
} from "../src/utils/analysisCapital.js";

const period = (
  year,
  kind = "annual",
  start = `${year}-01-01`,
  end = `${year}-12-31`,
  fp = "FY",
) => ({ kind, start, end, fp });
const point = (value, p, tag = "NetIncomeLoss", instant = false) => ({
  period: p,
  value,
  classification: "reported",
  sources: [
    {
      taxonomy: "us-gaap",
      tag,
      unit: "USD",
      value,
      start: instant ? null : p.start,
      end: p.end,
      accession: "0000000001-26-000001",
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1/",
    },
  ],
});
const cashData = (periods = [period(2025), period(2024), period(2023)]) => ({
  lens: "corporate",
  periods,
  metrics: Object.fromEntries(
    ["operatingCashFlow", "netIncome", "capex", "freeCashFlow"].map(
      (key, k) => [
        key,
        periods.map((p, i) => point([120, 100, 20, 100][k] + i, p, key)),
      ],
    ),
  ),
});
const annual = (val, year = 2025, instant = false, extra = {}) => ({
  val,
  end: `${year}-12-31`,
  ...(instant ? {} : { start: `${year}-01-01` }),
  fy: year,
  fp: "FY",
  form: "10-K",
  filed: `${year + 1}-02-01`,
  accn: `0000000001-${String(year + 1).slice(2)}-000001`,
  ...extra,
});
const company = (tags, sic = 3571) => ({
  ticker: "TEST",
  cik: "0000000001",
  companyName: "Test Company",
  sic,
  filings: [],
  facts: {
    "us-gaap": Object.fromEntries(
      Object.entries(tags).map(([key, values]) => [
        key,
        { units: { USD: values } },
      ]),
    ),
  },
});

test("Cash quality adds only complete nonoverlapping annual flows and keeps every source", () => {
  const d = cashData();
  const result = buildCashQuality(d, 0, 3);
  assert.deepEqual(result.indices, [0, 1, 2]);
  assert.equal(result.period.start, "2023-01-01");
  assert.equal(result.rows[0].point.value, 363);
  assert.equal(result.rows[0].point.sources.length, 3);
  assert.equal(result.conversion.value, (363 / 303) * 100);
  assert.equal(result.difference.value, 60);
});
test("Cash quality never sums overlapping YTD or trailing-year observations", () => {
  for (const kind of ["ytd", "ttm"]) {
    const d = cashData([
      period(2025, kind, "2025-01-01", "2025-09-30", "Q3"),
      period(2025, kind, "2025-01-01", "2025-06-30", "Q2"),
    ]);
    const result = buildCashQuality(d, 0, 4);
    assert.deepEqual(result.indices, [0]);
    assert.equal(result.rows[0].point.value, 120);
    assert.equal(result.cumulative, false);
    assert.match(result.reason, /overlap/);
  }
});
test("Cash windows stop at gaps, overlaps or unavailable starts", () => {
  assert.deepEqual(
    cashWindow(cashData([period(2025), period(2023)]), 0, 4).indices,
    [0],
  );
  assert.deepEqual(
    cashWindow(
      cashData([
        period(2025),
        period(2024, "annual", "2024-01-01", "2025-01-01"),
      ]),
      0,
      4,
    ).indices,
    [0],
  );
  assert.deepEqual(
    cashWindow(cashData([period(2025, "annual", null)]), 0, 4).indices,
    [],
  );
});
test("Cash quality rejects a reported flow with a different actual source duration", () => {
  const d = cashData();
  d.metrics.operatingCashFlow[0].sources[0].start = "2024-12-15";
  const result = buildCashQuality(d);
  assert.equal(result.rows[0].point.value, null);
  assert.match(result.rows[0].point.reason, /source duration/);
});
test("Flow duration verification preserves cumulative-subtraction quarters and four-quarter TTM operands", () => {
  const p = period(2026, "quarter", "2026-04-01", "2026-06-30", "Q2");
  const source = (start, end) => ({
    taxonomy: "us-gaap",
    tag: "NetCashProvidedByUsedInOperatingActivities",
    unit: "USD",
    start,
    end,
  });
  const derivedQuarter = {
    value: 100,
    classification: "calculated",
    sources: [
      source("2026-01-01", "2026-06-30"),
      source("2026-01-01", "2026-03-31"),
    ],
  };
  assert.equal(supportsAnalysisDuration(derivedQuarter, p), true);
  assert.equal(
    supportsAnalysisDuration(
      { ...derivedQuarter, sources: [source("2026-01-01", "2026-06-30")] },
      p,
    ),
    false,
  );
  const trailing = period(2026, "ttm", "2025-04-01", "2026-03-31", "Q1");
  const derivedTtm = {
    value: 400,
    classification: "calculated",
    sources: [
      source("2025-01-01", "2025-03-31"),
      source("2025-01-01", "2025-06-30"),
      source("2025-01-01", "2025-09-30"),
      source("2025-01-01", "2025-12-31"),
      source("2026-01-01", "2026-03-31"),
    ],
  };
  assert.equal(supportsAnalysisDuration(derivedTtm, trailing), true);
  assert.equal(
    supportsAnalysisDuration(
      { ...derivedTtm, sources: derivedTtm.sources.slice(1) },
      trailing,
    ),
    false,
  );
});
test("Cash quality retains explicit zero and reports incomplete input coverage", () => {
  const d = cashData();
  d.metrics.capex[1] = point(0, d.periods[1], "capex");
  assert.equal(buildCashQuality(d, 0, 3).rows[2].point.value, 42);
  d.metrics.capex[1] = { value: null };
  const incomplete = buildCashQuality(d, 0, 3);
  assert.equal(incomplete.rows[2].point.value, null);
  assert.equal(incomplete.rows[2].available, 2);
  assert.match(incomplete.rows[2].point.reason, /2 of 3/);
  assert.equal(incomplete.rows[0].point.value, 363);
});
test("Cash conversion is unavailable when cumulative income is not positive", () => {
  const d = cashData();
  d.metrics.netIncome = d.periods.map((p) => point(-10, p));
  assert.equal(buildCashQuality(d).conversion.value, null);
  assert.match(buildCashQuality(d).conversion.reason, /zero or negative/);
});
test("Working-capital opening balances use the start of the actual YTD duration", () => {
  const q = (val, end, fp, start) => ({
    val,
    end,
    start,
    fy: 2026,
    fp,
    form: "10-Q",
    filed: end === "2026-03-31" ? "2026-05-01" : "2026-08-01",
    accn:
      end === "2026-03-31" ? "0000000001-26-000002" : "0000000001-26-000003",
  });
  const d = buildAnalysisCompany(
    company({
      Assets: [
        annual(1000, 2025, true),
        q(1100, "2026-03-31", "Q1"),
        q(1200, "2026-06-30", "Q2"),
      ],
      NetIncomeLoss: [
        annual(100),
        q(25, "2026-03-31", "Q1", "2026-01-01"),
        q(60, "2026-06-30", "Q2", "2026-01-01"),
      ],
      Revenues: [
        annual(400),
        q(100, "2026-03-31", "Q1", "2026-01-01"),
        q(200, "2026-06-30", "Q2", "2026-01-01"),
      ],
      CostOfRevenue: [q(100, "2026-06-30", "Q2", "2026-01-01")],
      AccountsReceivableNetCurrent: [
        annual(20, 2025, true),
        q(100, "2026-03-31", "Q1"),
        q(40, "2026-06-30", "Q2"),
      ],
      InventoryNet: [annual(10, 2025, true), q(20, "2026-06-30", "Q2")],
      AccountsPayableCurrent: [
        annual(5, 2025, true),
        q(15, "2026-06-30", "Q2"),
      ],
    }),
    { basis: "ytd" },
  );
  assert.equal(d.periods[0].start, "2026-01-01");
  const result = buildWorkingCapital(
    unpackAnalysisCompany(packAnalysisCompany(d)),
    0,
  );
  assert.equal(result.days, 181);
  assert.equal(result.rows[0].opening.value, 20);
  assert.equal(result.rows[0].average.value, 30);
  assert.equal(result.rows[0].point.value, (30 / 200) * 181);
  assert.ok(result.rows[0].point.sources.some((s) => s.end === "2025-12-31"));
  assert.ok(!result.rows[0].point.sources.some((s) => s.end === "2026-03-31"));
  assert.equal(result.rows[1].point.value, (15 / 100) * 181);
  assert.equal(result.rows[2].point.value, (10 / 100) * 181);
  assert.equal(
    result.cycle.value,
    (30 / 200) * 181 + (15 / 100) * 181 - (10 / 100) * 181,
  );
});
test("Working-capital averages do not mix concepts or infer missing opening balances", () => {
  const d = cashData([period(2025)]);
  d.metrics.revenue = [point(400, d.periods[0], "Revenues")];
  d.metrics.receivables = [
    point(40, d.periods[0], "AccountsReceivableNetCurrent", true),
  ];
  d.metrics.openingReceivables = [
    point(20, period(2024), "ReceivablesNetCurrent", true),
  ];
  assert.equal(buildWorkingCapital(d).rows[0].point.value, null);
  assert.match(
    buildWorkingCapital(d).rows[0].point.reason,
    /different reported concepts/,
  );
  delete d.metrics.openingReceivables;
  assert.equal(buildWorkingCapital(d).rows[0].point.value, null);
});
test("Working-capital cycles are not applied to banks or insurers", () => {
  for (const lens of ["banking", "insurance"]) {
    const d = { ...cashData(), lens };
    assert.equal(buildWorkingCapital(d).available, false);
    assert.deepEqual(buildWorkingCapital(d).rows, []);
  }
});
test("Capital lab separates current and long-term debt and never invents total debt", () => {
  const d = cashData();
  for (const [key, val] of [
    ["totalAssets", 1000],
    ["shortTermDebt", 100],
    ["longTermDebt", 250],
    ["totalLiabilities", 750],
    ["stockholdersEquity", 200],
    ["cash", 50],
  ])
    d.metrics[key] = d.periods.map((p) => point(val, p, key, true));
  const result = buildCapitalLab(d, { baseline: "year" });
  assert.equal(
    result.fundingRows.find((r) => r.definition.key === "shortTermDebt").point
      .value,
    100,
  );
  assert.equal(
    result.fundingRows.find((r) => r.definition.key === "longTermDebt").point
      .value,
    250,
  );
  assert.equal(
    result.ratios.find((r) => r.definition.key === "capitalLiabilitiesAssets")
      .point.value,
    75,
  );
  assert.equal(
    result.ratios.find((r) => r.definition.key === "capitalEquityAssets").point
      .value,
    20,
  );
  assert.equal(
    result.fundingRows.some((r) => /total debt/i.test(r.definition.label)),
    false,
  );
});
test("Capital lab withholds changes when the source concept changes between dates", () => {
  const d = cashData();
  d.metrics.cash = d.periods.map((p, i) =>
    point(
      50 + i,
      p,
      i === 0 ? "Cash" : "CashAndCashEquivalentsAtCarryingValue",
      true,
    ),
  );
  const cash = buildCapitalLab(d, { baseline: "year" }).assetRows[0];
  assert.equal(cash.change.value, null);
  assert.match(cash.change.reason, /concept changes/);
});
test("Bank capital lab uses reported net loans and explicitly separate deposit funding ratios", () => {
  const d = { ...cashData(), lens: "banking" };
  for (const [key, val] of [
    ["loans", 400],
    ["deposits", 500],
    ["totalLiabilities", 800],
    ["totalAssets", 1000],
  ])
    d.metrics[key] = d.periods.map((p) => point(val, p, key, true));
  const result = buildCapitalLab(d, { baseline: "year" });
  assert.equal(
    result.ratios.find((r) => r.definition.key === "capitalLoansDeposits").point
      .value,
    80,
  );
  assert.equal(
    result.ratios.find((r) => r.definition.key === "capitalDepositsLiabilities")
      .point.value,
    62.5,
  );
  assert.equal(
    result.assetRows.some((r) => r.definition.key === "inventory"),
    false,
  );
  assert.equal(
    result.fundingRows.some((r) => r.definition.key === "deposits"),
    true,
  );
});
