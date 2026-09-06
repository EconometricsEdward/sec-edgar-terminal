import test from "node:test";
import assert from "node:assert/strict";
import { analysisChange } from "../src/utils/analysisResearch.js";
import {
  growthCompatibility,
  growthPair,
  endpointCagr,
  growthHistory,
  fiscalSeasonality,
  profitChangeBridge,
} from "../src/utils/analysisGrowth.js";

const period = (year, extra = {}) => ({
  fy: year,
  fp: "FY",
  kind: "annual",
  start: year + "-01-01",
  end: year + "-12-31",
  ...extra,
});
const point = (value, p, tag = "Revenues", extra = {}) => ({
  value,
  period: p,
  classification: Number.isFinite(value) ? "reported" : "unavailable",
  sources: Number.isFinite(value)
    ? [
        {
          value,
          taxonomy: "us-gaap",
          tag,
          unit: "USD",
          start: p.start,
          end: p.end,
          accession: "0000000001-" + String(p.fy + 1).slice(2) + "-000001",
        },
      ]
    : [],
  ...extra,
});
function fixture(
  years = [2025, 2024, 2023, 2022],
  revenues = [133.1, 121, 110, 100],
  profits = [18, 10, 8, 5],
) {
  const periods = years.map((year) => period(year));
  return {
    ticker: "TEST",
    lens: "corporate",
    basis: "annual",
    revenueKey: "revenue",
    periods,
    definitions: [
      {
        key: "revenue",
        label: "Revenue",
        format: "currency",
        category: "income",
      },
      {
        key: "netIncome",
        label: "Net income",
        format: "currency",
        category: "income",
      },
    ],
    metrics: {
      revenue: periods.map((p, i) => point(revenues[i] ?? null, p)),
      netIncome: periods.map((p, i) =>
        point(profits[i] ?? null, p, "NetIncomeLoss"),
      ),
    },
  };
}

test("growth pairs use the same fiscal season and preserve both source observations", () => {
  const data = fixture();
  const pair = growthPair(data, "revenue", 0);
  assert.equal(pair.beforeIndex, 1);
  assert.ok(Math.abs(pair.point.value - 10) < 1e-10);
  assert.equal(pair.point.sources.length, 2);
  assert.deepEqual(
    pair.point.sources.map((source) => source.end),
    ["2025-12-31", "2024-12-31"],
  );
  data.periods[1] = { ...data.periods[1], fp: "Q4" };
  assert.equal(growthPair(data, "revenue", 0).beforeIndex, -1);
});

test("growth retains explicit zero and rejects percentage growth from negative or zero bases", () => {
  const zeroCurrent = fixture([2025, 2024], [0, 10]);
  assert.equal(growthPair(zeroCurrent, "revenue", 0).point.value, -100);
  for (const previous of [0, -10]) {
    const data = fixture([2025, 2024], [10, previous]);
    const pair = growthPair(data, "revenue", 0);
    assert.equal(pair.point.value, null);
    assert.equal(pair.change.delta, 10 - previous);
    assert.match(pair.point.reason, /zero or negative/);
  }
});

test("CAGR uses elapsed time and complete same-season coverage with all evidence", () => {
  const data = fixture();
  const result = endpointCagr(data, "revenue", 0, 3);
  const elapsed =
    (Date.parse("2025-12-31") - Date.parse("2022-12-31")) / 86400000 / 365.25;
  assert.equal(result.elapsedYears, elapsed);
  assert.ok(
    Math.abs(result.point.value - (Math.pow(1.331, 1 / elapsed) - 1) * 100) <
      1e-10,
  );
  assert.equal(result.count, 4);
  assert.equal(result.expected, 4);
  assert.equal(result.point.sources.length, 4);
  assert.match(result.point.note, /not a steady path/);
});

test("CAGR never skips a missing observation, missing year, or nonpositive endpoint", () => {
  const missingValue = fixture(
    [2025, 2024, 2023, 2022],
    [133.1, null, 110, 100],
  );
  const absent = endpointCagr(missingValue, "revenue", 0, 3);
  assert.equal(absent.point.value, null);
  assert.equal(absent.count, 3);
  assert.match(absent.point.reason, /not skipped/);
  const missingYear = fixture([2025, 2023, 2022], [133.1, 110, 100]);
  assert.match(
    endpointCagr(missingYear, "revenue", 0, 3).point.reason,
    /does not skip/,
  );
  const zeroEnd = fixture([2025, 2024, 2023, 2022], [0, 121, 110, 100]);
  assert.match(
    endpointCagr(zeroEnd, "revenue", 0, 3).point.reason,
    /positive beginning and ending/,
  );
});

test("actual reported flow durations override a misleading inferred annual window", () => {
  const a = point(120, period(2025));
  a.sources[0].start = "2025-03-01";
  const b = point(100, period(2024));
  assert.equal(growthCompatibility(a, b).delta, null);
  assert.match(
    growthCompatibility(a, b).reason,
    /actual reported flow durations/,
  );
  assert.deepEqual(analysisChange(a, b, "currency"), growthCompatibility(a, b));
});

test("derived quarters retain cumulative inputs without rejecting the valid quarter duration", () => {
  const q1 = period(2025, {
    fp: "Q2",
    kind: "quarter",
    start: "2025-04-01",
    end: "2025-06-30",
  });
  const q0 = period(2024, {
    fp: "Q2",
    kind: "quarter",
    start: "2024-04-01",
    end: "2024-06-30",
  });
  const a = point(20, q1, "Revenues", { classification: "calculated" });
  a.sources[0].start = "2025-01-01";
  a.sources.push({ ...a.sources[0], value: 10, end: "2025-03-31" });
  const b = point(10, q0);
  assert.equal(growthCompatibility(a, b).percent, 100);
});

