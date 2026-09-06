import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveChartKeys,
  analysisChartWindow,
  chartYearChangePoint,
  buildAnalysisChart,
} from "../src/utils/analysisChart.js";

const annual = (year) => ({
  kind: "annual",
  fp: "FY",
  fy: year,
  start: `${year}-01-01`,
  end: `${year}-12-31`,
});
function fixture(periods = [annual(2025), annual(2024), annual(2023)]) {
  const definitions = [
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
    { key: "margin", label: "Margin", format: "percent", category: "ratios" },
    {
      key: "multiple",
      label: "Multiple",
      format: "decimal",
      category: "ratios",
    },
  ];
  const values = {
    revenue: [120, 100, 80],
    netIncome: [15, 10, 8],
    margin: [12.5, 10, 10],
    multiple: [3, 2, 1],
  };
  return {
    lens: "corporate",
    revenueKey: "revenue",
    basis: periods[0].kind,
    periods,
    definitions,
    metrics: Object.fromEntries(
      definitions.map(({ key, format }) => [
        key,
        periods.map((period, i) => ({
          period,
          value: values[key][i] ?? 10,
          classification: "reported",
          sources: [
            {
              tag: key,
              taxonomy: "us-gaap",
              unit: format === "currency" ? "USD" : "pure",
              value: values[key][i] ?? 10,
              start: period.start,
              end: period.end,
              accession: `0000000001-${String(period.fy).slice(2)}-000001`,
            },
          ],
        })),
      ]),
    ),
  };
}

test("stale chart selections resolve against definitions and actual metric arrays", () => {
  const data = fixture();
  data.metrics.orphan = [];
  data.definitions.push({ key: "missing", format: "currency" });
  const resolved = resolveChartKeys(data, {
    chart: ["orphan", "missing", "oldBankMetric"],
  });
  assert.deepEqual(resolved.keys, ["revenue", "netIncome"]);
  assert.equal(resolved.usedFallback, true);
  assert.deepEqual(resolved.discardedKeys, [
    "orphan",
    "missing",
    "oldBankMetric",
  ]);
  const partial = resolveChartKeys(data, {
    chart: [
      "oldBankMetric",
      "margin",
      "margin",
      "netIncome",
      "multiple",
      "revenue",
    ],
  });
  assert.deepEqual(partial.keys, ["margin", "netIncome", "multiple"]);
  assert.equal(partial.usedFallback, false);
  assert.equal(partial.discarded.length, 3);
});

test("fallbacks stay within an insurance lens and preserve at least one available metric", () => {
  const data = fixture();
  data.lens = "insurance";
  data.revenueKey = null;
  data.definitions = [
    { key: "premiumsEarned", label: "Premiums", format: "currency" },
  ];
  data.metrics.premiumsEarned = data.metrics.revenue;
  assert.deepEqual(resolveChartKeys(data, {}).keys, ["premiumsEarned"]);
});

test("YTD charts use only the selected fiscal season and preserve source indices", () => {
  const periods = [
    { fy: 2025, fp: "Q3", kind: "ytd", start: "2025-01-01", end: "2025-09-30" },
    { fy: 2025, fp: "Q2", kind: "ytd", start: "2025-01-01", end: "2025-06-30" },
    { fy: 2024, fp: "Q3", kind: "ytd", start: "2024-01-01", end: "2024-09-30" },
    { fy: 2024, fp: "Q2", kind: "ytd", start: "2024-01-01", end: "2024-06-30" },
  ];
  const data = fixture(periods);
  assert.deepEqual(
    analysisChartWindow(data, 0, 8).map((row) => row.index),
    [0, 2],
  );
  assert.deepEqual(
    analysisChartWindow(data, 1, 8).map((row) => row.index),
    [1, 3],
  );
  for (const chartMode of ["reported", "indexed", "yearChange"]) {
    const model = buildAnalysisChart(data, {
      chartMode,
      chart: ["revenue"],
      years: 8,
    });
    assert.deepEqual(
      model.chart.map((row) => row.end),
      ["2024-09-30", "2025-09-30"],
    );
    assert.deepEqual(
      model.rows.map((row) => row.index),
      [0, 2],
    );
  }
});

test("quarter and TTM windows retain sequential observations and a selected historical endpoint", () => {
  for (const kind of ["quarter", "ttm"]) {
    const data = fixture([
      { kind, fp: "Q3", fy: 2025, start: "2025-07-01", end: "2025-09-30" },
      { kind, fp: "Q2", fy: 2025, start: "2025-04-01", end: "2025-06-30" },
      { kind, fp: "Q1", fy: 2025, start: "2025-01-01", end: "2025-03-31" },
    ]);
    assert.deepEqual(
      analysisChartWindow(data, 1, 8).map((row) => row.index),
      [1, 2],
    );
    assert.deepEqual(
      buildAnalysisChart(data, { chart: ["revenue"] }, 1).chart.map(
        (row) => row.end,
      ),
      ["2025-03-31", "2025-06-30"],
    );
  }
});

