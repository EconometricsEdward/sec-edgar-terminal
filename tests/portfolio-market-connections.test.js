import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPortfolioMarketConnections,
  marketConnectionCsvRows,
  marketConnectionIssuers,
} from "../src/utils/portfolioMarketConnections.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";

const now = new Date("2026-09-14T12:00:00Z");
const cik = (value) => String(value).padStart(10, "0");
const directory = {
  A: { cik: "1", name: "Company A" },
  B: { cik: "2", name: "Company B" },
  C: { cik: "3", name: "Company C" },
  "CL-A": { cik: "8", name: "Two share classes" },
  "CL-B": { cik: "8", name: "Two share classes" },
  FUND: { cik: "9", name: "Example Fund", isFund: true },
};
const sectors = { 1: "Energy", 2: "Industrials", 3: "Technology", 8: "Financials" };
const company = (id) => ({
  cik: cik(id),
  name: `Company ${id}`,
  kind: "company",
  lens: "corporate",
  status: "ready",
  metrics: {},
});
const reportFor = (holdings, settings = { basis: "weights" }) => {
  const report = buildPortfolioAnalytics(
    resolvePortfolioRows(createPortfolioRows(holdings), directory),
    settings,
    [company(1), company(2), company(3), company(8)],
  );
  // Synthetic CIKs are absent from the public sector classification reference.
  for (const issuer of report.concentration.issuers) issuer.sector = sectors[Number(issuer.cik)] || null;
  return report;
};
const portfolio = () => reportFor([
  { ticker: "A", weight_pct: 30 },
  { ticker: "B", weight_pct: 20 },
  { ticker: "C", weight_pct: 10 },
  { ticker: "FUND", weight_pct: 40 },
]);
const evidenceFor = (issuer) => ({
  form: "10-K",
  accession: "0001193125-26-000078",
  filed: "2026-02-24",
  reportDate: "2025-12-31",
  url: `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/000119312526000078/annual-20251231.htm`,
  text: "Our borrowing facilities reference SOFR and our operations include crude oil and natural gas production.",
});
const contracts = {
  sofr: { family: "tff", contract: "134741", group: "leveraged-funds" },
  crude: { family: "disaggregated", contract: "067651", group: "managed-money" },
  gas: { family: "disaggregated", contract: "023651", group: "managed-money" },
  bitcoin: { family: "tff", contract: "133741", group: "leveraged-funds" },
  ether: { family: "tff", contract: "146021", group: "leveraged-funds" },
};
const resultFor = (issuer, names = ["sofr"], status = "ready") => ({
  cik: issuer.cik,
  ticker: issuer.ticker,
  status,
  context: {
    schemaVersion: "edgar.company-cftc-context.v1",
    cik: issuer.cik,
    ticker: issuer.ticker,
    status,
    links: names.map((name) => ({ ...contracts[name], evidence: [evidenceFor(issuer)] })),
  },
});
const modelFor = (report, results, options = {}) =>
  buildPortfolioMarketConnections(report, results, { now, ...options });
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("included share classes count once and retain their combined issuer allocation", () => {
  const report = reportFor([
    { ticker: "CL-A", weight_pct: 20 },
    { ticker: "CL-B", weight_pct: 30 },
    { ticker: "A", weight_pct: 50 },
  ]);
  const issuers = marketConnectionIssuers(report);
  const classes = issuers.find((issuer) => issuer.cik === cik(8));
  assert.equal(issuers.length, 2);
  assert.deepEqual(classes.tickers, ["CL-A", "CL-B"]);
  assert.equal(classes.ticker, "CL-A");
  assert.equal(classes.rowIds.length, 2);
  assert.equal(classes.weightPct, 50);
  const result = resultFor(classes);
  const model = modelFor(report, [result, result], { basis: "allocation" });
  assert.equal(model.coverage.eligible, 2);
  assert.equal(model.coverage.linked, 1);
  assert.equal(model.markets[0].count, 1);
  assert.equal(model.markets[0].allocationPct, 50);
  assert.equal(model.markets[0].companyPct, 50);
});

