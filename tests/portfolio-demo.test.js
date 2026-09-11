import { createPortfolioBaseline } from "../src/utils/portfolioChanges.js";
import {
  unpackPortfolioSnapshot,
  packPortfolioStore,
} from "../src/utils/portfolioEvidenceCodec.js";
import { portfolioAvailableMetrics } from "../src/utils/portfolioDeepResearch.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import {
  parsePortfolioCsv,
  parsePortfolioJson,
  parsePortfolioXlsx,
  mapPortfolioColumns,
  MAX_PORTFOLIO_FILE_BYTES,
} from "../src/utils/portfolioFiles.js";
import {
  normalizePortfolioInput,
  allocationSummary,
} from "../src/utils/portfolioModel.js";
import {
  createPortfolio,
  validatePortfolios,
  PORTFOLIO_STORAGE_LIMIT,
} from "../src/utils/portfolioStorage.js";

const asset = (suffix) =>
  fs.readFileSync(
    new URL(`../public/portfolio/portfolio-demo-100${suffix}`, import.meta.url),
  );
const input = JSON.parse(asset(".json"));
const encodedDemo = JSON.parse(asset("-results.json"));
const demo = {
  ...encodedDemo,
  snapshot: unpackPortfolioSnapshot(encodedDemo.snapshot),
};
const tickers = input.holdings.map((holding) => holding.ticker);
const secUrl = (value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port
  );
};

test("all three demo templates import the same 100 unique ticker-only rows", () => {
  assert.equal(tickers.length, 100);
  assert.equal(new Set(tickers).size, 100);
  assert.ok(tickers.every((ticker) => /^[A-Z][A-Z0-9.-]*$/.test(ticker)));
  assert.deepEqual(input.allocation, { basis: "none", normalize: false });
  assert.deepEqual(input.research, { basis: "annual" });
  const templates = [
    [".csv", parsePortfolioCsv],
    [".json", parsePortfolioJson],
    [".xlsx", parsePortfolioXlsx],
  ];
  for (const [extension, parser] of templates) {
    const bytes = asset(extension);
    assert.ok(bytes.byteLength < MAX_PORTFOLIO_FILE_BYTES);
    const parsed = parser(
      extension === ".xlsx" ? bytes : bytes.toString("utf8"),
    );
    const rows = mapPortfolioColumns(parsed);
    const normalized = normalizePortfolioInput({ ...input, holdings: rows });
    assert.deepEqual(
      normalized.holdings.map((holding) => holding.ticker),
      tickers,
    );
    for (const holding of normalized.holdings) {
      for (const field of [
        "weight_pct",
        "market_value",
        "shares",
        "currency",
        "as_of_date",
        "notes",
      ])
        assert.equal(
          holding[field],
          "",
          `${extension} must not imply allocations or add private data`,
        );
    }
  }
});

test("the demo workbook contains review instructions and literal cells without active content", () => {
  const parts = unzipSync(asset(".xlsx"));
  const xml = Object.entries(parts)
    .filter(([name]) => name.endsWith(".xml"))
    .map(([, bytes]) => strFromU8(bytes))
    .join("\n");
  assert.match(xml, /Instructions/);
  assert.match(xml, /workspace\/demo/);
  assert.doesNotMatch(xml, /<f(?:\s|>)/);
  assert.ok(
    Object.keys(parts).every(
      (name) => !/vbaProject|externalLinks|connections\.xml/i.test(name),
    ),
  );
});

