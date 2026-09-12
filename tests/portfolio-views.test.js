import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  availablePortfolioViewPresets,
  DEFAULT_PORTFOLIO_VIEW,
  PORTFOLIO_VIEW_PRESETS,
  PORTFOLIO_VIEWS_KEY,
  PORTFOLIO_VIEWS_BYTES,
  readPortfolioViews,
  rowMatchesPortfolioView,
  validatePortfolioView,
  writePortfolioView,
} from "../src/utils/portfolioViews.js";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";
import { portfolioMetricDefinitionFor } from "../src/utils/portfolioMetricCatalog.js";
import { portfolioMetricState } from "../src/utils/portfolioDeepResearch.js";

const now = "2026-09-08T10:00:00.000Z";
const value = (patch = {}) => ({
  ...DEFAULT_PORTFOLIO_VIEW,
  columns: [...DEFAULT_PORTFOLIO_VIEW.columns],
  ...patch,
});
const row = (patch = {}) => ({
  id: "row-a",
  excluded: false,
  resolution: { status: "resolved", kind: "company" },
  ...patch,
});
const company = (patch = {}) => ({
  status: "ready",
  lens: "corporate",
  kind: "company",
  cache: { status: "fresh" },
  metrics: { netIncome: { value: 0, classification: "reported" } },
  ...patch,
});
function storage(initial = null) {
  const data = new Map(
    initial === null ? [] : [[PORTFOLIO_VIEWS_KEY, initial]],
  );
  return {
    data,
    writes: 0,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      this.writes += 1;
      data.set(key, value);
    },
  };
}

test("saved screens round-trip user search, filters, ordered columns and sort independently of built-ins", () => {
  const local = storage();
  const settings = value({
    query: "Apple <research>",
    industryFilter: "ELECTRONIC COMPUTERS",
    filter: "partial",
    sort: "freeCashFlow",
    direction: "desc",
    columns: ["freeCashFlow", "netIncome"],
    preset: "cash-flow",
  });
  const saved = writePortfolioView(local, {
    mode: "save",
    name: " Cash and evidence ",
    value: settings,
    now,
  });
  assert.equal(saved.views[0].name, "Cash and evidence");
  assert.deepEqual(saved.views[0].value, settings);
  assert.deepEqual(
    readPortfolioViews(local.getItem(PORTFOLIO_VIEWS_KEY)),
    saved,
  );
  settings.columns.push("debt");
  assert.equal(saved.views[0].value.columns.length, 2);
});

test("fresh writes preserve views created in other tabs and current preferences stay portfolio-specific", () => {
  const local = storage();
  const first = writePortfolioView(local, {
    mode: "save",
    name: "Tab A",
    value: value(),
    now,
  });
  writePortfolioView(local, {
    mode: "save",
    name: "Tab B",
    value: value({ preset: "banking" }),
    now,
  });
  writePortfolioView(local, {
    mode: "current",
    portfolioId: "portfolio-a",
    value: value({ query: "AAPL" }),
    now,
  });
  writePortfolioView(local, {
    mode: "current",
    portfolioId: "portfolio-b",
    value: value({ query: "JPM" }),
    now,
  });
  const latest = writePortfolioView(local, {
    mode: "save",
    id: first.views[0].id,
    name: "Updated A",
    value: value({ sort: "cash" }),
    now,
  });
  assert.deepEqual(
    latest.views.map((entry) => entry.name),
    ["Updated A", "Tab B"],
  );
  assert.deepEqual(
    latest.current.map((entry) => entry.value.query),
    ["AAPL", "JPM"],
  );
  writePortfolioView(local, { mode: "delete", id: first.views[0].id, now });
  const before = local.getItem(PORTFOLIO_VIEWS_KEY);
  assert.throws(
    () =>
      writePortfolioView(local, {
        mode: "save",
        id: first.views[0].id,
        name: "Stale update",
        value: value(),
        now,
      }),
    /removed in another tab/,
  );
  assert.equal(local.getItem(PORTFOLIO_VIEWS_KEY), before);
});

test("corrupt, oversized and prototype-bearing stores never get overwritten", () => {
  for (const raw of [
    "{invalid",
    "x".repeat(PORTFOLIO_VIEWS_BYTES + 1),
    '{"version":1,"views":[],"current":[],"__proto__":{"polluted":true}}',
  ]) {
    const local = storage(raw);
    assert.throws(() =>
      writePortfolioView(local, {
        mode: "current",
        portfolioId: "portfolio-a",
        value: value(),
        now,
      }),
    );
    assert.equal(local.writes, 0);
    assert.equal(local.getItem(PORTFOLIO_VIEWS_KEY), raw);
  }
  assert.equal({}.polluted, undefined);
});

