import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisRows,
  exportVisibleAnalysisCsv,
} from "../src/utils/analysisRows.js";
import {
  normalizeAnalysisSettings,
  analysisPath,
  readAnalysisSettings,
  analysisValue,
} from "../src/utils/analysisNotebook.js";

const periods = [2025, 2024, 2023].map((year) => ({
  kind: "annual",
  fp: "FY",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
}));
function fixture() {
  const definitions = [
    {
      key: "revenue",
      label: "Revenue",
      format: "currency",
      category: "income",
    },
    { key: "income", label: "Income", format: "currency", category: "income" },
    { key: "cash", label: "Cash", format: "currency", category: "balance" },
    {
      key: "capex",
      label: "PP&E purchases",
      format: "currency",
      category: "cashflow",
    },
  ];
  const values = {
    revenue: [200, 100, 90],
    income: [0, -20, -20],
    cash: [100, 80, 70],
    capex: [null, 10, 9],
  };
  return {
    ticker: "TEST",
    cik: "123",
    basis: "annual",
    periods,
    definitions,
    revenueKey: "revenue",
    metrics: Object.fromEntries(
      definitions.map((d) => [
        d.key,
        values[d.key].map((value, index) => ({
          value,
          period: periods[index],
          classification: value == null ? "unavailable" : "reported",
          sources:
            value == null
              ? []
              : [
                  {
                    tag: d.key,
                    unit: "USD",
                    value,
                    start: d.key === "cash" ? null : periods[index].start,
                    end: periods[index].end,
                    accession: `filing-${index}`,
                  },
                ],
        })),
      ]),
    ),
  };
}
const keys = (rows) => rows.map((d) => d.key);
test("Focused statements combine category and pins, then apply explicit scopes and search", () => {
  const data = fixture(),
    settings = normalizeAnalysisSettings({ pins: ["cash"] });
  assert.deepEqual(keys(analysisRows(data, settings, 0)), [
    "cash",
    "revenue",
    "income",
  ]);
  assert.deepEqual(
    keys(analysisRows(data, { ...settings, rowScope: "pins" }, 0)),
    ["cash"],
  );
  assert.deepEqual(
    keys(analysisRows(data, { ...settings, search: "purchases" }, 0)),
    ["capex"],
  );
  assert.deepEqual(
    keys(
      analysisRows(data, { ...settings, rowScope: "pins", pins: ["gone"] }, 0),
    ),
    [],
  );
});
test("Missing filters distinguish zero from missing and respect selected period", () => {
  const data = fixture(),
    settings = normalizeAnalysisSettings({
      search: "",
      statement: "cashflow",
      rowScope: "missing",
    });
  assert.deepEqual(keys(analysisRows(data, settings, 0)), ["capex"]);
  assert.deepEqual(keys(analysisRows(data, settings, 1)), []);
  assert.deepEqual(
    keys(
      analysisRows(
        data,
        { ...settings, statement: "income", rowScope: "available" },
        0,
      ),
    ),
    ["revenue", "income"],
  );
});
test("Changed rows include negative-base improvements but exclude incompatible source durations", () => {
  const data = fixture(),
    settings = normalizeAnalysisSettings({ rowScope: "changed" });
  assert.deepEqual(keys(analysisRows(data, settings, 0)), [
    "revenue",
    "income",
  ]);
  assert.deepEqual(keys(analysisRows(data, settings, 1)), ["revenue"]);
  data.metrics.revenue[0].sources[0].start = "2025-07-01";
  assert.deepEqual(keys(analysisRows(data, settings, 0)), ["income"]);
});
test("Visible evidence export contains only selected metric/period cells and raw source provenance", () => {
  const data = fixture(),
    settings = normalizeAnalysisSettings({ pins: ["cash"], rowScope: "pins" });
  const csv = exportVisibleAnalysisCsv(data, settings, 1);
  assert.ok(csv.includes('"Cash","80","USD"'));
  assert.ok(csv.includes("filing-1"));
  assert.ok(!csv.includes("2025-12-31"));
  assert.ok(!csv.includes('"Revenue"'));
  assert.equal(csv.split("\r\n").length, 3);
});
test("Legacy indexed views and new workflow settings round trip without losing semantics", () => {
  assert.equal(readAnalysisSettings("?indexed=true").chartMode, "indexed");
  const settings = normalizeAnalysisSettings({
    chartMode: "yearChange",
    rowScope: "pins",
    vintageDate: "2024-06-01",
  });
  assert.equal(settings.indexed, false);
  assert.deepEqual(
    readAnalysisSettings(analysisPath("JPM", settings).split("?")[1]),
    settings,
  );
  assert.equal(
    normalizeAnalysisSettings({ asOf: "2024-01-01", vintageDate: "2024-06-01" })
      .vintageDate,
    "",
  );
  assert.equal(
    analysisValue(-1.25, "percentagePoints", "billions"),
    "-1.25 pp",
  );
  assert.equal(analysisValue(115.25, "index", "raw"), "115.25 index");
});

test("Restoring a legacy view clears newer filters and preserves indexed mode", () => {
  const current = normalizeAnalysisSettings({
    rowScope: "pins",
    vintageDate: "2024-01-01",
    chartMode: "reported",
  });
  const restored = normalizeAnalysisSettings({
    ...current,
    ...normalizeAnalysisSettings({ view: "trends", indexed: true }),
  });
  assert.equal(restored.chartMode, "indexed");
  assert.equal(restored.rowScope, "all");
  assert.equal(restored.vintageDate, "");
});