test("captured analysis aligns every input to one verified issuer and retains SEC evidence", () => {
  assert.equal(demo.schema_version, "edgar.portfolio.demo.v1");
  assert.deepEqual(demo.input, input);
  assert.equal(demo.snapshot.generated_at, demo.captured_at);
  assert.equal(demo.snapshot.basis, "annual");
  assert.ok(
    Date.parse(demo.capture_started_at) <= Date.parse(demo.captured_at),
  );
  assert.equal(demo.rows.length, 100);
  assert.equal(demo.snapshot.companies.length, 100);
  assert.deepEqual(
    demo.rows.map((row) => row.input.ticker),
    tickers,
  );
  assert.equal(new Set(demo.rows.map((row) => row.resolution.cik)).size, 100);
  for (const row of demo.rows) {
    assert.equal(row.resolution.status, "resolved");
    assert.equal(row.resolution.kind, "company");
    const company = demo.snapshot.companies.find(
      (entry) => entry.cik === row.resolution.cik,
    );
    assert.ok(company, `Missing captured issuer for ${row.input.ticker}`);
    if (company.ticker) assert.equal(company.ticker, row.input.ticker);
    assert.equal(company.kind, "company");
    for (const point of Object.values(company.metrics || {})) {
      if (Number.isFinite(point.value)) {
        assert.ok(["reported", "calculated"].includes(point.classification));
        assert.ok(
          point.period?.end,
          "Financial evidence retains its reporting period",
        );
        assert.ok(
          point.sources?.length,
          "Available values require captured source evidence",
        );
      }
      for (const source of point.sources || []) {
        assert.ok(secUrl(source.documentUrl));
        assert.ok(source.accession && source.form && source.filed);
      }
    }
    for (const filing of company.filings || []) {
      assert.ok(secUrl(filing.documentUrl));
      assert.ok(filing.accession && filing.filingDate && filing.form);
    }
    if (company.status !== "failed")
      assert.ok(Number.isFinite(Date.parse(company.retrievedAt)));
  }
  assert.equal(demo.methodology.requests.length, 20);
  assert.deepEqual(
    demo.methodology.requests.flatMap((request) => request.tickers),
    tickers,
  );
  assert.ok(
    demo.methodology.requests.every((request) => request.tickers.length <= 5),
  );
});

test("demo coverage is recomputed over all companies and the full capture fits existing storage", () => {
  const companies = demo.snapshot.companies;
  const summary = allocationSummary(
    demo.rows,
    input.allocation,
    Object.fromEntries(companies.map((company) => [company.cik, company])),
  );
  assert.equal(
    demo.coverage.financialEvidence,
    summary.coverage.availableCompanies,
  );
  assert.equal(demo.coverage.financialEvidencePct, summary.coverage.companyPct);
  assert.ok(
    demo.coverage.financialEvidence > 0,
    "The example must contain usable financial evidence",
  );
  for (const status of ["ready", "partial", "failed", "unsupported"])
    assert.equal(
      demo.coverage[status],
      companies.filter((company) => company.status === status).length,
    );
  assert.equal(
    demo.coverage.filingCount,
    companies.reduce(
      (total, company) => total + (company.filings?.length || 0),
      0,
    ),
  );
  assert.ok(demo.coverage.filingCount > 0);
  assert.equal(summary.mode, "universe");
  assert.equal(summary.allocatedWeight, null);
  const document = createPortfolio({
    id: "demo-validation",
    name: input.name,
    rows: demo.rows,
    allocation: input.allocation,
    research: input.research,
    snapshot: demo.snapshot,
    now: demo.captured_at,
  });
  document.comparisonBaseline = createPortfolioBaseline(document.snapshot);
  const store = { version: 1, portfolios: [document], activeId: document.id };
  assert.doesNotThrow(() => validatePortfolios(store));
  assert.ok(
    Buffer.byteLength(JSON.stringify(packPortfolioStore(store))) <
      PORTFOLIO_STORAGE_LIMIT,
  );
});

test("the expanded demo exposes measured debt and never offers empty investment income", () => {
  const available = portfolioAvailableMetrics(demo.snapshot.companies);
  assert.equal(
    available.find((metric) => metric.key === "shortTermDebt").availableCount,
    84,
  );
  assert.ok(!available.some((metric) => metric.key === "investmentIncome"));
  assert.ok(available.every((metric) => metric.availableCount > 0));
});