test("same-season amount growth retains both SEC inputs and negative current values", () => {
  const data = fixture();
  const growth = chartYearChangePoint(data, "revenue", 0);
  assert.ok(Math.abs(growth.value - 20) < 1e-10);
  assert.deepEqual(
    growth.sources.map((source) => source.end),
    ["2025-12-31", "2024-12-31"],
  );
  data.metrics.revenue[0].value = -50;
  assert.equal(chartYearChangePoint(data, "revenue", 0).value, -150);
});

test("growth withholds zero/negative prior amounts, missing seasons, and inconsistent durations", () => {
  for (const value of [0, -100, null]) {
    const data = fixture();
    data.metrics.revenue[1].value = value;
    assert.equal(chartYearChangePoint(data, "revenue", 0).value, null);
  }
  const gap = fixture([annual(2025), annual(2023)]);
  assert.equal(chartYearChangePoint(gap, "revenue", 0).value, null);
  const duration = fixture();
  duration.metrics.revenue[0].sources[0].start = "2025-03-01";
  assert.equal(chartYearChangePoint(duration, "revenue", 0).value, null);
});

test("ratio YoY changes use percentage points and multiples, including negative baselines", () => {
  const data = fixture();
  assert.equal(chartYearChangePoint(data, "margin", 0).value, 2.5);
  assert.equal(chartYearChangePoint(data, "multiple", 0).value, 1);
  data.metrics.margin[1].value = -10;
  assert.equal(chartYearChangePoint(data, "margin", 0).value, 22.5);
  const model = buildAnalysisChart(data, {
    chartMode: "yearChange",
    chart: ["margin", "multiple", "revenue"],
  });
  assert.equal(model.unit, "percentagePoints");
  assert.deepEqual(model.withheldKeys, ["multiple", "revenue"]);
  assert.equal(model.rows[0].points.multiple.value, null);
  assert.match(model.rows[0].points.multiple.reason, /different unit/);
});

test("indexed mode uses a common positive base and retains derivation inputs", () => {
  const data = fixture();
  data.metrics.netIncome[2].value = 0;
  const model = buildAnalysisChart(data, {
    chartMode: "indexed",
    chart: ["revenue", "netIncome"],
  });
  assert.equal(model.base.period.end, "2024-12-31");
  assert.equal(model.rows[0].points.revenue.value, 120);
  assert.equal(model.rows[0].points.netIncome.value, 150);
  assert.equal(model.rows[1].points.revenue.value, 100);
  assert.equal(model.rows[2].points.revenue.value, null);
  assert.equal(model.rows[0].points.revenue.sources.length, 2);
  assert.equal(model.series[0].displayDefinition.format, "index");
  assert.match(model.rows[0].points.revenue.formula, /2024-12-31/);
});

test("indexing withholds when no shared positive period or duration-compatible base exists", () => {
  const data = fixture();
  data.metrics.netIncome.forEach((point) => (point.value = -1));
  const noBase = buildAnalysisChart(data, {
    chartMode: "indexed",
    chart: ["revenue", "netIncome"],
  });
  assert.equal(noBase.base, undefined);
  assert.ok(noBase.rows.every((row) => row.points.revenue.value === null));
  const duration = fixture();
  duration.metrics.revenue[0].sources[0].start = "2025-03-01";
  const model = buildAnalysisChart(duration, {
    chartMode: "indexed",
    chart: ["revenue"],
  });
  assert.equal(model.rows[0].points.revenue.value, null);
});

test("reported values stay in original units and mixed formats are not plotted on one axis", () => {
  const data = fixture();
  const model = buildAnalysisChart(data, {
    chartMode: "reported",
    chart: ["revenue", "margin"],
    units: "billions",
  });
  assert.equal(model.chart.at(-1).revenue, 120);
  assert.equal(model.rows[0].points.revenue, data.metrics.revenue[0]);
  assert.deepEqual(model.withheldKeys, ["margin"]);
  assert.equal(model.rows[0].points.margin.value, null);
  assert.equal(
    buildAnalysisChart(data, {
      chartMode: "indexed",
      chart: ["revenue", "margin"],
    }).withheldKeys.length,
    0,
  );
});

test("missing observations and absent whole periods break chart trajectories", () => {
  const data = fixture([annual(2025), annual(2023), annual(2022)]);
  data.metrics.revenue[1].value = null;
  const model = buildAnalysisChart(data, { chart: ["revenue"], years: 8 });
  assert.equal(model.chart.length, 4);
  assert.equal(model.chart[1].revenue, null);
  assert.equal(model.chart[2].gap, true);
  assert.equal(model.chart[3].end, "2025-12-31");
});
