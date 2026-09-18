import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisBriefMatches,
  analysisBrowserCacheKey,
  createAnalysisBrowserCache,
  matchesAnalysisResponse,
} from "../src/utils/analysisBrowserCache.js";
import { unpackAnalysisCompany } from "../src/utils/analysisResearch.js";
import { ANALYSIS_VERSION, ANALYSIS_MAPPING_VERSION } from "../src/utils/analysisVersion.js";

const packed = (value = 120) => ({
  packed: true,
  version: ANALYSIS_VERSION,
  mappingVersion: ANALYSIS_MAPPING_VERSION,
  ticker: "AAPL",
  basis: "annual",
  asOf: "",
  definitions: [{ key: "revenue" }],
  periods: [{ kind: "annual", end: "2025-09-27" }],
  metrics: {
    revenue: [{ value, sourceIds: [0], calculationIds: [] }],
    margin: [{ value: 25, sourceIds: [0], calculationIds: [0] }],
  },
  sourceCatalog: [{ taxonomy: "us-gaap", tag: "Revenue", value }],
  calculationCatalog: [{ formula: "income / revenue × 100" }],
});

test("responses must match issuer, basis, cutoff and calculation version", () => {
  const selection = { ticker: "AAPL", basis: "annual", asOf: "" };
  assert.equal(matchesAnalysisResponse(packed(), selection), true);
  for (const change of [{ ticker: "GS" }, { basis: "quarter" }, { asOf: "2025-01-01" }, { version: "old" }, { mappingVersion: undefined }, { packed: false }, { sourceCatalog: null }])
    assert.ok(!matchesAnalysisResponse({ ...packed(), ...change }, selection));
});

test("temporary source gaps expire promptly instead of retaining an incomplete result", () => {
  let time = 0;
  const cache = createAnalysisBrowserCache({ now: () => time });
  cache.set("gap", { ...packed(), sourceCoverage: { filingFallback: { status: "unavailable" } } });
  cache.set("healthy", packed());
  time = 60000;
  assert.equal(cache.get("gap"), null);
  assert.ok(cache.get("healthy"));
  assert.equal(cache.set("old", { ...packed(), version: "old" }), false);
});

test("only selected packed results expand, retaining period and complete evidence", () => {
  const cache = createAnalysisBrowserCache();
  const original = packed();
  cache.set("annual", original);
  original.sourceCatalog[0].value = 999;
  const stored = cache.get("annual");
  assert.equal(stored.packed, true);
  assert.equal(stored.metrics.revenue[0].sources, undefined);
  assert.equal(stored.sourceCatalog[0].value, 120);
  const selected = unpackAnalysisCompany(stored);
  assert.deepEqual(selected.metrics.revenue[0].period, original.periods[0]);
  assert.deepEqual(selected.metrics.margin[0].calculations, original.calculationCatalog);
  selected.metrics.revenue[0].sources[0].value = 888;
  assert.equal(cache.get("annual").sourceCatalog[0].value, 120);
});

test("entry and serialized-payload bounds evict least recently used inactive results", () => {
  const sample = packed();
  const size = JSON.stringify(sample).length * 2;
  const cache = createAnalysisBrowserCache({ maxEntries: 2, maxBytes: size * 3 });
  cache.set("annual", sample);
  cache.set("quarter", sample);
  cache.get("annual");
  cache.set("ttm", sample);
  assert.equal(cache.get("quarter"), null);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().bytes, size * 2);

  const byteLimited = createAnalysisBrowserCache({ maxEntries: 8, maxBytes: size * 2 });
  byteLimited.set("annual", sample);
  byteLimited.set("quarter", sample);
  byteLimited.set("ttm", sample);
  assert.equal(byteLimited.get("annual"), null);
  assert.equal(byteLimited.stats().bytes, size * 2);
  assert.equal(byteLimited.set("oversized", { ...sample, extra: "a".repeat(size * 2) }), false);
  assert.equal(byteLimited.stats().entries, 2);
  assert.equal(byteLimited.set("expanded", unpackAnalysisCompany(sample)), false);
});

test("frequent navigation does not extend stale cache lifetimes", () => {
  let time = 100;
  const cache = createAnalysisBrowserCache({ ttlMs: 50, now: () => time });
  cache.set("annual", packed());
  time = 149;
  assert.ok(cache.get("annual"));
  time = 150;
  assert.equal(cache.get("annual"), null);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test("manual retry drops the previous value and replaces the same selector key", () => {
  const settings = { basis: "annual", asOf: "", end: "latest", retry: 0 };
  const key = analysisBrowserCacheKey("aapl", settings);
  const cache = createAnalysisBrowserCache();
  cache.set(key, packed(120));
  const retriedKey = analysisBrowserCacheKey("AAPL", {
    ...settings, retry: 9, end: "2024-09-28",
  });
  assert.equal(retriedKey, key);
  assert.equal(cache.get(key, { bypass: true }), null);
  assert.equal(cache.get(key), null, "failed retries must not restore the prior response");
  cache.set(retriedKey, packed(130));
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.get(key).metrics.revenue[0].value, 130);
  assert.notEqual(key, analysisBrowserCacheKey("AAPL", { ...settings, basis: "quarter" }));
  assert.notEqual(key, analysisBrowserCacheKey("AAPL", { ...settings, asOf: "2024-10-01" }));
});

test("server brief stays visible only for its exact company, basis, period, vintage and comparison", () => {
  const brief = { ticker: "AAPL", basis: "quarter", end: "2025-06-28", asof: "2025-08-01", baseline: "year" };
  const settings = { basis: "quarter", end: "2025-06-28", asOf: "2025-08-01", baseline: "year" };
  assert.equal(analysisBriefMatches(brief, "AAPL", settings), true);
  assert.equal(analysisBriefMatches(brief, "JPM", settings), false);
  for (const next of [
    { basis: "annual" }, { basis: "ttm" }, { end: "latest" },
    { end: "2024-06-29" }, { asOf: "" }, { baseline: "previous" },
  ]) assert.equal(analysisBriefMatches(brief, "AAPL", { ...settings, ...next }), false);
  assert.equal(analysisBriefMatches(brief, "AAPL", settings), true, "returning to the original selectors restores the brief");
  assert.equal(analysisBriefMatches(
    { ticker: "AAPL", basis: "annual", end: "latest", asof: "", baseline: "year" },
    "AAPL", { basis: "annual", end: "latest", asOf: "", baseline: "year" },
  ), true);
});
