import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompareSettings, readCompareUrl, comparePath } from "../src/utils/compareSettings.js";
import { exportCompareTableCsv } from "../src/utils/compareCsv.js";
import { createCompareClientCache, compareResponseExpiresAt } from "../src/utils/compareClientCache.js";
import { buildCompareCompanyIndex, compareCompanySuggestions } from "../src/utils/compareCompanySearch.js";

test("legacy notebook and snapshot URLs open the current comparison without losing financial settings", () => {
  const settings = readCompareUrl("?view=notebook&changeMode=snapshots&basis=quarter&asOf=2025-12-31&metrics=revenue,netIncome");
  assert.equal(settings.view, "table");
  assert.equal(settings.changeMode, "periods");
  assert.equal(settings.basis, "quarter");
  assert.equal(settings.asOf, "2025-12-31");
  assert.deepEqual(settings.metrics, ["revenue", "netIncome"]);
  const url = comparePath(["GS", "JPM"], settings);
  assert.ok(!url.includes("notebook") && !url.includes("snapshots"));
  assert.deepEqual(readCompareUrl(url.split("?")[1]), settings);
});

test("CSV retains each source input and keeps missing observations distinct from zero", () => {
  const source = { tag: "us-gaap:Revenues", value: 5, unit: "USD", start: "2025-01-01", end: "2025-12-31", filed: "2026-02-01", accession: "0000000001-26-000001", documentUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm" };
  const metric = { key: "revenue", label: "Revenue", format: "currency" };
  const csv = exportCompareTableCsv([
    { metric, cell: { ticker: "AAA", name: '=HYPERLINK("danger")', cik: "0000000001", point: { value: 0, classification: "reported", period: { kind: "annual", start: source.start, end: source.end }, sources: [source, { ...source, value: 4, tag: "us-gaap:OtherRevenue" }] } } },
    { metric, cell: { ticker: "BBB", status: "fetch failed", period: { kind: "annual", end: source.end }, point: null } },
  ], { tickers: ["AAA", "BBB"], settings: normalizeCompareSettings({ basis: "annual" }) });
  const rows = csv.split("\r\n");
  assert.equal(rows.length, 4);
  assert.ok(rows[1].includes('"0","currency"'));
  assert.ok(rows[2].includes('"0","currency"'));
  assert.ok(rows[3].includes('"","currency"'));
  assert.ok(rows[3].includes('"fetch failed"'));
  assert.ok(rows[1].includes("'=HYPERLINK"));
  assert.ok(rows[1].includes(source.accession));
  assert.ok(rows[2].includes("us-gaap:OtherRevenue"));
  assert.ok(!rows[0].includes("collection") && !rows[0].includes("saved_at"));
});

test("healthy revalidated prepared responses cache despite an old payload observation, without extending HTTP freshness", () => {
  let now = Date.parse("2026-09-19T00:00:00Z");
  const startedAt = now;
  const cache = createCompareClientCache({ now: () => now });
  const value = { observedAt: "2026-09-18T00:00:00Z" };
  const headers = new Headers({
    "Cache-Control": "public, max-age=60, s-maxage=300",
    "X-Data-Fetched-At": "2026-09-18T00:00:00Z",
    "X-Data-Revalidated-At": "2026-09-18T23:55:00Z",
    "X-Data-Stale": "false",
    Date: new Date(now - 10000).toUTCString(), Age: "10",
  });
  assert.equal(cache.set("AAA:annual:", value, 100, { headers, requestStartedAt: now }), true);
  now += 49000;
  assert.equal(cache.get("AAA:annual:"), value);
  now += 1001;
  assert.equal(cache.get("AAA:annual:"), null);
  // Reusing the same response metadata cannot restart the freshness window.
  assert.equal(cache.set("AAA:annual:", value, 100, { headers, requestStartedAt: startedAt }), false);
});

test("HTTP freshness rejects stale, degraded and expired responses, and honors CDN age and origin expiry", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const headers = (extra = {}) => new Headers({ "Cache-Control": "public, max-age=60, s-maxage=300", ...extra });
  assert.equal(compareResponseExpiresAt(headers({ "X-Data-Stale": "true" }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ "Cache-Control": "private, no-store" }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ "Cache-Control": "public, max-age=0, s-maxage=60, must-revalidate" }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ Age: "61" }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ Warning: '110 - "Previously validated SEC data"' }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ Age: "50" }), { now, requestStartedAt: now - 2000 }), now + 8000);
  assert.equal(compareResponseExpiresAt(headers({ "X-Data-Expires-At": new Date(now + 7000).toISOString() }), { now }), now + 7000);
  assert.equal(compareResponseExpiresAt(headers({ "X-Data-Expires-At": new Date(now - 1).toISOString() }), { now }), null);
  assert.equal(compareResponseExpiresAt(headers({ "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300", Age: "290" }), { now }), now + 10000);
  const cache = createCompareClientCache({ now: () => now });
  assert.equal(cache.set("degraded", { sourceCoverage: { filingFallback: { status: "unavailable" } } }, 100, { headers: headers() }), false);
  assert.equal(cache.set("unknown", { observedAt: new Date(now).toISOString() }, 100), false);
});