test("only supported settings and columns can enter a saved view", () => {
  for (const invalid of [
    value({ columns: ["priceTarget"] }),
    value({ columns: ["cash", "cash"] }),
    value({ columns: ["constructor"] }),
    value({ sort: "secret" }),
    value({ preset: "forecast" }),
    value({ filter: "<script>" }),
    value({ query: "x".repeat(301) }),
    value({ href: "javascript:alert(1)" }),
    JSON.parse(
      '{"query":"","filter":"all","industryFilter":"","sort":"name","direction":"asc","columns":[],"preset":"overview","__proto__":{}}',
    ),
  ])
    assert.throws(() => validatePortfolioView(invalid));
  assert.deepEqual(validatePortfolioView(value({ columns: [] })).columns, []);
});

test("view limits bound growth and old per-portfolio preferences expire without removing saved screens", () => {
  const local = storage();
  for (let i = 0; i < 20; i += 1)
    writePortfolioView(local, {
      mode: "save",
      name: `View ${i}`,
      value: value(),
      now,
    });
  const before = local.getItem(PORTFOLIO_VIEWS_KEY);
  assert.throws(
    () =>
      writePortfolioView(local, {
        mode: "save",
        name: "Too many",
        value: value(),
        now,
      }),
    /up to 20/,
  );
  assert.equal(local.getItem(PORTFOLIO_VIEWS_KEY), before);
  for (let i = 0; i < 21; i += 1)
    writePortfolioView(local, {
      mode: "current",
      portfolioId: `portfolio-${i}`,
      value: value({ query: `${i}` }),
      now,
    });
  const saved = readPortfolioViews(local.getItem(PORTFOLIO_VIEWS_KEY));
  assert.equal(saved.views.length, 20);
  assert.equal(saved.current.length, 20);
  assert.equal(saved.current[0].portfolioId, "portfolio-1");
  assert.equal(saved.current.at(-1).portfolioId, "portfolio-20");
});

test("cash-flow and banking views use business-model classification, not issuer names or ticker guesses", () => {
  assert.equal(rowMatchesPortfolioView(row(), company(), "cash-flow"), true);
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({ lens: "banking", ticker: "AAPL" }),
      "cash-flow",
    ),
    false,
  );
  assert.equal(
    rowMatchesPortfolioView(row(), company({ lens: "insurance" }), "cash-flow"),
    false,
  );
  assert.equal(
    rowMatchesPortfolioView(row(), company({ lens: "common" }), "cash-flow"),
    false,
  );
  assert.equal(rowMatchesPortfolioView(row(), undefined, "cash-flow"), false);
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({ lens: "banking", ticker: "AAPL" }),
      "banking",
    ),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({ lens: "corporate", ticker: "JPM" }),
      "banking",
    ),
    false,
  );
  assert.equal(rowMatchesPortfolioView(row(), undefined, "banking"), false);
  assert.equal(
    rowMatchesPortfolioView(
      row({ resolution: { status: "unsupported", kind: "fund" } }),
      company({ lens: "banking", kind: "fund" }),
      "banking",
    ),
    false,
  );
});

const datedMetric = (value, unit = "USD", patch = {}) => ({
  value,
  unit,
  classification: "reported",
  period: { kind: "annual", start: "2025-01-01", end: "2025-12-31" },
  ...patch,
});
const identifiedRow = (cik, patch = {}) =>
  row({
    id: `row-${cik}`,
    resolution: { status: "resolved", kind: "company", cik },
    ...patch,
  });

