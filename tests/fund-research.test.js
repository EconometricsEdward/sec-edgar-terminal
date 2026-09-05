import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNport,
  parseFundFeed,
  portfolioSummary,
  filterHoldings,
  portfolioOverlap,
  holdingsCsv,
} from "../src/utils/fundResearch.js";
function xml(positions, extra = "") {
  return `<edgarSubmission><genInfo><regCik>36405</regCik><regName>Trust &amp; Co.</regName><seriesName>Correct Fund</seriesName><seriesId>S000002839</seriesId><repPdEnd>2026-12-31</repPdEnd><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><totAssets>1200</totAssets><totLiabs>200</totLiabs><netAssets>1000</netAssets><cshNotRptdInCorD>0</cshNotRptdInCorD></fundInfo><invstOrSecs>${positions}</invstOrSecs>${extra}</edgarSubmission>`;
}
function position({
  name = "Company",
  value = "100",
  weight = "10",
  cusip = "123456789",
  asset = "EC",
  payoff = "Long",
} = {}) {
  return `<invstOrSec><name>${name}</name><cusip>${cusip}</cusip><balance>-2</balance><units>NC</units><valUSD>${value}</valUSD>${weight == null ? "" : `<pctVal>${weight}</pctVal>`}<assetCat>${asset}</assetCat><invCountry>US</invCountry><payoffProfile>${payoff}</payoffProfile><identifiers><isin value="US1234567890"/></identifiers></invstOrSec>`;
}
const expected = { cik: "0000036405", seriesId: "S000002839" };
test("rejects another series under the same trust CIK", () => {
  assert.throws(
    () => parseNport(xml(position()), { ...expected, seriesId: "S000002846" }),
    /series does not match/,
  );
});
test("rejects another registrant and malformed reports", () => {
  assert.throws(
    () => parseNport(xml(position()), { cik: "999" }),
    /registrant/,
  );
  assert.throws(() => parseNport("<html>Blocked</html>"), /readable/);
});
test("uses portfolio date, preserves identity and attribute identifiers", () => {
  const p = parseNport(xml(position()), expected);
  assert.equal(p.asOf, "2026-06-30");
  assert.equal(p.registrant, "Trust & Co.");
  assert.equal(p.holdings[0].isin, "US1234567890");
  assert.equal(p.fundInfo.cash, 0);
});
test("reads namespaced filings without truncating before sorting", () => {
  const many = Array.from({ length: 125 }, (_, i) =>
    position({ name: `Holding ${i}`, value: String(i) }),
  ).join("");
  const namespaced = xml(many).replace(
    /<(\/?)([a-zA-Z][\w]*)(?=[\s>])/g,
    "<$1n:$2",
  );
  const p = parseNport(namespaced, expected);
  assert.equal(p.holdings.length, 125);
  assert.equal(p.holdings[0].name, "Holding 124");
  assert.equal(p.holdings[124].value, 0);
});
test("keeps zero, negative, missing and scientific notation values distinct", () => {
  const p = parseNport(
    xml(
      position({ value: "0", weight: "0" }) +
        position({ value: "-20", weight: "-2" }) +
        position({ value: "N/A", weight: null }) +
        position({ value: "1e2", weight: null }),
    ),
  );
  assert.deepEqual(
    p.holdings.map((h) => h.value),
    [100, 0, -20, null],
  );
  assert.equal(p.holdings[0].pctOfNav, 10);
  assert.equal(p.holdings[0].weightSource, "calculated");
  assert.equal(p.holdings[2].balance, -2);
  assert.equal(p.holdings[3].pctOfNav, null);
});
test("net assets require both inputs when not reported directly", () => {
  const raw = xml(position()).replace("<netAssets>1000</netAssets>", "");
  assert.equal(parseNport(raw).fundInfo.netAssets, 1000);
  assert.equal(
    parseNport(raw.replace("<totLiabs>200</totLiabs>", "")).fundInfo.netAssets,
    null,
  );
});
test("category weights use net assets, not a normalized holdings subset", () => {
  const p = parseNport(
    xml(
      position({ value: "600", weight: "60" }) +
        position({ value: "-100", weight: "-10", asset: "DE" }),
    ),
  );
  const s = portfolioSummary(p);
  assert.equal(s.assets[0].pctOfNav, 60);
  assert.equal(s.assets[1].pctOfNav, -10);
  assert.equal(s.weightTotal, 50);
  assert.equal(s.derivativeCount, 1);
});
test("filter and sort search the full portfolio, preserve missing values at the end", () => {
  const p = parseNport(
    xml(
      position({ name: "Alpha", value: "N/A", weight: null }) +
        position({ name: "Beta", value: "-100" }) +
        position({ name: "Gamma", value: "0" }),
    ),
  );
  assert.equal(
    filterHoldings(p.holdings, { sort: "value", direction: "asc" })[0].name,
    "Beta",
  );
  assert.equal(
    filterHoldings(p.holdings, { sort: "value", direction: "asc" }).at(-1).name,
    "Alpha",
  );
  assert.equal(filterHoldings(p.holdings, { query: "US1234567890" }).length, 3);
  assert.equal(filterHoldings(p.holdings, { country: "GB" }).length, 0);
});
test("feed includes amendments but excludes exhibits", () => {
  const entry = (form) =>
    `<entry><accession-number>0000036405-26-000473</accession-number><filing-type>${form}</filing-type><filing-date>2026-08-28</filing-date></entry>`;
  assert.deepEqual(
    parseFundFeed(
      entry("NPORT-P") + entry("NPORT-P/A") + entry("NPORT-EX"),
    ).map((f) => f.form),
    ["NPORT-P", "NPORT-P/A"],
  );
});
test("overlap aggregates duplicate securities and excludes shorts and derivatives", () => {
  const a = {
    ...parseNport(
      xml(
        position({ weight: "6" }) +
          position({ weight: "4" }) +
          position({ weight: "20", asset: "DE" }) +
          position({ weight: "3", payoff: "Short" }),
      ),
    ),
    ticker: "AAA",
  };
  const b = {
    ...parseNport(xml(position({ weight: "8" }))),
    ticker: "BBB",
    asOf: "2026-03-31",
  };
  const result = portfolioOverlap(a, b);
  assert.equal(result.count, 1);
  assert.equal(result.overlap, 8);
  assert.equal(result.leftExcludedCount, 2);
  assert.equal(result.leftEligibleWeight, 10);
  assert.equal(result.samePeriod, false);
  assert.equal(result.samePortfolio, true);
});
test("overlap never matches absent identifiers by company name", () => {
  const a = parseNport(
    xml(position({ cusip: "N/A" })).replace('<isin value="US1234567890"/>', ""),
  );
  assert.equal(portfolioOverlap(a, a).count, 0);
});
test("CSV includes every requested row and evidence, escapes formulas and quotes, preserves signed numbers", () => {
  const p = {
    ...parseNport(
      xml(position({ name: "=HYPERLINK(&quot;x&quot;)", value: "-10" })),
    ),
    ticker: "TEST",
    sourceUrl: "https://www.sec.gov/filing",
    accession: "0000036405-26-000473",
    filingDate: "2026-08-28",
  };
  const csv = holdingsCsv(p);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"-10"/);
  assert.match(csv, /2026-06-30/);
  assert.match(csv, /https:\/\/www.sec.gov\/filing/);
  assert.equal(csv.split("\r\n").length, 2);
});
test("unassigned series names fall back to the registrant, not N/A", () => {
  const raw = xml(position()).replace(
    "<seriesName>Correct Fund</seriesName>",
    "<seriesName>N/A</seriesName>",
  );
  assert.equal(parseNport(raw).name, "Trust & Co.");
});
test("overlap excludes missing long/short labels and malformed security identifiers", () => {
  const p = parseNport(
    xml(position()).replace("<payoffProfile>Long</payoffProfile>", ""),
  );
  assert.equal(portfolioOverlap(p, p).count, 0);
  const q = parseNport(
    xml(position({ cusip: "Unspecified" })).replace(
      '<isin value="US1234567890"/>',
      "",
    ),
  );
  assert.equal(portfolioOverlap(q, q).count, 0);
});
