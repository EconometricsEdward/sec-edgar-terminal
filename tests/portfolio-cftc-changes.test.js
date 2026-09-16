import test from "node:test";
import { readFileSync } from "node:fs";
import { buildCftcHistoryResponse } from "../src/utils/cftcServer.js";
import assert from "node:assert/strict";
import {
  buildPortfolioCftcChanges,
  PORTFOLIO_CFTC_COMPANY_LIMIT,
  PORTFOLIO_CFTC_CONCURRENCY,
} from "../src/utils/portfolioCftcChanges.js";
import { POST } from "../src/app/api/v1/cftc/portfolio-changes/route.js";

const company = { ticker: "XOM", cik: "0000034088", rowId: "row-xom" };
const now = new Date("2026-09-14T12:00:00Z");
const markets = {
  crude: { family: "disaggregated", contract: "067651", group: "managed-money", label: "WTI Physical Crude Oil" },
  gas: { family: "disaggregated", contract: "023651", group: "managed-money", label: "NYMEX Natural Gas" },
  rates: { family: "tff", contract: "043602", group: "leveraged-funds", label: "U.S. Treasury 10-Year Note" },
};

function context({ issuer = company, status = "ready", links = [markets.crude] } = {}) {
  const accession = `${issuer.cik}-26-000001`;
  return {
    status, ticker: issuer.ticker, cik: issuer.cik, companyName: `${issuer.ticker} Corporation`,
    links: status !== "ready" ? [] : links.map(market => ({
      ...market, reviewStatus: "candidate",
      reason: "The annual filing discusses the business exposure to this market.",
      reviewQuestion: "Does the cited market materially relate to the company exposure being reviewed?",
      evidence: [{
        form: "10-K", filed: "2026-02-25", reportDate: "2025-12-31", accession,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accession.replaceAll("-", "")}/annual.htm`,
        text: "Our operations produce crude oil and natural gas, and revenue varies with commodity prices.",
      }],
    })),
  };
}

function history(market = markets.crude, points = null) {
  const observations = points || [
    { reportDate: "2026-09-01", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-08", long: 150000, short: 120000, openInterest: 1000000 },
  ];
  const selected = observations.at(-1);
  const datasetId = market.family === "tff" ? "gpe5-46if" : "72hh-3qpy";
  return {
    status: "ready", report_family: market.family, report_basis: "futures_only",
    selection: { contract: market.contract, group: market.group },
    retrieved_at: "2026-09-12T12:00:00Z",
    selected: { ...selected, code: market.contract, family: market.family, reportBasis: "futures_only", contractName: market.label, exchange: "CME", selectedGroup: { label: "Managed Money" } },
    history: observations,
    source: { url: `https://publicreporting.cftc.gov/resource/${datasetId}.json`, dataset_id: datasetId, report_basis: "futures_only" },
    freshness: { cache_status: "fresh", source_currency: "current" },
  };
}

const build = (options = {}, dependencies = {}) => buildPortfolioCftcChanges(
  { companies: [company], days: 30, ...options },
  { now, loadContext: async () => context(), loadHistory: async () => history(), ...dependencies },
);

test("SEC-linked CFTC market changes retain exact observation dates, evidence, scope and calculations", async () => {
  const result = await build();
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.id, "disaggregated:067651:managed-money:2026-09-08");
  assert.equal(event.reportDate, "2026-09-08");
  assert.equal(event.priorDate, "2026-09-01");
  assert.equal(event.netChange, 15000);
  assert.equal(event.netPctChange, 1.5);
  assert.equal(event.openInterestChangePct, 0);
  assert.deepEqual(event.thresholdReasons, ["net-share"]);
  assert.equal(event.reportBasis, "futures_only");
  assert.equal(event.publicationTimeVerified, false);
  assert.equal(event.retrievedAt, "2026-09-12T12:00:00Z");
  assert.equal(event.relatedCompanies[0].ticker, "XOM");
  assert.match(event.relatedCompanies[0].candidate.evidence[0].text, /Our operations/);
  assert.match(event.marketPath, /date=2026-09-08/);
  assert.match(result.limitation, /not represent the company’s own futures position/i);
  assert.match(result.methodology, /not statistical significance/);
});

test("all supported links are inspected and identical market reports load once across companies", async () => {
  const other = { ticker: "CVX", cik: "0000093410", rowId: "row-cvx" };
  const calls = [];
  const result = await build({ companies: [company, other] }, {
    loadContext: async ({ ticker }) => context({ issuer: ticker === "XOM" ? company : other, links: [markets.rates, markets.crude] }),
    loadHistory: async ({ family, code, group, window }) => {
      calls.push({ family, code, group, window });
      const market = Object.values(markets).find(item => item.contract === code);
      return history(market, market === markets.rates ? [
        { reportDate: "2026-09-01", long: 100, short: 50, openInterest: 10000 },
        { reportDate: "2026-09-08", long: 100, short: 50, openInterest: 10000 },
      ] : null);
    },
  });
  assert.equal(calls.length, 2, "one 1y history read per distinct linked market");
  assert.ok(calls.every(call => call.window === "1y"));
  assert.equal(result.events.length, 1, "second candidate market is included, one event across both issuers");
  assert.deepEqual(result.events[0].relatedCompanies.map(item => item.ticker), ["CVX", "XOM"]);
  assert.equal(new Set(result.events[0].relatedCompanies.map(item => item.candidate.filing.url)).size, 2);
  assert.equal(result.coverage.linked, 2);
  assert.equal(result.coverage.uniqueMarkets, 2);
  assert.equal(result.coverage.belowThreshold, 1);
});

test("every threshold-sized weekly change in the recent window is retained without substituting missing dates", async () => {
  const result = await build({ days: 14 }, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-08-25", long: 120000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-01", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-08", long: 150000, short: 120000, openInterest: 1000000 },
  ]) });
  assert.deepEqual(result.events.map(event => event.reportDate), ["2026-09-08", "2026-09-01"]);
  const gap = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-08-25", long: 100, short: 0, openInterest: 1000 },
    { reportDate: "2026-09-08", long: 500, short: 0, openInterest: 1000 },
  ]) });
  assert.equal(gap.events.length, 0);
  assert.equal(gap.coverage.noComparison, 2);
});

