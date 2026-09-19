import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildCompareCompany,
  COMPARE_MAPPING_VERSION,
  comparisonSelection,
} from "../src/utils/compareResearch.js";
import { buildAnalysisCompany } from "../src/utils/analysisResearch.js";
import { comparePointQuality } from "../src/utils/compareQuality.js";

const goldman = JSON.parse(fs.readFileSync(new URL("./fixtures/analysis-gs-sec-facts.json", import.meta.url)));
const annual = (val, instant = false, extra = {}) => ({
  val, ...(instant ? {} : { start: "2025-01-01" }), end: "2025-12-31",
  fy: 2025, fp: "FY", form: "10-K", filed: "2026-02-01",
  accn: "0000000001-26-000001", ...extra,
});
const company = (tags = {}, sic = 3571) => ({
  ticker: "TEST", cik: "1", companyName: "Test issuer", sic,
  facts: { "us-gaap": Object.fromEntries(Object.entries({
    Assets: [annual(1000, true)], StockholdersEquity: [annual(400, true)],
    NetIncomeLoss: [annual(100)], Revenues: [annual(500)], ...tags,
  }).map(([tag, facts]) => [tag, { units: { USD: facts } }])) },
});
const at = (data, key) => data.metrics[key]?.[0];

test("Compare and Analysis share actual Goldman net revenue and debt across every supported basis", () => {
  for (const [basis, expectedRevenue] of [["quarter", 20338000000], ["annual", 58283000000], ["ttm", 66203000000]]) {
    const compare = buildCompareCompany(goldman, { basis });
    const analysis = buildAnalysisCompany(goldman, { basis, latestOnly: true });
    assert.equal(at(compare, "revenue").value, expectedRevenue, basis);
    assert.equal(at(compare, "netMargin").value, at(analysis, "netMargin").value);
    assert.equal(at(compare, "debtAssets").value, at(analysis, "debtAssets").value);
    assert.ok(at(compare, "revenue").sources.every((source) => source.tag === "RevenuesNetOfInterestExpense"
      && source.unit === "USD" && source.scopeNote && source.documentUrl.includes("/886982/")));
    for (const key of ["revenue", "netMargin", "debtAssets"])
      assert.equal(comparePointQuality(at(compare, key), key).valid, true, `${basis} ${key}`);
    assert.equal(at(compare, "operatingIncome").value, null, "pretax income is not substituted for operating income");
    assert.equal(at(compare, "operatingMargin").value, null);
  }
});

test("mapped Compare values preserve the filing cutoff", () => {
  const data = buildCompareCompany(goldman, { basis: "quarter", asOf: "2026-05-15" });
  assert.equal(data.periods[0].end, "2026-03-31");
  assert.equal(at(data, "revenue").value, 17227000000);
  for (const points of Object.values(data.metrics)) for (const point of points)
    assert.ok(point.sources.every((source) => source.filed <= "2026-05-15"));
});

test("reported bank net revenue supports efficiency without fabricating missing component income", () => {
  const data = buildCompareCompany(company({ RevenuesNetOfInterestExpense: [annual(200)],
    InterestAndDividendIncomeOperating: [annual(900)], NoninterestExpense: [annual(80)] }, 6021));
  assert.equal(at(data, "bankRevenue").value, 200);
  assert.equal(at(data, "bankRevenue").classification, "reported");
  assert.equal(at(data, "efficiency").value, 40);
  assert.deepEqual(at(data, "efficiency").sources.map((source) => source.tag), ["NoninterestExpense", "RevenuesNetOfInterestExpense"]);
  assert.equal(at(data, "netInterestIncome").value, null);
  assert.equal(at(data, "noninterestIncome").value, null);
});

test("financial net revenue is not substituted for corporate sales or non-USD revenue", () => {
  const corporate = company({ Revenues: [], RevenuesNetOfInterestExpense: [annual(200)] });
  assert.equal(at(buildCompareCompany(corporate), "revenue").value, null);
  corporate.sic = 6211;
  corporate.facts["us-gaap"].RevenuesNetOfInterestExpense.units = { EUR: [annual(200)] };
  assert.equal(at(buildCompareCompany(corporate), "revenue").value, null);
});

test("debt ratios include commercial paper and do not double-count an including-current total", () => {
  const data = buildCompareCompany(company({ LongTermDebtCurrent: [annual(5, true)],
    LongTermDebt: [annual(40, true)], CommercialPaper: [annual(2, true)] }));
  assert.equal(at(data, "debtAssets").value, 4.2);
  assert.ok(at(data, "debtAssets").sources.some((source) => source.tag === "CommercialPaper"));
  assert.ok(at(data, "debtAssets").calculations.some((calculation) => /− current maturities/.test(calculation.formula)));
});

test("complete debt components take priority over narrower combined debt subtotals", () => {
  const data = buildCompareCompany(company({ LongTermDebtCurrent: [annual(5, true)],
    ShortTermBorrowings: [annual(2, true)], LongTermDebtNoncurrent: [annual(35, true)],
    DebtLongtermAndShorttermCombinedAmount: [annual(40, true)] }));
  assert.equal(at(data, "debtAssets").value, 4.2);
});

test("reported combined debt can support a ratio without inventing a current/noncurrent split", () => {
  const data = buildCompareCompany(company({ DebtLongtermAndShorttermCombinedAmount: [annual(40, true)] }));
  assert.equal(at(data, "debtAssets").value, 4);
  assert.deepEqual(at(data, "debtAssets").sources.map((source) => source.tag), ["DebtLongtermAndShorttermCombinedAmount", "Assets"]);
  const incomplete = buildCompareCompany(company({ LongTermDebtCurrent: [annual(5, true)], LongTermDebtNoncurrent: [annual(35, true)] }));
  assert.equal(at(incomplete, "debtAssets").value, null, "missing other short-term borrowing is not assumed to be zero");
});

test("Compare carries source gaps and a mapping revision through its response", () => {
  const input = company();
  input.sourceCoverage = { filingFallback: { status: "unavailable" }, notices: ["The filing could not be loaded."] };
  const data = buildCompareCompany(input);
  assert.equal(data.mappingVersion, COMPARE_MAPPING_VERSION);
  assert.deepEqual(data.sourceCoverage, input.sourceCoverage);
});

test("same-issuer aliases cannot count as distinct peers because one CIK is padded", () => {
  const data = buildCompareCompany(company());
  const result = comparisonSelection([
    { ticker: "ONE", data }, { ticker: "TWO", data: { ...data, cik: "0000000001" } },
  ], { basis: "annual", period: "latest", alignment: "common" });
  assert.equal(result.entries.length, 1);
  assert.equal(result.requested, 1);
});
