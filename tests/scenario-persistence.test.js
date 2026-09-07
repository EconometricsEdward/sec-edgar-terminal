import test from "node:test";
import assert from "node:assert/strict";
import { buildAnalysisScenario } from "../src/utils/analysisScenarios.js";
import { normalizeAnalysisSettings } from "../src/utils/analysisNotebook.js";
import { createScenarioCase } from "../src/utils/analysisScenarioCases.js";
import {
  validateResearchStore,
  readResearchVault,
  exportResearchBackup,
  parseResearchBackup,
  previewResearchRestore,
  restoreResearchVault,
} from "../src/utils/researchVault.js";

const key = "edgar:research-workspace:v1";
const now = "2026-09-07T12:00:00.000Z";
const period = {
  kind: "annual",
  start: "2025-01-01",
  end: "2025-12-31",
  label: "FY2025",
};

function fixture() {
  const rows = [
    ["revenue", "Revenue", "income", 1000],
    ["operatingIncome", "Operating income", "income", 200],
    ["totalAssets", "Total assets", "balance", 2000],
    ["stockholdersEquity", "Equity", "balance", 500],
  ];
  const data = {
    ticker: "AAPL",
    name: "Apple Inc.",
    cik: "0000320193",
    lens: "corporate",
    basis: "annual",
    asOf: "2026-02-28",
    version: "scenario-fixture-v1",
    observedAt: now,
    periods: [period],
    definitions: rows.map(([key, label, category]) => ({
      key,
      label,
      category,
      format: "currency",
    })),
    metrics: Object.fromEntries(
      rows.map(([key, label, category, value]) => [
        key,
        [
          {
            value,
            period,
            classification: "reported",
            sources: [
              {
                taxonomy: "us-gaap",
                tag: key,
                label,
                value,
                unit: "USD",
                start: category === "balance" ? null : period.start,
                end: period.end,
                filed: "2026-02-01",
                form: "10-K",
                accession: "0000320193-26-000001",
                documentUrl:
                  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/report.htm",
              },
            ],
          },
        ],
      ]),
    ),
  };
  const settings = normalizeAnalysisSettings({
    view: "scenarios",
    units: "billions",
    asOf: data.asOf,
    end: period.end,
    scenarioModel: "cost",
    scenarioRevenue: -10,
    scenarioVariableCost: 65,
    scenarioCostChange: 5,
    goalTargetIncome: "150",
    goalAssumedRevenue: "900",
    goalAssumedMargin: "20",
    goalEquityFloor: "15",
    goalOperatingSolved: true,
  });
  const entry = createScenarioCase({
    data,
    settings,
    index: 0,
    scenario: buildAnalysisScenario(data, settings, 0),
    name: "Demand decline with sticky costs",
    notes: "Review operating leverage before changing the margin assumption.",
    id: "scenario_costs",
    now,
  });
  return {
    version: 1,
    companies: {
      AAPL: {
        ticker: "AAPL",
        notes: "Existing company notes are retained.",
        analysisViews: [
          { name: "Cash review", settings: { view: "cash" }, savedAt: now },
        ],
        analysisScenarios: [entry],
      },
    },
    peerGroups: [],
  };
}

function storage(initial = {}) {
  const entries = new Map(
    Object.entries(initial).map(([k, value]) => [
      k,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  return {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (k) => entries.get(k) ?? null,
    setItem: (k, value) => entries.set(k, value),
    removeItem: (k) => entries.delete(k),
  };
}

test("Scenario cases appear in research search with their original assumptions, period and goal inputs", () => {
  const saved = fixture();
  const vault = readResearchVault(storage({ [key]: saved }));
  assert.deepEqual(vault.issues, []);
  const entry = vault.entries.find((row) =>
    row.id.endsWith(":scenario:scenario_costs"),
  );
  assert.equal(entry.type, "search");
  assert.equal(entry.source, "Analysis");
  assert.equal(entry.ticker, "AAPL");
  assert.equal(entry.title, "Demand decline with sticky costs");
  assert.match(entry.text, /Saved hypothetical scenario/);
  assert.match(entry.text, /annual ending 2025-12-31/);
  assert.match(entry.text, /Fixed and variable cost model/);
  assert.match(entry.text, /operating leverage/);
  assert.equal(entry.date, now);
  const destination = new URL(entry.href, "https://secedgarterminal.com");
  assert.equal(destination.pathname, "/analysis/AAPL");
  for (const [setting, value] of Object.entries({
    view: "scenarios",
    scenarioTab: "cases",
    scenarioCase: "scenario_costs",
    units: "billions",
    end: "2025-12-31",
    asOf: "2026-02-28",
    scenarioModel: "cost",
    scenarioRevenue: "-10",
    scenarioVariableCost: "65",
    scenarioCostChange: "5",
    goalTargetIncome: "150",
    goalOperatingSolved: "true",
  }))
    assert.equal(destination.searchParams.get(setting), value, setting);
  assert.equal(destination.searchParams.has("notes"), false);
});

test("Research backups restore complete immutable scenario evidence alongside existing company research", () => {
  const saved = fixture();
  const backup = parseResearchBackup(
    exportResearchBackup(storage({ [key]: saved }), now),
  );
  assert.deepEqual(backup.issues, []);
  const target = storage();
  const preview = previewResearchRestore(target, backup).find(
    (store) => store.key === key,
  );
  assert.equal(preview.available, true);
  assert.equal(preview.incomingCount, 3);
  const result = restoreResearchVault(
    target,
    backup,
    [key],
    exportResearchBackup(target, now),
  );
  assert.equal(result.restored, 1);
  assert.deepEqual(validateResearchStore(key, target.getItem(key)), saved);
  assert.equal(readResearchVault(target).totals.searches, 2);
});

test("Scenario imports reject cross-company cases, invalid sources and malformed case lists", () => {
  const mutations = [
    (company) => {
      company.analysisScenarios = {};
    },
    (company) => {
      company.analysisScenarios[0].context.ticker = "JPM";
    },
    (company) => {
      company.analysisScenarios.push(
        structuredClone(company.analysisScenarios[0]),
      );
    },
    (company) => {
      company.analysisScenarios[0].snapshot.balance.inputs[0].point.sources[0].form = 10;
    },
    (company) => {
      company.analysisScenarios[0].snapshot.balance.inputs[0].point.sources[0].documentUrl =
        "https://example.com/forged.htm";
    },
    (company) => {
      company.analysisScenarios[0].settings.scenarioRevenue = 70;
    },
    (company) => {
      company.analysisScenarios[0].snapshot.balance.rows[0].selection.point.value =
        "2000";
    },
  ];
  for (const mutate of mutations) {
    const saved = fixture();
    mutate(saved.companies.AAPL);
    const raw = JSON.stringify(saved);
    assert.throws(() => validateResearchStore(key, raw));
    const vault = readResearchVault(storage({ [key]: raw }));
    assert.equal(vault.issues.length, 1);
    assert.equal(vault.entries.length, 0);
    const backup = parseResearchBackup(
      exportResearchBackup(storage({ [key]: raw }), now),
    );
    assert.equal(backup.issues.length, 1);
    assert.equal(
      previewResearchRestore(storage(), backup).find(
        (store) => store.key === key,
      ).available,
      false,
    );
  }
});