test("overlapping contracts use issuer unions within categories without double counting", () => {
  const report = portfolio();
  const [a, b, c] = marketConnectionIssuers(report).filter((issuer) => issuer.eligible);
  const model = modelFor(report, [
    resultFor(a, ["sofr", "crude", "gas"]),
    resultFor(b, ["crude"]),
    resultFor(c, [], "no_matches"),
  ], { basis: "allocation" });
  const energy = model.categories.find((category) => category.key === "energy");
  const rates = model.categories.find((category) => category.key === "rates");
  assert.equal(energy.marketCount, 2);
  assert.equal(energy.count, 2);
  assert.equal(energy.allocationPct, 50);
  assert.equal(rates.count, 1);
  assert.equal(rates.allocationPct, 30);
  assert.equal(model.coverage.linkedAllocationPct, 50);
  assert.equal(model.coverage.linked, 2);
  assert.equal(model.allMarkets.find((market) => market.contract === "067651").count, 2);
  assert.equal(model.allMarkets.find((market) => market.contract === "023651").count, 1);
  assert.equal(model.crossSectorMarkets, 1);
  assert.equal(model.completeScan, true);
  const filtered = modelFor(report, [resultFor(a, ["sofr", "crude", "gas"]), resultFor(b, ["crude"])], { category: "energy" });
  assert.equal(filtered.markets.length, 2);
  assert.equal(filtered.allMarkets.length, 3);
  assert.equal(filtered.coverage.linked, 2);
});

test("partial scans retain full eligible-company and full portfolio allocation denominators", () => {
  const report = portfolio();
  const [a, b] = marketConnectionIssuers(report).filter((issuer) => issuer.eligible);
  const model = modelFor(report, [resultFor(a), resultFor(b)], { basis: "allocation" });
  assert.equal(model.coverage.total, 4);
  assert.equal(model.coverage.eligible, 3);
  assert.equal(model.coverage.unsupported, 1);
  assert.equal(model.coverage.checked, 2);
  assert.equal(model.coverage.checkedAllocationPct, 50);
  assert.equal(model.coverage.linkedAllocationPct, 50);
  assert.equal(model.markets[0].allocationPct, 50);
  close(model.markets[0].companyPct, 200 / 3);
  assert.equal(model.markets[0].value, 50);
  assert.equal(model.coverage.unchecked, 1);
  assert.equal(model.companyRows.find((row) => row.ticker === "C").status, "unchecked");
  assert.equal(model.coverage.noMatch, 0);
  assert.equal(model.completeScan, false);
});

test("other futures remain reachable through a category with deduplicated companies", () => {
  const report = portfolio();
  const [a, b] = marketConnectionIssuers(report).filter((issuer) => issuer.eligible);
  const model = modelFor(report, [
    resultFor(a, ["bitcoin", "ether"]),
    resultFor(b, ["bitcoin"]),
  ], { category: "other" });
  const category = model.categories.find((entry) => entry.key === "other");
  assert.equal(category.label, "Other markets");
  assert.equal(category.count, 2);
  assert.equal(category.marketCount, 2);
  assert.deepEqual(model.markets.map((market) => market.contract).sort(), ["133741", "146021"]);
});

test("unchecked, unavailable, no annual filing and checked with no match remain distinct", () => {
  const report = portfolio();
  const [a, b, c] = marketConnectionIssuers(report).filter((issuer) => issuer.eligible);
  const model = modelFor(report, [
    resultFor(a, [], "no_matches"),
    resultFor(b, [], "no_filing"),
    { cik: c.cik, ticker: c.ticker, status: "unavailable", context: null },
  ]);
  assert.equal(model.coverage.attempted, 3);
  assert.equal(model.coverage.checked, 1);
  assert.equal(model.coverage.noMatch, 1);
  assert.equal(model.coverage.noFiling, 1);
  assert.equal(model.coverage.unavailable, 1);
  assert.equal(model.coverage.unchecked, 0);
  assert.equal(model.coverage.linked, 0);
  assert.equal(model.completeScan, false);
  assert.match(model.companyRows[0].message, /does not establish zero exposure/i);
  assert.deepEqual(model.companyRows.map((row) => row.status), ["no_match", "no_filing", "unavailable"]);
});