test("noise and unchanged positions are excluded; normalized share uses each week's actual open interest", async () => {
  for (const increase of [0, 9999]) {
    const result = await build({}, { loadHistory: async () => history(markets.crude, [
      { reportDate: "2026-09-01", long: 140000, short: 125000, openInterest: 1000000, netPctOi: 99 },
      { reportDate: "2026-09-08", long: 140000 + increase, short: 125000, openInterest: 1000000, netPctOi: 0 },
    ]) });
    assert.equal(result.events.length, 0);
    assert.equal(result.coverage.belowThreshold, 1);
  }
  const boundary = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-09-01", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-08", long: 150000, short: 125000, openInterest: 1000000 },
  ]) });
  assert.equal(boundary.events[0].netPctChange, 1);
  const oi = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-09-01", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-08", long: 140000, short: 125000, openInterest: 1050000 },
  ]) });
  assert.equal(oi.events[0].openInterestChangePct, 5);
  assert.equal(oi.events[0].netChange, 0);
  assert.deepEqual(oi.events[0].thresholdReasons, ["open-interest"]);
  assert.match(oi.events[0].title, /total open interest increased/);
  assert.ok(Math.abs(oi.events[0].netPctChange - (100 * 15000 / 1050000 - 1.5)) < 1e-10);
});

test("missing, zero and negative values never become a zero change or valid comparison", async () => {
  for (const patch of [{ long: null }, { short: -1 }, { openInterest: null }, { openInterest: 0 }]) {
    const value = history();
    Object.assign(value.history[1], patch);
    const result = await build({}, { loadHistory: async () => value });
    assert.equal(result.events.length, 0);
    assert.equal(result.coverage.noComparison, 2);
  }
});

