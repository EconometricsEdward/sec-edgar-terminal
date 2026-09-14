import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioCftcChanges,
  PORTFOLIO_CFTC_COMPANY_LIMIT,
} from "../src/utils/portfolioCftcChanges.js";

const company = { ticker: "XOM", cik: "0000034088", rowId: "row-xom" };

function context(status = "ready") {
  return status === "ready"
    ? {
        status,
        cik: company.cik,
        companyName: "Exxon Mobil Corp",
        links: [
          {
            family: "tff",
            contract: "067651",
            group: "leveraged-funds",
            label: "WTI crude oil",
            reason: "The annual filing discusses crude-oil market exposure.",
            reviewQuestion: "Does this market materially relate to the company exposure being reviewed?",
            evidence: [
              {
                form: "10-K",
                filed: "2026-02-25",
                url: "https://www.sec.gov/Archives/edgar/data/34088/example.htm",
                accession: "0000034088-26-000001",
              },
            ],
          },
        ],
      }
    : { status, cik: company.cik, companyName: "Exxon Mobil Corp", links: [] };
}

function history() {
  return {
    status: "ready",
    report_family: "tff",
    selected: {
      reportDate: "2026-09-08",
      contractName: "Crude Oil, Light Sweet - NYMEX",
      exchange: "NYMEX",
      openInterest: 1000000,
      selectedGroup: {
        label: "Leveraged funds",
        long: 150000,
        short: 120000,
        net: 30000,
        netPctOi: 3,
      },
    },
    history: [
      { reportDate: "2026-09-01", long: 140000, short: 125000, netPctOi: 1.5 },
      { reportDate: "2026-09-08", long: 150000, short: 120000, netPctOi: 3 },
    ],
    source: { url: "https://www.cftc.gov/dea/futures/deacmesf.htm" },
    freshness: { cache_status: "fresh" },
  };
}

test("portfolio CFTC feed keeps SEC-linked market context distinct from company positions", async () => {
  const result = await buildPortfolioCftcChanges(
    { companies: [company], days: 30 },
    {
      now: new Date("2026-09-14T12:00:00Z"),
      loadContext: async () => context(),
      loadHistory: async () => history(),
    },
  );
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.ticker, "XOM");
  assert.equal(event.reportDate, "2026-09-08");
  assert.equal(event.priorDate, "2026-09-01");
  assert.equal(event.netChange, 15000);
  assert.equal(event.netPctChange, 1.5);
  assert.match(event.title, /positioning increased/);
  assert.match(result.limitation, /not represent the company’s own futures position/i);
  assert.equal(event.candidate.filing.form, "10-K");
  assert.match(event.marketPath, /^\/market\?/);
});

test("portfolio CFTC feed omits unlinked companies and bounds discovery", async () => {
  let calls = 0;
  const companies = Array.from({ length: PORTFOLIO_CFTC_COMPANY_LIMIT + 5 }, (_, index) => ({
    ticker: `T${index + 1}`,
    cik: String(index + 1).padStart(10, "0"),
    rowId: `r${index + 1}`,
  }));
  const result = await buildPortfolioCftcChanges(
    { companies, days: 30 },
    {
      now: new Date("2026-09-14T12:00:00Z"),
      loadContext: async () => { calls += 1; return context("no_matches"); },
      loadHistory: async () => { throw new Error("history should not be called"); },
    },
  );
  assert.equal(calls, PORTFOLIO_CFTC_COMPANY_LIMIT);
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.requested, PORTFOLIO_CFTC_COMPANY_LIMIT);
  assert.equal(result.coverage.limited, true);
});

test("portfolio CFTC feed excludes reports outside the selected recent window", async () => {
  const oldHistory = history();
  oldHistory.selected.reportDate = "2026-07-08";
  oldHistory.history = [
    { reportDate: "2026-07-01", long: 140000, short: 125000, netPctOi: 1.5 },
    { reportDate: "2026-07-08", long: 150000, short: 120000, netPctOi: 3 },
  ];
  const result = await buildPortfolioCftcChanges(
    { companies: [company], days: 30 },
    {
      now: new Date("2026-09-14T12:00:00Z"),
      loadContext: async () => context(),
      loadHistory: async () => oldHistory,
    },
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.coverage.linked, 1);
});
