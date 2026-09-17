import test from "node:test";
import assert from "node:assert/strict";
import {
  marketComparisonHistoryPath,
  marketComparisonKey,
  summarizePortfolioMarketHistory,
} from "../src/utils/portfolioMarketComparison.js";

const now = new Date("2026-09-14T12:00:00Z");
const candidate = {
  family: "tff",
  contract: "134741",
  group: "leveraged-funds",
};
const observation = (reportDate, long, short = 20, openInterest = 100) => ({
  reportDate,
  long,
  short,
  openInterest,
  netPctOi: -999, // Incoming derived values must never drive the comparison.
});
function history() {
  return {
    schema_version: "edgar.cftc-positioning.v1",
    status: "ready",
    report_family: candidate.family,
    report_basis: "futures_only",
    selection: { contract: candidate.contract, group: candidate.group },
    selected: {
      family: candidate.family,
      code: candidate.contract,
      reportBasis: "futures_only",
      reportDate: "2026-09-08",
      openInterest: 200,
      selectedGroup: { id: candidate.group, long: 80, short: 20 },
    },
    source: {
      dataset_id: "gpe5-46if",
      report_basis: "futures_only",
      url: "https://publicreporting.cftc.gov/resource/gpe5-46if.json?$limit=100",
    },
    freshness: {},
    history: [
      observation("2026-08-25", 10),
      observation("2026-09-01", 70),
      observation("2026-09-08", 80, 20, 200),
    ],
  };
}

test("identities and prepared request paths match the selected market drilldown", () => {
  assert.equal(marketComparisonKey(candidate), "tff:134741:leveraged-funds");
  assert.equal(
    marketComparisonHistoryPath(candidate),
    "/api/v1/cftc/history?family=tff&contract=134741&group=leveraged-funds&window=1y&date=latest",
  );
  assert.equal(
    marketComparisonHistoryPath(candidate, "2026-09-08"),
    "/api/v1/cftc/history?family=tff&contract=134741&group=leveraged-funds&window=1y&date=2026-09-08",
  );
  for (const date of [null, "", "2026-02-30", "2026-09-08&window=5y", "2026-09-08T00:00:00Z"])
    assert.equal(marketComparisonHistoryPath(candidate, date), null);
  for (const invalid of [
    null,
    {},
    { ...candidate, family: "combined" },
    { ...candidate, family: "__proto__" },
    { ...candidate, contract: "134741&window=5y" },
    { ...candidate, group: "managed-money" },
  ]) {
    assert.equal(marketComparisonKey(invalid), null);
    assert.equal(marketComparisonHistoryPath(invalid), null);
    assert.equal(summarizePortfolioMarketHistory(history(), invalid, now), null);
  }
});

test("compares normalized net/OI values and distinguishes range position from a percentile", () => {
  const result = summarizePortfolioMarketHistory(history(), candidate, now);
  assert.equal(result.netPctOi, 30);
  assert.equal(result.weeklyChangePp, -20);
  assert.equal(result.priorDate, "2026-09-01");
  assert.deepEqual(result.range, {
    min: -10,
    max: 50,
    position: (100 * 40) / 60,
    count: 3,
    start: "2026-08-25",
    end: "2026-09-08",
  });
  assert.equal(result.observationCount, 3);
  assert.equal(result.historyStart, result.range.start);
  assert.equal(result.historyEnd, result.range.end);
  assert.equal(result.reportDate, "2026-09-08");
  assert.equal(result.groupLabel, "Leveraged Funds");
  assert.equal(result.ageDays, 6);
  assert.equal(result.stale, false);
  assert.equal(result.incomplete, true, "three valid reports do not establish a complete annual range");
  assert.match(result.marketPath, /date=2026-09-08/);
  assert.equal(result.sourceUrl, history().source.url);
});

test("a missing exact prior week does not substitute the nearest available report", () => {
  const input = history();
  input.history[1].reportDate = "2026-09-02";
  const result = summarizePortfolioMarketHistory(input, candidate, now);
  assert.equal(result.weeklyChangePp, null);
  assert.equal(result.priorDate, "2026-09-01");
  assert.equal(result.range.count, 3);
  assert.equal(result.netPctOi, 30);
});

test("selected report identity, futures-only dataset and official source fail closed", () => {
  for (const change of [
    (h) => { h.status = "loading"; },
    (h) => { h.report_family = "disaggregated"; },
    (h) => { h.report_basis = "combined"; },
    (h) => { h.selected.code = "043602"; },
    (h) => { h.selection.group = "asset-manager"; },
    (h) => { h.selected.selectedGroup.id = "asset-manager"; },
    (h) => { h.selected.reportDate = "2026-09-15"; },
    (h) => { h.selected.reportDate = "2026-02-30"; },
    (h) => { h.source.dataset_id = "72hh-3qpy"; },
    (h) => { h.source.url = "https://publicreporting.cftc.gov.evil.example/resource/gpe5-46if.json"; },
    (h) => { h.source.url = "https://user:password@publicreporting.cftc.gov/resource/gpe5-46if.json"; },
    (h) => { h.selected.selectedGroup.long = 81; },
    (h) => { h.selected.openInterest = 201; },
  ]) {
    const input = history();
    change(input);
    assert.equal(summarizePortfolioMarketHistory(input, candidate, now), null);
  }
  assert.equal(summarizePortfolioMarketHistory(undefined, candidate, now), null);
});

