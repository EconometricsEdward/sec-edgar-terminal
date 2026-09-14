import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPortfolioMarketConnections,
  PORTFOLIO_MARKET_SCAN_LIMIT,
  scanPortfolioMarketConnections,
} from "../src/utils/portfolioMarketConnectionsClient.js";

let nextId = 1000;
const companiesFor = (count) => Array.from({ length: count }, () => {
  const id = nextId++;
  return { cik: String(id).padStart(10, "0"), ticker: `T${id}`, weightPct: 100 / count, name: `Company ${id}` };
});
const resultFor = ({ cik, ticker }, status = "no_matches") => ({
  cik,
  ticker,
  status,
  context: { schemaVersion: "edgar.company-cftc-context.v1", cik, ticker, status, links: [] },
});
const readyResultFor = (company) => {
  const result = resultFor(company, "ready");
  result.context.links = [{
    family: "tff",
    contract: "134741",
    group: "leveraged-funds",
    evidence: [{
      form: "10-K",
      accession: "0001193125-25-000078",
      filed: "2025-02-24",
      reportDate: "2024-12-31",
      url: `https://www.sec.gov/Archives/edgar/data/${Number(company.cik)}/000119312525000078/annual-20241231.htm`,
      text: "Our borrowing facilities bear interest at a variable rate based on SOFR plus the applicable margin.",
    }],
  }];
  return result;
};
const responseFor = (results, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ schemaVersion: "edgar.portfolio-market-connections.v1", results }),
});

test("scans sequential batches of at most 12 and sends identities without portfolio weights", async () => {
  const companies = companiesFor(25);
  const calls = [];
  const progress = [];
  let active = 0;
  let peak = 0;
  const results = await scanPortfolioMarketConnections([...companies, companies[0]], {
    onProgress: (rows) => progress.push(rows.length),
    fetchImpl: async (url, options) => {
      active++;
      peak = Math.max(active, peak);
      assert.equal(url, "/api/v1/cftc/portfolio-connections");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["companies"]);
      body.companies.forEach((company) => assert.deepEqual(Object.keys(company).sort(), ["cik", "ticker"]));
      calls.push(body.companies);
      await Promise.resolve();
      active--;
      return responseFor(body.companies.map((company) => resultFor(company)));
    },
  });
  assert.deepEqual(calls.map((batch) => batch.length), [12, 12, 1]);
  assert.equal(peak, 1);
  assert.equal(results.length, 25);
  assert.equal(new Set(results.map((result) => result.cik)).size, 25);
  assert.deepEqual(progress, [0, 12, 24, 25]);
  clearPortfolioMarketConnections(companies);
});

test("successful scans are reused across calls and explicit refresh clears only selected identities", async () => {
  const companies = companiesFor(3);
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const batch = JSON.parse(options.body).companies;
    calls.push(batch);
    return responseFor(batch.map((company) => resultFor(company)));
  };
  const original = await scanPortfolioMarketConnections(companies, { fetchImpl });
  const repeated = await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.deepEqual(repeated, original);
  assert.equal(calls.length, 1);
  clearPortfolioMarketConnections([companies[1]]);
  await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [{ cik: companies[1].cik, ticker: companies[1].ticker }]);
  clearPortfolioMarketConnections(companies);
});

test("canceling a partial scan retains completed results and prevents future batches", async () => {
  const companies = companiesFor(25);
  const controller = new AbortController();
  let calls = 0;
  const results = await scanPortfolioMarketConnections(companies, {
    signal: controller.signal,
    onProgress: (rows) => { if (rows.length === 12) controller.abort(); },
    fetchImpl: async (_url, options) => {
      calls++;
      return responseFor(JSON.parse(options.body).companies.map((company) => resultFor(company)));
    },
  });
  assert.equal(calls, 1);
  assert.equal(results.length, 12);
  assert.equal(results.some((result) => result.cik === companies[12].cik), false);
  const untouched = companiesFor(1);
  await scanPortfolioMarketConnections(untouched, {
    signal: controller.signal,
    fetchImpl: async () => { assert.fail("an already canceled scan must not start a request"); },
  });
  clearPortfolioMarketConnections(companies);
});

