import test from "node:test";
import assert from "node:assert/strict";
import { filerCik, isTickerComparison, mergeFilerSuggestions, exactFilerMatch, validateFilerSearch, createFilerSearchClient } from "../src/utils/secFilerSearch.js";
import { routeSearch, getSuggestions } from "../src/utils/searchRouter.js";

const manager = { cik: "0001747057", name: "D1 Capital Partners L.P.", formTypes: ["13F-HR"] };
const response = (query = "D1 Capital") => ({ query, results: [manager], truncated: true });

test("CIKs open filings without a ticker directory and invalid numeric identifiers fail explicitly", () => {
  for (const input of ["1747057", "0001747057", " 1747057 "]) {
    assert.equal(filerCik(input), manager.cik);
    assert.deepEqual(routeSearch(input, null), { path: "/filings/0001747057" });
  }
  for (const input of ["0", "0000000000", "10000000000"]) {
    assert.equal(filerCik(input), null);
    assert.match(routeSearch(input, null).error, /CIK/);
  }
});

test("legal name punctuation stays a name while ticker lists retain comparison behavior", () => {
  for (const query of ["D1 Capital Partners, L.P.", "Apple Inc.,", "Bridgewater Associates, LP", "Citadel, LLC"]) {
    assert.equal(isTickerComparison(query), false);
    assert.equal(getSuggestions(query, {}).active, query.toUpperCase());
  }
  for (const query of ["aapl,msft", "AAPL, MSFT,", "AAPL,"]) assert.equal(isTickerComparison(query), true);
  assert.equal(isTickerComparison("AAPL, INC", { AAPL: {}, INC: {} }), true);
});

test("filer results retain separate legal entities and never silently choose a prefix", () => {
  const offshore = { cik: "0001750024", name: "D1 Capital Partners Offshore Ltd.", formTypes: [] };
  assert.equal(exactFilerMatch("D1 Capital", [manager, offshore]), null);
  assert.equal(exactFilerMatch("D1 Capital Partners LP", [manager, offshore]), manager);
  assert.equal(exactFilerMatch(manager.name, [manager], { truncated: true }), null);
  assert.equal(exactFilerMatch(manager.name, [manager], { warning: "Incomplete" }), null);
  const rows = mergeFilerSuggestions([{ ticker: "D1 CAPITAL", type: "topic" }], [manager, offshore]);
  assert.deepEqual(rows.map(row => row.type), ["filer", "filer", "topic"]);
  assert.equal(rows[0].path, "/filings/0001747057");
  assert.equal(rows[0].isFund, undefined);
  const apple = { ticker: "AAPL", cik: "0000320193", name: "Apple Inc.", type: "company" };
  assert.equal(mergeFilerSuggestions([apple], [{ cik: apple.cik, name: apple.name, formTypes: [] }]).length, 1);
});

test("search responses cannot replace the requested name or inject duplicate/invalid identities", () => {
  assert.deepEqual(validateFilerSearch(response(), "D1 Capital").results, [manager]);
  for (const value of [response("Another filer"), { ...response(), results: [manager, manager] },
    { ...response(), results: [{ ...manager, cik: "../evil" }] },
    { ...response(), results: [{ ...manager, name: "" }] }])
    assert.throws(() => validateFilerSearch(value, "D1 Capital"), /invalid/);
});

test("successful query responses are bounded and cached while failures and partial results remain retryable", async () => {
  let calls = 0, now = 0, partial = false, fail = false;
  const search = createFilerSearchClient({ now: () => now, fetchImpl: async url => {
    calls++;
    assert.equal(url, "/api/sec-filers?query=D1%20Capital");
    return new Response(JSON.stringify(fail ? { error: "SEC unavailable" } : { ...response(), ...(partial ? { warning: "Some SEC sources unavailable" } : {}) }), { status: fail ? 502 : 200 });
  } });
  await search("D1 Capital"); await search("D1 Capital"); assert.equal(calls, 1);
  now = 300001; partial = true;
  await search("D1 Capital"); await search("D1 Capital"); assert.equal(calls, 3);
  fail = true;
  await assert.rejects(search("D1 Capital"), /SEC unavailable/);
  fail = false; partial = false;
  assert.equal((await search("D1 Capital")).results[0].cik, manager.cik);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search("D1 Capital", { signal: controller.signal }), { name: "AbortError" });
});
