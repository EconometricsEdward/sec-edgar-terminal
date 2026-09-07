import test from "node:test";
import assert from "node:assert/strict";
import {
  holdingsMatchTarget,
  mergeDiscoveredFunds,
  normalizeIssuerName,
  resolveSecurityTarget,
  summarizeDiscoveredFund,
} from "../src/utils/globalFundSecurity.js";

const companies = {
  AAPL: { name: "Apple Inc.", cik: "0000320193" },
  APLE: { name: "Apple Hospitality REIT, Inc.", cik: "0001418121" },
  MSFT: { name: "Microsoft Corporation", cik: "0000789019" },
  GOOG: { name: "Alphabet Inc.", cik: "0001652044" },
  GOOGL: { name: "Alphabet Inc.", cik: "0001652044" },
};
const apple = resolveSecurityTarget("Apple", companies);
const holding = (patch = {}) => ({
  name: "APPLE INC",
  title: "Common Stock",
  tickerSymbol: "AAPL",
  cusip: "037833100",
  isin: "US0378331005",
  assetCat: "EC",
  value: 100,
  pctOfNav: 2,
  ...patch,
});
const portfolio = (patch = {}) => ({
  name: "Example Equity Fund",
  tickers: ["EXAM"],
  cik: "0000000001",
  seriesId: "S000000001",
  asOf: "2026-03-31",
  filingDate: "2026-05-28",
  accession: "0000000001-26-000001",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/report.xml",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/1/filing-index.html",
  holdings: [holding()],
  ...patch,
});

test("normalization removes terminal legal suffixes and preserves meaningful company words", () => {
  assert.equal(normalizeIssuerName("Apple, Incorporated"), "apple");
  assert.equal(
    normalizeIssuerName("Apple Hospitality REIT, Inc."),
    "apple hospitality reit",
  );
  assert.equal(
    normalizeIssuerName("Example Holdings P.L.C."),
    "example holdings",
  );
  assert.equal(normalizeIssuerName("JPMorgan Chase & Co."), "jpmorgan chase");
  assert.equal(normalizeIssuerName("Co Operative Company"), "co operative");
  assert.equal(normalizeIssuerName("Company"), "company");
});

test("AAPL and Apple resolve to the same exact issuer without broad Apple substring matching", () => {
  const ticker = resolveSecurityTarget(" aapl ", companies);
  assert.equal(ticker.kind, "company");
  assert.equal(ticker.ticker, "AAPL");
  assert.equal(apple.kind, "company");
  assert.equal(apple.cik, ticker.cik);
  assert.equal(apple.name, "Apple Inc.");
  assert.deepEqual(apple.terms, ["Apple Inc.", "apple"]);
  assert.equal(resolveSecurityTarget("Microsoft", companies).kind, "company");
  assert.equal(
    holdingsMatchTarget(holding({ tickerSymbol: null }), apple),
    true,
  );
  assert.equal(
    holdingsMatchTarget(
      holding({ name: "Apple Hospitality REIT Inc.", tickerSymbol: "APLE" }),
      apple,
    ),
    false,
  );
  assert.equal(
    holdingsMatchTarget(
      holding({ name: "Unrelated Issuer", tickerSymbol: "AAPL" }),
      ticker,
    ),
    true,
  );
});

test("issuer-name resolution does not choose a share class or an unrelated ambiguous issuer", () => {
  const alphabet = resolveSecurityTarget("Alphabet", companies);
  assert.equal(alphabet.kind, "company");
  assert.equal(alphabet.ticker, null);
  assert.equal(alphabet.cik, "0001652044");
  assert.equal(resolveSecurityTarget("GOOGL", companies).ticker, "GOOGL");
  const ambiguous = resolveSecurityTarget("Example", {
    AAA: { name: "Example Inc.", cik: "1" },
    BBB: { name: "Example Corporation", cik: "2" },
  });
  assert.equal(ambiguous.kind, "text");
  assert.equal(ambiguous.ticker, null);
  assert.equal(ambiguous.suggestions.length, 2);
  const unknown = resolveSecurityTarget("Example", {
    AAA: { name: "Example Inc." },
    BBB: { name: "Example Inc." },
  });
  assert.equal(unknown.kind, "text");
});

