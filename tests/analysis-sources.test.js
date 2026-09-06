import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisSourceContext,
  analysisSecUrl,
  uniqueAnalysisSources,
  analysisSourceState,
  analysisSourceCoherence,
  buildAnalysisSourceMatrix,
  analysisRevisionLedger,
  analysisComparisonIndex,
  analysisEvidenceComparison,
  analysisCollectionSettings,
} from "../src/utils/analysisSources.js";

const period = (year, extra = {}) => ({
  kind: "annual",
  fp: "FY",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  ...extra,
});
const source = (year, value, extra = {}) => ({
  taxonomy: "us-gaap",
  tag: "NetIncomeLoss",
  unit: "USD",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  value,
  filed: `${year + 1}-02-01`,
  accession: `0000000001-${String(year + 1).slice(-2)}-000001`,
  form: "10-K",
  documentUrl: `https://www.sec.gov/Archives/edgar/data/1/${year}/report.htm`,
  ...extra,
});
const point = (year, value, extra = {}) => ({
  value,
  period: period(year),
  classification: "reported",
  sources: [source(year, value)],
  ...extra,
});
const dataset = () => ({
  periods: [period(2025), period(2024), period(2023)],
  definitions: [
    {
      key: "netIncome",
      label: "Net income",
      format: "currency",
      category: "income",
    },
    {
      key: "revenue",
      label: "Revenue",
      format: "currency",
      category: "income",
    },
  ],
  metrics: {
    netIncome: [point(2025, 15), point(2024, 10), point(2023, 0)],
    revenue: [point(2025, 100), point(2024, 80), point(2023, 50)],
  },
  revenueKey: "revenue",
});

test("Source coverage keeps reported zero, missing values and calculated/revised overlap distinct", () => {
  const data = dataset();
  data.metrics.netIncome[1] = point(2024, 0, {
    classification: "calculated",
    sources: [source(2024, 10, { revised: true })],
  });
  data.metrics.revenue[2] = point(2023, null, {
    sources: [],
    classification: "unavailable",
    reason: "No matching context",
  });
  const matrix = buildAnalysisSourceMatrix(data, { years: 4 }, 1);
  assert.deepEqual(
    matrix.periods.map((entry) => entry.index),
    [1, 2],
  );
  assert.deepEqual(matrix.totals, {
    total: 4,
    available: 3,
    reported: 2,
    calculated: 1,
    missing: 1,
    revised: 1,
  });
  assert.equal(matrix.rows[0].cells[1].available, true);
  assert.equal(matrix.rows[1].cells[1].point.reason, "No matching context");
  assert.equal(analysisSourceState({ value: Infinity }).kind, "missing");
});

test("Source identity deduplicates labels while preserving concept units, dates and accessions", () => {
  const a = source(2025, 15, { label: "Profit input" });
  const b = { ...a, label: "Income input" };
  const c = { ...a, unit: "USD/shares" };
  const d = { ...a, accession: "0000000001-26-000002" };
  assert.equal(uniqueAnalysisSources({ sources: [a, b, c, d] }).length, 3);
  assert.equal(analysisSourceContext(a), analysisSourceContext(b));
  assert.notEqual(analysisSourceContext(a), analysisSourceContext(c));
  assert.notEqual(
    analysisSourceContext(a),
    analysisSourceContext({ ...a, start: null }),
  );
});

test("Source coherence counts actual accessions and calls multiple source filings a provenance condition", () => {
  const result = analysisSourceCoherence(
    {
      sources: [
        source(2025, 15),
        source(2024, 10),
        source(2025, 15, { label: "Reused input" }),
      ],
    },
    "2025-12-31",
  );
  assert.equal(result.sourceCount, 2);
  assert.equal(result.filingCount, 2);
  assert.equal(result.contextCount, 2);
  assert.equal(result.earliestFiled, "2025-02-01");
  assert.equal(result.latestFiled, "2026-02-01");
  assert.equal(result.afterCutoff, 1);
  assert.equal(result.status, "Multiple source filings");
  assert.match(result.explanation, /expected/);
  assert.equal(
    analysisSourceCoherence({
      sources: [source(2025, 15, { accession: null })],
    }).status,
    "Incomplete filing metadata",
  );
  assert.equal(analysisSourceCoherence({ sources: [] }).filingCount, 0);
});

