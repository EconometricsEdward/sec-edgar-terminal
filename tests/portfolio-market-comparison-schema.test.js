import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { buildCftcHistoryResponse } from "../src/utils/cftcServer.js";
import { buildPortfolioMarketComparison } from "../src/utils/portfolioMarketComparisonServer.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const schema = readJson("../public/schemas/portfolio-market-comparison-v1.schema.json");
const validate = new Ajv({ allErrors: true }).compile(schema);
const now = new Date("2026-09-09T12:00:00Z");
const fixtures = {
  tff: readJson("./fixtures/cftc-tff-gpe5-46if-v1.json")[0],
  disaggregated: readJson("./fixtures/cftc-disaggregated-72hh-3qpy-v1.json")[0],
};

function preparedHistory({ family, code, group }) {
  const rawRows = Array.from({ length: 53 }, (_, index) => ({
    ...fixtures[family],
    id: `${code}-${index}`,
    cftc_contract_market_code: code,
    report_date_as_yyyy_mm_dd: new Date(
      Date.parse("2026-09-08T00:00:00Z") - index * 7 * 86_400_000,
    ).toISOString().slice(0, -1),
  }));
  return buildCftcHistoryResponse({
    family, code, group, rawRows,
    throughDate: "2026-09-08",
    window: "1y",
    retrievedAt: now.toISOString(),
  });
}

test("public comparison ready, partial and unavailable builders match the published schema", async () => {
  const ready = await buildPortfolioMarketComparison({ now, loadHistory: preparedHistory });
  assert.equal(ready.status, "ready");
  assert.equal(validate(ready), true, JSON.stringify(validate.errors));
  const partial = await buildPortfolioMarketComparison({
    now,
    loadHistory: (selection) => selection.code === "13874A" ? null : preparedHistory(selection),
  });
  assert.equal(partial.status, "partial");
  assert.equal(validate(partial), true, JSON.stringify(validate.errors));
  const unavailable = await buildPortfolioMarketComparison({ now, loadHistory: () => null });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(validate(unavailable), true, JSON.stringify(validate.errors));

  for (const change of [
    (value) => { value.portfolio = { holdings: ["AAPL"] }; },
    (value) => { value.results.pop(); },
    (value) => { value.results[0].summary = null; },
    (value) => { value.results[0].summary.stale = true; },
    (value) => { value.results[0].summary.range.position = 101; },
    (value) => { value.results[0].summary.range.count = 1; },
    (value) => { value.results[0].summary.weeklyChangePp = "unavailable"; },
    (value) => { delete value.results[0].summary.reportDate; },
    (value) => { value.results[0].summary.sourceUrl = "https://example.com/resource/gpe5-46if.json"; },
    (value) => { value.results[0].summary.group = "managed-money"; },
    (value) => { value.results[0].group = "managed-money"; },
  ]) {
    const invalid = structuredClone(ready);
    change(invalid);
    assert.equal(validate(invalid), false, "invalid public comparison must not satisfy its success contract");
  }
  assert.equal(validate({
    schemaVersion: ready.schemaVersion,
    status: "disabled",
    code: "CFTC_DISABLED",
    error: "CFTC data is currently disabled.",
    retryable: false,
  }), false, "HTTP error envelopes have a separate contract");
});

test("OpenAPI and crawler guidance discover the same parameter-free comparison contract", () => {
  const api = readJson("../public/openapi.json");
  const operation = api.paths["/api/v1/cftc/market-comparison"].get;
  assert.deepEqual(operation.parameters, []);
  assert.equal(operation.responses["200"].content["application/json"].schema.$ref, schema.$id);
  assert.ok(operation.responses["200"].headers.Link);
  assert.ok(operation.responses["400"]);
  assert.ok(operation.responses["429"]);
  assert.ok(operation.responses["503"]);
  const guidance = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(guidance, /GET \/api\/v1\/cftc\/market-comparison/);
  assert.match(guidance, /range\.position.*NOT a percentile/);
});
