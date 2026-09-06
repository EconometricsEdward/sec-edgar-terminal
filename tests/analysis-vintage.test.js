import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisVintageComparison,
  exportAnalysisVintageCsv,
  validateVintageDate,
  vintageSnapshotSettings,
} from "../src/utils/analysisVintage.js";

const period = {
  kind: "annual",
  fp: "FY",
  start: "2024-01-01",
  end: "2024-12-31",
};
const source = (value, options = {}) => ({
  taxonomy: "us-gaap",
  tag: "NetIncomeLoss",
  unit: "USD",
  start: period.start,
  end: period.end,
  value,
  filed: "2025-02-01",
  accession: "0000000001-25-000001",
  form: "10-K",
  documentUrl: "https://www.sec.gov/Archives/edgar/data/1/25/report.htm",
  ...options,
});
const point = (value, options = {}) => ({
  period,
  value,
  classification: "reported",
  sources: [source(value)],
  ...options,
});
const definition = {
  key: "netIncome",
  label: "Net income",
  format: "currency",
  category: "income",
};
const data = (value, extra = {}) => ({
  ticker: "TEST",
  cik: "0000000001",
  version: "test-model-1",
  basis: "annual",
  asOf: "2026-08-01",
  observedAt: "2026-09-01T12:00:00.000Z",
  periods: [period],
  definitions: [definition],
  metrics: { netIncome: [point(value)] },
  ...extra,
});
const compare = (now, before, options = {}) =>
  buildAnalysisVintageComparison(now, before, 0, {
    earlierCutoff: "2025-03-01",
    currentCutoff: "2026-08-01",
    today: "2026-09-01",
    ...options,
  });
const earlier = (value, extra = {}) =>
  data(value, { asOf: "2025-03-01", ...extra });

test("Filing snapshots compare the same source context and preserve explicit cutoff metadata", () => {
  const current = data(120);
  current.metrics.netIncome[0].sources[0] = source(120, {
    filed: "2026-02-01",
    accession: "0000000001-26-000001",
  });
  const result = compare(current, earlier(100));
  assert.equal(result.status, "ready");
  assert.equal(result.rows[0].state, "changed");
  assert.equal(result.rows[0].delta, 20);
  assert.equal(result.rows[0].percent, 20);
  assert.equal(result.totals.changed, 1);
  assert.equal(result.totals.total, 1);
  assert.deepEqual(result.earlierSettings, {
    basis: "annual",
    end: period.end,
    asOf: "2025-03-01",
  });
  assert.equal(
    result.rows[0].before.sources[0].accession,
    "0000000001-25-000001",
  );
});

test("Source substitutions and unequal actual date windows never become same-concept value revisions", () => {
  for (const options of [
    { tag: "ProfitLoss" },
    { unit: "USD/shares" },
    { start: "2024-07-01" },
    { taxonomy: "custom" },
  ]) {
    const current = data(120);
    current.metrics.netIncome[0].sources[0] = source(120, options);
    const row = compare(current, earlier(100)).rows[0];
    assert.equal(row.state, "incompatible");
    assert.equal(row.delta, null);
    assert.match(row.reason, /date windows/);
  }
});

test("Equal values with different source inputs or later accessions remain separately reviewable", () => {
  const current = data(100);
  current.metrics.netIncome[0].sources[0] = source(100, { tag: "ProfitLoss" });
  assert.equal(compare(current, earlier(100)).rows[0].state, "inputs");
  assert.equal(compare(current, earlier(100)).rows[0].delta, null);
  current.metrics.netIncome[0].sources[0] = source(100, {
    accession: "0000000001-26-000002",
  });
  assert.equal(compare(current, earlier(100)).rows[0].state, "inputs");
  current.metrics.netIncome[0].sources[0] = source(100);
  assert.equal(compare(current, earlier(100)).rows[0].state, "unchanged");
});

test("Formula changes and incomplete source metadata withhold arithmetic revision claims", () => {
  const current = data(120);
  current.metrics.netIncome[0].formula = "A minus B";
  assert.equal(compare(current, earlier(100)).rows[0].state, "incompatible");
  current.metrics.netIncome[0] = point(120, { sources: [] });
  assert.equal(compare(current, earlier(100)).rows[0].delta, null);
  current.metrics.netIncome[0] = point(120, {
    sources: [source(120, { end: "2024-02-31" })],
  });
  assert.equal(compare(current, earlier(100)).rows[0].state, "incompatible");
});

test("Newly available, unavailable now and missing in both retain separate exact coverage counts", () => {
  const current = data(0, {
    definitions: [
      definition,
      { ...definition, key: "other", label: "Other" },
      { ...definition, key: "third", label: "Third" },
    ],
    metrics: {
      netIncome: [point(0)],
      other: [point(null, { sources: [] })],
      third: [point(null, { sources: [] })],
    },
  });
  const before = earlier(null, {
    definitions: current.definitions,
    metrics: {
      netIncome: [point(null, { sources: [] })],
      other: [point(4)],
      third: [point(null, { sources: [] })],
    },
  });
  const result = compare(current, before);
  assert.deepEqual(
    result.rows.map((row) => row.state),
    ["added", "removed", "missing"],
  );
  assert.equal(result.totals.total, 3);
  assert.equal(result.totals.currentAvailable, 1);
  assert.equal(result.totals.earlierAvailable, 1);
  assert.equal(
    result.totals.added + result.totals.removed + result.totals.missing,
    3,
  );
  assert.equal(result.rows[0].before.value, null);
  assert.equal(result.rows[0].current.value, 0);
});