test("Source coherence detects conflicting filing dates for the same accession", () => {
  const result = analysisSourceCoherence({
    sources: [
      source(2025, 15),
      source(2025, 100, { tag: "Revenues", filed: "2026-02-03" }),
    ],
  });
  assert.equal(result.filingCount, 1);
  assert.equal(result.conflictingDates, 1);
  assert.equal(result.status, "Inconsistent filing dates");
});

test("Retained revision ledger deduplicates a source reused by metrics and retains source links and uses", () => {
  const data = dataset();
  const revisions = [
    {
      value: 12,
      filed: "2026-02-01",
      accession: "a",
      form: "10-K",
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1/a.htm",
    },
    {
      value: 15,
      filed: "2026-03-01",
      accession: "b",
      form: "10-K/A",
      documentUrl: "https://www.sec.gov/Archives/edgar/data/1/b.htm",
    },
  ];
  data.metrics.netIncome[0].sources[0] = source(2025, 15, {
    revised: true,
    revisions,
  });
  data.metrics.revenue[0].sources = [
    source(2025, 15, {
      revised: true,
      revisions: [...revisions, revisions[0]],
      label: "Net income component",
    }),
  ];
  const ledger = analysisRevisionLedger(data, [0]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].uses.length, 2);
  assert.equal(ledger[0].revisions.length, 2);
  assert.equal(ledger[0].retainedHistoryLimit, 12);
  assert.equal(ledger[0].revisions[1].form, "10-K/A");
  assert.ok(ledger[0].revisions[1].documentUrl.endsWith("/b.htm"));
  assert.deepEqual(analysisRevisionLedger(data, [1]), []);
  assert.equal(analysisSourceState(data.metrics.netIncome[0]).revised, true);
});

test("A capped retained revision history is displayed even if only one changed value remains", () => {
  const data = dataset();
  data.metrics.netIncome[0].sources[0].revised = true;
  data.metrics.netIncome[0].sources[0].revisions = [
    { value: 15, filed: "2026-03-01", accession: "b" },
  ];
  assert.equal(analysisRevisionLedger(data, [0]).length, 1);
  assert.equal(analysisSourceState(data.metrics.netIncome[0]).revised, true);
});

test("Comparison uses the selected cell period and refuses unequal YTD durations", () => {
  const data = dataset();
  assert.equal(
    analysisComparisonIndex(data, data.metrics.netIncome[1], 0, "year"),
    2,
  );
  const selection = {
    definition: data.definitions[0],
    point: data.metrics.netIncome[0],
  };
  assert.equal(analysisEvidenceComparison(data, selection, 1).change.delta, 5);
  assert.equal(
    analysisEvidenceComparison(data, selection, 1).change.percent,
    50,
  );
  data.periods[0] = period(2025, { kind: "ytd", fp: "Q2", end: "2025-06-30" });
  data.periods[1] = period(2024, { kind: "ytd", fp: "Q1", end: "2024-03-31" });
  data.metrics.netIncome[0].period = data.periods[0];
  data.metrics.netIncome[1].period = data.periods[1];
  assert.equal(
    analysisEvidenceComparison(data, selection, 1).change.delta,
    null,
  );
  assert.match(
    analysisEvidenceComparison(data, selection, 1).change.reason,
    /durations/,
  );
});

test("Common-size comparison transforms the earlier figure using its own denominator", () => {
  const data = dataset();
  const selection = {
    definition: { ...data.definitions[0], format: "percent" },
    point: point(2025, 15, { classification: "calculated" }),
  };
  const comparison = analysisEvidenceComparison(data, selection, 1);
  assert.equal(comparison.before.value, 12.5);
  assert.equal(comparison.common, true);
  assert.equal(comparison.change.delta, 2.5);
  assert.equal(comparison.change.percent, null);
  data.metrics.revenue[1].value = 0;
  assert.equal(
    analysisEvidenceComparison(data, selection, 1).before.value,
    null,
  );
});

