import test from "node:test";
import assert from "node:assert/strict";
import {
  scenarioMarketCandidates,
  scenarioMarketHistory,
} from "../src/utils/portfolioScenarioMarket.js";

const now = new Date("2026-09-14T12:00:00Z");
const company = { cik: "0000093410", ticker: "CVX" };
const evidence = {
  form: "10-K",
  accession: "0000093410-26-000078",
  filed: "2026-02-24",
  reportDate: "2025-12-31",
  url: "https://www.sec.gov/Archives/edgar/data/93410/000009341026000078/cvx-20251231.htm",
  text: "Our borrowing facilities reference SOFR and our operations include crude oil production.",
};
const context = () => ({
  schemaVersion: "edgar.company-cftc-context.v1",
  status: "ready",
  ...company,
  links: [
    {
      family: "tff",
      contract: "134741",
      group: "leveraged-funds",
      evidence: [{ ...evidence }],
    },
    {
      family: "disaggregated",
      contract: "067651",
      group: "managed-money",
      evidence: [{ ...evidence }],
    },
  ],
});
const candidate = scenarioMarketCandidates(context(), company, "cash", now)
  .links[0];
const history = () => ({
  schema_version: "edgar.cftc-positioning.v1",
  status: "ready",
  report_family: "tff",
  report_basis: "futures_only",
  selection: { contract: "134741", group: "leveraged-funds" },
  selected: {
    family: "tff",
    code: "134741",
    reportBasis: "futures_only",
    reportDate: "2026-09-08",
    selectedGroup: { id: "leveraged-funds" },
  },
  source: {
    dataset_id: "gpe5-46if",
    report_basis: "futures_only",
    url: "https://publicreporting.cftc.gov/resource/gpe5-46if.json?$limit=100",
  },
  freshness: {},
  history: [
    {
      reportDate: "2026-09-01",
      long: 70,
      short: 20,
      openInterest: 100,
      netPctOi: -999,
    },
    {
      reportDate: "2026-09-08",
      long: 80,
      short: 20,
      openInterest: 200,
      netPctOi: 999,
    },
  ],
});

test("scenario ordering retains verified filing-linked alternatives without inferring market sensitivity", () => {
  const cost = scenarioMarketCandidates(context(), company, "cost", now);
  assert.equal(cost.verified, true);
  assert.equal(cost.links.length, 2);
  assert.equal(cost.links[0].contract, "067651");
  assert.equal(cost.preferredCount, 1);
  assert.equal(candidate.contract, "134741");
  assert.deepEqual(cost.links[0].evidence, [evidence]);
});

test("company identity, document path and trader-family binding are required", () => {
  assert.equal(
    scenarioMarketCandidates(
      context(),
      { ...company, cik: "0000320193" },
      "cost",
      now,
    ).verified,
    false,
  );
  for (const alter of [
    (c) => {
      c.links[0].evidence[0].url = c.links[0].evidence[0].url.replace(
        "data/93410/",
        "data/320193/",
      );
    },
    (c) => {
      c.links[0].evidence[0].url += "?redirect=https://example.com";
    },
    (c) => {
      c.links[0].evidence[0].filed = "2026-09-15";
    },
    (c) => {
      c.links[0].group = "managed-money";
    },
  ]) {
    const changed = context();
    alter(changed);
    const result = scenarioMarketCandidates(changed, company, "cash", now);
    assert.equal(result.links.length, 1);
    assert.equal(result.omitted, 1);
  }
  const agent = context();
  agent.links[0].evidence[0].accession = "0001193125-26-000078";
  agent.links[0].evidence[0].url =
    "https://www.sec.gov/Archives/edgar/data/93410/000119312526000078/cvx-20251231.htm";
  assert.equal(
    scenarioMarketCandidates(agent, company, "cash", now).links.length,
    2,
    "filing agent accession is permitted for verified issuer path",
  );
});

test("weekly changes use actual longs and shorts with each report's own open interest", () => {
  const result = scenarioMarketHistory(history(), candidate, now);
  assert.equal(result.current.net, 60);
  assert.equal(result.current.netPctOi, 30);
  assert.equal(result.weekly.netChange, 10);
  assert.equal(result.weekly.netPctChange, -20);
  assert.equal(result.openInterestChangePct, 100);
  assert.equal(result.stale, false);
  assert.match(result.marketPath, /date=2026-09-08/);
});

test("scope, instrument, group, official source and future observations fail closed", () => {
  for (const alter of [
    (h) => {
      h.report_basis = "combined";
    },
    (h) => {
      h.selected.reportBasis = "combined";
    },
    (h) => {
      h.selected.code = "043602";
    },
    (h) => {
      h.selection.group = "asset-manager";
    },
    (h) => {
      h.selected.selectedGroup.id = "asset-manager";
    },
    (h) => {
      h.selected.reportDate = "2026-09-15";
    },
    (h) => {
      h.source.dataset_id = "72hh-3qpy";
    },
    (h) => {
      h.source.url =
        "https://publicreporting.cftc.gov.evil.example/resource/gpe5-46if.json";
    },
    (h) => {
      h.source.url =
        "https://user:password@publicreporting.cftc.gov/resource/gpe5-46if.json";
    },
  ]) {
    const changed = history();
    alter(changed);
    assert.equal(scenarioMarketHistory(changed, candidate, now), null);
  }
});

test("missing or duplicate exact weeks stay unavailable and charts do not bridge gaps", () => {
  const missing = history();
  missing.history[0].reportDate = "2026-08-25";
  const gap = scenarioMarketHistory(missing, candidate, now);
  assert.equal(gap.weekly.available, false);
  assert.equal(gap.openInterestChangePct, null);
  assert.equal(gap.chart.paths.length, 2);
  assert.equal(gap.incomplete, true);
  const duplicate = history();
  duplicate.history.push({ ...duplicate.history[0], long: 90 });
  const deduped = scenarioMarketHistory(duplicate, candidate, now);
  assert.equal(deduped.weekly.available, false);
  assert.equal(deduped.excluded, 1);
  assert.equal(deduped.incomplete, true);
});

test("invalid positions and zero open interest never become a valid net-share observation", () => {
  for (const value of [null, -1, 900]) {
    const changed = history();
    changed.history[1].long = value;
    const result = scenarioMarketHistory(changed, candidate, now);
    assert.equal(result.current.netPctOi, null);
    assert.equal(result.incomplete, true);
  }
  const zeroOi = history();
  zeroOi.history[1].openInterest = 0;
  assert.equal(
    scenarioMarketHistory(zeroOi, candidate, now).current.netPctOi,
    null,
  );
  assert.equal(
    scenarioMarketHistory(history(), candidate, new Date("2026-10-01")).stale,
    true,
  );
  const malformedRaw = history();
  malformedRaw.history[1].raw = {
    cftc_contract_market_code: 134741,
    futonly_or_combined: "FutOnly",
  };
  assert.equal(
    scenarioMarketHistory(malformedRaw, candidate, now).current,
    null,
  );
});