test("unavailable discovery is distinct from no evidence, and wrong issuer or SEC evidence cannot be attributed", async () => {
  for (const status of ["unavailable", "disabled", "unknown"]) {
    const result = await build({}, { loadContext: async () => context({ status }), loadHistory: async () => assert.fail("unavailable issuer must not load market") });
    assert.equal(result.coverage.unavailable, 1);
    assert.equal(result.coverage.noLink, 0);
    assert.equal(result.coverage.checked, 0);
  }
  const noMatch = await build({}, { loadContext: async () => context({ status: "no_matches" }) });
  assert.equal(noMatch.coverage.noLink, 1);
  assert.equal(noMatch.coverage.unavailable, 0);
  const mismatch = await build({}, { loadContext: async () => context({ issuer: { ...company, cik: "0000320193" } }) });
  assert.equal(mismatch.coverage.identityMismatch, 1);
  assert.equal(mismatch.coverage.linked, 0);
  for (const url of ["https://example.com/filing", "https://www.sec.gov/Archives/edgar/data/320193/000003408826000001/annual.htm", ""]) {
    const value = context();
    value.links[0].evidence[0].url = url;
    const result = await build({}, { loadContext: async () => value, loadHistory: async () => assert.fail("unsafe SEC evidence must not load market") });
    assert.equal(result.coverage.invalidLinks, 1);
    assert.equal(result.events.length, 0);
  }
});

test("CFTC family, contract, trader group, dataset and futures-only basis must agree", async () => {
  const incompatible = [
    value => { value.report_family = "tff"; },
    value => { value.report_basis = "combined"; },
    value => { value.selection.contract = "023651"; },
    value => { value.selection.group = "swap-dealers"; },
    value => { value.source.dataset_id = "gpe5-46if"; },
    value => { value.source.url = "https://example.com/cftc"; },
  ];
  for (const patch of incompatible) {
    const value = history(); patch(value);
    const result = await build({}, { loadHistory: async () => value });
    assert.equal(result.events.length, 0);
    assert.equal(result.coverage.marketUnavailable, 1);
  }
  const invalidCandidate = context(); invalidCandidate.links[0].family = "tff";
  const result = await build({}, { loadContext: async () => invalidCandidate });
  assert.equal(result.coverage.invalidLinks, 1, "WTI must never be presented as TFF");
});

test("future and old reports are excluded, while recent stale source context is marked explicitly", async () => {
  const future = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-09-08", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-09-15", long: 150000, short: 120000, openInterest: 1000000 },
  ]) });
  assert.equal(future.events.length, 0);
  assert.equal(future.coverage.futureReports, 1);
  assert.equal(future.marketChecks[0].status, "unavailable");
  assert.equal(future.coverage.marketUnavailable, 1);
  const old = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-07-01", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-07-08", long: 150000, short: 120000, openInterest: 1000000 },
  ]) });
  assert.equal(old.events.length, 0);
  assert.equal(old.coverage.linked, 1);
  assert.equal(old.coverage.staleMarkets, 1);
  const stale = await build({}, { loadHistory: async () => history(markets.crude, [
    { reportDate: "2026-08-18", long: 140000, short: 125000, openInterest: 1000000 },
    { reportDate: "2026-08-25", long: 150000, short: 120000, openInterest: 1000000 },
  ]) });
  assert.equal(stale.events.length, 1);
  assert.equal(stale.events[0].reportDate, "2026-08-25");
  assert.equal(stale.events[0].historyStatus, "stale");
  assert.equal(stale.events[0].sourceCurrency, "aged");
  assert.equal(stale.coverage.staleMarkets, 1);
});

