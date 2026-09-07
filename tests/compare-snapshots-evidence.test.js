import test from "node:test";
import assert from "node:assert/strict";
import {
  createCompareSnapshot,
  compareSnapshot,
} from "../src/utils/compareSnapshots.js";
import {
  comparisonSourceFingerprint,
  comparisonEvidenceIdentity,
  makeCompareEvidenceUrl,
  readCompareEvidencePointer,
  resolveCompareEvidencePointer,
  compareEvidenceCitation,
  safeCompareSourceUrl,
} from "../src/utils/compareEvidenceLinks.js";
import {
  normalizeCompareSettings,
  comparisonPin,
  readCompareUrl,
} from "../src/utils/compareNotebook.js";
import { METRIC_BY_KEY } from "../src/utils/compareResearch.js";
import {
  computeCompareFormula,
  compareFormulaMetric,
} from "../src/utils/compareFormula.js";
import { commonSizeCell } from "../src/utils/compareCommonSize.js";

const settings = normalizeCompareSettings({
  metrics: ["netIncome"],
  asOf: "2026-06-30",
});
const metrics = [METRIC_BY_KEY.netIncome];
const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  fp: "FY",
  fy: 2025,
  asOf: settings.asOf,
};
const source = (value = 100, extra = {}) => ({
  taxonomy: "us-gaap",
  tag: "NetIncomeLoss",
  value,
  unit: "USD",
  start: period.start,
  end: period.end,
  filed: "2026-02-10",
  form: "10-K",
  accession: "0000000001-26-000001",
  documentUrl:
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm",
  ...extra,
});
const point = (value = 100, extra = {}) => ({
  value,
  period: { ...period },
  classification: "reported",
  sources: [source(value)],
  ...extra,
});
const entry = (value = 100, extra = {}) => ({
  ticker: "AAA",
  loading: false,
  error: null,
  index: 0,
  period: { ...period },
  data: {
    cik: "0000000001",
    name: "Alpha",
    lens: "corporate",
    periods: [{ ...period }],
    metrics: { netIncome: [point(value)] },
  },
  ...extra,
});
const current = (entries = [entry()], extra = {}) => ({
  metrics,
  entries,
  settings,
  tickers: entries.map((item) => item.ticker),
  ...extra,
});
const snapshot = (data = current()) =>
  createCompareSnapshot(
    { name: "June review", ...data },
    "2026-06-30T12:00:00.000Z",
  );
const evidence = () => ({
  cell: {
    ticker: "AAA",
    cik: "0000000001",
    name: "Alpha",
    period: { ...period, end: "2024-12-31" },
    point: point(),
  },
  metric: METRIC_BY_KEY.netIncome,
  settings,
});

