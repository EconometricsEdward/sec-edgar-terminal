import test from "node:test";
import assert from "node:assert/strict";
import {
  comparePointQuality,
  comparePairQuality,
} from "../src/utils/compareQuality.js";
import {
  buildCompareCompany,
  companyLens,
  inferLens,
  metricComparison,
  historicGrowth,
  trendSeries,
  MAX_COMPARE_COMPANIES,
  COMPARE_VERSION,
} from "../src/utils/compareResearch.js";

const period = (
  end = "2025-12-31",
  start = `${end.slice(0, 4)}-01-01`,
  kind = "annual",
) => ({ start, end, kind, fp: kind === "annual" ? "FY" : "Q2" });
const source = (
  start = "2025-01-01",
  end = "2025-12-31",
  tag = "NetIncomeLoss",
  extra = {},
) => ({
  taxonomy: "us-gaap",
  tag,
  unit: "USD",
  start,
  end,
  filed: "2026-02-01",
  accession: "0000000001-26-000001",
  value: 10,
  ...extra,
});
const point = (
  value = 10,
  p = period(),
  sources = [source(p.start, p.end)],
  extra = {},
) => ({ value, period: p, sources, classification: "reported", ...extra });
const entry = (ticker, observation) => ({
  ticker,
  index: 0,
  period: observation.period,
  data: {
    ticker,
    cik: ticker,
    periods: [observation.period],
    metrics: { netIncome: [observation] },
  },
});

test("quality checks actual source durations and retains excluded raw values", () => {
  const p = period();
  const bad = point(100, p, [source("2025-03-01")]);
  assert.equal(comparePointQuality(bad, "netIncome").valid, false);
  const comparison = metricComparison(
    [entry("A", point(10)), entry("B", point(20)), entry("C", bad)],
    "netIncome",
  );
  assert.equal(comparison.peerMedian, 15);
  assert.equal(comparison.count, 3);
  assert.equal(comparison.eligibleCount, 2);
  assert.equal(comparison.excludedCount, 1);
  assert.equal(comparison.cells[2].point.value, 100);
  assert.equal(comparison.cells[2].rank, null);
  assert.equal(comparison.cells[2].delta, null);
  assert.match(
    comparison.cells[2].quality.reason,
    /actual reported flow durations/,
  );
});

test("benchmarks reject mixed annual and TTM bases even when source dates are identical", () => {
  const annual = entry("A", point(10));
  const trailing = entry(
    "B",
    point(20, period("2025-12-31", "2025-01-01", "ttm")),
  );
  for (const benchmark of ["median", "A"]) {
    const comparison = metricComparison(
      [annual, trailing],
      "netIncome",
      benchmark,
    );
    assert.equal(comparison.peerMedian, null);
    assert.equal(comparison.reference, null);
    assert.match(comparison.reason, /Reporting bases differ/);
    assert.deepEqual(
      comparison.cells.map((cell) => cell.point.value),
      [10, 20],
    );
    assert.ok(
      comparison.cells.every((cell) => cell.rank == null && cell.delta == null),
    );
  }
});

test("balance-only comparisons do not inherit annual flow duration mismatches", () => {
  const a = point(10, period(), [source(null, "2025-12-31", "Assets")]);
  const b = point(20, period("2025-12-31", "2025-03-01"), [
    source(null, "2025-12-31", "Assets"),
  ]);
  assert.equal(comparePairQuality(a, b, "totalAssets").valid, true);
  assert.equal(comparePointQuality(a, "totalAssets").durationDays, null);
});

test("standalone quarter evidence accepts same-concept cumulative subtraction", () => {
  const p = period("2025-06-30", "2025-04-01", "quarter");
  const observation = point(
    10,
    p,
    [source("2025-01-01", p.end), source("2025-01-01", "2025-03-31")],
    { classification: "calculated" },
  );
  assert.equal(comparePointQuality(observation, "netIncome").valid, true);
  assert.equal(comparePointQuality(observation, "netIncome").durationDays, 91);
  assert.equal(
    comparePointQuality(
      { ...observation, sources: [observation.sources[0]] },
      "netIncome",
    ).valid,
    false,
  );
});

test("TTM evidence accepts consecutive quarters and rejects an unconnected missing quarter", () => {
  const p = period("2025-12-31", "2025-01-01", "ttm");
  const quarters = [
    ["2025-01-01", "2025-03-31"],
    ["2025-04-01", "2025-06-30"],
    ["2025-07-01", "2025-09-30"],
    ["2025-10-01", "2025-12-31"],
  ].map(([start, end]) => source(start, end));
  const observation = point(40, p, quarters, { classification: "calculated" });
  assert.equal(comparePointQuality(observation, "netIncome").valid, true);
  assert.equal(
    comparePointQuality(
      { ...observation, sources: quarters.filter((_, index) => index !== 1) },
      "netIncome",
    ).valid,
    false,
  );
});

test("every flow concept in a calculated amount must support the same selected duration", () => {
  const observation = point(
    40,
    period(),
    [
      source(),
      source(
        "2025-03-01",
        "2025-12-31",
        "PaymentsToAcquirePropertyPlantAndEquipment",
      ),
    ],
    { classification: "calculated" },
  );
  assert.equal(comparePointQuality(observation, "freeCashFlow").valid, false);
});

test("return ratios allow the exact opening balance and reject unrelated old balances", () => {
  const observation = point(
    10,
    period(),
    [
      source(),
      source(null, "2025-12-31", "Assets"),
      source(null, "2024-12-31", "Assets"),
    ],
    { classification: "calculated" },
  );
  assert.equal(comparePointQuality(observation, "roa").valid, true);
  observation.sources[2].end = "2024-09-30";
  assert.equal(comparePointQuality(observation, "roa").valid, false);
});