test("APPL remains literal text and offers an explicit AAPL correction", () => {
  const target = resolveSecurityTarget("APPL", companies);
  assert.equal(target.kind, "text");
  assert.equal(target.query, "APPL");
  assert.equal(target.ticker, null);
  assert.equal(target.suggestions[0].query, "AAPL");
  assert.equal(holdingsMatchTarget(holding(), target), false);
  assert.deepEqual(resolveSecurityTarget("APPL", {}).suggestions, []);
  assert.equal(
    resolveSecurityTarget("APPL", { APPL: { name: "Other Company", cik: "5" } })
      .ticker,
    "APPL",
  );
});

test("CUSIP and ISIN resolve and match exactly; short numeric CIK input stays text", () => {
  for (const query of ["037833100", "us0378331005"]) {
    const target = resolveSecurityTarget(query, companies);
    assert.equal(target.kind, "identifier");
    assert.equal(target.identifier, query.toUpperCase());
    assert.equal(holdingsMatchTarget(holding(), target), true);
    assert.equal(
      holdingsMatchTarget(
        holding({ cusip: "037833101", isin: "US0378331013" }),
        target,
      ),
      false,
    );
  }
  assert.equal(resolveSecurityTarget("320193", companies).kind, "text");
  assert.equal(resolveSecurityTarget("0000320193", companies).kind, "text");
  assert.equal(resolveSecurityTarget("000000000", companies).kind, "text");
});

test("stock filter excludes corporate bonds and derivatives; all permits directly matched records", () => {
  for (const assetCat of ["DC", "DE", "EP", "UNKNOWN"]) {
    assert.equal(holdingsMatchTarget(holding({ assetCat }), apple), false);
    assert.equal(
      holdingsMatchTarget(holding({ assetCat }), apple, "all"),
      true,
    );
  }
  const derivative = holding({
    name: "Counterparty Bank",
    title: "Equity Swap",
    tickerSymbol: null,
    cusip: null,
    isin: null,
    assetCat: "DE",
    underlier: { name: "Apple Inc.", tickerSymbol: "AAPL" },
    derivativeText: "Apple Inc AAPL",
  });
  assert.equal(holdingsMatchTarget(derivative, apple, "all"), false);
  assert.equal(
    holdingsMatchTarget(derivative, resolveSecurityTarget("Apple", {}), "all"),
    false,
  );
});

test("unresolved text requires every complete word from the reported fields", () => {
  assert.equal(
    holdingsMatchTarget(holding(), resolveSecurityTarget("apple common", {})),
    true,
  );
  assert.equal(
    holdingsMatchTarget(holding(), resolveSecurityTarget("appl", {})),
    false,
  );
  assert.equal(
    holdingsMatchTarget(
      holding(),
      resolveSecurityTarget("apple preferred", {}),
    ),
    false,
  );
  assert.equal(
    holdingsMatchTarget(holding(), resolveSecurityTarget("", {})),
    false,
  );
  assert.equal(
    holdingsMatchTarget(holding(), resolveSecurityTarget("037833", {})),
    false,
  );
});

