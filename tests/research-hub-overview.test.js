import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeHubPortfolio,
  buildHubSearchIndex,
  searchHubResearch,
} from "../src/utils/researchHubOverview.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";

const directory = {
  AAPL: { cik: "0000320193", name: "Apple Inc." },
  GOOG: { cik: "0001652044", name: "Alphabet Inc." },
  GOOGL: { cik: "0001652044", name: "Alphabet Inc." },
};
const rows = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const document = (holdings, snapshot = null) => ({
  id: "research-a",
  name: "Long-term research",
  rows: rows(holdings),
  research: { basis: "annual" },
  allocation: { basis: "none" },
  updatedAt: "2026-09-08T08:00:00.000Z",
  snapshot,
});
const snapshot = (companies) => ({
  basis: "annual",
  generated_at: "2026-09-08T07:00:00.000Z",
  companies,
});

test("overview distinguishes unresearched companies from measured zero coverage", () => {
  const unresearched = summarizeHubPortfolio(document([{ ticker: "AAPL" }]));
  assert.equal(unresearched.availableCompanies, null);
  assert.equal(unresearched.coveragePct, null);
  assert.equal(unresearched.totalCompanies, 1);
  assert.equal(unresearched.status, "Ready to research");
  const filingsOnly = summarizeHubPortfolio(
    document(
      [{ ticker: "AAPL" }],
      snapshot([
        {
          cik: "0000320193",
          status: "partial",
          metrics: { revenue: { value: null, classification: "unavailable" } },
          filings: [{ form: "10-K" }],
        },
      ]),
    ),
  );
  assert.equal(filingsOnly.availableCompanies, 0);
  assert.equal(filingsOnly.coveragePct, 0);
});

test("overview counts share classes once and does not count unresolved or excluded rows as financial issuers", () => {
  const input = document(
    [
      { ticker: "GOOG" },
      { ticker: "GOOGL" },
      { ticker: "UNKNOWN" },
      { ticker: "AAPL" },
    ],
    snapshot([
      {
        cik: "0001652044",
        status: "ready",
        metrics: { netIncome: { value: 0, classification: "reported" } },
      },
    ]),
  );
  input.rows[3].excluded = true;
  const result = summarizeHubPortfolio(input);
  assert.equal(result.rowCount, 3);
  assert.equal(result.totalCompanies, 1);
  assert.equal(result.availableCompanies, 1);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.unresolved, 1);
  assert.equal(result.status, "Identity review needed");
});

test("stale or unchecked snapshots remain visible with an explicit refresh status", () => {
  const input = document(
    [{ ticker: "AAPL" }],
    snapshot([
      {
        cik: "0000320193",
        status: "ready",
        refreshStatus: "not_checked",
        metrics: { revenue: { value: 10, classification: "reported" } },
      },
    ]),
  );
  const result = summarizeHubPortfolio(input);
  assert.equal(result.availableCompanies, 1);
  assert.equal(result.incomplete, 1);
  assert.equal(result.status, "Research needs a refresh");
  input.research.basis = "ttm";
  const changedBasis = summarizeHubPortfolio(input);
  assert.equal(changedBasis.hasSnapshot, false);
  assert.equal(changedBasis.availableCompanies, null);
  assert.equal(changedBasis.capturedAt, null);
});

test("search includes portfolio tickers and notes while excluding retired Hub collections", () => {
  const index = buildHubSearchIndex({
    portfolios: [document([{ ticker: "AAPL", notes: "Verify supply chain" }])],
    watchlist: [{ ticker: "AAPL", kind: "company", name: "Apple Inc." }],
    entries: [
      {
        id: "note-1",
        title: "Supplier dependency",
        text: "Apple supply chain evidence",
        type: "note",
        source: "Analysis",
        href: "/analysis/AAPL?view=notebook",
      },
      {
        id: "unsafe",
        title: "Supply chain redirect",
        type: "note",
        href: "https://example.com/",
      },
    ],
  });
  assert.equal(index.length, 1);
  assert.equal(searchHubResearch(index, "AAPL").results[0].kind, "Portfolio");
  const result = searchHubResearch(index, "supply chain", 1);
  assert.equal(result.total, 1);
  assert.equal(result.results.length, 1);
  assert.equal(searchHubResearch(index, "  ").total, 0);
  assert.equal(searchHubResearch(index, "supply unrelated").total, 0);
  assert.equal(index[0].href.includes("supply"), false);
});
