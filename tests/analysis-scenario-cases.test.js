import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";
import {
  normalizeAnalysisSettings,
  analysisCollectionSettings,
} from "../src/utils/analysisNotebook.js";
import { analysisCollectionSettings as inspectorCollectionSettings } from "../src/utils/analysisSources.js";
import {
  createScenarioCase,
  scenarioCaseCompatibility,
  scenarioCaseRestoreSettings,
  scenarioCaseRevision,
  scenarioCaseSelection,
  updateScenarioCases,
  validateScenarioCases,
} from "../src/utils/analysisScenarioCases.js";
import {
  buildScenarioBrief,
  scenarioBriefCsv,
  scenarioBriefHtml,
  scenarioSourceUrl,
} from "../src/utils/analysisScenarioBrief.js";

const period = {
  start: "2025-01-01",
  end: "2025-12-31",
  kind: "annual",
  label: "FY2025",
};
const now = "2026-04-01T12:00:00.000Z";
function company(lens = "corporate") {
  const values = {
    revenue: 1000000000,
    operatingIncome: 100000000,
    totalAssets: 2000000000,
    stockholdersEquity: 200000000,
    cash: 300000000,
    deposits: 1000000000,
  };
  return {
    ticker: "TEST",
    name: "Test Company",
    cik: "1",
    lens,
    version: "analysis-test-v1",
    basis: "annual",
    asOf: "",
    observedAt: now,
    periods: [period],
    definitions: Object.keys(values).map((key) => ({
      key,
      label: key,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        [
          {
            value,
            period,
            classification: "reported",
            sources: [
              {
                tag: key,
                taxonomy: "us-gaap",
                unit: "USD",
                value,
                start: ["revenue", "operatingIncome"].includes(key)
                  ? period.start
                  : null,
                end: period.end,
                filed: "2026-02-01",
                accession: "0000000001-26-000001",
              },
            ],
          },
        ],
      ]),
    ),
  };
}
function make(id = "case_a", changes = {}, data = company()) {
  const settings = normalizeAnalysisSettings({
    view: "scenarios",
    scenarioRevenue: -10,
    goalTargetIncome: "120",
    ...changes,
  });
  const scenario = buildAnalysisScenario(data, settings, 0);
  return createScenarioCase({
    data,
    settings,
    index: 0,
    scenario,
    name: id,
    notes: "A documented user assumption.",
    id,
    now,
  });
}

test("Scenario snapshots retain actual reporting context, goal settings and immutable source evidence", () => {
  const data = company();
  const entry = make("base", {}, data);
  assert.equal(entry.settings.end, period.end);
  assert.equal(entry.context.period.start, period.start);
  assert.equal(entry.settings.goalTargetIncome, "120");
  assert.equal(entry.context.dataVersion, data.version);
  assert.equal(entry.context.observedAt, now);
  data.metrics.revenue[0].value = 15;
  data.metrics.revenue[0].sources[0].value = 15;
  assert.equal(entry.snapshot.operating.inputs[0].point.value, 1e9);
  assert.equal(entry.snapshot.operating.inputs[0].point.sources[0].value, 1e9);
  const restored = scenarioCaseRestoreSettings(entry);
  assert.equal(restored.end, period.end);
  assert.equal(restored.scenarioCase, entry.id);
  assert.equal(restored.scenarioTab, "cases");
  const selection = scenarioCaseSelection(
    entry,
    entry.snapshot.operating.rows[0].selection,
  );
  assert.equal(selection.analysisSettings.basis, "annual");
  assert.equal(selection.analysisSettings.end, period.end);
  assert.equal(selection.analysisSettings.asOf, "");
  assert.equal(selection.analysisSettings.scenarioRevenue, -10);
  assert.equal(selection.analysisSettings.goalTargetIncome, "120");
  const inspectorSettings = inspectorCollectionSettings(
    selection,
    data,
    normalizeAnalysisSettings({ scenarioRevenue: 45 }),
    selection.point,
  );
  const collected = analysisCollectionSettings(
    { ...selection, analysisSettings: inspectorSettings },
    normalizeAnalysisSettings({ scenarioRevenue: 45 }),
  );
  assert.equal(collected.scenarioRevenue, -10);
  assert.equal(collected.goalTargetIncome, "120");
  assert.match(selection.point.note, /Hypothetical/);
});