test("missing or invalid current observations do not reuse older net/OI or a range marker", () => {
  for (const change of [
    (h) => { h.history.pop(); },
    (h) => { h.history[2].openInterest = h.selected.openInterest = 0; },
    (h) => { h.history[2].openInterest = h.selected.openInterest = null; },
    (h) => { h.history[2].long = h.selected.selectedGroup.long = null; },
    (h) => { h.history[2].long = h.selected.selectedGroup.long = 201; },
    (h) => { h.history[2].raw = { cftc_contract_market_code: "043602", futonly_or_combined: "FutOnly" }; },
    (h) => { h.history.push({ ...h.history[2] }); },
  ]) {
    const input = history();
    change(input);
    const result = summarizePortfolioMarketHistory(input, candidate, now);
    assert.equal(result.netPctOi, null);
    assert.equal(result.weeklyChangePp, null);
    assert.equal(result.range.position, null);
    assert.equal(result.range.count, 2);
    assert.equal(result.range.end, "2026-09-01");
    assert.equal(result.incomplete, true);
    assert.equal(result.reportDate, "2026-09-08");
  }
});

test("zero and unchanged positioning remain real values; a flat range has no relative position", () => {
  const input = history();
  input.history = input.history.map((point) => ({ ...point, long: 20, short: 20 }));
  input.selected.selectedGroup.long = 20;
  const result = summarizePortfolioMarketHistory(input, candidate, now);
  assert.equal(result.netPctOi, 0);
  assert.equal(result.weeklyChangePp, 0);
  assert.equal(result.range.min, 0);
  assert.equal(result.range.max, 0);
  assert.equal(result.range.position, null);
});

test("history ranges use only valid observations inside the trailing 52-week window", () => {
  const input = history();
  input.history.push(
    observation("2025-09-08", 100), // 365 days before selected; outside window.
    observation("2025-09-09", 0), // Exactly 52 weeks before selected; included.
    observation("2026-09-15", 100), // Later than selected; excluded.
    observation("2026-08-18", null),
    observation("2026-02-30", 100),
  );
  const result = summarizePortfolioMarketHistory(input, candidate, now);
  assert.equal(result.range.count, 4);
  assert.equal(result.range.min, -20);
  assert.equal(result.range.max, 50);
  assert.equal(result.range.start, "2025-09-09");
  assert.equal(result.range.end, "2026-09-08");
  assert.equal(result.incomplete, true);
});

test("one valid observation never fabricates a historical range", () => {
  const input = history();
  input.history = input.history.slice(-1);
  const result = summarizePortfolioMarketHistory(input, candidate, now);
  assert.equal(result.netPctOi, 30);
  assert.equal(result.weeklyChangePp, null);
  assert.equal(result.range, null);
  assert.equal(result.observationCount, 1);
  assert.equal(result.historyStart, "2026-09-08");
  assert.equal(result.historyEnd, "2026-09-08");
  assert.equal(result.incomplete, true);
});

test("partial and stale source states are retained alongside available values", () => {
  const partial = history();
  partial.status = "partial";
  assert.equal(summarizePortfolioMarketHistory(partial, candidate, now).incomplete, true);
  const cached = history();
  cached.freshness.cache_status = "stale_refresh_pending";
  assert.equal(summarizePortfolioMarketHistory(cached, candidate, now).stale, true);
  assert.equal(summarizePortfolioMarketHistory(history(), candidate, new Date("2026-10-01")).stale, true);
  const stale = history();
  stale.status = "stale";
  const result = summarizePortfolioMarketHistory(stale, candidate, now);
  assert.equal(result.stale, true);
  assert.equal(result.incomplete, true);
  assert.equal(result.netPctOi, 30);
});

test("complete annual coverage requires 52 valid observations spanning about 51 weeks", () => {
  const input = history();
  input.history = Array.from({ length: 52 }, (_, index) => observation(
    new Date(Date.parse("2026-09-08T00:00:00Z") - index * 7 * 86_400_000).toISOString().slice(0, 10),
    80, 20, 200,
  ));
  assert.equal(summarizePortfolioMarketHistory(input, candidate, now).incomplete, false);
  const shifted = structuredClone(input);
  shifted.history[51].reportDate = new Date(Date.parse(shifted.history[51].reportDate) + 86_400_000).toISOString().slice(0, 10);
  assert.equal(summarizePortfolioMarketHistory(shifted, candidate, now).incomplete, false, "official one-day calendar shift is allowed");
  input.history.pop();
  assert.equal(summarizePortfolioMarketHistory(input, candidate, now).incomplete, true);
  input.history = Array.from({ length: 52 }, (_, index) => observation(
    new Date(Date.parse("2026-09-08T00:00:00Z") - index * 86_400_000).toISOString().slice(0, 10),
    80, 20, 200,
  ));
  assert.equal(summarizePortfolioMarketHistory(input, candidate, now).incomplete, true, "52 values in 51 days do not form a year of weekly coverage");
});