test("Negative-base and unavailable comparisons do not invent percentage growth or zero", () => {
  const data = dataset();
  data.metrics.netIncome[1].value = -10;
  const selection = {
    definition: data.definitions[0],
    point: data.metrics.netIncome[0],
  };
  const comparison = analysisEvidenceComparison(data, selection, 1);
  assert.equal(comparison.change.delta, 25);
  assert.equal(comparison.change.percent, null);
  assert.match(comparison.change.reason, /negative/);
  data.metrics.netIncome[1].value = null;
  assert.equal(
    analysisEvidenceComparison(data, selection, 1).change.delta,
    null,
  );
  assert.equal(analysisEvidenceComparison(data, selection, -1), null);
  assert.equal(
    analysisEvidenceComparison(
      data,
      { definition: { label: "Saved legacy evidence" } },
      1,
    ),
    null,
  );
});

test("Comparison identifies changed source concepts, and SEC links reject untrusted destinations", () => {
  const data = dataset();
  data.metrics.netIncome[1].sources[0].tag = "ProfitLoss";
  const selection = {
    definition: data.definitions[0],
    point: data.metrics.netIncome[0],
  };
  assert.equal(
    analysisEvidenceComparison(data, selection, 1).sourceTagsChanged,
    true,
  );
  for (const url of [
    "javascript:alert(1)",
    "https://www.sec.gov.evil.test/Archives/a",
    "https://evil.test/Archives/a",
    "http://www.sec.gov/Archives/a",
    "https://user:password@www.sec.gov/Archives/a",
    "/Archives/a",
  ])
    assert.equal(analysisSecUrl(url), null);
  assert.equal(
    analysisSecUrl("https://www.sec.gov/Archives/edgar/data/1/a.htm"),
    "https://www.sec.gov/Archives/edgar/data/1/a.htm",
  );
});

test("Evidence comparison checks actual reported duration despite matching normalized annual periods", () => {
  const data = dataset();
  data.metrics.netIncome[1].sources[0].start = "2024-07-01";
  const selection = {
    definition: data.definitions[0],
    point: data.metrics.netIncome[0],
  };
  const comparison = analysisEvidenceComparison(data, selection, 1);
  assert.equal(comparison.change.delta, null);
  assert.match(comparison.change.reason, /actual reported flow durations/);
});

test("Recollecting saved evidence preserves its original cutoff or explicitly unknown metadata", () => {
  const data = { ...dataset(), basis: "annual", asOf: "2026-09-01" };
  const original = { basis: "annual", end: "2025-12-31", asOf: "2026-02-15" };
  assert.deepEqual(
    analysisCollectionSettings(
      { analysisSettings: original },
      data,
      { basis: "annual", asOf: "2026-09-01" },
      data.metrics.netIncome[0],
    ),
    original,
  );
  assert.equal(
    analysisCollectionSettings(
      { analysisSettings: null },
      data,
      { asOf: "2026-09-01" },
      data.metrics.netIncome[0],
    ),
    null,
  );
  assert.deepEqual(
    analysisCollectionSettings(
      { analysisSettings: original },
      data,
      { asOf: "2026-08-01" },
      data.metrics.netIncome[1],
      true,
    ),
    { basis: "annual", end: "2024-12-31", asOf: "2026-09-01" },
  );
});

test("New evidence collection stamps its actual period and honors a latest-available loaded cutoff", () => {
  const data = { ...dataset(), basis: "annual", asOf: "" };
  assert.deepEqual(
    analysisCollectionSettings(
      {},
      data,
      { basis: "annual", asOf: "2026-02-15", end: "latest" },
      data.metrics.netIncome[1],
    ),
    { basis: "annual", end: "2024-12-31", asOf: "" },
  );
  assert.deepEqual(
    analysisCollectionSettings(
      {},
      { ...data, asOf: undefined },
      { basis: "annual", asOf: "2026-02-15" },
      data.metrics.netIncome[2],
      true,
    ),
    { basis: "annual", end: "2023-12-31", asOf: "2026-02-15" },
  );
});