test("Scenario case writes reject stale revisions, duplicates, limits and immutable evidence replacements", () => {
  const original = make();
  const initial = updateScenarioCases([], {
    type: "add",
    id: original.id,
    entry: original,
  });
  assert.equal(initial.ok, true);
  assert.equal(
    updateScenarioCases(initial.cases, {
      type: "add",
      id: original.id,
      entry: original,
    }).ok,
    false,
  );
  const edited = {
    ...original,
    name: "Revised name",
    notes: "Preserved thesis",
    updatedAt: "2026-04-02T12:00:00.000Z",
  };
  const updated = updateScenarioCases(initial.cases, {
    type: "update",
    id: original.id,
    expectedRevision: scenarioCaseRevision(original),
    entry: edited,
  });
  assert.equal(updated.ok, true);
  const stale = updateScenarioCases(updated.cases, {
    type: "update",
    id: original.id,
    expectedRevision: scenarioCaseRevision(original),
    entry: original,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /another tab/);
  assert.equal(stale.cases[0].notes, "Preserved thesis");
  assert.equal(
    updateScenarioCases(updated.cases, {
      type: "remove",
      id: original.id,
      expectedRevision: scenarioCaseRevision(original),
    }).ok,
    false,
  );
  const replacement = make(original.id, { scenarioRevenue: 20 });
  assert.match(
    updateScenarioCases(initial.cases, {
      type: "update",
      id: original.id,
      expectedRevision: scenarioCaseRevision(original),
      entry: replacement,
    }).reason,
    /immutable/,
  );
  const full = Array.from({ length: 8 }, (_, index) => make(`case_${index}`));
  const over = updateScenarioCases(full, {
    type: "add",
    id: "ninth",
    entry: make("ninth"),
  });
  assert.equal(over.ok, false);
  assert.equal(over.cases.length, 8);
  const removed = updateScenarioCases(initial.cases, {
    type: "remove",
    id: original.id,
    expectedRevision: scenarioCaseRevision(original),
  });
  assert.deepEqual(removed.cases, []);
});

test("Scenario comparison requires matching period, cutoff, model and exact baseline sources", () => {
  const base = make();
  const alternate = make("alternate", {
    scenarioRevenue: 15,
    scenarioMargin: 2,
  });
  assert.equal(scenarioCaseCompatibility(base, alternate).compatible, true);
  const newObservation = make(
    "fresh",
    {},
    { ...company(), observedAt: "2026-04-02T12:00:00.000Z" },
  );
  assert.equal(
    scenarioCaseCompatibility(base, newObservation).compatible,
    true,
  );
  for (const [change, expected] of [
    [{ period: { ...period, end: "2024-12-31" } }, /period/],
    [{ asOf: "2026-03-01" }, /cutoff/],
    [{ dataVersion: "v2" }, /data version/],
  ]) {
    const candidate = structuredClone(base);
    candidate.context = { ...candidate.context, ...change };
    assert.match(scenarioCaseCompatibility(base, candidate).status, expected);
  }
  const revisedSource = structuredClone(base);
  revisedSource.snapshot.operating.inputs[0].point.sources[0].accession =
    "0000000001-26-000002";
  assert.match(
    scenarioCaseCompatibility(base, revisedSource).status,
    /source inputs/,
  );
  const missing = structuredClone(base);
  missing.snapshot.operating.inputs[0].reason = "Baseline unavailable";
  assert.equal(scenarioCaseCompatibility(base, missing).compatible, false);
});

test("Portable scenario validation rejects malformed context, snapshots and unsafe numeric values", () => {
  const entry = make();
  let count = 0;
  validateScenarioCases([entry], () => count++);
  assert.ok(count >= 6);
  assert.throws(() => validateScenarioCases([entry, entry]), /unique/);
  for (const mutate of [
    (e) => {
      e.name = " ";
    },
    (e) => {
      e.notes = "x".repeat(8001);
    },
    (e) => {
      e.context.period.end = "latest";
    },
    (e) => {
      e.settings.scenarioRevenue = 10000;
    },
    (e) => {
      e.snapshot.operating.rows[0].selection.point.value = Infinity;
    },
    (e) => {
      e.snapshot.operating.rows[0].selection.point.sources = {};
    },
  ]) {
    const broken = structuredClone(entry);
    mutate(broken);
    assert.throws(() => validateScenarioCases([broken]));
  }
});

test("Scenario briefs keep full USD, original source dates, assumptions and notes in the exact export model", () => {
  const first = make("downside");
  const second = make("upside", { scenarioRevenue: 10 });
  first.name = '<script>alert("case")</script>';
  first.notes = '=HYPERLINK("evil")\nA <b>real</b> note.';
  const model = buildScenarioBrief([first, second], now);
  const html = scenarioBriefHtml(model);
  const csv = scenarioBriefCsv(model);
  assert.match(html, /Comparison on matching reported inputs/);
  assert.match(html, /900000000/);
  assert.match(html, /1100000000/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;b&gt;real&lt;\/b&gt;/);
  assert.match(html, /0000000001-26-000001/);
  assert.match(html, /2026-02-01/);
  assert.match(html, /Full USD|full USD/);
  assert.match(csv, /"Hypothetical result"/);
  assert.match(csv, /900000000/);
  assert.match(csv, /'\=HYPERLINK/);
  assert.match(csv, /Revenue change \(%\)/);
  assert.match(csv, /Goal: target operating income/);
  assert.doesNotMatch(csv, /scenarioTab|scenarioCase/);
  assert.match(csv, /not forecasts/);
  assert.match(csv, /SEC URL/);
  assert.equal(scenarioBriefHtml(model), html);
  assert.equal(
    scenarioSourceUrl("1", { documentUrl: "javascript:alert(1)" }),
    "",
  );
  assert.equal(
    scenarioSourceUrl("1", { documentUrl: "https://evil.example/report" }),
    "",
  );
});

test("Incompatible cases remain separately documented without entering a shared comparison", () => {
  const first = make();
  const other = make(
    "different_cutoff",
    { asOf: "2026-03-01" },
    { ...company(), asOf: "2026-03-01" },
  );
  const model = buildScenarioBrief([first, other], now);
  assert.equal(model.cases[1].compatibility.compatible, false);
  const html = scenarioBriefHtml(model);
  assert.doesNotMatch(html, /<h2>Comparison on matching/);
  assert.match(html, /Different filing cutoff/);
  assert.match(html, /different_cutoff/);
  assert.match(scenarioBriefCsv(model), /Different filing cutoff/);
});

test("Unavailable model results export explicit reasons and keep available original inputs", () => {
  const data = company("banking");
  const entry = make("cash_gap", { scenarioFunding: 50 }, data);
  assert.ok(entry.snapshot.balance.reason);
  const model = buildScenarioBrief([entry], now);
  const html = scenarioBriefHtml(model),
    csv = scenarioBriefCsv(model);
  assert.match(html, /Unavailable:/);
  assert.match(html, /original reported inputs/);
  assert.match(csv, /Reported baseline input/);
  assert.match(csv, /cash|withdrawal/i);
});

test("Solved goal snapshots stay distinct from applied sensitivities and preserve their evidence", () => {
  const entry = make("goals", {
    goalMode: "revenue",
    goalTargetIncome: "120000000",
    goalAssumedMargin: "15",
    goalOperatingSolved: true,
    goalEquityFloor: "5",
    goalAssetSolved: true,
  });
  assert.equal(entry.goalSnapshots.length, 2);
  assert.equal(entry.goalSnapshots[0].rows[0].point.value, 800000000);
  assert.equal(
    entry.snapshot.operating.rows.find((row) => row.key === "Revenue").selection
      .point.value,
    900000000,
  );
  const model = buildScenarioBrief([entry], now);
  const html = scenarioBriefHtml(model),
    csv = scenarioBriefCsv(model);
  assert.match(html, /Hypothetical goal:/);
  assert.match(html, /Solving a target does not apply it/);
  assert.match(csv, /Hypothetical goal-seek result/);
  assert.match(csv, /800000000/);
  entry.goalSnapshots[0].rows[0].point.value = 1;
  assert.equal(model.cases[0].goalSnapshots[0].rows[0].point.value, 800000000);
  assert.equal(scenarioBriefHtml(model), html);
});
