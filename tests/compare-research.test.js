import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompareCompany,
  comparisonSelection,
  metricComparison,
  growthBetween,
  historicGrowth,
  trendSeries,
  uniqueIssuerCompanies,
  periodBucket,
} from "../src/utils/compareResearch.js";
import {
  DEFAULT_COMPARE_SETTINGS,
  normalizeCompareSettings,
  comparePath,
  readCompareUrl,
  writeCompareNotebook,
  exportCompareBrief,
  exportCompareCsv,
} from "../src/utils/compareNotebook.js";

const annual = (value, year = 2025, instant = false, extra = {}) => ({
  val: value,
  end: `${year}-12-31`,
  ...(instant ? {} : { start: `${year}-01-01` }),
  fy: year,
  fp: "FY",
  form: "10-K",
  filed: `${year + 1}-02-01`,
  accn: `0000000001-${String(year + 1).slice(2)}-000001`,
  ...extra,
});
const company = (tags, sic = 3571, unit = "USD") => ({
  ticker: "TEST",
  cik: "0000000001",
  companyName: "Test Company",
  sic,
  facts: {
    "us-gaap": Object.fromEntries(
      Object.entries(tags).map(([key, values]) => [
        key,
        { units: { [unit]: values } },
      ]),
    ),
  },
});
const balanceFacts = () => ({
  Assets: [annual(1000, 2024, true), annual(1200, 2025, true)],
  StockholdersEquity: [annual(100, 2024, true), annual(140, 2025, true)],
  NetIncomeLoss: [annual(24)],
});
const period = (end = "2025-12-31", start = "2025-01-01", kind = "annual") => ({
  end,
  start,
  kind,
  fp: kind === "annual" ? "FY" : "Q4",
});
const entry = (ticker, value, p = period(), cik = ticker) => ({
  ticker,
  loading: false,
  error: null,
  index: 0,
  period: p,
  data: {
    cik,
    lens: "corporate",
    name: ticker,
    periods: [p],
    metrics: {
      netIncome: [{ value, period: p, sources: [] }],
      roe: [{ value, period: p, sources: [] }],
    },
  },
});

