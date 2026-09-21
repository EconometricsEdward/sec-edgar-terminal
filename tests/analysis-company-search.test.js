import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisCompanyPath,
  findAnalysisCompanyMatches,
  resolveAnalysisCompany,
  analysisCikIdentifier,
  analysisBrokerDealerMatches,
} from "../src/utils/analysisCompanySearch.js";

const company = (ticker, name, isFund = false) => ({ ticker, name, isFund });
const directory = Object.fromEntries([
  company("AAPL", "Apple Inc."),
  company("APLE", "Apple Hospitality REIT, Inc."),
  company("TSLA", "Tesla, Inc."),
  company("AMZN", "Amazon.com, Inc."),
  company("EXAMPLE", "Example Company Outside the Samples"),
  company("BRK-A", "Berkshire Hathaway Inc"),
  company("BRK-B", "Berkshire Hathaway Inc"),
  company("TEST.A", "Dot Share Class Incorporated"),
  company("VFIAX", "Mutual Fund (VFIAX)", true),
].map((entry) => [entry.ticker, entry]));

test("name-shaped symbols resolve to the actual SEC ticker, not an invented URL", () => {
  assert.equal(resolveAnalysisCompany("Tesla", directory).company?.ticker, "TSLA");
  assert.equal(resolveAnalysisCompany("amazon", directory).company?.ticker, "AMZN");
  assert.equal(analysisCompanyPath(resolveAnalysisCompany("Tesla", directory).company), "/analysis/TSLA");
  assert.equal(resolveAnalysisCompany("MADEUP", directory).kind, "not_found");
});

test("company search is independent of the landing-page sample companies", () => {
  assert.equal(resolveAnalysisCompany("  example ", directory).company?.ticker, "EXAMPLE");
  assert.equal(resolveAnalysisCompany("Outside the Samples", directory).company?.ticker, "EXAMPLE");
});

test("exact company names take priority over incidental name matches", () => {
  assert.deepEqual(findAnalysisCompanyMatches("Apple", directory).map((entry) => entry.ticker), ["AAPL", "APLE"]);
  assert.equal(resolveAnalysisCompany("Apple", directory).company?.ticker, "AAPL");
  assert.equal(resolveAnalysisCompany("Apple, Inc.", directory).company?.ticker, "AAPL");
});

test("ambiguous names and multiple share classes require an explicit selection", () => {
  assert.equal(resolveAnalysisCompany("Berkshire Hathaway", directory).kind, "ambiguous");
  assert.equal(resolveAnalysisCompany("Inc", directory).kind, "ambiguous");
  const crowded = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
    const ticker = `XYZ${i}`;
    return [ticker, company(ticker, `Common Name ${i}`)];
  }));
  assert.equal(findAnalysisCompanyMatches("Common", crowded).length, 6);
  assert.equal(resolveAnalysisCompany("Common", crowded).kind, "ambiguous");
});

test("exact tickers win over competing names and share-class aliases remain valid", () => {
  const withAlias = { ...directory, TESLA: company("TESLA", "A Company Named Differently") };
  assert.equal(resolveAnalysisCompany("TESLA", withAlias).company?.ticker, "TESLA");
  assert.equal(resolveAnalysisCompany("brk.b", directory).company?.ticker, "BRK-B");
  assert.equal(resolveAnalysisCompany("BRK-A", directory).company?.ticker, "BRK-A");
  assert.equal(resolveAnalysisCompany("test-a", directory).company?.ticker, "TEST.A");
});

test("fund classifications survive both search and navigation", () => {
  const result = resolveAnalysisCompany("vfiax", directory);
  assert.equal(result.company?.isFund, true);
  assert.equal(analysisCompanyPath(result.company), "/fund/VFIAX");
  assert.equal(analysisCompanyPath(directory.AAPL), "/analysis/AAPL");
});

test("empty, unavailable and punctuation-only inputs do not create destinations", () => {
  assert.equal(resolveAnalysisCompany(" ", directory).kind, "empty");
  assert.equal(resolveAnalysisCompany("AAPL", null).kind, "unavailable");
  assert.equal(resolveAnalysisCompany("..", directory).kind, "not_found");
  assert.deepEqual(findAnalysisCompanyMatches("..", directory), []);
  assert.deepEqual(findAnalysisCompanyMatches("AAPL", null), []);
});

test('broker-dealer analysis choices preserve verified annual-filer CIKs instead of listed parent tickers', () => {
  assert.equal(analysisCikIdentifier('CIK 123456'), '0000123456');
  assert.equal(analysisCikIdentifier('0000000000'), null);
  assert.equal(analysisCikIdentifier('12345678901'), null);
  const choices = analysisBrokerDealerMatches([
    { cik: '123456', name: 'Example Securities LLC', formTypes: ['X-17A-5/A'] },
    { cik: '999999', name: 'Example Parent Inc', formTypes: ['10-K'] },
    { cik: '0000000000', name: 'Invalid identity', formTypes: ['X-17A-5'] },
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].isBrokerDealer, true);
  assert.equal(analysisCompanyPath(choices[0]), '/analysis/0000123456');
});
