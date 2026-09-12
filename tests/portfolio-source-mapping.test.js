import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { unpackPortfolioSnapshot } from "../src/utils/portfolioEvidenceCodec.js";

// Audit the shipped evidence itself, independently of the helpers that present
// observation dates. This catches a bad capture as well as a bad source link.
const demo = JSON.parse(
  fs.readFileSync(
    new URL(
      "../public/portfolio/portfolio-demo-100-results.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const snapshot = unpackPortfolioSnapshot(demo.snapshot);
const observations = snapshot.companies.flatMap((company) =>
  Object.entries(company.metrics || {})
    .filter(([, point]) => Number.isFinite(point.value))
    .map(([key, point]) => ({ company, key, point })),
);
const openingKeys = new Set([
  "openingReceivables",
  "openingInventory",
  "openingAccountsPayable",
]);
const identify = (company, key) => `${company.ticker}: ${key}`;

test("every demo financial source URL identifies its company and exact source accession", () => {
  assert.equal(snapshot.companies.length, 100);
  let checked = 0;
  for (const { company, key, point } of observations) {
    for (const source of point.sources || []) {
      const message = identify(company, key);
      assert.ok(source.documentUrl, `${message} has an SEC source URL`);
      const url = new URL(source.documentUrl);
      assert.equal(url.protocol, "https:", message);
      assert.ok(["sec.gov", "www.sec.gov"].includes(url.hostname), message);
      const path = url.pathname.match(
        /^\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//,
      );
      assert.ok(path, `${message} links to an SEC filing accession`);
      const filingCik = String(path[1]).padStart(10, "0");
      if (source.sourceCik) {
        assert.match(
          source.sourceCik,
          /^\d{10}$/,
          `${message} has a canonical source CIK`,
        );
        assert.equal(Number(path[1]), Number(source.sourceCik), message);
      }
      if (filingCik !== company.cik) {
        assert.ok(
          company.evidenceContinuity?.predecessorCiks?.includes(filingCik),
          `${message} discloses its verified predecessor source`,
        );
      } else {
        assert.equal(Number(path[1]), Number(company.cik), message);
      }
      assert.match(source.accession, /^\d{10}-\d{2}-\d{6}$/, message);
      assert.equal(path[2], source.accession.replaceAll("-", ""), message);
      checked++;
    }
  }
  assert.ok(checked > 8000, "the audit must cover the complete demo evidence");
});

test("every single-source reported demo value matches the original value and unit", () => {
  let checked = 0;
  for (const { company, key, point } of observations) {
    if (point.classification !== "reported" || point.sources?.length !== 1)
      continue;
    const source = point.sources[0];
    const message = identify(company, key);
    assert.ok(Number.isFinite(source.value), message);
    assert.equal(point.value, source.value, message);
    assert.equal(point.unit, source.unit, message);
    checked++;
  }
  assert.ok(checked > 3000, "reported values must not escape the source audit");
});

test("reported closing balances and financial flows match the selected company period", () => {
  let checked = 0;
  for (const { company, key, point } of observations) {
    if (
      openingKeys.has(key) ||
      point.classification !== "reported" ||
      point.sources?.length !== 1
    )
      continue;
    const source = point.sources[0];
    const message = identify(company, key);
    assert.equal(source.end, company.period.end, message);
    if (source.start) assert.equal(source.start, company.period.start, message);
    checked++;
  }
  assert.ok(checked > 3000, "both flow values and closing balances are checked");
});

test("opening working-capital balances are measured immediately before the selected duration", () => {
  const checkedKeys = new Set();
  let checked = 0;
  for (const { company, key, point } of observations) {
    if (!openingKeys.has(key)) continue;
    const message = identify(company, key);
    assert.equal(point.classification, "reported", message);
    assert.equal(point.sources.length, 1, message);
    const source = point.sources[0];
    assert.equal(source.start, null, `${message} is an instant balance`);
    const dayAfterBalance = new Date(`${source.end}T00:00:00.000Z`);
    dayAfterBalance.setUTCDate(dayAfterBalance.getUTCDate() + 1);
    assert.equal(
      dayAfterBalance.toISOString().slice(0, 10),
      company.period.start,
      `${message} must not use the closing balance or the previous visible quarter`,
    );
    checkedKeys.add(key);
    checked++;
  }
  assert.deepEqual(checkedKeys, openingKeys);
  assert.ok(checked > 200, "the audit covers opening balances across the demo");
});

test("Amazon opening and closing payables retain the correct comparative values and filings", () => {
  const amazon = snapshot.companies.find((company) => company.ticker === "AMZN");
  assert.ok(amazon);
  assert.equal(amazon.period.start, "2025-01-01");
  assert.equal(amazon.period.end, "2025-12-31");
  const opening = amazon.metrics.openingAccountsPayable;
  const closing = amazon.metrics.accountsPayable;

  // Amazon's FY2025 10-K, consolidated balance sheets, page 39, reports
  // accounts payable of $94,363m (2024) and $121,909m (2025).
  assert.equal(opening.value, 94_363_000_000);
  assert.equal(opening.sources[0].end, "2024-12-31");
  assert.equal(opening.sources[0].accession, "0001018724-26-000004");
  assert.equal(
    opening.sources[0].documentUrl,
    "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000004/amzn-20251231.htm",
  );

  assert.equal(closing.value, 121_909_000_000);
  assert.equal(closing.sources[0].end, "2025-12-31");
  // The most recently filed exact-context observation can be a comparative
  // column in a later 10-Q. Its filing year must not replace its balance date.
  assert.equal(closing.sources[0].accession, "0001018724-26-000026");
  assert.equal(closing.sources[0].form, "10-Q");
  assert.equal(
    closing.sources[0].documentUrl,
    "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000026/amzn-20260630.htm",
  );
  assert.notEqual(opening.value, closing.value);
});