test("comparison cache bounds retained selections and packed size, evicting least recently used", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const cache = createCompareClientCache({ now: () => now, maxEntries: 2, maxBytes: 250 });
  const value = { observedAt: new Date(now).toISOString() };
  const freshness = { headers: new Headers({ "Cache-Control": "public, max-age=60" }) };
  cache.set("AAA:annual:", value, 100, freshness);
  cache.set("AAA:quarter:", value, 100, freshness);
  cache.get("AAA:annual:");
  cache.set("BBB:annual:", value, 100, freshness);
  assert.equal(cache.get("AAA:quarter:"), null);
  assert.equal(cache.get("AAA:annual:"), value);
  cache.set("CCC:annual:", value, 200, freshness);
  assert.equal(cache.get("AAA:annual:"), null);
  assert.equal(cache.get("BBB:annual:"), null);
  assert.equal(cache.set("large", value, 251, freshness), false);
  cache.clear();
  assert.equal(cache.get("CCC:annual:"), null);
});

const companies = buildCompareCompanyIndex({
  F: { ticker: "F", name: "Ford Motor Co", cik: "0000037996" },
  FORD: { ticker: "FORD", name: "Forward Industries, Inc.", cik: "0000038264" },
  JPM: { ticker: "JPM", name: "JPMorgan Chase & Co", cik: "0000019617" },
  JPMD: { ticker: "JPMD", name: "Another issuer", cik: "0000000002" },
  "BRK-B": { ticker: "BRK-B", name: "Berkshire Hathaway Inc.", cik: "0001067983" },
  V: { ticker: "V", name: "Visa Inc.", cik: "0001403161" },
});
test("company suggestions preserve exact ticker identity and verified share classes", () => {
  assert.equal(compareCompanySuggestions(companies, "Ford Motor")[0].ticker, "F");
  assert.equal(companies.resolveTicker("FORD").ticker, "FORD");
  assert.equal(compareCompanySuggestions(companies, "V")[0].ticker, "V");
  assert.equal(companies.resolveTicker("BRK.B").ticker, "BRK-B");
  assert.equal(companies.resolveTicker("UNKNOWN.B"), null);
  assert.deepEqual(compareCompanySuggestions(companies, "JPM", ["JPM"]), []);
  assert.deepEqual(compareCompanySuggestions(companies, "JPM F V"), []);
  const exactDot = buildCompareCompanyIndex({ "BRK.B": { ticker: "BRK.B", name: "Exact entry" }, "BRK-B": { ticker: "BRK-B", name: "Dash entry" } });
  assert.equal(exactDot.resolveTicker("BRK.B").name, "Exact entry");
});
