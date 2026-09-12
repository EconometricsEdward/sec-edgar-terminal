import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisCompany } from "../src/utils/analysisResearch.js";
import { buildMetricRow } from "../src/utils/xbrlParser.js";
import {
  reportingPeriods,
  selectFinancialFact,
  withPeriodKind,
} from "../src/utils/xbrlPeriods.js";

const observation = (value, start, end, extra = {}) => ({
  val: value,
  start,
  end,
  fp: "FY",
  fy: Number(end.slice(0, 4)),
  form: "10-K",
  filed: "2026-02-20",
  accn: "0000000001-26-000001",
  ...extra,
});
const facts = (tags) => ({
  "us-gaap": Object.fromEntries(
    Object.entries(tags).map(([tag, entries]) => [
      tag,
      { units: { USD: entries } },
    ]),
  ),
});
const annualPeriod = {
  kind: "annual",
  fp: "FY",
  start: "2025-01-01",
  end: "2025-12-31",
};

// An eleven-month monetary fact must not quietly become a twelve-month margin.
test("annual statements and formulas reject a different flow start at the same endpoint", () => {
  const data = facts({
    Revenues: [observation(100, "2025-01-01", "2025-12-31")],
    NetIncomeLoss: [observation(20, "2025-01-01", "2025-12-31")],
    GrossProfit: [observation(80, "2025-02-01", "2025-12-31")],
    NetCashProvidedByUsedInOperatingActivities: [
      observation(50, "2025-02-01", "2025-12-31"),
    ],
  });
  const result = buildAnalysisCompany(
    { facts: data, sic: "3571", ticker: "TEST", cik: "0000000001" },
    { basis: "annual" },
  );
  assert.equal(result.periods[0].start, "2025-01-01");
  assert.equal(result.metrics.revenue[0].value, 100);
  assert.equal(result.metrics.grossProfit[0].value, null);
  assert.equal(result.metrics.grossMargin[0].value, null);
  assert.equal(result.metrics.operatingCashFlow[0].value, null);
  assert.equal(result.metrics.cashConversion[0].value, null);
});

test("annual and TTM fact selection preserve the requested window when a newer different-duration fact exists", () => {
  const data = facts({
    Revenues: [
      observation(100, "2025-01-01", "2025-12-31"),
      observation(999, "2025-02-01", "2025-12-31", {
        filed: "2026-03-01",
        accn: "0000000001-26-000002",
      }),
    ],
  });
  for (const kind of ["annual", "ttm"]) {
    const point = selectFinancialFact(data, ["Revenues"], {
      ...annualPeriod,
      kind,
    });
    assert.equal(point.value, 100);
    assert.equal(point.sources[0].start, "2025-01-01");
    assert.equal(point.sources[0].filed, "2026-02-20");
  }
  // Legacy callers without an explicit start still receive the actual source
  // interval rather than inventing an assumed calendar-year start.
  const legacy = selectFinancialFact(data, ["Revenues"], {
    kind: "annual",
    end: "2025-12-31",
  });
  assert.equal(legacy.source.start, "2025-02-01");
});

test("52- and 53-week fiscal years retain their actual annual flow intervals", () => {
  const windows = [
    ["2024-01-28", "2025-02-01", 371, 150],
    ["2025-02-02", "2026-01-31", 364, 170],
  ];
  const data = facts({
    Revenues: windows.map(([start, end, , value], index) =>
      observation(value, start, end, {
        filed: index ? "2026-03-01" : "2025-03-01",
        accn: `0000000001-${index ? "26" : "25"}-000001`,
      }),
    ),
  });
  const periods = reportingPeriods(data, "annual");
  for (const [start, end, days, value] of windows) {
    const period = periods.find((entry) => entry.end === end);
    const point = selectFinancialFact(data, ["Revenues"], period);
    assert.equal(period.start, start);
    assert.equal(point.value, value);
    assert.equal(point.source.durationDays, days);
    assert.equal(point.source.start, start);
  }
});

test("non-calendar fiscal YTD is cumulative while the quarter is standalone", () => {
  const q1 = {
    fp: "Q1",
    fy: 2026,
    form: "10-Q",
    filed: "2026-02-01",
    accn: "0000000001-26-000001",
  };
  const q2 = {
    fp: "Q2",
    fy: 2026,
    form: "10-Q",
    filed: "2026-05-01",
    accn: "0000000001-26-000002",
  };
  const data = facts({
    Revenues: [
      observation(180, "2025-10-01", "2025-12-31", q1),
      observation(400, "2025-10-01", "2026-03-31", q2),
      observation(220, "2026-01-01", "2026-03-31", q2),
    ],
    NetCashProvidedByUsedInOperatingActivities: [
      observation(80, "2025-10-01", "2025-12-31", q1),
      observation(220, "2025-10-01", "2026-03-31", q2),
    ],
  });
  const quarters = reportingPeriods(data, "quarter");
  const ytd = withPeriodKind(quarters, "ytd")[0];
  const quarter = quarters[0];
  assert.equal(ytd.start, "2025-10-01");
  assert.equal(quarter.start, "2026-01-01");
  assert.equal(selectFinancialFact(data, ["Revenues"], ytd).value, 400);
  assert.equal(selectFinancialFact(data, ["Revenues"], quarter).value, 220);
  const quarterlyCash = buildMetricRow(data, "operatingCashFlow", "Cash flow", [
    quarter,
  ]).values[0];
  const ytdCash = buildMetricRow(data, "operatingCashFlow", "Cash flow", [ytd])
    .values[0];
  assert.equal(quarterlyCash.value, 140);
  assert.equal(quarterlyCash.classification, "calculated");
  assert.equal(quarterlyCash.source.start, "2026-01-01");
  assert.equal(quarterlyCash.sources.length, 2);
  assert.equal(ytdCash.value, 220);
  assert.equal(ytdCash.classification, "reported");
});

test("Q4 EPS and weighted average shares stay missing when only cumulative contexts exist", () => {
  const annual = observation(4, "2025-01-01", "2025-12-31");
  const nineMonths = observation(3, "2025-01-01", "2025-09-30", {
    fp: "Q3",
    form: "10-Q",
    filed: "2025-11-01",
    accn: "0000000001-25-000003",
  });
  const data = facts({ Revenues: [annual, nineMonths] });
  data["us-gaap"].EarningsPerShareDiluted = {
    units: { "USD/shares": [annual, nineMonths] },
  };
  data["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding = {
    units: {
      shares: [
        { ...annual, val: 100 },
        { ...nineMonths, val: 110 },
      ],
    },
  };
  const quarter = reportingPeriods(data, "quarter")[0];
  assert.equal(quarter.fp, "Q4");
  assert.equal(quarter.start, "2025-10-01");
  assert.equal(
    buildMetricRow(data, "revenue", "Revenue", [quarter]).values[0].value,
    1,
  );
  for (const [key, format] of [
    ["epsDiluted", "eps"],
    ["sharesDiluted", "shares"],
  ]) {
    assert.equal(
      buildMetricRow(data, key, key, [quarter], format).values[0].value,
      null,
    );
    assert.notEqual(
      buildMetricRow(data, key, key, [annualPeriod], format).values[0].value,
      null,
    );
  }
});
