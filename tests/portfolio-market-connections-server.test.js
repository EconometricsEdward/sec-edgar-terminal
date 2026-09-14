import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioMarketConnections, parsePortfolioMarketConnections,
  PORTFOLIO_MARKET_CONNECTIONS_BATCH, PORTFOLIO_MARKET_CONNECTIONS_CONCURRENCY,
} from "../src/utils/portfolioMarketConnectionsServer.js";
import { POST } from "../src/app/api/v1/cftc/portfolio-connections/route.js";

const now = new Date("2026-09-14T12:00:00Z");
const company = (index = 1) => ({ ticker: `C${index}`, cik: String(index).padStart(10, "0") });
const companies = Array.from({ length: 12 }, (_, index) => company(index + 1));
function context(issuer = company(), status = "ready") {
  const accession = `${issuer.cik}-26-000001`;
  const filing = { form: "10-K", accession, filed: "2026-02-01", reportDate: "2025-12-31", url: `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accession.replaceAll("-", "")}/annual.htm` };
  return {
    schemaVersion: "edgar.company-cftc-context.v1", ...issuer,
    companyName: `${issuer.ticker} Company`, generatedAt: now.toISOString(), asOf: null, status,
    retryable: false, filing: status === "no_filing" ? null : filing,
    links: status === "ready" ? [{
      id: "crude", family: "disaggregated", contract: "067651", group: "managed-money", label: "WTI Physical Crude Oil",
      reviewStatus: "candidate", reason: "The annual report discusses crude oil production.",
      reviewQuestion: "How do the company's production, prices and hedges differ from this benchmark?",
      evidence: [{ ...filing, text: "Our crude oil production and sales create exposure to changes in crude oil prices." }],
    }] : [],
    coverage: { filingsScanned: status === "no_filing" ? 0 : 1, textTruncated: false },
  };
}
const build = (input = { companies: [company()] }, dependencies = {}) => buildPortfolioMarketConnections(input, {
  now, loadContext: async ({ ticker }) => context(companies.find(item => item.ticker === ticker)), ...dependencies,
});
const request = (body, headers = {}, suffix = "") => new Request(`https://example.test/api/v1/cftc/portfolio-connections${suffix}`, {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `connections-test-${request.counter++}`, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
request.counter = 0;

test("unfiltered discovery returns every issuer and raw verified context without history or thresholds", async () => {
  const result = await build({ companies });
  assert.equal(result.schemaVersion, "edgar.portfolio-market-connections.v1");
  assert.equal(result.results.length, PORTFOLIO_MARKET_CONNECTIONS_BATCH);
  assert.deepEqual(result.results.map(item => item.cik), companies.map(item => item.cik));
  assert.ok(result.results.every(item => item.status === "ready"));
  assert.deepEqual(result.results[0].context, context());
  assert.ok(!("events" in result) && !("thresholds" in result));
});

test("only three company loaders are active and requests contain only public ticker selections", async () => {
  let active = 0, maximum = 0;
  const calls = [];
  const result = await build({ companies }, { loadContext: async (selection, options) => {
    calls.push(selection); assert.ok(options.signal instanceof AbortSignal);
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return context(companies.find(item => item.ticker === selection.ticker));
  } });
  assert.equal(maximum, PORTFOLIO_MARKET_CONNECTIONS_CONCURRENCY);
  assert.equal(calls.length, 12); assert.equal(result.results.length, 12);
  assert.ok(calls.every(item => Object.keys(item).join() === "ticker"));
});

test("no matches and no filing retain distinct successful statuses rather than unavailable", async () => {
  const result = await build({ companies: companies.slice(0, 3) }, { loadContext: async ({ ticker }) => context(
    companies.find(item => item.ticker === ticker), ticker === "C1" ? "ready" : ticker === "C2" ? "no_matches" : "no_filing",
  ) });
  assert.deepEqual(result.results.map(item => item.status), ["ready", "no_matches", "no_filing"]);
  assert.ok(result.results.every(item => item.context));
});

test("identity, accession binding, source text and future context timestamps fail closed", async () => {
  for (const mutate of [
    value => { value.cik = company(2).cik; },
    value => { value.ticker = "OTHER"; },
    value => { value.filing.url = value.filing.url.replace("data/1/", "data/2/"); },
    value => { value.links[0].evidence[0].accession = `${company(2).cik}-26-000001`; },
    value => { value.links[0].evidence[0].text = "Short"; },
    value => { value.links[0].group = "leveraged-funds"; },
    value => { value.generatedAt = "2026-09-15T12:00:00Z"; },
    value => { value.asOf = "2025-01-01"; },
  ]) {
    const value = context(); mutate(value);
    const result = await build(undefined, { loadContext: async () => value });
    assert.equal(result.results[0].status, "unavailable");
    assert.equal(result.results[0].context, null);
    assert.ok(["ISSUER_IDENTITY_MISMATCH", "CONTEXT_UNVERIFIED"].includes(result.results[0].errorCode));
  }
});

test("deadline returns all twelve rows even when an injected loader ignores cancellation", async () => {
  let calls = 0;
  const started = Date.now();
  const result = await build({ companies }, { deadlineMs: 20, loadContext: async ({ ticker }) => {
    calls++;
    return ticker === "C1" ? context() : new Promise(() => {});
  } });
  assert.ok(Date.now() - started < 500);
  assert.equal(calls, 4);
  assert.equal(result.results.length, 12);
  assert.equal(result.results[0].status, "ready");
  assert.ok(result.results.slice(1).every(item => item.status === "unavailable" && item.context === null && item.errorCode === "DISCOVERY_TIMEOUT"));
});

test("caller cancellation stops queued work without dropping any company outcomes", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await build({ companies }, { signal: controller.signal, loadContext: async () => { calls++; return context(); } });
  assert.equal(calls, 0); assert.equal(result.results.length, 12);
  assert.ok(result.results.every(item => item.errorCode === "DISCOVERY_CANCELLED"));
});

test("source failures preserve public codes without forwarding provider messages or private fields", async () => {
  const result = await build({ companies: companies.slice(0, 3) }, { loadContext: async ({ ticker }) => {
    if (ticker === "C1") throw Object.assign(new Error("private-provider-secret"), { code: "SEC_RATE_GATE_UNAVAILABLE" });
    if (ticker === "C2") return { status: "unavailable", code: "private-provider-secret", message: "private-provider-secret" };
    return context(company(3));
  } });
  assert.equal(result.results[0].errorCode, "SEC_RATE_GATE_UNAVAILABLE");
  assert.equal(result.results[1].errorCode, "SOURCE_UNAVAILABLE");
  assert.equal(result.results[2].status, "ready");
  assert.doesNotMatch(JSON.stringify(result), /private-provider-secret/);
});

test("request parsing deduplicates exact identities and rejects conflicting share-class submissions", () => {
  assert.deepEqual(parsePortfolioMarketConnections({ companies: [company(), { ...company(), ticker: "c1" }] }), { companies: [company()] });
  for (const input of [
    null, [], {}, { companies: [] }, { companies: [...companies, company(13)] },
    { companies: [company()], weights: [100] }, { companies: [{ ...company(), notes: "Private note" }] },
    { companies: [{ ...company(), cik: "1" }] }, { companies: [{ ...company(), cik: "0000000000" }] },
    { companies: [{ ...company(), cik: 1 }] }, { companies: [{ ...company(), ticker: " C1" }] },
    { companies: [{ ...company(), ticker: "A".repeat(13) }] },
    { companies: [company(), { ...company(), ticker: "OTHER" }] },
    { companies: [company(), { ...company(2), ticker: "C1" }] },
  ]) assert.throws(() => parsePortfolioMarketConnections(input), { status: 400 });
});

test("HTTP route rejects malformed JSON, private fields, unsupported media and oversized streamed bodies", async () => {
  for (const [body, headers, status, suffix] of [
    ["{", {}, 400], [[], {}, 400], [{ companies: [] }, {}, 400],
    [{ companies: [{ ...company(), weight_pct: 100 }] }, {}, 400],
    [{ companies: [company()] }, { "content-type": "text/plain" }, 415],
    [{ companies: [company()] }, { "content-length": "9000" }, 413],
    [JSON.stringify({ padding: "x".repeat(9000) }), {}, 413],
    [{ companies: [company()] }, {}, 400, "?includeWeights=true"],
  ]) {
    const response = await POST(request(body, headers, suffix));
    assert.equal(response.status, status);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const value = await response.json();
    assert.equal(value.schemaVersion, "edgar.portfolio-market-connections.v1");
    assert.equal(value.code, "INVALID_PORTFOLIO_CONNECTIONS_REQUEST");
    assert.equal(value.retryable, false);
  }
});

test("feature gate stops the batch before source retrieval", async () => {
  const prior = process.env.CFTC_ENABLED;
  process.env.CFTC_ENABLED = "false";
  try {
    const response = await POST(request({ companies: [company()] }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "CFTC_DISABLED");
  } finally {
    if (prior === undefined) delete process.env.CFTC_ENABLED;
    else process.env.CFTC_ENABLED = prior;
  }
});