test("summaries retain per-fund totals, positions, identifiers, category totals and evidence", () => {
  const source = portfolio({
    holdings: [
      holding(),
      holding({ value: 30, pctOfNav: 0.6, assetCat: "DC" }),
      holding({ value: -5, pctOfNav: -0.1, assetCat: "DE" }),
    ],
  });
  const stocks = summarizeDiscoveredFund(source, apple);
  assert.equal(stocks.value, 100);
  assert.equal(stocks.pctOfNav, 2);
  assert.equal(stocks.positionCount, 1);
  const all = summarizeDiscoveredFund(source, apple, "all");
  assert.equal(all.id, "0000000001:S000000001");
  assert.deepEqual(all.tickers, ["EXAM"]);
  assert.equal(all.value, 125);
  assert.equal(all.pctOfNav, 2.5);
  assert.equal(all.stockPositionCount, 1);
  assert.equal(all.derivativeCount, 1);
  assert.deepEqual(
    all.categories.map((category) => [category.asset, category.value]),
    [
      ["EC", 100],
      ["DC", 30],
      ["DE", -5],
    ],
  );
  assert.equal(all.sourceUrl, source.sourceUrl);
  assert.equal(all.filingUrl, source.filingUrl);
  assert.equal(all.holdings[0].cusip, "037833100");
  assert.equal(
    summarizeDiscoveredFund(portfolio({ holdings: [] }), apple),
    null,
  );
});

test("missing values produce unavailable totals and known subtotals, while zeros remain observed", () => {
  const result = summarizeDiscoveredFund(
    portfolio({
      holdings: [
        holding(),
        holding({ value: null, pctOfNav: NaN }),
        holding({ value: 0, pctOfNav: 0 }),
      ],
    }),
    apple,
  );
  assert.equal(result.value, null);
  assert.equal(result.knownValue, 100);
  assert.equal(result.missingValueCount, 1);
  assert.equal(result.pctOfNav, null);
  assert.equal(result.knownWeight, 2);
  assert.equal(result.missingWeightCount, 1);
  assert.equal(result.categories[0].value, null);
  const missing = summarizeDiscoveredFund(
    portfolio({
      holdings: [holding({ value: undefined, pctOfNav: Infinity })],
    }),
    apple,
  );
  assert.equal(missing.knownValue, null);
  assert.equal(missing.knownWeight, null);
  const zero = summarizeDiscoveredFund(
    portfolio({ holdings: [holding({ value: 0, pctOfNav: 0 })] }),
    apple,
  );
  assert.equal(zero.value, 0);
  assert.equal(zero.pctOfNav, 0);
});

test("merging deduplicates share classes, retains separate series under one trust and never adds fund weights", () => {
  const first = summarizeDiscoveredFund(portfolio(), apple);
  const sameSeries = { ...first, tickers: ["EXB"], cik: "1" };
  const anotherSeries = {
    ...first,
    id: "0000000001:S000000002",
    seriesId: "S000000002",
    pctOfNav: 7,
  };
  const result = mergeDiscoveredFunds([first], [sameSeries, anotherSeries]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].tickers, ["EXAM", "EXB"]);
  assert.deepEqual(
    result.map((fund) => fund.pctOfNav),
    [2, 7],
  );
  assert.deepEqual(first.tickers, ["EXAM"]);
});

test("latest portfolio period wins over a recently filed older period, with later amendments retained", () => {
  const first = summarizeDiscoveredFund(portfolio(), apple);
  const newer = {
    ...first,
    asOf: "2026-06-30",
    filingDate: "2026-08-28",
    accession: "0000000001-26-000002",
    value: 200,
  };
  const oldAmendment = {
    ...first,
    filingDate: "2026-09-01",
    accession: "0000000001-26-000003",
    value: 150,
  };
  assert.equal(
    mergeDiscoveredFunds([first, newer], [oldAmendment])[0].value,
    200,
  );
  const amendment = {
    ...newer,
    filingDate: "2026-09-02",
    accession: "0000000001-26-000004",
    value: 210,
  };
  assert.equal(mergeDiscoveredFunds([newer], [amendment])[0].value, 210);
  assert.equal(mergeDiscoveredFunds([amendment], [newer])[0].value, 210);
  const sameDayAmendment = {
    ...amendment,
    accession: "0000000001-26-000005",
    value: 220,
  };
  assert.equal(
    mergeDiscoveredFunds([sameDayAmendment], [amendment])[0].value,
    220,
  );
});