test("research lenses separate business models and do not classify funds or unknown companies by name", () => {
  const corporate = company({
    cik: "0000000001",
    metrics: {
      revenueGrowth: datedMetric(-5, "%"),
      netMargin: datedMetric(0, "%"),
      operatingCashFlow: datedMetric(30),
      currentRatio: datedMetric(1.4, "x"),
      debtAssets: datedMetric(15, "%"),
      dividendsPaid: datedMetric(0),
      cashConversion: datedMetric(80, "%"),
    },
  });
  const bank = company({
    cik: "0000000002",
    lens: "banking",
    metrics: {
      netInterestIncome: datedMetric(20),
      netMargin: datedMetric(5, "%"),
      currentRatio: datedMetric(2, "x"),
    },
  });
  const insurer = company({
    cik: "0000000003",
    lens: "insurance",
    metrics: {
      premiumsEarned: datedMetric(10),
      debtAssets: datedMetric(5, "%"),
    },
  });
  const unknown = company({
    cik: "0000000004",
    lens: "unknown",
    name: "Bank Insurance Corp",
  });
  const fund = company({
    cik: "0000000005",
    kind: "fund",
    lens: "banking",
    metrics: {
      deposits: datedMetric(999),
    },
  });
  const companies = [corporate, bank, insurer, unknown, fund];
  const rows = companies.map((item) => identifiedRow(item.cik));
  const presets = availablePortfolioViewPresets(rows, companies);
  assert.deepEqual(presets.find((view) => view.id === "banking").columns, [
    "netInterestIncome",
  ]);
  assert.equal(presets.find((view) => view.id === "banking").rowCount, 1);
  assert.equal(presets.find((view) => view.id === "insurance").rowCount, 1);
  assert.equal(presets.find((view) => view.id === "leverage").rowCount, 2);
  for (const id of [
    "profitability",
    "growth",
    "cash-flow",
    "liquidity",
    "efficiency",
  ])
    assert.equal(presets.find((view) => view.id === id).rowCount, 1, id);
  assert.equal(presets.find((view) => view.id === "overview").rowCount, 5);
  assert.equal(rowMatchesPortfolioView(rows[3], unknown, "cash-flow"), false);
  assert.equal(rowMatchesPortfolioView(rows[4], fund, "banking"), false);
});

test("lens choices keep valid zero and negative values while rejecting unavailable, wrong-unit and undated measures", () => {
  const captured = company({
    cik: "0000000001",
    metrics: {
      netMargin: datedMetric(-10, "%"),
      operatingMargin: datedMetric(0, "%"),
      grossMargin: datedMetric(12, "%", { classification: "unavailable" }),
      roe: datedMetric(1, "USD"),
      roa: datedMetric(4, "%", { period: undefined }),
      netIncome: datedMetric(8, "USD", { classification: "not_applicable" }),
      dividendsPaid: datedMetric(0),
    },
  });
  const presets = availablePortfolioViewPresets(
    [identifiedRow("1")],
    [captured],
  );
  const profitability = presets.find((view) => view.id === "profitability");
  assert.deepEqual(profitability.columns, ["netMargin", "operatingMargin"]);
  assert.equal(profitability.sort, "netMargin");
  assert.equal(profitability.direction, "desc");
  assert.deepEqual(
    presets.find((view) => view.id === "capital-returns").columns,
    ["dividendsPaid"],
  );
  assert.equal(
    presets.find((view) => view.id === "capital-returns").sort,
    "dividendsPaid",
  );
  assert.equal(
    presets.some((view) => view.id === "growth"),
    false,
  );
  assert.equal(
    presets.some((view) => view.id === "banking"),
    false,
  );
  assert.equal(
    presets.some((view) => view.id === "insurance"),
    false,
  );
});

test("growth and shareholder payout lenses need their defining evidence rather than unrelated supporting numbers", () => {
  const captured = company({
    cik: "1",
    metrics: {
      revenue: datedMetric(100),
      netIncome: datedMetric(20),
      operatingCashFlow: datedMetric(30),
      dividendsPaid: datedMetric(0, "USD", { classification: "unavailable" }),
    },
  });
  const presets = availablePortfolioViewPresets(
    [identifiedRow("0000000001")],
    [captured],
  );
  assert.ok(presets.some((view) => view.id === "overview"));
  assert.ok(presets.some((view) => view.id === "cash-flow"));
  assert.equal(
    presets.some((view) => view.id === "growth"),
    false,
  );
  assert.equal(
    presets.some((view) => view.id === "capital-returns"),
    false,
  );
});

test("review-only portfolios still offer coverage while excluded rows cannot make financial lenses available", () => {
  const captured = company({
    cik: "0000000001",
    metrics: { operatingCashFlow: datedMetric(10) },
  });
  const rows = [identifiedRow("1", { excluded: true }), identifiedRow("2")];
  const presets = availablePortfolioViewPresets(rows, [captured]);
  assert.deepEqual(
    presets.map((view) => view.id),
    ["overview", "coverage"],
  );
  assert.deepEqual(presets[0].columns, []);
  assert.equal(presets[0].rowCount, 2);
  assert.equal(presets[1].rowCount, 1);
  assert.equal(presets[0].sort, "name");
  assert.deepEqual(availablePortfolioViewPresets([], []), []);
  const removed = availablePortfolioViewPresets(
    [identifiedRow("1", { duplicateChoice: "remove" })],
    [captured],
  );
  assert.deepEqual(
    removed.map((view) => view.id),
    ["overview"],
  );
  assert.deepEqual(removed[0].columns, []);
});