test("currency, filing cutoff and selected endpoint are checked against every source", () => {
  assert.equal(
    comparePointQuality(
      point(10, period(), [
        source(undefined, undefined, undefined, { unit: "EUR" }),
      ]),
      "netIncome",
    ).valid,
    false,
  );
  assert.equal(
    comparePointQuality(
      point(10, { ...period(), asOf: "2026-01-31" }),
      "netIncome",
    ).valid,
    false,
  );
  assert.equal(
    comparePointQuality(
      point(10, period(), [source("2025-01-01", "2026-01-01")]),
      "netIncome",
    ).valid,
    false,
  );
});

test("missing source evidence is withheld for reported data; zero remains valid", () => {
  assert.equal(
    comparePointQuality(point(10, period(), []), "netIncome").valid,
    false,
  );
  assert.equal(comparePointQuality(point(0), "netIncome").valid, true);
  assert.equal(comparePointQuality(point(null), "netIncome").valid, false);
});

test("flow metrics cannot be supported solely by an instant observation", () => {
  assert.equal(
    comparePointQuality(point(10, period(), [source(null)]), "netIncome").valid,
    false,
  );
});

test("revised source contexts are reviewable warnings without inventing a restatement", () => {
  const quality = comparePointQuality(
    point(10, period(), [
      source(undefined, undefined, undefined, { revised: true }),
    ]),
    "netIncome",
  );
  assert.equal(quality.valid, true);
  assert.match(quality.issues[0], /before attributing/);
});

test("peer definition differences are exposed and temporal definition changes pause growth", () => {
  const a = point();
  const b = point(20, period(), [source(undefined, undefined, "ProfitLoss")]);
  const comparison = metricComparison(
    [entry("A", a), entry("B", b)],
    "netIncome",
  );
  assert.equal(comparison.definitionsDiffer, true);
  assert.match(comparison.definitionNote, /identical accounting scope/);
  assert.equal(comparePairQuality(a, b, "netIncome").valid, false);
});

test("year growth and CAGR reject unequal durations despite matching annual endpoints", () => {
  const data = entry("A", point(20)).data;
  data.metrics.netIncome.push(
    point(10, period("2024-12-31", "2024-03-01")),
    point(5, period("2022-12-31", "2022-03-01")),
  );
  const growth = historicGrowth(data, "netIncome", 0);
  assert.equal(growth.yoy.value, null);
  assert.match(growth.yoy.reason, /durations differ/);
  assert.equal(growth.cagr, null);
  assert.match(growth.cagrReason, /durations differ/);
});

test("same-duration sourced year-over-year growth and ratios remain available", () => {
  const data = entry("A", point(20)).data;
  data.metrics.netIncome.push(point(10, period("2024-12-31")));
  assert.equal(historicGrowth(data, "netIncome", 0).yoy.value, 100);
});

test("missing selected period does not expose later history in charts", () => {
  const a = entry("A", point());
  assert.deepEqual(
    trendSeries([{ ...a, index: -1, period: null }], "netIncome").rows,
    [],
  );
  const old = point(5, period("2023-12-31"));
  a.data.metrics.netIncome.push(old);
  a.index = 1;
  a.period = old.period;
  assert.deepEqual(
    trendSeries([a], "netIncome").rows.map((row) => row.bucket),
    ["2023"],
  );
});

test("indexed histories retain incompatible observations as gaps", () => {
  const a = entry("A", point(20));
  a.data.metrics.netIncome.push(
    point(15, period("2024-12-31", "2024-03-01")),
    point(10, period("2023-12-31")),
  );
  const series = trendSeries([a], "netIncome", { mode: "indexed" });
  assert.equal(series.sharedBase, "2023");
  assert.equal(series.rows.find((row) => row.bucket === "2024").A, null);
  assert.equal(series.rows.find((row) => row.bucket === "2025").A, 200);
});

test("broker-dealers receive an explicit business-model distinction and common defaults", () => {
  assert.equal(companyLens(6211), "corporate");
  assert.equal(companyLens(6021), "banking");
  const broker = buildCompareCompany({
    ticker: "BRK",
    cik: "1",
    companyName: "Broker",
    sic: 6211,
    facts: {},
  });
  assert.equal(broker.businessModel, "broker-dealer");
  assert.match(broker.lensNote, /Deposit-taking-bank ratios are not assumed/);
  assert.equal(inferLens([{ data: broker }]), "common");
  assert.equal(
    inferLens([{ data: broker }, { data: { lens: "banking" } }]),
    "common",
  );
  assert.equal(MAX_COMPARE_COMPANIES, 12);
  assert.match(COMPARE_VERSION, /^compare-v2:/);
});

test("derived Compare ratios do not calculate from a short income source and full-year revenue", () => {
  const fact = (val, tag, start) => [
    tag,
    {
      units: {
        USD: [
          {
            val,
            start,
            end: "2025-12-31",
            fy: 2025,
            fp: "FY",
            form: "10-K",
            filed: "2026-02-01",
            accn: "0000000001-26-000001",
          },
        ],
      },
    },
  ];
  const data = buildCompareCompany({
    ticker: "A",
    cik: "1",
    companyName: "A",
    sic: 3571,
    facts: {
      "us-gaap": Object.fromEntries([
        fact(20, "NetIncomeLoss", "2025-03-01"),
        fact(100, "Revenues", "2025-01-01"),
      ]),
    },
  });
  // Reject the short fact at selection, before it can appear as an annual value.
  assert.equal(data.metrics.netIncome[0].value, null);
  assert.equal(data.metrics.netMargin[0].value, null);
  assert.match(
    data.metrics.netMargin[0].reason,
    /required reported inputs are missing/,
  );
});