test("CFTC history unavailability does not erase verified SEC market connections", () => {
  const report = portfolio();
  const a = marketConnectionIssuers(report).find((issuer) => issuer.ticker === "A");
  const result = resultFor(a, ["sofr", "crude"]);
  const expected = modelFor(report, [result]);
  result.history = { status: "unavailable", error: "CFTC history is unavailable" };
  result.context.links.forEach((link) => { link.history = null; link.positioning = { status: "unavailable" }; });
  const actual = modelFor(report, [result]);
  assert.equal(actual.coverage.linked, 1);
  assert.equal(actual.markets.length, 2);
  assert.deepEqual(actual.markets, expected.markets);
});

test("identity mismatches are unavailable and invalid SEC evidence is omitted", () => {
  const report = portfolio();
  const a = marketConnectionIssuers(report).find((issuer) => issuer.ticker === "A");
  for (const alter of [
    (result) => { result.context.cik = cik(2); },
    (result) => { result.context.ticker = "B"; },
    (result) => { result.status = "no_matches"; },
  ]) {
    const result = resultFor(a);
    alter(result);
    const model = modelFor(report, [result]);
    assert.equal(model.coverage.unavailable, 1);
    assert.equal(model.coverage.checked, 0);
    assert.equal(model.markets.length, 0);
  }
  for (const alter of [
    (entry) => { entry.evidence[0].url = entry.evidence[0].url.replace("data/1/", "data/2/"); },
    (entry) => { entry.evidence[0].url += "?redirect=https://example.com"; },
    (entry) => { entry.evidence[0].filed = "2026-09-15"; },
    (entry) => { entry.group = "managed-money"; },
  ]) {
    const result = resultFor(a, ["sofr", "crude"]);
    alter(result.context.links[0]);
    const model = modelFor(report, [result]);
    assert.equal(model.coverage.omittedLinks, 1);
    assert.equal(model.coverage.linked, 1);
    assert.equal(model.markets.length, 1);
    assert.equal(model.markets[0].contract, "067651");
    assert.equal(model.completeScan, false);
  }
});

test("missing or unreviewed weights disable allocation without disabling company connections", () => {
  for (const report of [
    reportFor([{ ticker: "A", weight_pct: 30 }, { ticker: "B" }]),
    reportFor([{ ticker: "A" }, { ticker: "B" }], { basis: "none" }),
    reportFor([{ ticker: "A", weight_pct: 30 }, { ticker: "B", weight_pct: 20 }]),
  ]) {
    const issuers = marketConnectionIssuers(report);
    const model = modelFor(report, issuers.map((issuer) => resultFor(issuer)), { basis: "allocation" });
    assert.equal(model.allocationAvailable, false);
    assert.equal(model.basis, "companies");
    assert.equal(model.markets[0].count, 2);
    assert.equal(model.markets[0].value, 2);
    assert.equal(model.markets[0].companyPct, 100);
    assert.equal(model.markets[0].allocationPct, null);
    assert.equal(model.coverage.checkedAllocationPct, null);
    assert.equal(model.coverage.linkedAllocationPct, null);
  }
});

test("CSV keeps source identity, raw filing passages, coverage and allocation interpretation", () => {
  const report = portfolio();
  const a = marketConnectionIssuers(report).find((issuer) => issuer.ticker === "A");
  const model = modelFor(report, [resultFor(a)]);
  const [header, ...rows] = marketConnectionCsvRows(model);
  const records = rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])));
  const connection = records.find((row) => row.record_type === "connection");
  const source = evidenceFor(a);
  assert.equal(connection.cik, a.cik);
  assert.equal(connection.ticker, "A");
  assert.equal(connection.family, "tff");
  assert.equal(connection.contract, "134741");
  assert.equal(connection.trader_group, "leveraged-funds");
  assert.equal(connection.form, source.form);
  assert.equal(connection.filed, source.filed);
  assert.equal(connection.report_date, source.reportDate);
  assert.equal(connection.accession, source.accession);
  assert.equal(connection.sec_source, source.url);
  assert.equal(connection.filing_passage, source.text);
  assert.equal(connection.eligible_company_denominator, 3);
  assert.equal(connection.allocation_in_linked_companies_pct, 30);
  assert.equal(connection.company_allocation_pct, 30);
  assert.equal(records.filter((row) => row.record_type === "coverage" && row.scan_status === "unchecked").length, 2);
  assert.match(records.find((row) => row.record_type === "methodology").company, /not market exposure/i);
});
