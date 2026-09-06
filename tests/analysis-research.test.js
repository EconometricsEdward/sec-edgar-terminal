import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisCompany,
  analysisBaseline,
  analysisChange,
  commonSizePoint,
  analysisChecks,
  calculateAnalysisPoint,
  packAnalysisCompany,
  unpackAnalysisCompany,
} from "../src/utils/analysisResearch.js";
import {
  normalizeAnalysisSettings,
  readAnalysisSettings,
  analysisPath,
  exportAnalysisCsv,
  exportAnalysisBrief,
} from "../src/utils/analysisNotebook.js";
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
const company = (tags = {}, sic = 3571, unit = "USD") => ({
  ticker: "TEST",
  cik: "0000000001",
  companyName: "Test Company",
  sic,
  filings: [],
  facts: {
    "us-gaap": Object.fromEntries(
      Object.entries(tags).map(([tag, values]) => [
        tag,
        { units: { [unit]: values } },
      ]),
    ),
  },
});
const base = () => ({
  Assets: [annual(1000, 2024, true), annual(1200, 2025, true)],
  LiabilitiesAndStockholdersEquity: [annual(1200, 2025, true)],
  StockholdersEquity: [annual(100, 2024, true), annual(140, 2025, true)],
  NetIncomeLoss: [annual(24)],
  Revenues: [annual(400)],
  NetCashProvidedByUsedInOperatingActivities: [annual(30)],
  PaymentsToAcquirePropertyPlantAndEquipment: [annual(8)],
  PaymentsOfDividends: [annual(5)],
  PaymentsForRepurchaseOfCommonStock: [annual(10)],
});
const p = (end, start, kind = "annual", fp = "FY") => ({
  end,
  start,
  kind,
  fp,
});
const point = (value, period, flow = true) => ({
  value,
  period,
  sources: [
    { unit: "USD", start: flow ? period.start : null, end: period.end },
  ],
});

