import test from "node:test";
import assert from "node:assert/strict";
import { historicalContext } from "../src/utils/analysisHistory.js";

const period = (year, extra = {}) => ({
  fy: year,
  fp: "FY",
  kind: "annual",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  ...extra,
});
const point = (value, p, extra = {}) => ({
  value,
  period: p,
  classification: Number.isFinite(value) ? "reported" : "unavailable",
  sources: Number.isFinite(value)
    ? [{ value, tag: "Revenues", unit: "USD", start: p.start, end: p.end }]
    : [],
  ...extra,
});
function fixture(values = [999, 30, 0, -10, 20]) {
  const periods = values.map((_, index) => period(2025 - index));
  return {
    basis: "annual",
    periods,
    definitions: [{ key: "revenue", label: "Revenue", format: "currency" }],
    metrics: { revenue: periods.map((p, index) => point(values[index], p)) },
  };
}

test("historical median excludes the current period, preserves zero and negative values, and retains every prior source", () => {
  const result = historicalContext(fixture(), "revenue");
  assert.equal(result.count, 4);
  assert.equal(result.checked, 4);
  assert.equal(result.median.value, 10);
  assert.equal(result.low.point.value, -10);
  assert.equal(result.low.period.end, "2022-12-31");
  assert.equal(result.high.point.value, 30);
  assert.equal(result.position, "Above the observed prior range");
  assert.deepEqual(
    result.median.sources.map((source) => source.value),
    [30, 0, -10, 20],
  );
  assert.match(result.median.formula, /current observation is excluded/);
  assert.match(result.boundaryReason, /stops here/);
});

test("odd-sized medians and selection of an older current period do not include later observations", () => {
  const data = fixture([999, 0, -30, 10, 20]);
  const result = historicalContext(data, "revenue", 1);
  assert.equal(result.median.value, 10);
  assert.equal(result.current.value, 0);
  assert.equal(result.position, "Within the observed prior range");
  assert.equal(
    result.median.sources.some((source) => source.value === 999),
    false,
  );
  assert.equal(result.rows[0].period.end, "2023-12-31");
  const bounded = historicalContext(data, "revenue", 0, 2);
  assert.equal(bounded.count, 2);
  assert.equal(bounded.checked, 2);
  assert.equal(bounded.boundaryReason, null);
});

test("missing values and incompatible actual flow durations are excluded with explicit coverage", () => {
  const data = fixture([100, 50, null, 20, 10]);
  data.metrics.revenue[3].sources[0].start = "2022-06-01";
  const result = historicalContext(data, "revenue");
  assert.equal(result.checked, 4);
  assert.equal(result.count, 2);
  assert.equal(result.excluded, 2);
  assert.equal(result.median.value, 30);
  assert.match(result.rows[1].reason, /unavailable/);
  assert.match(result.rows[2].reason, /actual reported flow window/);
});

test("insufficient history withholds a range and median instead of inventing a risk grade", () => {
  const result = historicalContext(fixture([10, 20]), "revenue");
  assert.equal(result.count, 1);
  assert.equal(result.median.value, null);
  assert.equal(result.low, null);
  assert.equal(result.position, null);
  assert.match(result.summaryReason, /At least two/);
  assert.equal("riskScore" in result, false);
});

test("history stops at missing reporting years or a fiscal-year mismatch", () => {
  const data = fixture();
  data.periods.splice(2, 1);
  data.metrics.revenue.splice(2, 1);
  const result = historicalContext(data, "revenue");
  assert.equal(result.count, 1);
  assert.match(result.boundaryReason, /does not jump a missing reporting year/);
  const mismatch = fixture();
  mismatch.periods[1].fy = 2025;
  const stopped = historicalContext(mismatch, "revenue");
  assert.equal(stopped.checked, 0);
  assert.match(stopped.boundaryReason, /fiscal-year mismatch/);
});

test("quarter and YTD histories use only the same fiscal season", () => {
  for (const kind of ["quarter", "ytd"]) {
    const periods = [
      period(2025, {
        kind,
        fp: "Q2",
        start: `2025-${kind === "ytd" ? "01" : "04"}-01`,
        end: "2025-06-30",
      }),
      period(2025, { kind, fp: "Q1", start: "2025-01-01", end: "2025-03-31" }),
      period(2024, {
        kind,
        fp: "Q2",
        start: `2024-${kind === "ytd" ? "01" : "04"}-01`,
        end: "2024-06-30",
      }),
      period(2023, {
        kind,
        fp: "Q2",
        start: `2023-${kind === "ytd" ? "01" : "04"}-01`,
        end: "2023-06-30",
      }),
    ];
    const data = fixture();
    data.basis = kind;
    data.periods = periods;
    data.metrics.revenue = periods.map((p, index) =>
      point([40, 999, 20, 10][index], p),
    );
    const result = historicalContext(data, "revenue");
    assert.equal(result.median.value, 15);
    assert.deepEqual(
      result.rows.map((row) => row.index),
      [2, 3],
    );
    assert.equal(
      result.rows.every((row) => row.period.fp === "Q2"),
      true,
    );
  }
});