test("coverage displays all 100 portfolio issuers while discovery and history concurrency remain bounded", async () => {
  const issuers = Array.from({ length: 100 }, (_, index) => ({ ticker: `T${index}`, cik: String(index + 1).padStart(10, "0"), rowId: `r${index}` }));
  let activeContexts = 0, maximumContexts = 0, calls = 0;
  let activeHistories = 0, maximumHistories = 0;
  const result = await build({ companies: issuers }, {
    loadContext: async ({ ticker }) => {
      calls += 1; activeContexts += 1; maximumContexts = Math.max(maximumContexts, activeContexts);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeContexts -= 1;
      return context({ issuer: issuers.find(item => item.ticker === ticker), links: Object.values(markets) });
    },
    loadHistory: async ({ code }) => {
      activeHistories += 1; maximumHistories = Math.max(maximumHistories, activeHistories);
      await new Promise(resolve => setTimeout(resolve, 2));
      activeHistories -= 1;
      return history(Object.values(markets).find(item => item.contract === code));
    },
  });
  assert.equal(calls, PORTFOLIO_CFTC_COMPANY_LIMIT);
  assert.equal(result.coverage.totalCompanies, 100);
  assert.equal(result.coverage.requested, PORTFOLIO_CFTC_COMPANY_LIMIT);
  assert.equal(result.coverage.limited, true);
  assert.ok(maximumContexts <= PORTFOLIO_CFTC_CONCURRENCY);
  assert.ok(maximumHistories <= PORTFOLIO_CFTC_CONCURRENCY);
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].relatedCompanies.length, PORTFOLIO_CFTC_COMPANY_LIMIT);
});

test("aborted portfolio discovery does not start source work or claim companies have no links", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await build({}, { signal: controller.signal, loadContext: async () => assert.fail("aborted source load") });
  assert.equal(result.coverage.unavailable, 1);
  assert.equal(result.coverage.noLink, 0);
  assert.equal(result.companyChecks[0].status, "unavailable");
  assert.deepEqual(result.companyChecks[0].marketKeys, []);
});

test("prepared readers cover all 100 with exact company outcomes and shared market checks", async () => {
  const companies = Array.from({ length: 100 }, (_, index) => ({ ticker: `P${index}`, cik: String(index + 1).padStart(10, "0") }));
  let marketReads = 0;
  const result = await build({ companies }, {
    companyLimit: 100,
    loadContext: async ({ ticker }) => {
      const issuer = companies.find(item => item.ticker === ticker);
      if (ticker === "P98") return context({ issuer, status: "no_matches" });
      if (ticker === "P99") throw Object.assign(new Error("private source detail"), { code: "SEC_UPSTREAM_UNAVAILABLE" });
      return context({ issuer });
    },
    loadHistory: async () => { marketReads += 1; return history(); },
  });
  assert.equal(result.companyChecks.length, 100);
  assert.equal(result.coverage.requested, 100);
  assert.equal(result.coverage.limited, false);
  assert.equal(result.coverage.checked, 99);
  assert.equal(result.coverage.linked, 98);
  assert.equal(result.coverage.noLink, 1);
  assert.equal(result.coverage.unavailable, 1);
  assert.equal(result.companyChecks[98].status, "no_matches");
  assert.equal(result.companyChecks[99].code, "SEC_UPSTREAM_UNAVAILABLE");
  assert.deepEqual(result.companyChecks[0].marketKeys, ["disaggregated:067651:managed-money"]);
  assert.equal(result.marketChecks.length, 1);
  assert.equal(result.marketChecks[0].status, "ready");
  assert.equal(marketReads, 1);
  assert.equal(result.events[0].relatedCompanies.length, 98);
  assert.doesNotMatch(JSON.stringify(result), /private source detail/);
  await assert.rejects(build({}, { companyLimit: 101 }), /processing bound/);
});