test("Analysis ROE decomposition agrees with the direct average-balance calculation", () => {
  const d = buildAnalysisCompany(company(base()));
  assert.equal(d.metrics.roe[0].value, 20);
  assert.ok(Math.abs(d.metrics.dupontRoe[0].value - 20) < 1e-10);
  assert.equal(d.metrics.averageAssets[0].value, 1100);
  assert.equal(d.metrics.averageEquity[0].value, 120);
  assert.ok(d.metrics.dupontRoe[0].sources.some((s) => s.end === "2024-12-31"));
});
test("Analysis bank revenue excludes gross interest and preserves both operating components", () => {
  const d = buildAnalysisCompany(
    company(
      {
        ...base(),
        InterestAndDividendIncomeOperating: [annual(1000)],
        InterestIncomeExpenseNet: [annual(100)],
        NoninterestIncome: [annual(50)],
        NoninterestExpense: [annual(60)],
      },
      6021,
    ),
  );
  assert.equal(d.revenueKey, "bankRevenue");
  assert.equal(d.metrics.bankRevenue[0].value, 150);
  assert.equal(d.metrics.bankNetMargin[0].value, 16);
  assert.equal(d.metrics.efficiency[0].value, 40);
  assert.equal(
    d.definitions.some((m) => m.key === "revenue"),
    false,
  );
  assert.equal(commonSizePoint(d, "netIncome", 0).value, 16);
});
test("Analysis YTD returns annualize the selected duration and use its opening balance", () => {
  const tags = base();
  const q = {
    start: "2026-01-01",
    end: "2026-06-30",
    fy: 2026,
    fp: "Q2",
    form: "10-Q",
    filed: "2026-08-01",
    accn: "0000000001-26-000002",
  };
  tags.NetIncomeLoss.push({ val: 12, ...q });
  tags.Revenues.push({ val: 200, ...q });
  tags.Assets.push({ ...q, start: undefined, val: 1300 });
  tags.StockholdersEquity.push({ ...q, start: undefined, val: 160 });
  const d = buildAnalysisCompany(company(tags), { basis: "ytd" });
  assert.equal(d.periods[0].start, "2026-01-01");
  assert.ok(
    Math.abs(d.metrics.roe[0].value - (((12 / 150) * 365) / 181) * 100) < 1e-10,
  );
  assert.ok(
    Math.abs(d.metrics.roe[0].value - d.metrics.dupontRoe[0].value) < 1e-10,
  );
});
test("Analysis missing buybacks do not become zero shareholder returns", () => {
  const tags = base();
  delete tags.PaymentsForRepurchaseOfCommonStock;
  const d = buildAnalysisCompany(company(tags));
  assert.equal(d.metrics.freeCashFlow[0].value, 22);
  assert.equal(d.metrics.cashReturned[0].value, null);
  assert.equal(d.metrics.cashAfterReturns[0].value, null);
});
test("Analysis disclosed zero is retained in cash-allocation calculations", () => {
  const d = buildAnalysisCompany(
    company({ ...base(), PaymentsForRepurchaseOfCommonStock: [annual(0)] }),
  );
  assert.equal(d.metrics.cashReturned[0].value, 5);
  assert.equal(d.metrics.cashAfterReturns[0].value, 17);
});
test("Analysis cash bridge identifies the net residual without inventing component causes", () => {
  const d = buildAnalysisCompany(company(base()));
  assert.equal(d.metrics.cashAdjustments[0].value, 6);
  assert.match(d.metrics.cashAdjustments[0].formula, /residual/);
  assert.equal(d.metrics.cashAfterReturns[0].value, 7);
});
test("Analysis reconciliations require complete inputs including explicit FX", () => {
  const tags = {
    ...base(),
    NetCashProvidedByUsedInInvestingActivities: [annual(-8)],
    NetCashProvidedByUsedInFinancingActivities: [annual(-15)],
    CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect:
      [annual(7)],
  };
  const incomplete = buildAnalysisCompany(company(tags));
  assert.equal(analysisChecks(incomplete, 0).checks[1].status, "Incomplete");
  tags.EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents =
    [annual(0)];
  const complete = buildAnalysisCompany(company(tags));
  assert.equal(analysisChecks(complete, 0).checks[1].status, "Reconciled");
  tags.CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect =
    [annual(15)];
  assert.equal(
    analysisChecks(buildAnalysisCompany(company(tags)), 0).checks[1].status,
    "Review residual",
  );
});
test("Analysis balance check uses the reported consolidated equation instead of parent equity", () => {
  const tags = { ...base(), Liabilities: [annual(1000, 2025, true)] };
  const d = buildAnalysisCompany(company(tags));
  assert.equal(analysisChecks(d, 0).checks[0].status, "Reconciled");
  delete tags.LiabilitiesAndStockholdersEquity;
  assert.equal(
    analysisChecks(buildAnalysisCompany(company(tags)), 0).checks[0].status,
    "Incomplete",
  );
});
test("Analysis positive denominators are required for common size and return drivers", () => {
  const d = buildAnalysisCompany(
    company({
      ...base(),
      Revenues: [annual(-100)],
      StockholdersEquity: [annual(-100, 2024, true), annual(-140, 2025, true)],
    }),
  );
  assert.equal(commonSizePoint(d, "netIncome", 0).value, null);
  assert.equal(d.metrics.roe[0].value, null);
  assert.equal(d.metrics.dupontRoe[0].value, null);
  assert.equal(
    calculateAnalysisPoint(
      p("2025-12-31", "2025-01-01"),
      [{ value: 1 }, null],
      "a+b",
      (a, b) => a + b,
    ).value,
    null,
  );
});
test("Analysis insurance income has no invented common-size revenue denominator", () => {
  const d = buildAnalysisCompany(
    company({ ...base(), PremiumsEarnedNet: [annual(300)] }, 6311),
  );
  assert.equal(d.revenueKey, null);
  assert.equal(commonSizePoint(d, "netIncome", 0).value, null);
  assert.equal(commonSizePoint(d, "totalAssets", 0).value, 100);
});
test("Analysis filing cutoff removes later revisions from values and revision history", () => {
  const tags = base();
  tags.NetIncomeLoss.push(
    annual(30, 2025, false, {
      filed: "2026-03-01",
      accn: "0000000001-26-000002",
      form: "10-K/A",
    }),
  );
  const latest = buildAnalysisCompany(company(tags));
  assert.equal(latest.metrics.netIncome[0].value, 30);
  assert.deepEqual(
    latest.metrics.netIncome[0].sources[0].revisions.map((r) => r.value),
    [24, 30],
  );
  const early = buildAnalysisCompany(company(tags), { asOf: "2026-02-15" });
  assert.equal(early.metrics.netIncome[0].value, 24);
  assert.equal(early.metrics.netIncome[0].sources[0].revised, false);
  assert.ok(
    Object.values(early.metrics)
      .flat()
      .flatMap((p) => p.sources)
      .every((s) => s.filed <= "2026-02-15"),
  );
});
test("Analysis does not substitute non-USD facts for dollar values", () => {
  const d = buildAnalysisCompany(company(base(), 3571, "EUR"));
  assert.equal(d.metrics.netIncome[0].value, null);
  assert.equal(d.metrics.totalAssets[0].value, null);
});
test("Analysis per-share values retain their own units", () => {
  const c = company(base());
  c.facts["us-gaap"].EarningsPerShareDiluted = {
    units: { "USD/shares": [annual(2.45)] },
  };
  const d = buildAnalysisCompany(c);
  assert.equal(d.metrics.epsDiluted[0].value, 2.45);
  assert.equal(commonSizePoint(d, "epsDiluted", 0).value, 2.45);
});
test("Analysis transport compaction round-trips source evidence and calculations", () => {
  const d = buildAnalysisCompany(company(base()));
  const packed = JSON.parse(JSON.stringify(packAnalysisCompany(d)));
  const unpacked = unpackAnalysisCompany(packed);
  assert.equal(
    unpacked.metrics.dupontRoe[0].value,
    d.metrics.dupontRoe[0].value,
  );
  assert.deepEqual(
    unpacked.metrics.dupontRoe[0].sources,
    d.metrics.dupontRoe[0].sources,
  );
  assert.deepEqual(
    unpacked.metrics.dupontRoe[0].calculations,
    d.metrics.dupontRoe[0].calculations,
  );
  assert.equal(unpacked.metrics.dupontRoe[0].period.end, d.periods[0].end);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(d).length * 0.75);
});
test("Analysis same-season comparisons reject missing years and growing YTD windows", () => {
  const periods = [
    p("2026-06-30", "2026-01-01", "ytd", "Q2"),
    p("2026-03-31", "2026-01-01", "ytd", "Q1"),
    p("2025-06-30", "2025-01-01", "ytd", "Q2"),
  ];
  assert.equal(analysisBaseline(periods, 0, "year"), 2);
  assert.equal(analysisBaseline(periods, 0, "previous"), -1);
  assert.equal(
    analysisBaseline(
      [p("2025-12-31", "2025-01-01"), p("2023-12-31", "2023-01-01")],
      0,
      "year",
    ),
    -1,
  );
  assert.equal(
    analysisChange(point(20, periods[0]), point(15, periods[1]), "currency")
      .delta,
    null,
  );
});
test("Analysis changes show percentage points and suppress growth from a negative base", () => {
  const now = p("2025-12-31", "2025-01-01"),
    before = p("2024-12-31", "2024-01-01");
  assert.deepEqual(
    analysisChange(point(20, now), point(15, before), "percent"),
    { delta: 5, percent: null, reason: null },
  );
  const loss = analysisChange(point(10, now), point(-10, before), "currency");
  assert.equal(loss.delta, 20);
  assert.equal(loss.percent, null);
  assert.match(loss.reason, /negative/);
});
test("Statement comparisons reject unequal actual flow durations despite identical annual labels", () => {
  const current = point(120, p("2025-12-31", "2025-01-01"));
  const before = point(100, p("2024-12-31", "2024-01-01"));
  current.sources[0].start = "2025-03-01";
  for (const format of ["currency", "percent", "decimal"])
    assert.deepEqual(analysisChange(current, before, format), {
      delta: null,
      percent: null,
      reason: "The actual reported flow durations differ by more than 14 days.",
    });
});
test("Statement comparisons require valid positive normalized and actual flow durations", () => {
  const current = point(120, p("2025-12-31", "2025-01-01"));
  const before = point(100, p("2024-12-31", "2024-01-01"));
  for (const start of ["", "unknown", "2025-02-30", "2026-01-01"])
    assert.equal(
      analysisChange(
        { ...current, period: { ...current.period, start } },
        before,
        "currency",
      ).delta,
      null,
    );
  for (const source of [
    { start: "unknown", end: "2025-12-31" },
    { start: "2025-01-01", end: "2025-02-30" },
    { start: "2025-01-01", end: null },
    { start: "2026-01-01", end: "2025-12-31" },
  ]) {
    const invalid = analysisChange(
      { ...current, sources: [...current.sources, source] },
      before,
      "currency",
    );
    assert.equal(invalid.delta, null);
    assert.match(invalid.reason, /actual reported flow duration is invalid/);
  }
});
test("Statement comparisons retain derived standalone quarters and four-quarter trailing flows", () => {
  const currentQuarter = point(
    20,
    p("2025-06-30", "2025-04-01", "quarter", "Q2"),
  );
  currentQuarter.classification = "calculated";
  currentQuarter.sources = [
    { unit: "USD", start: "2025-01-01", end: "2025-06-30" },
    { unit: "USD", start: "2025-01-01", end: "2025-03-31" },
  ];
  const priorQuarter = point(
    10,
    p("2024-06-30", "2024-04-01", "quarter", "Q2"),
  );
  assert.equal(
    analysisChange(currentQuarter, priorQuarter, "currency").percent,
    100,
  );
  const trailing = (year, value) => ({
    ...point(value, p(`${year}-06-30`, `${year - 1}-07-01`, "ttm", "Q2")),
    classification: "calculated",
    sources: [
      [`${year - 1}-07-01`, `${year - 1}-09-30`],
      [`${year - 1}-10-01`, `${year - 1}-12-31`],
      [`${year}-01-01`, `${year}-03-31`],
      [`${year}-04-01`, `${year}-06-30`],
    ].map(([start, end]) => ({ unit: "USD", start, end })),
  });
  assert.deepEqual(
    analysisChange(trailing(2025, 120), trailing(2024, 100), "currency"),
    {
      delta: 20,
      percent: 20,
      reason: null,
    },
  );
});
test("Statement comparisons preserve instant-only and average-balance ratio semantics", () => {
  const current = point(20, p("2025-12-31", null), false);
  const before = point(15, p("2024-12-31", null), false);
  for (const format of ["percent", "decimal"])
    assert.deepEqual(analysisChange(current, before, format), {
      delta: 5,
      percent: null,
      reason: null,
    });
  const ratio = (year, value) => ({
    ...point(value, p(`${year}-12-31`, `${year}-01-01`)),
    sources: [
      { unit: "USD", start: `${year}-01-01`, end: `${year}-12-31` },
      { unit: "USD", start: null, end: `${year - 1}-12-31` },
      { unit: "USD", start: null, end: `${year}-12-31` },
    ],
  });
  assert.deepEqual(
    analysisChange(ratio(2025, 20), ratio(2024, 15), "percent"),
    {
      delta: 5,
      percent: null,
      reason: null,
    },
  );
  assert.equal(
    analysisChange(
      { ...before, period: { ...before.period, end: "not-a-date" } },
      current,
      "currency",
    ).delta,
    null,
  );
});
test("Analysis share URLs restore every financial control and reject malformed dates", () => {
  const settings = normalizeAnalysisSettings({
    basis: "ytd",
    end: "2025-06-30",
    asOf: "2025-09-01",
    view: "trends",
    pins: ["netIncome", "roe"],
    chart: ["netIncome", "roe"],
    indexed: true,
    years: 12,
    baseline: "2024-06-30",
    display: "common",
    units: "raw",
    search: "cash",
  });
  const path = analysisPath("JPM", settings);
  assert.deepEqual(readAnalysisSettings(path.split("?")[1]), settings);
  assert.equal(normalizeAnalysisSettings({ asOf: "2025-02-31" }).asOf, "");
  assert.equal(readAnalysisSettings("?view=ownership").view, "extended");
});
test("Analysis exports preserve raw negatives, source dates, settings and safe analyst text", () => {
  const d = buildAnalysisCompany(
    company({ ...base(), NetIncomeLoss: [annual(-24)] }),
  );
  const csv = exportAnalysisCsv(d, { asOf: "2026-02-15" });
  assert.ok(csv.includes('"-24"'));
  assert.ok(csv.includes("2026-02-01"));
  assert.ok(csv.includes("0000000001-26-000001"));
  const brief = exportAnalysisBrief(
    d,
    normalizeAnalysisSettings({ asOf: "2026-02-15" }),
    0,
    "<script>alert(1)</script>",
    [
      {
        label: "=unsafe",
        notes: "<img src=x>",
        format: "currency",
        point: d.metrics.netIncome[0],
      },
    ],
  );
  assert.ok(!brief.includes("<script>"));
  assert.ok(brief.includes("&lt;script&gt;"));
  assert.ok(brief.includes("2026-02-15"));
  assert.ok(brief.includes("www.sec.gov/Archives/edgar/data/"));
});
