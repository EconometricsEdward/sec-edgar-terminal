import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverFundSecurity,
  discoveryWindows,
  readDiscoveryCursor,
  splitDiscoveryWindow,
  normalizeNportHit,
  latestNportCandidate,
} from "../src/utils/globalFundDiscoveryServer.js";
const date = "2026-09-07";
const accession = (n) => `0000000001-26-${String(n).padStart(6, "0")}`;
const hit = (n, patch = {}) => ({
  _id: `${accession(n)}:primary_doc.xml`,
  _source: {
    ciks: ["0000000001"],
    adsh: accession(n),
    form: "NPORT-P",
    display_names: ["Fund Trust (CIK 0000000001)"],
    period_ending: "2026-06-30",
    file_date: "2026-08-31",
    ...patch,
  },
});
const holding = (patch = {}) => ({
  name: "Apple Inc",
  tickerSymbol: "AAPL",
  assetCat: "EC",
  cusip: "037833100",
  value: 100,
  pctOfNav: 5,
  ...patch,
});
const report = (n, patch = {}) => ({
  cik: "0000000001",
  seriesId: `S${n}`,
  name: `Fund ${n}`,
  asOf: "2026-06-30",
  filingDate: "2026-08-31",
  accession: accession(n),
  sourceUrl: "https://www.sec.gov/report.xml",
  holdings: [holding()],
  ...patch,
});
const dependencies = (patch = {}) => ({
  today: date,
  operatingDirectory: { AAPL: { cik: "0000320193", name: "Apple Inc." } },
  seriesTickers: {},
  searchPage: async () => ({ hits: [], total: 0, relation: "eq" }),
  loadReport: async (candidate) =>
    report(Number(candidate.accession.slice(-6))),
  latestReport: async (fund) => fund,
  ...patch,
});

test("single-letter stock tickers resolve while broad single-letter text is rejected", async () => {
  const result = await discoverFundSecurity(
    { query: "F" },
    dependencies({
      operatingDirectory: { F: { cik: "0000037996", name: "Ford Motor Co" } },
    }),
  );
  assert.equal(result.target.ticker, "F");
  await assert.rejects(
    discoverFundSecurity({ query: "Z" }, dependencies()),
    /recognized stock ticker/,
  );
});

test("latest report verification refuses incomplete metadata and prioritizes portfolio date", () => {
  const older = hit(2, {
    period_ending: "2026-03-31",
    file_date: "2026-09-01",
  });
  const current = hit(1);
  assert.equal(
    latestNportCandidate({ hits: [older, current], total: 2, relation: "eq" })
      .accession,
    accession(1),
  );
  assert.throws(
    () => latestNportCandidate({ hits: [current], total: 2, relation: "eq" }),
    /safely verified/,
  );
  assert.throws(
    () =>
      latestNportCandidate({
        hits: [current, hit(3, { period_ending: "" })],
        total: 2,
        relation: "eq",
      }),
    /no valid portfolio date/,
  );
});

test("global search requires no selected fund and resolves Apple/ticker before searching", async () => {
  const queries = [];
  const result = await discoverFundSecurity(
    { query: "AAPL", asset: "EC" },
    dependencies({
      searchPage: async (term, range) => {
        queries.push(term);
        return {
          hits: range.end === date ? [hit(1)] : [],
          total: range.end === date ? 1 : 0,
        };
      },
    }),
  );
  assert.equal(result.funds.length, 1);
  assert.equal(result.target.ticker, "AAPL");
  assert.ok(queries.every((q) => q.includes("apple")));
  assert.equal(result.funds[0].tickers.length, 0);
  assert.equal(result.nextCursor, null);
});

test("discovery windows partition the full year without gaps or overlapping days", () => {
  const windows = discoveryWindows(date);
  assert.equal(windows[0].end, date);
  assert.equal(windows.at(-1).start, "2025-09-07");
  for (let i = 1; i < windows.length; i++)
    assert.equal(
      Date.parse(windows[i - 1].start) - Date.parse(windows[i].end),
      86400000,
    );
  const [newer, older] = splitDiscoveryWindow(windows[1]);
  assert.equal(newer.end, windows[1].end);
  assert.equal(older.start, windows[1].start);
  assert.equal(Date.parse(newer.start) - Date.parse(older.end), 86400000);
  assert.throws(
    () => splitDiscoveryWindow({ start: date, end: date, offset: 0 }),
    /more specific/,
  );
});