test("market outcomes retain failed and no-event markets so progressive batches can deduplicate coverage", async () => {
  const result = await build({}, {
    loadContext: async () => context({ links: [markets.crude, markets.gas] }),
    loadHistory: async ({ code }) => {
      if (code === markets.gas.contract) throw Object.assign(new Error("unprepared"), { code: "CFTC_REPORT_NOT_PREPARED" });
      return history(markets.crude, [
        { reportDate: "2026-09-01", long: 100, short: 50, openInterest: 10000 },
        { reportDate: "2026-09-08", long: 100, short: 50, openInterest: 10000 },
      ]);
    },
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.marketChecks.length, 2);
  assert.equal(result.marketChecks[0].belowThreshold, 1);
  assert.equal(result.marketChecks[1].status, "unavailable");
  assert.equal(result.marketChecks[1].code, "CFTC_REPORT_NOT_PREPARED");
  assert.equal(result.companyChecks[0].marketKeys.length, 2);
});

test("portfolio route rejects malformed JSON and invalid fields with HTTP 400 before source discovery", async () => {
  const invalidBodies = [
    "{", "null", "[]", "{}", JSON.stringify({ companies: [company], unknown: 1 }),
    JSON.stringify({ companies: [] }), JSON.stringify({ companies: [company], days: 0 }),
    JSON.stringify({ companies: [company], days: 1.5 }), JSON.stringify({ companies: [company], days: 91 }),
    JSON.stringify({ companies: [{ ticker: "AAPL", cik: "320193" }] }),
    JSON.stringify({ companies: [{ ticker: "<bad>" }] }),
    JSON.stringify({ companies: [{ ...company, url: "https://example.com" }] }),
    JSON.stringify({ companies: [{ ...company, rowId: "x".repeat(201) }] }),
    JSON.stringify({ companies: Array.from({ length: 101 }, () => company) }),
  ];
  for (const [index, body] of invalidBodies.entries()) {
    const response = await POST(new Request("https://example.test/api/v1/cftc/portfolio-changes", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${index + 1}` }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).code, "INVALID_PORTFOLIO_CFTC_REQUEST");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});


test("portfolio feed consumes the actual validated CFTC history builder response", async () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/cftc-disaggregated-72hh-3qpy-v1.json", import.meta.url), "utf8"))[0];
  const prior = { ...raw, id: "prior-report", report_date_as_yyyy_mm_dd: "2026-09-01T00:00:00.000", m_money_positions_long_all: "60" };
  const response = buildCftcHistoryResponse({ family: "disaggregated", code: "067651", group: "managed-money", throughDate: "2026-09-08", window: "1y", rawRows: [prior, raw], retrievedAt: "2026-09-12T12:00:00Z" });
  const result = await build({}, { loadHistory: async () => response });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].netChange, 10);
  assert.equal(result.events[0].openInterest, 365);
  assert.ok(Math.abs(result.events[0].netPctChange - 1000 / 365) < 1e-10);
  assert.equal(result.coverage.marketUnavailable, 0);
});

test("recent calendar windows include today and exclude the preceding boundary day", async () => {
  const atBoundary = await build({ days: 7 });
  assert.equal(atBoundary.cutoff, "2026-09-08");
  assert.equal(atBoundary.events.length, 1);
  const outside = await build({ days: 6 });
  assert.equal(outside.cutoff, "2026-09-09");
  assert.equal(outside.events.length, 0);
});


test("coverage preserves safe failure categories without leaking source exception details", async () => {
  const unavailable = await build({}, { loadContext: async () => ({ status: "unavailable", code: "SEC_RATE_GATE_UNAVAILABLE", message: "private detail" }) });
  assert.deepEqual(unavailable.coverage.unavailableReasons, { SEC_RATE_GATE_UNAVAILABLE: 1 });
  const rejected = await build({}, { loadContext: async () => { throw Object.assign(new Error("private connection string"), { code: "private-token-value" }); } });
  assert.deepEqual(rejected.coverage.unavailableReasons, { SOURCE_UNAVAILABLE: 1 });
  assert.ok(!JSON.stringify(rejected).includes("private"));
  const market = await build({}, { loadHistory: async () => { throw Object.assign(new Error("private detail"), { code: "CFTC_REPORT_NOT_PREPARED" }); } });
  assert.deepEqual(market.coverage.marketUnavailableReasons, { CFTC_REPORT_NOT_PREPARED: 1 });
  assert.equal(market.coverage.noLink, 0);
});
