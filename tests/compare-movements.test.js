import test from "node:test";
import assert from "node:assert/strict";
import {
  movementBaseline,
  movementBuckets,
  movementCell,
  movementComparison,
} from "../src/utils/compareMovements.js";

const period = (
  year,
  start = `${year}-01-01`,
  end = `${year}-12-31`,
  kind = "annual",
) => ({ start, end, kind });
const point = (value, p, tag = "Revenues") => ({
  value,
  period: p,
  classification: "reported",
  sources: [
    { taxonomy: "us-gaap", tag, unit: "USD", start: p.start, end: p.end },
  ],
});
const entry = (
  ticker,
  values,
  periods = [period(2025), period(2024)],
  key = "revenue",
) => ({
  ticker,
  index: 0,
  period: periods[0],
  data: {
    cik: ticker,
    periods,
    lens: "corporate",
    metrics: { [key]: values.map((value, i) => point(value, periods[i])) },
  },
});
const settings = { basis: "annual", movementFrom: "previous", excluded: [] };

test("movements use the previous reporting year and preserve both evidence inputs", () => {
  const company = entry("A", [120, 100]);
  const result = movementCell(company, "revenue", settings);
  assert.equal(result.absolute, 20);
  assert.equal(result.rate, 20);
  assert.equal(result.current, company.data.metrics.revenue[0]);
  assert.equal(result.prior, company.data.metrics.revenue[1]);
});

test("standalone quarters default to preceding quarter, cumulative periods to preceding year", () => {
  const quarters = [
    period(2025, "2025-04-01", "2025-06-30", "quarter"),
    period(2025, "2025-01-01", "2025-03-31", "quarter"),
    period(2024, "2024-04-01", "2024-06-30", "quarter"),
  ];
  const quarterly = entry("Q", [120, 100, 80], quarters);
  assert.equal(
    movementBaseline(quarterly, { ...settings, basis: "quarter" }).index,
    1,
  );
  assert.equal(
    movementCell(quarterly, "revenue", { ...settings, basis: "quarter" }).rate,
    20,
  );
  const ytd = entry(
    "Y",
    [120, 30, 100],
    quarters.map((p) => ({
      ...p,
      kind: "ytd",
      start: `${p.end.slice(0, 4)}-01-01`,
    })),
  );
  assert.equal(movementBaseline(ytd, { ...settings, basis: "ytd" }).index, 2);
  assert.equal(
    movementCell(ytd, "revenue", { ...settings, basis: "ytd" }).rate,
    20,
  );
});

test("an explicit YTD quarter with a shorter duration never becomes growth", () => {
  const periods = [
    period(2025, "2025-01-01", "2025-06-30", "ytd"),
    period(2025, "2025-01-01", "2025-03-31", "ytd"),
  ];
  const result = movementCell(entry("Y", [120, 50], periods), "revenue", {
    ...settings,
    basis: "ytd",
    movementFrom: "2025-Q1",
  });
  assert.equal(result.absolute, null);
  assert.match(result.reason, /durations/);
});

test("baseline selection excludes future/current observations even for explicit buckets", () => {
  const company = entry(
    "A",
    [150, 120, 100],
    [period(2026), period(2025), period(2024)],
  );
  company.index = 1;
  company.period = company.data.periods[1];
  assert.deepEqual(movementBuckets([company]), ["2024"]);
  assert.equal(
    movementCell(company, "revenue", { ...settings, movementFrom: "2026" })
      .absolute,
    null,
  );
  assert.equal(movementCell(company, "revenue", settings).absolute, 20);
});

test("a gap in the immediately comparable year is not bridged silently", () => {
  const company = entry("A", [120, 80], [period(2025), period(2023)]);
  assert.equal(movementCell(company, "revenue", settings).absolute, null);
  assert.equal(
    movementCell(company, "revenue", { ...settings, movementFrom: "2023" })
      .rate,
    50,
  );
});

test("zero and negative monetary bases retain absolute changes and suppress percentage growth", () => {
  for (const base of [0, -20]) {
    const result = movementCell(entry("A", [10, base]), "revenue", settings);
    assert.equal(result.absolute, 10 - base);
    assert.equal(result.rate, null);
    assert.match(result.rateReason, /zero or negative/);
  }
});

test("percentage and ratio metrics use differences rather than growth rates", () => {
  const company = entry("A", [6, 4], [period(2025), period(2024)], "netMargin");
  const result = movementCell(company, "netMargin", settings);
  assert.equal(result.absolute, 2);
  assert.equal(result.rate, null);
  assert.equal(result.rateReason, null);
});

test("changed concepts and inputs outside a selected cutoff cannot enter movement calculations", () => {
  const company = entry("A", [120, 100]);
  company.data.metrics.revenue[1].sources[0].tag = "SalesRevenueNet";
  assert.match(
    movementCell(company, "revenue", settings).reason,
    /concepts differ/,
  );
  company.data.metrics.revenue[1].sources[0].tag = "Revenues";
  company.period.asOf = "2026-02-01";
  company.data.metrics.revenue[0].sources[0].filed = "2026-03-01";
  assert.match(movementCell(company, "revenue", settings).reason, /cutoff/);
});

test("peer medians share a paired sample and median changes are not differences of medians", () => {
  const entries = [
    entry("A", [100, 1]),
    entry("B", [11, 10]),
    entry("C", [20, 100]),
    entry("MISSING", [10000, null]),
  ];
  const result = movementComparison(entries, "revenue", settings);
  assert.deepEqual(result.members, ["A", "B", "C"]);
  assert.equal(result.pairedCount, 3);
  assert.equal(result.total, 4);
  assert.equal(result.priorMedian, 10);
  assert.equal(result.currentMedian, 20);
  assert.equal(result.medianChange, 1);
  assert.notEqual(
    result.medianChange,
    result.currentMedian - result.priorMedian,
  );
});

test("peer summaries are withheld for incompatible reporting endpoints", () => {
  const result = movementComparison(
    [
      entry("A", [120, 100]),
      entry(
        "B",
        [120, 100],
        [
          period(2025, "2025-03-01", "2026-02-28"),
          period(2024, "2024-03-01", "2025-02-28"),
        ],
      ),
    ],
    "revenue",
    settings,
  );
  assert.equal(result.pairedCount, 2);
  assert.equal(result.medianChange, null);
  assert.match(result.reason, /45 days/);
});

test("paired sample is deduplicated by issuer and respects exclusions", () => {
  const a = entry("A", [120, 100]);
  const alias = { ...a, ticker: "ALIAS" };
  const result = movementComparison(
    [a, alias, entry("B", [20, 10]), entry("C", [50, 20])],
    "revenue",
    { ...settings, excluded: ["C"] },
  );
  assert.deepEqual(result.members, ["A", "B"]);
  assert.equal(result.total, 2);
});

test("percentage median never quietly changes the paired sample when a base is negative", () => {
  const result = movementComparison(
    [entry("A", [10, -10]), entry("B", [20, 10])],
    "revenue",
    settings,
  );
  assert.equal(result.medianChange, 15);
  assert.equal(result.medianRate, null);
  assert.match(result.rateReason, /paired sample/);
});
