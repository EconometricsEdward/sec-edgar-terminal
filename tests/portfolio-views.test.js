import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PORTFOLIO_VIEW,
  PORTFOLIO_VIEWS_KEY,
  PORTFOLIO_VIEWS_BYTES,
  readPortfolioViews,
  rowMatchesPortfolioView,
  validatePortfolioView,
  writePortfolioView,
} from "../src/utils/portfolioViews.js";

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
  assert.equal(rowMatchesPortfolioView(row(), undefined, "cash-flow"), true);
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