test("TTM histories take nonoverlapping annual anchors and reject an overlapping source window", () => {
  const data = fixture([100, 50, 30, 10]);
  data.basis = "ttm";
  data.periods.forEach((p) => {
    p.kind = "ttm";
    p.fp = "Q4";
  });
  data.metrics.revenue[0].sources[0].start = "2024-12-27";
  const result = historicalContext(data, "revenue");
  assert.equal(result.rows[0].included, false);
  assert.match(result.rows[0].reason, /overlaps/);
  assert.equal(result.count, 2);
  assert.equal(result.median.value, 20);
});

test("invalid, forward-looking, missing, or stale evidence is excluded without treating it as zero", () => {
  const mutations = [
    (p) => {
      p.sources[0].end = "2025-12-31";
    },
    (p) => {
      p.sources[0].end = "2024-12-30";
    },
    (p) => {
      p.sources[0].end = "2024-02-30";
    },
    (p) => {
      p.sources = [];
    },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data.metrics.revenue[1]);
    const result = historicalContext(data, "revenue");
    assert.equal(result.rows[0].included, false);
    assert.equal(result.excluded, 1);
    assert.equal(result.median.value, 0);
  }
  const absentCurrent = fixture([null, 30, 20]);
  const unavailable = historicalContext(absentCurrent, "revenue");
  assert.equal(unavailable.count, 0);
  assert.equal(unavailable.median.value, null);
  assert.match(unavailable.currentReason, /unavailable/);
});

test("derived quarterly inputs and instant balance observations retain valid historical context", () => {
  const data = fixture([30, 20, 10]);
  data.periods.forEach((p, index) => {
    p.kind = "quarter";
    p.fp = "Q2";
    p.start = `${p.fy}-04-01`;
    p.end = `${p.fy}-06-30`;
    data.metrics.revenue[index] = point(30 - index * 10, p, {
      classification: "calculated",
      sources: [
        { value: 50, tag: "Revenues", start: `${p.fy}-01-01`, end: p.end },
        {
          value: 20,
          tag: "Revenues",
          start: `${p.fy}-01-01`,
          end: `${p.fy}-03-31`,
        },
      ],
    });
  });
  assert.equal(historicalContext(data, "revenue").median.value, 15);
  data.metrics.revenue.forEach((p) => {
    p.classification = "reported";
    p.sources = [{ value: p.value, tag: "Cash", end: p.period.end }];
  });
  assert.equal(historicalContext(data, "revenue").median.value, 15);
});

test("equally short direct sources cannot masquerade as comparable annual periods", () => {
  for (const format of ["currency", "eps", "percent"]) {
    const data = fixture([100, 50, 20]);
    data.definitions[0].format = format;
    data.metrics.revenue.forEach((p) => {
      p.sources[0].start = `${p.period.fy}-07-01`;
    });
    const result = historicalContext(data, "revenue");
    assert.equal(result.count, 0);
    assert.match(result.currentReason, /actual reported flow window/);
  }
  const mismatchedPoint = fixture();
  mismatchedPoint.metrics.revenue[1].period = {
    ...mismatchedPoint.periods[1],
    start: "2024-02-01",
  };
  const result = historicalContext(mismatchedPoint, "revenue");
  assert.equal(result.rows[0].included, false);
  assert.match(result.rows[0].reason, /does not match this reporting period/);
});

test("an explicit filing cutoff requires dated evidence and excludes later filings", () => {
  const data = fixture();
  data.asOf = "2026-03-01";
  data.metrics.revenue.forEach((p) => {
    p.sources[0].filed = "2026-02-01";
  });
  data.metrics.revenue[1].sources[0].filed = "2026-04-01";
  delete data.metrics.revenue[2].sources[0].filed;
  const result = historicalContext(data, "revenue");
  assert.equal(result.count, 2);
  assert.equal(result.excluded, 2);
  assert.equal(result.median.value, 5);
  assert.match(result.rows[0].reason, /filing cutoff/);
  assert.match(result.rows[1].reason, /valid filing date/);
});

test("historical input-concept changes remain reviewable without silently labeling them equivalent", () => {
  const data = fixture();
  data.metrics.revenue[1].sources[0].tag = "SalesRevenueNet";
  const result = historicalContext(data, "revenue");
  assert.equal(result.rows[0].included, true);
  assert.match(result.rows[0].note, /Reported input concepts differ/);
  assert.equal(result.rows[1].note, null);
});