test("Missing exact reporting end never silently selects the latest older report", () => {
  const before = earlier(50, { periods: [{ ...period, end: "2023-12-31" }] });
  const result = compare(data(120), before);
  assert.equal(result.status, "missing-period");
  assert.equal(result.rows.length, 0);
  assert.equal(result.totals.total, 0);
  assert.match(result.reason, /No older period was substituted/);
  before.periods = [{ ...period, kind: "quarter" }];
  assert.equal(compare(data(120), before).status, "missing-period");
});

test("Duplicate period contexts, wrong issuer, basis, requested cutoff and model version block the comparison", () => {
  const current = data(120);
  for (const extra of [
    { cik: "2" },
    { ticker: "OTHER" },
    { basis: "quarter" },
    { asOf: "2025-04-01" },
    { version: "changed-model" },
  ])
    assert.equal(compare(current, earlier(100, extra)).status, "invalid");
  assert.equal(
    compare(current, earlier(100, { periods: [period, period] })).status,
    "missing-period",
  );
  assert.equal(compare(current, earlier(100, { cik: "1" })).status, "ready");
});

test("Date validation rejects nonexistent, equal, later and future cutoffs", () => {
  for (const value of [
    "",
    "not-a-date",
    "2025-02-29",
    "2026-08-01",
    "2026-08-02",
    "2026-10-01",
  ])
    assert.ok(validateVintageDate(value, "2026-08-01", "2026-09-01"));
  assert.equal(
    validateVintageDate("2024-02-29", "2026-08-01", "2026-09-01"),
    "",
  );
  assert.ok(validateVintageDate("2026-09-01", "", "2026-09-01"));
  assert.equal(validateVintageDate("2026-08-31", "", "2026-09-01"), "");
  assert.equal(
    compare(data(100), earlier(100, { asOf: "2026-08-01" }), {
      earlierCutoff: "2026-08-01",
    }).status,
    "invalid",
  );
});

test("Zero and negative earlier values preserve arithmetic without percentage growth", () => {
  for (const [oldValue, newValue, delta] of [
    [0, 5, 5],
    [-10, 5, 15],
    [-10, -20, -10],
    [5, 0, -5],
  ]) {
    const row = compare(data(newValue), earlier(oldValue)).rows[0];
    assert.equal(row.state, "changed");
    assert.equal(row.delta, delta);
    assert.equal(row.percent, oldValue > 0 ? -100 : null);
  }
  assert.equal(compare(data(0), earlier(0)).rows[0].state, "unchanged");
});

test("Latest-available metadata does not inherit a stale screen cutoff", () => {
  const current = data(120, { asOf: "" });
  assert.equal(vintageSnapshotSettings(current, period, "2026-08-01").asOf, "");
  const result = compare(current, earlier(100));
  assert.equal(result.currentSettings.asOf, "");
  assert.equal(result.currentObservedAt, "2026-09-01T12:00:00.000Z");
});

test("Inputs filed after their stated snapshot cutoff cannot support a revision comparison", () => {
  const before = earlier(100);
  before.metrics.netIncome[0].sources[0].filed = "2025-03-02";
  const row = compare(data(120), before).rows[0];
  assert.equal(row.state, "incompatible");
  assert.equal(row.delta, null);
  assert.match(row.reason, /after its snapshot cutoff/);
  const incomplete = earlier(120);
  incomplete.metrics.netIncome[0].sources[0].accession = null;
  assert.equal(compare(data(120), incomplete).rows[0].state, "incompatible");
});

test("Snapshot CSV includes only visible rows, both sources and settings, safe links and quoted text", () => {
  const current = data(120, {
    definitions: [{ ...definition, label: '=HYPERLINK("bad")\nquoted, label' }],
  });
  current.metrics.netIncome[0].sources[0].documentUrl =
    "https://evil.example/Archives/a";
  const result = compare(current, earlier(100));
  const csv = exportAnalysisVintageCsv(result, current, result.rows, {
    state: "changed",
    query: 'quote "test"',
  });
  assert.match(csv, /Earlier sources \(JSON\)/);
  assert.match(csv, /Current settings \(JSON\)/);
  assert.match(csv, /2025-03-01/);
  assert.match(csv, /0000000001-25-000001/);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)/);
  assert.ok(!csv.includes("evil.example"));
  assert.ok(csv.includes('""url"":null'));
  assert.equal(
    exportAnalysisVintageCsv(result, current, []).split("\r\n").length,
    1,
  );
});