test("growth coverage separates observations, comparable pairs, and percentage availability", () => {
  const data = fixture([2025, 2024, 2023, 2022], [120, 0, 100, null]);
  const history = growthHistory(data, "revenue", 0);
  assert.equal(history.total, 4);
  assert.equal(history.observed, 3);
  assert.equal(history.comparable, 2);
  assert.equal(history.growthAvailable, 1);
});

test("fiscal matrix uses issuer quarters and preserves missing slots and reported zero", () => {
  const data = fixture([2025, 2025, 2025], [40, 0, 10]);
  data.basis = "quarter";
  data.periods = [
    period(2025, {
      fp: "Q4",
      kind: "quarter",
      start: "2025-07-01",
      end: "2025-09-30",
    }),
    period(2025, {
      fp: "Q2",
      kind: "quarter",
      start: "2025-01-01",
      end: "2025-03-31",
    }),
    period(2025, {
      fp: "Q1",
      kind: "quarter",
      start: "2024-10-01",
      end: "2024-12-31",
    }),
  ];
  data.metrics.revenue = data.periods.map((p, i) => point([40, 0, 10][i], p));
  const matrix = fiscalSeasonality(data, "revenue", 0);
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].available, 3);
  assert.equal(matrix.rows[0].cells[2], null);
  assert.equal(matrix.rows[0].cells[1].point.value, 0);
  assert.equal(matrix.rows[0].cells[0].period.end, "2024-12-31");
  assert.equal(
    fiscalSeasonality({ ...data, basis: "ytd" }, "revenue", 0).rows.length,
    0,
  );
  assert.match(
    fiscalSeasonality({ ...data, basis: "ttm" }, "revenue", 0).reason,
    /overlapping TTM/,
  );
});

test("fiscal matrix marks duplicate fiscal quarter labels instead of hiding their ambiguity", () => {
  const data = fixture([2025, 2025], [40, 35]);
  data.basis = "quarter";
  data.periods = [
    period(2025, { fp: "Q4", kind: "quarter", end: "2025-12-31" }),
    period(2025, { fp: "Q4", kind: "quarter", end: "2025-09-30" }),
  ];
  assert.equal(
    fiscalSeasonality(data, "revenue", 0).rows[0].cells[3].duplicate,
    true,
  );
});

test("midpoint profit contributions sum exactly to the change and retain all four inputs", () => {
  const data = fixture([2025, 2024], [120, 100], [18, 10]);
  const bridge = profitChangeBridge(data, 0);
  assert.equal(bridge.reason, null);
  assert.equal(bridge.components[0].point.value, 2.5);
  assert.ok(Math.abs(bridge.components[1].point.value - 5.5) < 1e-10);
  assert.equal(bridge.change.value, 8);
  assert.ok(Math.abs(bridge.residual) < 1e-10);
  for (const item of bridge.components)
    assert.equal(item.point.sources.length, 4);
  const reversed = profitChangeBridge(
    fixture([2025, 2024], [100, 120], [10, 18]),
    0,
  );
  assert.equal(
    reversed.components[0].point.value,
    -bridge.components[0].point.value,
  );
  assert.equal(
    reversed.components[1].point.value,
    -bridge.components[1].point.value,
  );
});

test("profit attribution works through a loss without inventing percentage growth", () => {
  const bridge = profitChangeBridge(
    fixture([2025, 2024], [120, 100], [5, -10]),
    0,
  );
  assert.equal(bridge.reason, null);
  assert.equal(bridge.change.value, 15);
  assert.ok(Math.abs(bridge.residual) < 1e-10);
});

test("profit bridge refuses missing inputs, incompatible durations, and nonpositive revenue", () => {
  assert.match(
    profitChangeBridge(fixture([2025, 2024], [120, null]), 0).reason,
    /Missing inputs/,
  );
  assert.match(
    profitChangeBridge(fixture([2025, 2024], [120, 0]), 0).reason,
    /positive/,
  );
  const data = fixture([2025, 2024], [120, 100], [18, 10]);
  data.metrics.netIncome[0].sources[0].start = "2025-03-01";
  assert.match(profitChangeBridge(data, 0).reason, /flow durations/);
});

test("bank bridge uses the defined net-interest-plus-noninterest revenue and insurance stays unavailable", () => {
  const data = fixture([2025, 2024], [120, 100], [18, 10]);
  data.lens = "banking";
  data.revenueKey = "bankRevenue";
  data.metrics.bankRevenue = data.metrics.revenue;
  assert.equal(profitChangeBridge(data, 0).revenueKey, "bankRevenue");
  data.lens = "insurance";
  data.revenueKey = null;
  assert.match(profitChangeBridge(data, 0).reason, /total-revenue denominator/);
});

test("YTD comparison never substitutes a shorter sequential period", () => {
  const data = fixture([2025, 2025], [120, 60], [18, 10]);
  data.basis = "ytd";
  data.periods = [
    period(2025, { kind: "ytd", fp: "Q2", end: "2025-06-30" }),
    period(2025, { kind: "ytd", fp: "Q1", end: "2025-03-31" }),
  ];
  for (const key of ["revenue", "netIncome"])
    data.metrics[key] = data.metrics[key].map((p, i) => ({
      ...p,
      period: data.periods[i],
    }));
  assert.match(
    profitChangeBridge(data, 0, "netIncome", "previous").reason,
    /compatible comparison/,
  );
});