test("Compare ROE and ROA use beginning and ending balances with all reported inputs", () => {
  const data = buildCompareCompany(company(balanceFacts()));
  assert.equal(data.metrics.roe[0].value, 20);
  assert.ok(Math.abs(data.metrics.roa[0].value - (24 / 1100) * 100) < 1e-12);
  assert.deepEqual(
    data.metrics.roe[0].sources.map((s) => s.value),
    [24, 140, 100],
  );
  assert.ok(
    data.metrics.roe[0].sources.every((s) =>
      s.documentUrl.includes("/Archives/edgar/data/"),
    ),
  );
});
test("missing beginning equity does not silently revert to ending equity", () => {
  const tags = balanceFacts();
  tags.StockholdersEquity = [annual(140, 2025, true)];
  assert.equal(buildCompareCompany(company(tags)).metrics.roe[0].value, null);
});
test("bank income requires net interest before provision and noninterest income", () => {
  const tags = {
    ...balanceFacts(),
    InterestAndDividendIncomeOperating: [annual(150)],
    InterestIncomeExpenseNet: [annual(80)],
    NoninterestIncome: [annual(20)],
  };
  const data = buildCompareCompany(company(tags, 6021));
  assert.equal(data.metrics.bankRevenue[0].value, 100);
  assert.equal(data.metrics.revenue[0].value, null);
  assert.deepEqual(
    data.metrics.bankRevenue[0].sources.map((s) => s.tag),
    ["InterestIncomeExpenseNet", "NoninterestIncome"],
  );
  delete tags.NoninterestIncome;
  assert.equal(
    buildCompareCompany(company(tags, 6021)).metrics.bankRevenue[0].value,
    null,
  );
});
test("zero income is retained and foreign-currency facts are not substituted", () => {
  const tags = { ...balanceFacts(), NetIncomeLoss: [annual(0)] };
  assert.equal(buildCompareCompany(company(tags)).metrics.roe[0].value, 0);
  assert.equal(
    buildCompareCompany(company(tags, 3571, "EUR")).metrics.netIncome[0].value,
    null,
  );
});
test("filing cutoff applies to comparative revisions and ratio inputs", () => {
  const tags = balanceFacts();
  tags.NetIncomeLoss.push(
    annual(30, 2025, false, {
      filed: "2026-03-01",
      form: "10-K/A",
      accn: "0000000001-26-000002",
    }),
  );
  assert.equal(
    buildCompareCompany(company(tags), { asOf: "2026-02-15" }).metrics.roe[0]
      .value,
    20,
  );
  assert.equal(buildCompareCompany(company(tags)).metrics.roe[0].value, 25);
});
test("standalone-quarter returns annualize income and use the quarter beginning balance", () => {
  const q = (value, instant) => ({
    val: value,
    ...(instant ? {} : { start: "2026-01-01" }),
    end: "2026-03-31",
    fy: 2026,
    fp: "Q1",
    form: "10-Q",
    filed: "2026-05-01",
    accn: "0000000001-26-000002",
  });
  const tags = balanceFacts();
  tags.NetIncomeLoss.push(q(10, false));
  tags.Assets.push(q(1300, true));
  tags.StockholdersEquity.push(q(160, true));
  const data = buildCompareCompany(company(tags), { basis: "quarter" });
  assert.ok(
    Math.abs(data.metrics.roe[0].value - (10 / 150) * (365 / 90) * 100) < 1e-10,
  );
  assert.equal(
    data.metrics.roe[0].sources.find((s) => s.end === "2025-12-31").value,
    140,
  );
});
test("trailing-year data remains missing when four consecutive quarters are unavailable", () => {
  const data = buildCompareCompany(company(balanceFacts()), { basis: "ttm" });
  assert.equal(data.metrics.netIncome[0].value, null);
  assert.match(data.metrics.netIncome[0].reason, /Four consecutive/);
});
test("selection preserves requested ticker aliases but prevents duplicate CIK peer counts", () => {
  const peers = [
    entry("GOOG", 10, period(), "1652044"),
    entry("GOOGL", 10, period(), "1652044"),
    entry("AAPL", 20),
  ];
  assert.equal(uniqueIssuerCompanies(peers)[1].duplicate, true);
  const selected = comparisonSelection(peers, DEFAULT_COMPARE_SETTINGS);
  assert.deepEqual(
    selected.entries.map((c) => c.ticker),
    ["GOOG", "AAPL"],
  );
});
test("common selection uses shared reporting-end buckets, not misleading issuer fiscal-year labels", () => {
  const a = entry("A", 10);
  a.data.periods.unshift(period("2026-12-31", "2026-01-01"));
  const result = comparisonSelection(
    [a, entry("B", 20)],
    DEFAULT_COMPARE_SETTINGS,
  );
  assert.equal(result.bucket, "2025");
  assert.equal(result.entries[0].index, 1);
  assert.equal(periodBucket({ ...period("2026-01-31"), fy: 2025 }), "2026");
});
test("incompatible fiscal ends pause medians, ranks, and benchmark deltas", () => {
  const result = metricComparison(
    [entry("A", 10), entry("B", 20, period("2025-06-30", "2024-07-01"))],
    "netIncome",
  );
  assert.equal(result.peerMedian, null);
  assert.equal(result.cells[0].rank, null);
  assert.equal(result.cells[0].delta, null);
  assert.match(result.reason, /Reporting dates/);
});
test("coverage separates failed issuers and missing values from numeric zero; ties share ranks", () => {
  const result = metricComparison(
    [
      entry("A", 10),
      entry("B", 10),
      entry("C", 0),
      { ticker: "D", error: "SEC unavailable", index: -1 },
    ],
    "netIncome",
  );
  assert.equal(result.peerMedian, 10);
  assert.equal(result.count, 3);
  assert.equal(result.total, 4);
  assert.deepEqual(
    result.cells.map((c) => c.rank),
    [1, 1, 3, null],
  );
  assert.equal(result.cells[3].status, "fetch failed");
  assert.equal(
    metricComparison([entry("A", 10), entry("B", 20)], "netIncome", "MISSING")
      .reference,
    null,
  );
});
test("growth requires a comparable prior year and positive currency base; ratios use points", () => {
  assert.equal(growthBetween({ value: 10 }, { value: -10 }).value, null);
  assert.deepEqual(growthBetween({ value: 12 }, { value: 10 }, "percent"), {
    value: 2,
    unit: "pp",
  });
  const data = entry("A", 10).data;
  data.metrics.netIncome.push({
    value: 5,
    period: period("2023-12-31", "2023-01-01"),
  });
  assert.equal(historicGrowth(data, "netIncome", 0).yoy.value, null);
});
test("indexed charts use the first shared positive base and retain missing observations", () => {
  const a = entry("A", 30),
    b = entry("B", 40);
  a.data.metrics.netIncome = [
    { value: 30, period: period() },
    { value: null, period: period("2024-12-31") },
    { value: 10, period: period("2023-12-31") },
    { value: 5, period: period("2022-12-31") },
  ];
  b.data.metrics.netIncome = [
    { value: 40, period: period() },
    { value: 30, period: period("2024-12-31") },
    { value: 20, period: period("2023-12-31") },
  ];
  const result = trendSeries([a, b], "netIncome", {
    mode: "indexed",
    years: 5,
  });
  assert.equal(result.sharedBase, "2023");
  assert.equal(result.rows.find((r) => r.bucket === "2023").A, 100);
  assert.equal(result.rows.find((r) => r.bucket === "2022").A, null);
  assert.equal(result.rows.find((r) => r.bucket === "2024").A, null);
  assert.equal(result.rows.find((r) => r.bucket === "2025").B, 200);
});
test("saved and shared setups round-trip all comparison controls", () => {
  const settings = normalizeCompareSettings({
    basis: "ttm",
    alignment: "latest",
    period: "2025-Q4",
    asOf: "2026-01-31",
    lens: "banking",
    benchmark: "JPM",
    metrics: ["roe", "deposits"],
    excluded: ["BAC"],
    view: "map",
    metric: "deposits",
    x: "loanDeposits",
    y: "roe",
    mode: "indexed",
    years: 10,
    sort: "roe",
    descending: false,
  });
  const path = comparePath(["JPM", "BAC"], settings);
  assert.deepEqual(readCompareUrl(path.split("?")[1]), settings);
  assert.equal(normalizeCompareSettings({ asOf: "2026-02-30" }).asOf, "");
});
test("unreadable or full browser storage does not silently destroy prior research", () => {
  assert.throws(() =>
    writeCompareNotebook(
      { getItem: () => "{bad", setItem: () => assert.fail() },
      (n) => n,
    ),
  );
  assert.throws(() =>
    writeCompareNotebook(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
      (n) => n,
    ),
  );
});
test("research exports retain exact dates, settings, inputs, and safely escape annotations", () => {
  const point = buildCompareCompany(company(balanceFacts())).metrics.roe[0];
  const notebook = {
    collectionName: "<script>bad</script>",
    notes: "=SUM(1,2)",
    pins: [
      {
        ticker: "TEST",
        cik: "1",
        name: "Test",
        label: "Return on average equity",
        point,
        format: "percent",
        settings: DEFAULT_COMPARE_SETTINGS,
        notes: "<img src=x>",
        tags: "capital",
        savedAt: "2026-09-06",
      },
    ],
  };
  const html = exportCompareBrief(notebook),
    csv = exportCompareCsv(notebook.pins, notebook);
  assert.ok(!html.includes("<script>bad"));
  assert.match(html, /&lt;img/);
  assert.match(html, /average beginning and ending equity/);
  assert.match(csv, /0000000001-26-000001/);
  assert.match(csv, /2024-12-31/);
  assert.match(csv, /'\=SUM/);
  assert.match(csv, /source_filed/);
});

test("a period missing for the entire peer set remains a chart gap", () => {
  const a = entry("A", 30);
  a.data.metrics.netIncome.push({ value: 10, period: period("2023-12-31") });
  const result = trendSeries([a], "netIncome");
  assert.equal(result.rows.find((r) => r.bucket === "2024").A, null);
});
test("indexed charts reject a shared calendar bucket with incompatible actual dates", () => {
  const a = entry("A", 30),
    b = entry("B", 40, period("2025-06-30"));
  assert.equal(
    trendSeries([a, b], "netIncome", { mode: "indexed" }).sharedBase,
    undefined,
  );
});