test("snapshots freeze full original observations and settings without sharing mutable inputs", () => {
  const data = current();
  const saved = snapshot(data);
  data.entries[0].data.metrics.netIncome[0].sources[0].value = 999;
  data.settings = { ...data.settings, asOf: "" };
  assert.equal(saved.companies[0].observations[0].point.sources[0].value, 100);
  assert.equal(saved.settings.asOf, "2026-06-30");
  assert.equal(saved.metrics[0].category, "Scale");
  assert.equal(saved.companies.length, 1);
});
test("snapshot value comparisons require identical actual observation periods", () => {
  const saved = snapshot();
  const changed = entry(120);
  let row = compareSnapshot(saved, current([changed])).rows[0];
  assert.equal(row.status, "value-changed");
  assert.equal(row.delta, 20);
  changed.data.metrics.netIncome[0].period.end = "2026-12-31";
  row = compareSnapshot(saved, current([changed])).rows[0];
  assert.equal(row.status, "period-changed");
  assert.equal(row.delta, null);
  changed.data.metrics.netIncome[0].period = { ...period, start: "2025-04-01" };
  assert.equal(
    compareSnapshot(saved, current([changed])).rows[0].status,
    "period-changed",
  );
  changed.data.metrics.netIncome[0].period = { ...period, kind: "ttm" };
  assert.equal(
    compareSnapshot(saved, current([changed])).rows[0].status,
    "period-changed",
  );
});
test("unchanged totals with changed input values or source contexts are visible", () => {
  const saved = snapshot(),
    changed = entry();
  changed.data.metrics.netIncome[0].sources[0].value = 101;
  let row = compareSnapshot(saved, current([changed])).rows[0];
  assert.equal(row.status, "inputs-changed");
  assert.equal(row.delta, null);
  changed.data.metrics.netIncome[0].sources[0] = source(100, {
    tag: "ProfitLoss",
  });
  assert.equal(
    compareSnapshot(saved, current([changed])).rows[0].status,
    "inputs-changed",
  );
  assert.equal(compareSnapshot(saved, current()).rows[0].status, "unchanged");
});
test("snapshot missing coverage, recovered fetches and membership changes remain distinct", () => {
  const missing = entry(null);
  missing.data.metrics.netIncome[0].reason = "Source unavailable";
  assert.equal(
    compareSnapshot(snapshot(), current([missing])).rows[0].status,
    "missing",
  );
  assert.equal(
    compareSnapshot(snapshot(current([missing])), current()).rows[0].status,
    "recovered",
  );
  const failed = entry(null, {
    data: null,
    period: null,
    index: -1,
    error: "Failed",
  });
  const recovered = compareSnapshot(snapshot(current([failed])), current());
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.rows[0].status, "recovered");
  const other = entry(100, { ticker: "BBB" });
  other.data.cik = "0000000002";
  const statuses = compareSnapshot(snapshot(), current([other])).rows.map(
    (row) => row.status,
  );
  assert.deepEqual(statuses, ["company-removed", "company-added"]);
});
test("same CIK aliases do not manufacture membership changes; different resolved CIK does", () => {
  const alias = entry(100, { ticker: "AA.A" });
  assert.equal(
    compareSnapshot(snapshot(), current([alias])).rows[0].status,
    "unchanged",
  );
  alias.ticker = "AAA";
  alias.data.cik = "0000000002";
  assert.deepEqual(
    compareSnapshot(snapshot(), current([alias])).rows.map((row) => row.status),
    ["company-removed", "company-added"],
  );
});
test("snapshot definition changes suppress deltas and settings changes are disclosed", () => {
  const updated = current([entry(120)], {
    metrics: [{ ...metrics[0], formula: "A different definition" }],
    settings: { ...settings, asOf: "" },
  });
  const result = compareSnapshot(snapshot(), updated);
  assert.equal(result.rows[0].status, "definition-changed");
  assert.equal(result.rows[0].delta, null);
  assert.ok(result.settingsDifferences.includes("asOf"));
  assert.equal(result.rows[0].prior.settings.asOf, "2026-06-30");
  assert.equal(result.rows[0].current.settings.asOf, "");
});
test("snapshot refuses incomplete loads, duplicate issuers and excessive source payloads", () => {
  assert.throws(
    () => snapshot(current([entry(100, { loading: true })])),
    /finish loading/,
  );
  assert.throws(
    () => snapshot(current([entry(), entry(100, { ticker: "AAA.B" })])),
    /duplicate issuer/,
  );
  const large = entry();
  large.data.metrics.netIncome[0].sources[0].label = "x".repeat(1_250_001);
  assert.throws(() => snapshot(current([large])), /1.25 MB/);
  const dozen = Array.from({ length: 12 }, (_, i) => {
    const value = entry(100, { ticker: `A${i}` });
    value.data.cik = String(i + 1);
    return value;
  });
  assert.equal(snapshot(current(dozen)).companies.length, 12);
});
test("pending current requests stay pending instead of becoming a missing-data signal", () => {
  const result = compareSnapshot(
    snapshot(),
    current([entry(100, { loading: true })]),
  );
  assert.equal(result.rows[0].status, "loading");
  assert.equal(result.rows[0].delta, null);
});
test("fingerprints capture exact precision and all input contexts with stable key ordering", () => {
  assert.equal(
    comparisonSourceFingerprint({ value: 1, sources: [source()] }),
    comparisonSourceFingerprint({ sources: [source()], value: 1 }),
  );
  assert.notEqual(
    comparisonSourceFingerprint(point(1.0000000000001)),
    comparisonSourceFingerprint(point(1.0000000000002)),
  );
  const updated = point();
  updated.sources[0].start = "2025-04-01";
  assert.notEqual(
    comparisonSourceFingerprint(point()),
    comparisonSourceFingerprint(updated),
  );
});
test("pins retain original point metadata, category and definitions with complete input identity", () => {
  const saved = evidence();
  const pin = comparisonPin(saved.cell, saved.metric, saved.settings);
  assert.equal(pin.category, "Scale");
  assert.equal(pin.point.period.end, period.end);
  assert.equal(pin.settings.asOf, settings.asOf);
  saved.cell.point.sources[0].value = 200;
  assert.equal(pin.point.sources[0].value, 100);
  assert.notEqual(
    pin.id,
    comparisonPin(saved.cell, saved.metric, saved.settings).id,
  );
  assert.notEqual(
    comparisonEvidenceIdentity(saved.cell, saved.metric, saved.settings),
    comparisonEvidenceIdentity(saved.cell, saved.metric, {
      ...saved.settings,
      asOf: "",
    }),
  );
});
test("exact links whitelist public settings and point periods without private annotations", () => {
  const saved = {
    ...evidence(),
    notes: "private note",
    snapshotName: "secret name",
    settings: { ...settings, notes: "private setting" },
  };
  const link = makeCompareEvidenceUrl(saved, {
    tickers: ["BBB", "AAA"],
    origin: "https://secedgarterminal.com/disclosures",
  });
  assert.ok(link.startsWith("https://secedgarterminal.com/compare/AAA,BBB?"));
  assert.ok(!link.includes("private") && !link.includes("secret"));
  const parsed = readCompareEvidencePointer(new URL(link).searchParams);
  assert.equal(parsed.end, period.end);
  assert.equal(
    parsed.fingerprint,
    comparisonSourceFingerprint(saved.cell.point),
  );
  assert.equal(readCompareUrl(new URL(link).search).asOf, settings.asOf);
});
test("exact links resolve a historical point instead of substituting the selected current period", () => {
  const saved = evidence(),
    link = makeCompareEvidenceUrl(saved);
  const company = entry();
  company.index = 1;
  company.period = { ...period, end: "2026-12-31" };
  company.data.metrics.netIncome.push(point(120, { period: company.period }));
  const resolved = resolveCompareEvidencePointer(
    readCompareEvidencePointer(link.split("?")[1]),
    [company],
    metrics,
    settings,
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.evidence.cell.point.value, 100);
  assert.equal(resolved.evidence.cell.period.end, period.end);
});
test("exact links fail clearly for input revisions, missing periods and identity mismatches", () => {
  const pointer = readCompareEvidencePointer(
    makeCompareEvidenceUrl(evidence()).split("?")[1],
  );
  const changed = entry();
  changed.data.metrics.netIncome[0].sources[0].value = 120;
  assert.equal(
    resolveCompareEvidencePointer(pointer, [changed], metrics, settings).status,
    "observation-changed",
  );
  changed.data.metrics.netIncome[0].period.end = "2026-12-31";
  assert.equal(
    resolveCompareEvidencePointer(pointer, [changed], metrics, settings).status,
    "period-unavailable",
  );
  changed.data.cik = "0000000002";
  assert.equal(
    resolveCompareEvidencePointer(pointer, [changed], metrics, settings).status,
    "company-unavailable",
  );
  assert.equal(readCompareEvidencePointer("obsTicker=AAA").invalid, true);
  assert.equal(readCompareEvidencePointer("notes=anything"), null);
  assert.equal(
    makeCompareEvidenceUrl({ ...evidence(), settings: undefined }),
    null,
  );
});
test("citations keep unrounded amounts, actual periods, filing cutoffs and safe source URLs", () => {
  const saved = evidence();
  saved.cell.point.value = 0.123456789012345;
  saved.cell.point.sources[0].value = 0.123456789012345;
  const citation = compareEvidenceCitation(saved);
  assert.ok(citation.includes("0.123456789012345 USD"));
  assert.ok(citation.includes("2025-01-01 to 2025-12-31"));
  assert.ok(citation.includes("Filing cutoff: 2026-06-30"));
  assert.ok(citation.includes(source().accession));
  assert.equal(
    safeCompareSourceUrl("https://www.sec.gov.evil.test/filing"),
    null,
  );
  assert.equal(safeCompareSourceUrl("javascript:alert(1)"), null);
  assert.equal(
    safeCompareSourceUrl("https://name:password@www.sec.gov/filing"),
    null,
  );
});
test("custom formula links regenerate and verify all original operands", () => {
  const company = entry();
  company.data.metrics.totalAssets = [
    point(1000, {
      sources: [source(1000, { tag: "Assets", start: undefined })],
    }),
  ];
  company.data.metrics.cash = [
    point(100, { sources: [source(100, { tag: "Cash", start: undefined })] }),
  ];
  const formulaSettings = normalizeCompareSettings({
    ...settings,
    formulaA: "cash",
    formulaB: "totalAssets",
    formulaOp: "divide",
    formulaScale: "percent",
  });
  const computed = computeCompareFormula(company, formulaSettings);
  const saved = {
    cell: { ...evidence().cell, point: computed },
    metric: compareFormulaMetric(formulaSettings),
    settings: formulaSettings,
  };
  assert.equal(computed.value, 10);
  const pointer = readCompareEvidencePointer(
    makeCompareEvidenceUrl(saved).split("?")[1],
  );
  assert.equal(
    resolveCompareEvidencePointer(pointer, [company], metrics, formulaSettings)
      .status,
    "resolved",
  );
  company.data.metrics.cash[0].sources[0].value = 101;
  assert.equal(
    resolveCompareEvidencePointer(pointer, [company], metrics, formulaSettings)
      .status,
    "observation-changed",
  );
});
test("common-size links reconstruct synthetic evidence rather than linking an unrelated raw metric", () => {
  const company = entry();
  company.data.metrics.totalAssets = [
    point(1000, {
      sources: [source(1000, { tag: "Assets", start: undefined })],
    }),
  ];
  company.data.metrics.cash = [
    point(100, { sources: [source(100, { tag: "Cash", start: undefined })] }),
  ];
  const calculated = commonSizeCell(company, "cash", "balance");
  const saved = {
    cell: { ...evidence().cell, point: calculated.calculatedPoint },
    metric: {
      ...METRIC_BY_KEY.cash,
      key: "cashCommonSizebalance",
      label: "Cash / assets",
      format: "percent",
    },
    settings,
  };
  const pointer = readCompareEvidencePointer(
    makeCompareEvidenceUrl(saved).split("?")[1],
  );
  const resolved = resolveCompareEvidencePointer(
    pointer,
    [company],
    metrics,
    settings,
  );
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.evidence.cell.point.value, 10);
  assert.equal(resolved.evidence.metric.key, "cashCommonSizebalance");
});

test("snapshot deltas are suppressed when concept or original source duration changes", () => {
  const changed = entry(120);
  changed.data.metrics.netIncome[0].sources[0].tag = "ProfitLoss";
  let row = compareSnapshot(snapshot(), current([changed])).rows[0];
  assert.equal(row.status, "inputs-changed");
  assert.equal(row.delta, null);
  changed.data.metrics.netIncome[0].sources[0] = source(120, {
    start: "2025-04-01",
  });
  row = compareSnapshot(snapshot(), current([changed])).rows[0];
  assert.equal(row.status, "inputs-changed");
  assert.equal(row.delta, null);
  changed.data.metrics.netIncome[0].sources[0] = source(120, {
    accession: "0000000001-26-000002",
    filed: "2026-03-01",
  });
  row = compareSnapshot(snapshot(), current([changed])).rows[0];
  assert.equal(row.status, "value-changed");
  assert.equal(row.delta, 20);
});
