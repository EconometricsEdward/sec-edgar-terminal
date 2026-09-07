import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFundWorkspaceSettings,
  readFundWorkspaceSettings,
  fundWorkspacePath,
} from "../src/utils/fundWorkspaceSettings.js";
import {
  fundUniverse,
  fundSnapshotFacts,
  screenFunds,
  fundScreenerCsv,
} from "../src/utils/fundScreener.js";
const state = (ticker, assets, top, date = "2026-06-30") => ({
  status: "ready",
  data: {
    ticker,
    status: "ready",
    name: ticker,
    asOf: date,
    filingDate: "2026-08-20",
    accession: "0000000001-26-000001",
    sourceUrl: "https://www.sec.gov/Archives/source.xml",
    seriesId: "S000000001",
    fundInfo: { netAssets: assets },
    summary: {
      count: 100,
      weightCount: 95,
      valuedCount: 98,
      top10Weight: top,
      weightTotal: 99,
    },
  },
});
test("fund workspace links preserve research context and numeric drafts while excluding private fields", () => {
  const settings = normalizeFundWorkspaceSettings({
    view: "allocation",
    category: "US equity",
    tickers: ["voo", "VTI", "VOO", "QQQ", "IWM", "BND"],
    reportMap: { VOO: "0000000001-26-000001", BND: "0000000001-26-000002" },
    allocations: {
      VOO: "50.123456789",
      VTI: "",
      QQQ: "-",
      IWM: "49.876543211",
    },
    minAssets: "10",
    securityQuery: "Apple",
    notes: "private note",
  });
  assert.deepEqual(settings.tickers, ["VOO", "VTI", "QQQ", "IWM"]);
  assert.equal(settings.allocations.VTI, "");
  assert.equal(settings.allocations.QQQ, "-");
  const path = fundWorkspacePath(settings);
  assert.deepEqual(readFundWorkspaceSettings(path.split("?")[1]), settings);
  assert.ok(!path.includes("private"));
  assert.ok(!settings.reportMap.BND);
  assert.deepEqual(
    readFundWorkspaceSettings("?compare=VOO,VTI&category=bad").tickers,
    ["VOO", "VTI"],
  );
  assert.equal(readFundWorkspaceSettings("?compare=VOO,VTI").view, "compare");
  assert.equal(
    readFundWorkspaceSettings("?category=bad").category,
    "All funds",
  );
});
test("arbitrary saved tickers appear in saved screens alongside catalog funds", () => {
  const rows = fundUniverse(["SCHD"], ["SCHD"], {
    "SCHD:latest": state("SCHD", 100e9, 44),
  });
  const result = screenFunds(
    rows,
    { category: "Saved funds" },
    ["SCHD"],
    "2026-09-01",
  );
  assert.deepEqual(
    result.rows.map((f) => f.ticker),
    ["SCHD"],
  );
  assert.equal(result.rows[0].curated, false);
  assert.equal(result.ready, 1);
});
test("numeric filters exclude unknown facts and never interpret failures or missing concentration as zero", () => {
  const states = {
    "VOO:latest": state("VOO", 200e9, 40),
    "VTI:latest": state("VTI", 100e9, null),
    "SPY:latest": { status: "error", error: "no source" },
    "IWM:latest": state("IWM", 50e9, 20),
  };
  const universe = fundUniverse([], [], states);
  const result = screenFunds(
    universe,
    { category: "US equity", minAssets: "75", maxConcentration: "45" },
    [],
    "2026-09-01",
  );
  assert.deepEqual(
    result.rows.map((f) => f.ticker),
    ["VOO"],
  );
  assert.equal(result.ready, 3);
  assert.equal(result.failed, 1);
  assert.equal(
    fundSnapshotFacts({ ...state("VOO", 1, 1), status: "loading" }),
    null,
  );
  const invalid = screenFunds(
    universe,
    { minAssets: "-", maxAge: "1e" },
    [],
    "2026-09-01",
  );
  assert.equal(Object.keys(invalid.errors).length, 2);
  assert.equal(invalid.rows.length, 12);
});
test("loaded facts sort both directions with missing values always last, and stale reports can be filtered", () => {
  const states = {
    "VOO:latest": state("VOO", 200e9, 40),
    "VTI:latest": state("VTI", 100e9, 30, "2024-06-30"),
  };
  const universe = fundUniverse([], [], states);
  assert.deepEqual(
    screenFunds(
      universe,
      { sort: "netAssets", direction: "desc" },
      [],
      "2026-09-01",
    )
      .rows.slice(0, 2)
      .map((f) => f.ticker),
    ["VOO", "VTI"],
  );
  assert.deepEqual(
    screenFunds(
      universe,
      { sort: "netAssets", direction: "asc" },
      [],
      "2026-09-01",
    )
      .rows.slice(0, 2)
      .map((f) => f.ticker),
    ["VTI", "VOO"],
  );
  assert.deepEqual(
    screenFunds(universe, { maxAge: "100" }, [], "2026-09-01").rows.map(
      (f) => f.ticker,
    ),
    ["VOO"],
  );
});
test("selected report keys resolve their own facts and CSV preserves statuses, raw dollars and source context", () => {
  const report = "0000000001-26-000001";
  const states = { [`VOO:${report}`]: state("VOO", 200e9, 40) };
  const universe = fundUniverse([], ["VOO"], states, { VOO: report });
  const result = screenFunds(universe, { category: "US equity" });
  const csv = fundScreenerCsv(
    result.rows,
    { reportMap: { VOO: report }, tickers: ["VOO"] },
    "2026-09-01T00:00:00Z",
  );
  assert.ok(csv.includes('"200000000000"'));
  assert.ok(csv.includes(report));
  assert.ok(csv.includes('"idle"'));
  assert.ok(csv.includes("https://www.sec.gov/Archives/source.xml"));
  assert.equal(
    fundSnapshotFacts(states[`VOO:${report}`], "2026-01-01").age,
    null,
  );
});
