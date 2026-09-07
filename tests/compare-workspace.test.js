import test from "node:test";
import assert from "node:assert/strict";
import {
  planComparePeers,
  validateCompareWorkspace,
} from "../src/utils/compareWorkspace.js";
import {
  comparePath,
  readCompareUrl,
  normalizeCompareSettings,
  emptyCompareNotebook,
  parseCompareNotebook,
  writeCompareNotebook,
  comparisonPin,
} from "../src/utils/compareNotebook.js";
import { createCompareSnapshot } from "../src/utils/compareSnapshots.js";
import {
  validateResearchStore,
  exportResearchBackup,
  parseResearchBackup,
} from "../src/utils/researchVault.js";
import { METRIC_BY_KEY } from "../src/utils/compareResearch.js";

const tickers = [
  "JPM",
  "BAC",
  "WFC",
  "C",
  "GS",
  "MS",
  "USB",
  "PNC",
  "TFC",
  "COF",
  "BK",
  "STT",
];
const settings = normalizeCompareSettings({
  focus: "JPM",
  benchmark: "peers",
  view: "changes",
  changeMode: "snapshots",
  tableMode: "formula",
  formulaA: "cash",
  formulaB: "deposits",
  formulaOp: "divide",
  formulaLabel: "Cash coverage",
  movementFrom: "2024",
  movementMetric: "netIncome",
  commonSize: "income",
});
const period = { kind: "annual", start: "2025-01-01", end: "2025-12-31" };
const point = {
  value: 100,
  period,
  classification: "reported",
  sources: [
    {
      taxonomy: "us-gaap",
      tag: "Assets",
      unit: "USD",
      end: period.end,
      value: 100,
      filed: "2026-02-01",
      accession: "0000019617-26-000001",
      documentUrl:
        "https://www.sec.gov/Archives/edgar/data/19617/000001961726000001/jpm.htm",
    },
  ],
  calculations: [],
};
const entry = {
  ticker: "JPM",
  index: 0,
  period,
  loading: false,
  data: {
    cik: "0000019617",
    name: "JPMorgan Chase",
    metrics: { totalAssets: [point] },
  },
};

test("twelve-peer paste is atomic, de-duplicated and never silently truncated", () => {
  assert.deepEqual(planComparePeers([], tickers).tickers, tickers);
  assert.deepEqual(planComparePeers(["JPM"], "jpm, bac; WFC").tickers, [
    "JPM",
    "BAC",
    "WFC",
  ]);
  assert.match(planComparePeers(tickers, "AAPL").error, /13/);
  assert.deepEqual(planComparePeers(tickers, "AAPL").tickers, tickers);
  assert.match(planComparePeers(["JPM"], "BAC, invalid!").error, /INVALID!/);
  assert.deepEqual(planComparePeers(["JPM"], "BAC, invalid!").tickers, ["JPM"]);
  assert.deepEqual(planComparePeers(tickers, "AAPL MSFT", "replace").tickers, [
    "AAPL",
    "MSFT",
  ]);
});

test("all new comparison controls and twelve peers survive share links", () => {
  const path = comparePath(tickers, settings);
  assert.ok(path.startsWith(`/compare/${tickers.join(",")}?`));
  assert.deepEqual(readCompareUrl(path.split("?")[1]), settings);
  assert.equal(
    normalizeCompareSettings({
      formulaOp: "eval",
      formulaA: "roe",
      focus: "<script>",
    }).formulaA,
    "cash",
  );
  assert.equal(
    normalizeCompareSettings({ formulaOp: "eval" }).formulaOp,
    "divide",
  );
});

test("snapshot, original evidence and research brief survive notebook and vault backup", () => {
  const snapshot = createCompareSnapshot({
    name: "Bank baseline",
    entries: [entry],
    metrics: [METRIC_BY_KEY.totalAssets],
    settings,
    tickers: ["JPM"],
  });
  const pin = comparisonPin(
    {
      ticker: entry.ticker,
      cik: entry.data.cik,
      name: entry.data.name,
      period,
      point,
    },
    METRIC_BY_KEY.totalAssets,
    settings,
  );
  const notebook = {
    ...emptyCompareNotebook(),
    pins: [pin],
    snapshots: [snapshot],
    brief: {
      title: "Capital review",
      researchQuestion: "What changed?",
      narrative: "Compare source scopes.",
      conclusions: "Review periods.",
      groupBy: "company",
    },
  };
  const raw = JSON.stringify(notebook);
  assert.deepEqual(parseCompareNotebook(raw), notebook);
  assert.deepEqual(
    validateResearchStore("edgar:compare-notebook:v1", raw),
    notebook,
  );
  const storage = {
    getItem: (key) => (key === "edgar:compare-notebook:v1" ? raw : null),
  };
  const backup = parseResearchBackup(exportResearchBackup(storage));
  assert.equal(backup.issues.length, 0);
  assert.ok(JSON.stringify(backup).includes("Capital review"));
  assert.ok(JSON.stringify(backup).includes("Bank baseline"));
});

test("malformed snapshot and brief metadata are rejected before storage writes", () => {
  for (const patch of [
    { snapshots: [{}] },
    { brief: { narrative: {} } },
    { snapshots: Array(9).fill({}) },
    { pins: [{ id: "broken", ticker: "JPM" }] },
  ]) {
    let writes = 0;
    assert.throws(() =>
      writeCompareNotebook(
        { getItem: () => null, setItem: () => writes++ },
        (old) => ({ ...old, ...patch }),
      ),
    );
    assert.equal(writes, 0);
  }
});

test("latest notebook writes preserve concurrent evidence and optional legacy fields", () => {
  const notebook = { ...emptyCompareNotebook(), notes: "Other tab memo" };
  let raw = JSON.stringify(notebook);
  const storage = {
    getItem: () => raw,
    setItem: (_, value) => {
      raw = value;
    },
  };
  writeCompareNotebook(storage, (current) => ({
    ...current,
    collectionName: "My collection",
  }));
  assert.equal(JSON.parse(raw).notes, "Other tab memo");
  assert.equal(
    validateCompareWorkspace({ version: 1, searches: [], pins: [] }).version,
    1,
  );
});