test("abort during an in-flight request does not manufacture unavailable results for unscanned companies", async () => {
  const companies = companiesFor(13);
  const controller = new AbortController();
  let calls = 0;
  const results = await scanPortfolioMarketConnections(companies, {
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(results, []);
});

test("mismatched or duplicate response identities are unavailable and retried instead of cached", async () => {
  for (const mode of ["wrong-cik", "wrong-ticker", "duplicate", "missing"]) {
    const companies = companiesFor(1);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const original = resultFor(companies[0]);
      const results = mode === "wrong-cik" ? [{ ...original, cik: "0000000001" }]
        : mode === "wrong-ticker" ? [{ ...original, ticker: "OTHER" }]
          : mode === "duplicate" ? [original, original] : [];
      return responseFor(results);
    };
    const results = await scanPortfolioMarketConnections(companies, { fetchImpl });
    assert.equal(results[0].status, "unavailable", mode);
    assert.equal(results[0].cik, companies[0].cik);
    assert.equal(results[0].ticker, companies[0].ticker);
    await scanPortfolioMarketConnections(companies, { fetchImpl });
    assert.equal(calls, 2, `${mode} must not be cached as a successful scan`);
  }
});

test("an outer ready status cannot cache null, mismatched or unverified SEC context", async () => {
  for (const mode of ["null-context", "wrong-context-cik", "wrong-context-ticker", "status-mismatch", "invalid-source"]) {
    const companies = companiesFor(1);
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      const result = readyResultFor(companies[0]);
      if (mode === "null-context") result.context = null;
      if (mode === "wrong-context-cik") result.context.cik = "0000000001";
      if (mode === "wrong-context-ticker") result.context.ticker = "OTHER";
      if (mode === "status-mismatch") result.context.status = "no_matches";
      if (mode === "invalid-source") result.context.links[0].evidence[0].url = "https://example.com/annual-report.htm";
      return responseFor([result]);
    };
    await scanPortfolioMarketConnections(companies, { fetchImpl });
    await scanPortfolioMarketConnections(companies, { fetchImpl });
    assert.equal(calls, 2, `${mode} must trigger a fresh network request when retried`);
    clearPortfolioMarketConnections(companies);
  }
});

test("a ready result with valid issuer-bound SEC evidence is cached", async () => {
  const companies = companiesFor(1);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return responseFor([readyResultFor(companies[0])]);
  };
  const first = await scanPortfolioMarketConnections(companies, { fetchImpl });
  const repeated = await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.equal(first[0].status, "ready");
  assert.equal(first[0].context.links.length, 1);
  assert.deepEqual(repeated, first);
  assert.equal(calls, 1);
  clearPortfolioMarketConnections(companies);
});

test("rate limiting stops remaining batches and preserves their unchecked state", async () => {
  for (const malformedBody of [false, true]) {
    const companies = companiesFor(25);
    let calls = 0;
    const results = await scanPortfolioMarketConnections(companies, {
      fetchImpl: async () => {
        calls++;
        return {
          ok: false,
          status: 429,
          json: async () => {
            if (malformedBody) throw new SyntaxError("Unexpected token '<'");
            return { error: "Too many requests" };
          },
        };
      },
    });
    assert.equal(calls, 1, `429 must stop later batches even with ${malformedBody ? "non-JSON" : "JSON"} response`);
    assert.equal(results.length, 12);
    assert.ok(results.every((result) => result.status === "unavailable"));
  }
});

test("invalid API schemas cannot become verified or cached company results", async () => {
  const companies = companiesFor(1);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ schemaVersion: "old-schema", results: [resultFor(companies[0])] }) };
  };
  const results = await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.equal(results[0].status, "unavailable");
  await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.equal(calls, 2);
});

test("scan size and successful-result cache remain bounded", async () => {
  const companies = companiesFor(PORTFOLIO_MARKET_SCAN_LIMIT + 5);
  let requested = 0;
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const batch = JSON.parse(options.body).companies;
    requested += batch.length;
    assert.ok(batch.length <= 12);
    return responseFor(batch.map((company) => resultFor(company)));
  };
  const results = await scanPortfolioMarketConnections(companies, { fetchImpl });
  assert.equal(results.length, PORTFOLIO_MARKET_SCAN_LIMIT);
  assert.equal(requested, PORTFOLIO_MARKET_SCAN_LIMIT);
  assert.equal(calls, Math.ceil(PORTFOLIO_MARKET_SCAN_LIMIT / 12));
  await scanPortfolioMarketConnections([companies[PORTFOLIO_MARKET_SCAN_LIMIT]], { fetchImpl });
  const before = calls;
  await scanPortfolioMarketConnections([companies[0]], { fetchImpl });
  assert.equal(calls, before + 1, "adding another result evicts the oldest cached identity at the cap");
  clearPortfolioMarketConnections(companies);
});
