import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";
import { buildPortfolioDemoUniverse, validatePortfolioDemoUniverse } from "../src/utils/portfolioDemoUniverse.js";
import { hypotheticalDemoHoldings } from "../src/utils/portfolioDemoAllocation.js";

const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));
const source = read("../src/data/portfolio-demo-source-2026-09-11.json");
const universe = read("../public/portfolio/portfolio-demo-100-universe.json");

test("the reviewed Supabase source archive reproduces all 503 listed security weights", () => {
  const bytes = gunzipSync(Buffer.from(source.csv_gzip_base64, "base64"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), universe.source.sha256);
  assert.equal(universe.source.sha256, source.snapshot.sourceSnapshot.sha256);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  assert.ok(lines.includes('Fund Holdings as of,"Sep 11, 2026"'));
  const header = lines.find(line => line.startsWith("Ticker,Name,"));
  const expected = new Map(source.rows.map(row => [row.ticker, row]));
  for (const line of lines) {
    if (!line.includes('","Equity",')) continue;
    const parsed = parsePortfolioCsv(`${header}\n${line}`);
    const values = Object.fromEntries(parsed.headers.map((name, index) => [name, parsed.records[0][index]]));
    const ticker = values.Ticker.replaceAll(".", "-").replaceAll(" ", "-");
    if (!expected.has(ticker)) {
      assert.ok(source.snapshot.sourceExclusions.some(row => row.ticker === ticker));
      continue;
    }
    assert.deepEqual(expected.get(ticker), {
      ticker, weight_pct: Number(values["Weight (%)"]), market_value_usd: Number(values["Market Value"].replaceAll(",", "")),
    });
    expected.delete(ticker);
  }
  assert.equal(expected.size, 0);
  assert.equal(source.rows.length, 503);
});

test("all 500 source issuers are ranked before selecting exactly 100 companies", () => {
  assert.deepEqual(buildPortfolioDemoUniverse(source.snapshot, source.rows), universe);
  assert.equal(universe.selection.availableIssuers, 500);
  assert.equal(new Set(universe.companies.map(row => row.cik)).size, 100);
  assert.deepEqual(universe.companies.slice(0, 5).map(row => row.ticker), ["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN"]);
  assert.ok(universe.companies.some(row => row.ticker === "BRK-B"));
  assert.equal(universe.companies.at(-1).ticker, "MO");
});

test("share classes are combined at the SEC issuer level and the largest class represents it", () => {
  const alphabet = universe.companies.find(row => row.ticker === "GOOGL");
  assert.equal(alphabet.rank, 4);
  assert.equal(alphabet.weight_pct, 5.4);
  assert.equal(alphabet.market_value_usd, 44672090546.2);
  assert.deepEqual(alphabet.share_classes.map(row => row.ticker), ["GOOGL", "GOOG"]);
  assert.equal(universe.companies.filter(row => row.cik === alphabet.cik).length, 1);
});

test("selection is independent of the source array order", () => {
  const snapshot = structuredClone(source.snapshot);
  snapshot.issuers.reverse();
  for (const issuer of snapshot.issuers) issuer.aliases.reverse();
  assert.deepEqual(buildPortfolioDemoUniverse(snapshot, [...source.rows].reverse()), universe);
});

test("unknown, duplicated, missing or invalid source holdings fail the entire selection", () => {
  for (const mutate of [
    rows => { rows[0].ticker = "FAKE"; },
    rows => { rows[0] = { ...rows[1] }; },
    rows => { rows.pop(); },
    rows => { rows[0].weight_pct = null; },
    rows => { rows[0].weight_pct = -1; },
    rows => { rows[0].market_value_usd = NaN; },
  ]) {
    const rows = structuredClone(source.rows); mutate(rows);
    assert.throws(() => buildPortfolioDemoUniverse(source.snapshot, rows), /Demo universe/);
  }
});

test("source identity, ranks, company identities and combined weights cannot silently change", () => {
  for (const mutate of [
    value => { value.source.url = "https://example.com/holdings.csv"; },
    value => { value.source.asOf = "2026-09-31"; },
    value => { value.membership_id = value.membership_id.replace("09-11", "09-10"); },
    value => { value.companies[0].cik = value.companies[1].cik; },
    value => { value.companies[0].rank = 2; },
    value => { value.companies[0].weight_pct = 5; },
    value => { value.companies.find(row => row.ticker === "GOOGL").ticker = "GOOG"; },
    value => { [value.companies[0], value.companies[1]] = [value.companies[1], value.companies[0]]; },
  ]) {
    const next = structuredClone(universe); mutate(next);
    assert.throws(() => validatePortfolioDemoUniverse(next), /Demo universe/);
  }
});

test("illustrative allocations cover the same 100 companies without copying fund weights", () => {
  const tickers = universe.companies.map(row => row.ticker);
  const holdings = hypotheticalDemoHoldings(tickers);
  assert.deepEqual(holdings.map(row => row.ticker), tickers);
  assert.deepEqual([5, 2, 1, 0.3].map(weight => holdings.filter(row => row.weight_pct === weight).length), [5, 15, 30, 50]);
  assert.ok(Math.abs(holdings.reduce((sum, row) => sum + row.weight_pct, 0) - 100) < 1e-8);
  assert.equal(holdings[0].weight_pct, 5);
  assert.equal(universe.companies[0].weight_pct, 8);
  assert.throws(() => hypotheticalDemoHoldings(tickers.slice(1)), /100 unique/);
});