test("overview keeps fund-only and unidentified portfolios reachable without offering missing financial columns", () => {
  const fixtures = [
    { rows: [identifiedRow("1")], companies: [] },
    {
      rows: [row({ resolution: { status: "review", kind: "unknown" } })],
      companies: [],
    },
    { rows: [identifiedRow("1", { excluded: true })], companies: [] },
    {
      rows: [
        row({ resolution: { status: "unsupported", kind: "fund", cik: "1" } }),
      ],
      companies: [
        company({
          cik: "1",
          kind: "fund",
          lens: "banking",
          metrics: { deposits: datedMetric(100) },
        }),
      ],
    },
    {
      rows: [identifiedRow("1")],
      companies: [company({ cik: "1", lens: undefined })],
    },
  ];
  for (const fixture of fixtures) {
    const presets = availablePortfolioViewPresets(
      fixture.rows,
      fixture.companies,
    );
    const overview = presets.find((view) => view.id === "overview");
    assert.ok(overview);
    assert.deepEqual(overview.columns, []);
    assert.equal(overview.rowCount, 1);
    assert.equal(overview.sort, "name");
    assert.ok(
      presets.every((view) => ["overview", "coverage"].includes(view.id)),
    );
  }
});

test("the captured demo supports all eleven lenses with only traceable available columns", () => {
  const demo = JSON.parse(
    readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const companies = unpackPortfolioSnapshot(demo.snapshot).companies;
  const presets = availablePortfolioViewPresets(demo.rows, companies);
  assert.equal(presets.length, 11);
  for (const preset of presets) {
    assert.ok(preset.rowCount > 0, preset.name);
    for (const key of preset.columns) {
      const definition = portfolioMetricDefinitionFor(key);
      assert.ok(
        companies.some(
          (captured) =>
            demo.rows.some(
              (item) =>
                item.resolution?.cik === captured.cik &&
                rowMatchesPortfolioView(item, captured, preset.id),
            ) && portfolioMetricState(captured, definition) === "available",
        ),
        `${preset.name}: ${key}`,
      );
    }
  }
  assert.equal(
    PORTFOLIO_VIEW_PRESETS.find((view) => view.id === "cash-flow").columns
      .length,
    6,
  );
});

test("coverage lens distinguishes missing or not-applicable data from a reported zero", () => {
  assert.equal(rowMatchesPortfolioView(row(), company(), "coverage"), false);
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({
        metrics: { netIncome: { value: null, classification: "unavailable" } },
      }),
      "coverage",
    ),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({
        metrics: {
          freeCashFlow: { value: null, classification: "not_applicable" },
        },
      }),
      "coverage",
    ),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(row(), company({ status: "partial" }), "coverage"),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({ refreshStatus: "not_checked" }),
      "coverage",
    ),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(
      row(),
      company({ cache: { status: "stale" } }),
      "coverage",
    ),
    true,
  );
  assert.equal(rowMatchesPortfolioView(row(), undefined, "coverage"), true);
  assert.equal(
    rowMatchesPortfolioView(
      row({ resolution: { status: "review", kind: "unknown" } }),
      company(),
      "coverage",
    ),
    true,
  );
  assert.equal(
    rowMatchesPortfolioView(row({ excluded: true }), undefined, "coverage"),
    false,
  );
  assert.equal(
    rowMatchesPortfolioView(
      row({ duplicateChoice: "remove" }),
      undefined,
      "cash-flow",
    ),
    false,
  );
  assert.equal(
    rowMatchesPortfolioView(row({ excluded: true }), undefined, "overview"),
    true,
  );
  assert.equal(rowMatchesPortfolioView(row(), company(), "unknown"), false);
});

test("quota failures preserve the last saved store and explain the failure", () => {
  const local = storage();
  writePortfolioView(local, {
    mode: "save",
    name: "Kept",
    value: value(),
    now,
  });
  const before = local.getItem(PORTFOLIO_VIEWS_KEY);
  local.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.throws(
    () =>
      writePortfolioView(local, {
        mode: "current",
        portfolioId: "portfolio-a",
        value: value(),
        now,
      }),
    /could not save/,
  );
  assert.equal(local.getItem(PORTFOLIO_VIEWS_KEY), before);
});
