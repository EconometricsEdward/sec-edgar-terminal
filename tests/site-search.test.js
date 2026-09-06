import test from "node:test";
import assert from "node:assert/strict";
import {
  routeSearch,
  getSuggestions,
  buildDestinationOptions,
  parseActiveSegment,
  normalizeRecentSearches,
} from "../src/utils/searchRouter.js";
import {
  classifyTickerDirectory,
  loadClassifiedTickerMap,
  clearTickerMapCache,
  TICKER_DIRECTORY_TTL,
  tickerDirectoryCoverage,
} from "../src/utils/tickerMapLoader.js";

const map = {
  AAPL: {
    ticker: "AAPL",
    name: "Apple Inc.",
    cik: "0000320193",
    isFund: false,
  },
  MSFT: {
    ticker: "MSFT",
    name: "Microsoft Corp",
    cik: "0000789019",
    isFund: false,
  },
  AI: { ticker: "AI", name: "C3.ai, Inc.", cik: "0001577526", isFund: false },
  SPY: {
    ticker: "SPY",
    name: "SPDR S&P 500 ETF Trust",
    cik: "0000884394",
    isFund: true,
  },
};

test("company destinations preserve the exact selected ticker and classification", () => {
  const decision = routeSearch(" aapl ", map);
  assert.equal(decision.disambiguate.ticker, "AAPL");
  assert.deepEqual(
    decision.disambiguate.options.map((o) => o.path),
    [
      "/analysis/AAPL",
      "/filings/AAPL",
      "/risk?ticker=AAPL",
      "/disclosures?tickers=AAPL",
    ],
  );
  assert.deepEqual(
    buildDestinationOptions("SPY", map.SPY).map((o) => o.path),
    ["/fund/SPY"],
  );
  assert.equal(routeSearch("Apple Inc.", map).disambiguate.ticker, "AAPL");
});

test("topic overlaps expose both meanings while normal topics and explicit phrases preserve their terms", () => {
  assert.equal(
    routeSearch("AI", map).disambiguate.options[0].path,
    "/disclosures?query=artificial%20intelligence",
  );
  assert.equal(
    routeSearch("liquidity", map).path,
    "/disclosures?query=liquidity",
  );
  assert.equal(
    routeSearch("covenant waiver", map).path,
    "/disclosures?query=covenant%20waiver",
  );
  assert.equal(
    routeSearch("topic: covenant waiver", null).path,
    "/disclosures?query=covenant%20waiver",
  );
  assert.equal(
    getSuggestions("AI", map).suggestions.filter((s) => s.ticker === "AI")
      .length,
    1,
  );
});

test("missing directories never turn a ticker or overlapping topic into a broad search", () => {
  for (const value of [null, {}])
    for (const query of ["JPM", "AI", "AAPL,MSFT", "Apple"])
      assert.ok(routeSearch(query, value).error);
  assert.match(routeSearch("ZZZZ", map).error, /not found/);
});

test("company comparison deduplicates tickers and rejects funds, topics and incomplete identities", () => {
  assert.equal(
    routeSearch("aapl, MSFT, aapl,", map).path,
    "/compare/AAPL,MSFT",
  );
  assert.match(routeSearch("AAPL,AAPL", map).error, /at least 2/);
  assert.match(routeSearch("AAPL,SPY", map).error, /does not support funds/);
  assert.match(routeSearch("AAPL,CYBER", map).error, /public-company/);
  assert.match(routeSearch("AAPL,NOPE", map).error, /Not recognized/);
  assert.equal(
    getSuggestions("AAPL,S", map).suggestions.some((s) => s.ticker === "SPY"),
    false,
  );
  assert.deepEqual(parseActiveSegment("AAPL, aapl, MSFT").completed, ["AAPL"]);
});

test("recent searches reject executable, external and malformed paths and retain distinct tools for one company", () => {
  const entries = [
    { query: "AAPL", path: "/analysis/AAPL", ts: 3 },
    { query: "AAPL", path: "/filings/AAPL", ts: 2 },
    { query: "again", path: "/analysis/AAPL", ts: 1 },
    { query: "bad", path: "javascript:alert(1)", ts: 0 },
    { query: "external", path: "//evil.example/x", ts: 0 },
    { query: "no time", path: "/risk" },
    null,
  ];
  assert.deepEqual(
    normalizeRecentSearches(entries).map((x) => x.path),
    ["/analysis/AAPL", "/filings/AAPL"],
  );
});

const companies = {
  0: { ticker: "AAPL", cik_str: 320193, title: "Apple Inc." },
  1: { ticker: "SPY", cik_str: 884394, title: "SPDR S&P 500 ETF Trust" },
};
const funds = {
  fields: ["cik", "seriesId", "classId", "symbol"],
  data: [
    [36405, "s", "c", "VOO"],
    [36405, "s", "c", null],
  ],
};

test("directory classification validates both files, recognizes named columns, and tolerates untickered share classes", () => {
  const result = classifyTickerDirectory(companies, funds);
  assert.equal(result.AAPL.isFund, false);
  assert.equal(result.SPY.isFund, true);
  assert.equal(result.VOO.isFund, true);
  assert.equal(result.VOO.cik, "0000036405");
  const withUnsupported = classifyTickerDirectory(companies, {
    ...funds,
    data: [
      ...funds.data,
      [36405, "s", "c", "n/a"],
      [36405, "s", "c", "(NWAKX)"],
    ],
  });
  assert.equal(withUnsupported.NWAKX, undefined);
  assert.equal(tickerDirectoryCoverage(withUnsupported).omittedSymbols, 3);
  assert.equal(
    classifyTickerDirectory(companies, {
      fields: ["symbol", "cik"],
      data: [["VOO", 36405]],
    }).VOO.isFund,
    true,
  );
  for (const pair of [
    [{}, funds],
    [companies, {}],
    [companies, { fields: ["cik", "symbol"], data: [] }],
    [{ 0: { ticker: "AAPL", cik_str: "bad", title: "Apple" } }, funds],
    [companies, { fields: ["cik", "symbol"], data: [[36405, "bad ticker"]] }],
  ])
    assert.throws(() => classifyTickerDirectory(...pair));
});

test("directory requests deduplicate, failures are retryable, and expired complete caches refresh", async () => {
  const originalFetch = global.fetch,
    originalNow = Date.now;
  let calls = 0,
    fail = true,
    now = 10000000;
  Date.now = () => now;
  global.fetch = async (url) => {
    calls++;
    if (fail && url.includes("mf.json")) return { ok: false, status: 503 };
    return {
      ok: true,
      json: async () => (url.includes("mf.json") ? funds : companies),
    };
  };
  clearTickerMapCache();
  try {
    const first = loadClassifiedTickerMap(),
      second = loadClassifiedTickerMap();
    assert.equal(first, second);
    await assert.rejects(first, /503/);
    assert.equal(calls, 2);
    fail = false;
    const result = await loadClassifiedTickerMap();
    assert.ok(result.AAPL);
    assert.equal(calls, 4);
    assert.equal(await loadClassifiedTickerMap(), result);
    assert.equal(calls, 4);
    now += TICKER_DIRECTORY_TTL + 1;
    await loadClassifiedTickerMap();
    assert.equal(calls, 6);
    await loadClassifiedTickerMap({ force: true });
    assert.equal(calls, 8);
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
    clearTickerMapCache();
  }
});
