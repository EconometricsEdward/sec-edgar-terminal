import test from "node:test";
import assert from "node:assert/strict";
import {
  packPortfolioCompany, unpackPortfolioCompany, packPortfolioSnapshot, unpackPortfolioSnapshot,
} from "../src/utils/portfolioEvidenceCodec.js";

function fixture() {
  const sources = Array.from({ length: 12 }, (_, index) => ({
    accession: "0000320193-26-000001", documentUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/report.htm",
    filed: "2026-02-01", form: "10-K", start: "2025-01-01", end: "2025-12-31", unit: "USD",
    namespace: "us-gaap", tag: `ReportedItem${index}`, value: index === 0 ? 0 : -index,
    ...(index % 2 ? { frame: null } : {}),
  }));
  return { cik: "0000320193", ticker: "AAPL", kind: "company", metrics: {
    revenue: { value: 10, sources, period: { start: "2025-01-01", end: "2025-12-31" }, calculations: [],
      classification: "reported", warnings: [] },
    unavailable: { value: null, sources: [], reason: "No matching observation" },
  } };
}

test("source tuples preserve every field, null, zero, negative number and missing field", () => {
  const company = fixture();
  const packed = JSON.parse(JSON.stringify(packPortfolioCompany(company, { compactSources: true })));
  assert.equal(packed.evidenceEncoding, "portfolio-evidence-pool-v2");
  assert.equal(packed.sourcePoolEncoding, "portfolio-source-tuples-v1");
  assert.deepEqual(unpackPortfolioCompany(packed), company);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(packPortfolioCompany(company)).length);
  const snapshot = { basis: "annual", companies: [company] };
  assert.deepEqual(unpackPortfolioSnapshot(packPortfolioSnapshot(snapshot)), snapshot);
});

test("prepared company payloads retain v1 by default and old saved evidence still opens", () => {
  const company = fixture();
  const legacy = packPortfolioCompany(company);
  assert.equal(legacy.evidenceEncoding, "portfolio-evidence-pool-v1");
  assert.equal(legacy.sourcePoolEncoding, undefined);
  assert.deepEqual(unpackPortfolioCompany(JSON.parse(JSON.stringify(legacy))), company);
});

test("tuple decoders reject unknown versions, ambiguous fields, invalid masks and truncation", () => {
  const packed = packPortfolioCompany(fixture(), { compactSources: true });
  for (const mutate of [
    value => { value.evidenceEncoding = "portfolio-evidence-pool-v9"; },
    value => { value.sourcePoolEncoding = "unknown"; },
    value => { delete value.sourcePoolEncoding; },
    value => { value.evidenceEncoding = "portfolio-evidence-pool-v1"; },
    value => { value.sourceKeys.push(value.sourceKeys[0]); },
    value => { value.sourceKeys[0] = "__proto__"; },
    value => { value.sourceKeys = Array(33).fill("field"); },
    value => { value.sourcePool[0][0] = -1; },
    value => { value.sourcePool[0][0] = 2 ** value.sourceKeys.length; },
    value => { value.sourcePool[0][0] = 0.5; },
    value => { value.sourcePool[0].pop(); },
    value => { value.metrics.revenue.sourceIds = [2000]; },
  ]) {
    const next = structuredClone(packed); mutate(next);
    assert.throws(() => unpackPortfolioCompany(next), /Invalid|Unsupported/);
  }
});

test("small or wide source catalogs fall back to the existing lossless representation", () => {
  const company = fixture();
  company.metrics.revenue.sources = [Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]))];
  const packed = packPortfolioCompany(company, { compactSources: true });
  assert.equal(packed.evidenceEncoding, "portfolio-evidence-pool-v1");
  assert.deepEqual(unpackPortfolioCompany(packed), company);
});

test("the expanded memory budget includes repeated references to tuple sources", () => {
  const company = fixture();
  company.metrics.revenue.sources = company.metrics.revenue.sources.map(source => ({ ...source, label: "x".repeat(20000) }));
  const packed = packPortfolioSnapshot({ companies: Array.from({ length: 100 }, () => structuredClone(company)) });
  for (const row of packed.companies) row.metrics.revenue.sourceIds = Array(100).fill(0);
  assert.throws(() => unpackPortfolioSnapshot(packed), /memory budget/);
});