test("cursors bind to the security and filter and reject invalid or overlapping ranges", () => {
  const state = readDiscoveryCursor("", "Apple", "EC", date);
  const token = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  assert.deepEqual(
    readDiscoveryCursor(token(state), "Apple", "EC", date),
    state,
  );
  assert.throws(
    () => readDiscoveryCursor(token(state), "Microsoft", "EC", date),
    /changed/,
  );
  assert.throws(
    () => readDiscoveryCursor(token(state), "Apple", "all", date),
    /changed/,
  );
  assert.throws(
    () =>
      readDiscoveryCursor(
        token({ ...state, ranges: [{ start: date, end: date, offset: -1 }] }),
        "Apple",
        "EC",
        date,
      ),
    /Invalid/,
  );
  assert.throws(
    () =>
      readDiscoveryCursor(
        token({ ...state, ranges: [state.ranges[0], state.ranges[0]] }),
        "Apple",
        "EC",
        date,
      ),
    /Invalid/,
  );
});

test("N-PORT hits preserve series-independent accession and reject unsafe document names", () => {
  assert.equal(
    normalizeNportHit(hit(1, { form: "NPORT-P/A" })).form,
    "NPORT-P/A",
  );
  assert.equal(
    normalizeNportHit({ ...hit(1), _id: `${accession(1)}:../../x.xml` })
      .documentName,
    null,
  );
  assert.equal(normalizeNportHit(hit(1, { adsh: "bad" })), null);
  assert.equal(normalizeNportHit(hit(1, { form: "13F-HR" })), null);
});

test("global pages continue after 24 documents instead of stopping at the selected-fund limit", async () => {
  const all = Array.from({ length: 30 }, (_, i) => hit(i + 1));
  const deps = dependencies({
    searchPage: async (_, range) => ({
      hits: range.end === date ? all : [],
      total: range.end === date ? 30 : 0,
    }),
  });
  const first = await discoverFundSecurity({ query: "Apple" }, deps);
  assert.equal(first.funds.length, 24);
  assert.equal(first.coverage.scannedDocuments, 24);
  assert.ok(first.nextCursor);
  const second = await discoverFundSecurity(
    { query: "Apple", cursor: first.nextCursor },
    deps,
  );
  assert.equal(second.funds.length, 6);
  assert.equal(second.funds[0].accession, accession(25));
  assert.equal(second.nextCursor, null);
});

test("full-text duplicates, derivative-only mentions and sold holdings do not become stock owners", async () => {
  let latestCalls = 0;
  const docs = [
    hit(1),
    { ...hit(1), _id: `${accession(1)}:report.htm` },
    hit(2),
    hit(3),
    hit(4),
  ];
  const result = await discoverFundSecurity(
    { query: "Apple" },
    dependencies({
      searchPage: async (_, r) => ({
        hits: r.end === date ? docs : [],
        total: r.end === date ? docs.length : 0,
      }),
      loadReport: async (c) =>
        report(Number(c.accession.slice(-6)), {
          holdings: [
            holding({ assetCat: c.accession === accession(2) ? "DE" : "EC" }),
          ],
        }),
      latestReport: async (p) => {
        latestCalls++;
        if (p.seriesId === "S4") throw new Error("Unavailable latest report");
        return p.seriesId === "S3" ? { ...p, holdings: [] } : p;
      },
    }),
  );
  assert.equal(result.funds.length, 1);
  assert.equal(result.funds[0].seriesId, "S1");
  assert.equal(latestCalls, 3);
  assert.equal(result.coverage.unavailableCount, 1);
  assert.equal(result.coverage.excludedCount, 2);
  assert.equal(result.issues[0].accession, accession(4));
});

test("large SEC result windows split before hitting the 10000 document cap", async () => {
  const ranges = [];
  await discoverFundSecurity(
    { query: "Apple" },
    dependencies({
      searchPage: async (_, r) => {
        ranges.push(r);
        const wide = r.end === date && r.start === "2026-09-01";
        return {
          hits: [],
          total: wide ? 10000 : 0,
          relation: wide ? "gte" : "eq",
        };
      },
    }),
  );
  assert.ok(ranges.some((r) => r.start === "2026-09-05" && r.end === date));
});
