import test from "node:test";
import assert from "node:assert/strict";
import {
  allocationSummary,
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { portfolioReviewPriorities } from "../src/utils/portfolioInsights.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const source =
  "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000001/goog.htm";
const directory = {
  GOOG: { cik: "1652044", name: "Alphabet Inc." },
  GOOGL: { cik: "1652044", name: "Alphabet Inc." },
  AAPL: { cik: "320193", name: "Apple Inc." },
  ARKK: { cik: "1579982", name: "ARK Innovation ETF", isFund: true },
};
const rows = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const company = (patch = {}) => ({
  cik: "0001652044",
  kind: "company",
  status: "ready",
  period: { kind: "annual", end: "2025-12-31" },
  metrics: {
    netIncome: {
      value: -10,
      classification: "reported",
      period: { end: "2025-12-31" },
      sources: [{ documentUrl: source }],
    },
  },
  filings: [],
  ...patch,
});
const priorities = (
  holdings,
  companies = [],
  settings = { basis: "weights", normalize: false },
) =>
  portfolioReviewPriorities(
    holdings,
    companies,
    allocationSummary(
      holdings,
      settings,
      Object.fromEntries(companies.map((entry) => [entry.cik, entry])),
    ),
    NOW,
  );
const coverage = (result) =>
  result.filter((entry) => entry.kind === "coverage");

test("negative financial prompts require supported financial evidence and retain its source", () => {
  const holdings = rows([{ ticker: "GOOG" }]);
  const result = priorities(holdings, [company()]);
  const negative = result.find((entry) => entry.kind === "metric");
  assert.equal(negative.metric, "netIncome");
  assert.equal(negative.url, source);
  assert.match(negative.reason, /Negative net income.*2025-12-31/);
  for (const unsupported of [
    { value: -10, classification: "unavailable" },
    { value: -10, classification: "not_applicable" },
    { value: -10, status: "unsupported" },
    { value: -10, status: "failed" },
    { value: null },
    { value: 0, classification: "reported" },
  ]) {
    const subject = company({
      metrics: { revenue: { value: 100 }, netIncome: unsupported },
    });
    assert.equal(
      priorities(holdings, [subject]).some((entry) => entry.kind === "metric"),
      false,
      JSON.stringify(unsupported),
    );
  }
  assert.equal(
    priorities(holdings, [company({ status: "failed" })]).some(
      (entry) => entry.kind === "metric",
    ),
    false,
  );
});

test("conflicting and unresolved identities cannot reuse a stale CIK's company evidence", () => {
  for (const status of ["conflict", "unresolved", "review"]) {
    const holdings = rows([{ ticker: "GOOG", weight_pct: 50 }]);
    holdings[0].resolution.status = status;
    const result = priorities(holdings, [
      company({
        period: { kind: "annual", end: "2020-12-31" },
        cache: { status: "stale" },
        filings: [
          { form: "10-Q", filingDate: "2026-09-01", documentUrl: source },
        ],
      }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "identity");
  }
});

test("verified foreign operating issuers retain supported financial and filing prompts", () => {
  const holdings = rows([{ ticker: "GOOG" }]);
  const foreign = company({
    kind: "foreign",
    filings: [{ form: "20-F", filingDate: "2026-09-01", documentUrl: source }],
  });
  assert.deepEqual(
    priorities(holdings, [foreign]).map((entry) => entry.kind),
    ["filing", "metric"],
  );
  holdings[0].resolution.status = "conflict";
  assert.deepEqual(
    priorities(holdings, [foreign]).map((entry) => entry.kind),
    ["identity"],
  );
});

test("coverage aggregates share classes by issuer without reweighting the supplied denominator", () => {
  const holdings = rows([
    { ticker: "GOOG", weight_pct: 8 },
    { ticker: "GOOGL", weight_pct: 12 },
    { ticker: "AAPL", weight_pct: 80 },
  ]);
  const result = coverage(
    priorities(holdings, [
      company({ status: "partial", metrics: {} }),
      company({ cik: "0000320193" }),
    ]),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].weightPct, 20);
  assert.equal(result[0].rowId, holdings[0].id);
  assert.equal(result[0].label, "GOOG / GOOGL");
  assert.match(result[0].reason, /^20.00% allocation/);
  assert.doesNotMatch(result[0].reason, /subtotal/);

  const partial = rows([
    { ticker: "GOOG", weight_pct: 8 },
    { ticker: "GOOGL", weight_pct: 12 },
    { ticker: "AAPL" },
  ]);
  const partialResult = coverage(priorities(partial));
  assert.equal(partialResult.length, 1);
  assert.equal(partialResult[0].weightPct, 20);
  assert.match(partialResult[0].reason, /known subtotal.*not estimated/);
});

test("an issuer's incomplete weights remain a known subtotal and missing weights never become zero", () => {
  const partial = rows([
    { ticker: "GOOG", weight_pct: 12 },
    { ticker: "GOOGL" },
  ]);
  const result = coverage(priorities(partial));
  assert.equal(result.length, 1);
  assert.equal(result[0].weightPct, 12);
  assert.match(result[0].reason, /known subtotal/);
  assert.deepEqual(coverage(priorities(rows([{ ticker: "GOOG" }]))), []);
  assert.deepEqual(
    coverage(priorities(rows([{ ticker: "GOOG", weight_pct: 0 }]))),
    [],
  );
});

test("filings-only partial results remain a financial coverage gap, while reported zero counts as evidence", () => {
  const holdings = rows([{ ticker: "GOOG", weight_pct: 20 }]);
  const subject = company({
    status: "partial",
    metrics: { netIncome: { value: -10, classification: "unavailable" } },
    filings: [{ form: "10-K", filingDate: "2026-01-30", documentUrl: source }],
  });
  const result = coverage(priorities(holdings, [subject]));
  assert.equal(result.length, 1);
  assert.match(
    result[0].reason,
    /Filings are available.*numeric financial facts are missing/,
  );
  subject.metrics.netIncome = { value: 0, classification: "reported" };
  assert.deepEqual(coverage(priorities(holdings, [subject])), []);
});

test("excluded, removed, and merged source positions cannot inflate issuer coverage or generate prompts", () => {
  for (const exclusion of [
    { excluded: true },
    { duplicateChoice: "remove" },
    { mergedInto: "another-position" },
  ]) {
    const holdings = rows([
      { ticker: "GOOG", weight_pct: 8 },
      { ticker: "GOOGL", weight_pct: 92 },
    ]);
    Object.assign(holdings[1], exclusion);
    assert.deepEqual(coverage(priorities(holdings)), []);
    Object.assign(holdings[0], exclusion);
    assert.deepEqual(priorities(holdings, [company()]), []);
  }
});

test("funds and verified fund results do not receive operating-company review prompts", () => {
  const fundRows = rows([{ ticker: "ARKK", weight_pct: 100 }]);
  const fund = company({ cik: "0001579982", kind: "fund" });
  const result = priorities(fundRows, [fund]);
  assert.ok(result.every((entry) => entry.kind === "identity"));
  const staleClassification = rows([{ ticker: "GOOG", weight_pct: 100 }]);
  assert.deepEqual(
    priorities(staleClassification, [company({ kind: "fund" })]),
    [],
  );
});
