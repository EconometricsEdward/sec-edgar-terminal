import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildPortfolioResearchPackage,
  portfolioAnalyticsCsv,
  portfolioCsv,
  portfolioMarkdown,
  portfolioXlsx,
  researchContext,
} from "../src/utils/portfolioExports.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";

const sourceUrl =
  "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm";
const directory = {
  AAA: { cik: "0000000001", name: "Alpha Corporation" },
  AAB: { cik: "0000000001", name: "Alpha Corporation" },
  BBB: { cik: "0000000002", name: "Beta Corporation" },
};
const source = {
  accession: "0000000001-26-000001",
  documentUrl: sourceUrl,
  form: "10-K",
  filed: "2026-02-01",
  start: "2025-01-01",
  end: "2025-12-31",
  unit: "USD",
  value: 100,
  taxonomy: "us-gaap",
  tag: "Revenue",
};
const company = (cik, ticker, name) => ({
  cik,
  ticker,
  name,
  status: "partial",
  kind: "company",
  industry: "Manufacturing",
  sicDescription: "Industrial machinery",
  period: { start: "2025-01-01", end: "2025-12-31" },
  retrievedAt: "2026-09-07T15:00:00.000Z",
  cache: { status: "cached", storedAt: "2026-09-07T15:00:00.000Z" },
  metrics: {
    revenue: {
      value: 100,
      unit: "USD",
      period: { start: "2025-01-01", end: "2025-12-31" },
      classification: "reported",
      sources: [source],
    },
    freeCashFlow: {
      value: 80,
      unit: "USD",
      classification: "calculated",
      formula: "operatingCashFlow - capitalExpenditure",
      sources: [
        { ...source, tag: "OperatingCashFlow" },
        { ...source, tag: "CapitalExpenditure", value: 20 },
      ],
    },
    debt: {
      value: null,
      unit: "USD",
      classification: "unavailable",
      reason: "No comparable reported inputs",
      sources: [],
    },
  },
  filings: [
    {
      accession: source.accession,
      documentUrl: sourceUrl,
      form: "10-K",
      filingDate: "2026-02-01",
      reportDate: "2025-12-31",
    },
  ],
  filingCoverage: {
    scope: "recent SEC submissions only",
    returnedCount: 1,
    limit: 30,
    archivedSubmissionFilesChecked: 0,
  },
  warnings: ["Debt is unavailable."],
});
function document(
  holdings = [
    { ticker: "AAA", weight_pct: 60, notes: "PRIVATE_SENTINEL" },
    { ticker: "BBB", weight_pct: 20 },
  ],
  allocation = { basis: "weights", normalize: false },
) {
  return {
    name: "Illustrative research",
    rows: resolvePortfolioRows(createPortfolioRows(holdings), directory),
    allocation,
    research: { basis: "annual" },
    snapshot: {
      schema_version: "edgar.portfolio.v1",
      generated_at: "2026-09-07T15:00:00.000Z",
      basis: "annual",
      companies: [
        company("0000000001", "AAA", "Alpha Corporation"),
        company("0000000002", "BBB", "Beta Corporation"),
      ],
    },
  };
}

test("captured package distinguishes original positions, calculations and source evidence", () => {
  const input = document();
  const before = JSON.stringify(input);
  const result = buildPortfolioResearchPackage(input);
  assert.equal(result.schema_version, "edgar.portfolio.research.v1");
  assert.equal(result.research_captured_at, input.snapshot.generated_at);
  assert.equal(result.positions[0].original_weight_pct, 60);
  assert.equal(result.positions[0].analysis_weight_pct, 60);
  assert.equal(result.allocation.originalWeightTotal, 80);
  assert.equal(result.allocation.normalized, false);
  assert.match(result.warnings.join(" "), /80%.*not 100%/);
  assert.equal(result.companies[0].metrics.debt.value, null);
  assert.equal(
    result.companies[0].metrics.freeCashFlow.classification,
    "calculated",
  );
  assert.equal(result.sources[0].documentUrl, sourceUrl);
  assert.equal(
    JSON.stringify(input),
    before,
    "export must not mutate browser state",
  );
});

test("selected export preserves full-document normalization and coverage denominator", () => {
  const input = document(undefined, { basis: "weights", normalize: true });
  const result = buildPortfolioResearchPackage(input, {
    selectedRowIds: [input.rows[0].id],
  });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].original_weight_pct, 60);
  assert.equal(result.positions[0].analysis_weight_pct, 75);
  assert.equal(result.coverage.selected_weight_pct, 75);
  assert.equal(result.coverage.full_document.totalWeight, 100);
  assert.equal(result.companies.length, 1);
  assert.match(result.warnings.join(" "), /full saved portfolio denominator/);
});

test("notes remain absent across nested originals and every export unless explicitly enabled", () => {
  const input = document();
  input.rows[0].originalInput = { ticker: "AAA", notes: "ORIGINAL_PRIVATE" };
  input.rows[0].mergedInputs = [
    { ticker: "AAA", weight_pct: 40, notes: "MERGED_PRIVATE" },
    { ticker: "AAA", weight_pct: 20, notes: "SECOND_PRIVATE" },
  ];
  input.rows[0].resolution.candidates = [
    { name: "Alpha", originals: { notes: "NESTED_PRIVATE" } },
  ];
  const result = buildPortfolioResearchPackage(input);
  for (const output of [
    JSON.stringify(result),
    portfolioCsv(result),
    portfolioMarkdown(result),
    researchContext(result),
  ])
    assert.doesNotMatch(output, /PRIVATE/);
  const workbook = unzipSync(portfolioXlsx(result));
  assert.doesNotMatch(
    Object.values(workbook).map(strFromU8).join(""),
    /PRIVATE/,
  );
  const optedIn = buildPortfolioResearchPackage(input, { includeNotes: true });
  assert.equal(optedIn.positions[0].input.notes, "PRIVATE_SENTINEL");
  assert.equal(optedIn.positions[0].original_inputs[0].notes, "MERGED_PRIVATE");
  assert.match(portfolioMarkdown(optedIn), /PRIVATE/);
});

test("allocation opt-out removes values, quantities, dates and derived allocations", () => {
  const input = document([
    {
      ticker: "AAA",
      weight_pct: 87.6543,
      market_value: 98765432,
      shares: 34567,
      currency: "XYZ",
      as_of_date: "2023-02-17",
      notes: "PRIVATE_SENTINEL",
    },
  ]);
  input.rows[0].originalInput = { ...input.rows[0].input };
  const result = buildPortfolioResearchPackage(input, {
    includeAllocations: false,
  });
  assert.deepEqual(result.positions[0].input, {
    ticker: "AAA",
    company_name: "",
    cik: "",
    exchange: "",
  });
  assert.equal(result.allocation.basis, "none");
  assert.equal(result.coverage.selected_weight_pct, undefined);
  assert.doesNotMatch(
    JSON.stringify(result),
    /87\.6543|98765432|34567|2023-02-17|XYZ|PRIVATE_SENTINEL/,
  );
  assert.equal(
    result.companies[0].metrics.revenue.value,
    100,
    "public company facts remain available",
  );
});

test("universe has no invented weights, and unresolved/excluded rows stay reviewable", () => {
  const input = document(
    [{ ticker: "AAA" }, { ticker: "UNKNOWN" }, { ticker: "BBB" }],
    { basis: "none" },
  );
  input.rows[2].excluded = true;
  const result = buildPortfolioResearchPackage(input);
  assert.equal(result.allocation.mode, "universe");
  assert.equal(result.coverage.selected_weight_pct, null);
  assert.equal(result.positions[0].analysis_weight_pct, null);
  assert.equal(result.coverage.selected_unresolved_positions, 1);
  assert.equal(result.coverage.selected_excluded_positions, 1);
  assert.equal(result.companies.length, 1);
  assert.equal(result.exclusions.length, 2);
  assert.doesNotMatch(portfolioMarkdown(result), /Selected analysis weight: 0/);
});

test("share classes preserve positions while exporting one issuer research record", () => {
  const input = document([
    { ticker: "AAA", weight_pct: 30 },
    { ticker: "AAB", weight_pct: 20 },
    { ticker: "BBB", weight_pct: 50 },
  ]);
  const result = buildPortfolioResearchPackage(input);
  assert.equal(result.positions.length, 3);
  assert.equal(result.companies.length, 2);
  assert.equal(
    result.allocation.issuers.find((issuer) => issuer.cik === "0000000001")
      .weightPct,
    50,
  );
  assert.equal(result.coverage.selected_resolved_companies, 2);
});

test("full exports carry shared analytics with the captured snapshot and issuer denominator", () => {
  const input = document([
    { ticker: "AAA", weight_pct: 30, notes: "ANALYTICS_PRIVATE" },
    { ticker: "AAB", weight_pct: 20 },
    { ticker: "BBB", weight_pct: 50 },
  ]);
  const bundle = buildPortfolioResearchPackage(input);
  const expected = buildPortfolioAnalytics(
    input.rows,
    input.allocation,
    input.snapshot.companies,
    { capturedAt: input.snapshot.generated_at },
  );
  assert.deepEqual(bundle.analytics, {
    ...expected,
    scope: "full_saved_document",
    allocation_information: "included_where_supplied",
  });
  assert.doesNotMatch(JSON.stringify(bundle.analytics), /ANALYTICS_PRIVATE/);
  assert.match(portfolioAnalyticsCsv(bundle), /research_captured_at/);
  assert.match(portfolioAnalyticsCsv(bundle), /2026-09-07T15:00:00.000Z/);
  assert.match(portfolioMarkdown(bundle), /## Portfolio analytics/);
  assert.match(researchContext(bundle), /## Portfolio analytics/);
  const files = unzipSync(portfolioXlsx(bundle));
  assert.match(strFromU8(files["xl/workbook.xml"]), /name="Analytics"/);
});

test("analytics CSV copies issuer medians and coverage without averaging share classes twice", () => {
  const input = document([
    { ticker: "AAA", weight_pct: 30 },
    { ticker: "AAB", weight_pct: 20 },
    { ticker: "BBB", weight_pct: 50 },
  ]);
  input.snapshot.companies[0].metrics.netMargin = {
    value: 10,
    unit: "%",
    classification: "calculated",
    period: { end: "2025-12-31" },
    sources: [source],
  };
  input.snapshot.companies[1].metrics.netMargin = {
    value: 30,
    unit: "%",
    classification: "calculated",
    period: { end: "2025-12-31" },
    sources: [source],
  };
  const bundle = buildPortfolioResearchPackage(input);
  const summary = bundle.analytics.metrics.find(
    (metric) => metric.id === "netMargin",
  );
  const lines = portfolioAnalyticsCsv(bundle).split("\r\n");
  const medianLine = lines.find((line) =>
    line.startsWith("financial_distribution,netMargin.median,"),
  );
  const parsed = parsePortfolioCsv([lines[0], medianLine].join("\r\n"));
  const record = Object.fromEntries(
    parsed.headers.map((header, index) => [header, parsed.records[0][index]]),
  );
  assert.equal(summary.median, 20);
  assert.equal(summary.availableCount, 2);
  assert.equal(Number(record.value), summary.median);
  assert.equal(Number(record.count), summary.availableCount);
  assert.equal(Number(record.eligible_count), summary.eligibleCount);
  assert.equal(Number(record.known_weight_pct), summary.coveredWeightPct);
  assert.equal(record.unit, "%");
  assert.equal(record.scope, "full_saved_document");
  assert.match(portfolioMarkdown(bundle), /Net margin \(%\).*20.*2 \/ 2/);
});

test("selected analytics exports explain omission without exposing unselected issuers", () => {
  const input = document(undefined, { basis: "weights", normalize: true });
  input.rows[1].resolution.name = "UNSELECTED_ISSUER_SENTINEL";
  input.snapshot.companies[1].name = "UNSELECTED_ISSUER_SENTINEL";
  const bundle = buildPortfolioResearchPackage(input, {
    selectedRowIds: [input.rows[0].id],
  });
  assert.deepEqual(bundle.analytics, {
    scope: "not_included_for_selected_export",
    reason:
      "Portfolio-wide analytics require a full-portfolio export; this selected export retains its original weights.",
  });
  assert.equal(bundle.positions[0].analysis_weight_pct, 75);
  for (const output of [
    JSON.stringify(bundle),
    portfolioAnalyticsCsv(bundle),
    portfolioMarkdown(bundle),
    researchContext(bundle),
    Object.values(unzipSync(portfolioXlsx(bundle)))
      .map(strFromU8)
      .join(""),
  ]) {
    assert.doesNotMatch(output, /UNSELECTED_ISSUER_SENTINEL/);
    assert.match(
      output,
      /Portfolio-wide analytics require a full-portfolio export/,
    );
  }
});

test("count-only analytics cannot retain allocation inputs, notes or private allocation dates", () => {
  const input = document([
    {
      ticker: "AAA",
      weight_pct: 87.6543,
      market_value: 98765432,
      shares: 34567,
      currency: "XYZ",
      as_of_date: "2023-02-17",
      notes: "ANALYTICS_PRIVATE",
    },
    { ticker: "BBB", weight_pct: 12.3457 },
  ]);
  input.rows[0].originalInput = { ...input.rows[0].input };
  const bundle = buildPortfolioResearchPackage(input, {
    includeAllocations: false,
  });
  const publicRows = resolvePortfolioRows(
    createPortfolioRows([{ ticker: "AAA" }, { ticker: "BBB" }]),
    directory,
  );
  assert.deepEqual(bundle.analytics, {
    ...buildPortfolioAnalytics(
      publicRows,
      { basis: "none", normalize: false },
      input.snapshot.companies,
      { capturedAt: input.snapshot.generated_at },
    ),
    scope: "full_saved_document",
    allocation_information: "excluded_count_only",
  });
  for (const output of [
    JSON.stringify(bundle),
    portfolioAnalyticsCsv(bundle),
    portfolioMarkdown(bundle),
    researchContext(bundle),
    Object.values(unzipSync(portfolioXlsx(bundle)))
      .map(strFromU8)
      .join(""),
  ])
    assert.doesNotMatch(
      output,
      /87\.6543|98765432|34567|2023-02-17|XYZ|ANALYTICS_PRIVATE/,
    );
});

test("CSV and Markdown retain metric units, periods, formulas, input facts and safe SEC sources", () => {
  const result = buildPortfolioResearchPackage(document());
  const csv = portfolioCsv(result, ["freeCashFlow"]);
  assert.match(csv, /freeCashFlow_unit/);
  assert.match(csv, /freeCashFlow_inputs/);
  assert.match(csv, /operatingCashFlow - capitalExpenditure/);
  assert.match(csv, /2025-12-31/);
  assert.match(csv, /USD/);
  assert.match(csv, /www\.sec\.gov/);
  assert.doesNotMatch(csv.split("\r\n")[0], /revenue_unit/);
  const markdown = portfolioMarkdown(result);
  assert.match(markdown, /CapitalExpenditure, 20 USD/);
  assert.match(markdown, /recent SEC submissions only/);
  assert.match(markdown, /does not refresh itself/);
});

test("spreadsheet and Markdown exports treat formula/script-looking text as data", () => {
  const input = document();
  input.name = "<script>alert(1)</script>";
  input.snapshot.companies[0].name = '=HYPERLINK("https://bad.example","run")';
  input.snapshot.companies[0].metrics.revenue.sources[0] = {
    ...source,
    documentUrl: "javascript:alert(1)",
  };
  input.rows[0].input.notes = '=WEBSERVICE("https://bad.example")';
  const result = buildPortfolioResearchPackage(input, { includeNotes: true });
  const csv = portfolioCsv(result, ["revenue"]);
  assert.match(csv, /'=HYPERLINK/);
  assert.doesNotMatch(portfolioMarkdown(result), /<script>|\]\(javascript:/);
  const files = unzipSync(portfolioXlsx(result));
  assert.match(
    strFromU8(files["xl/workbook.xml"]),
    /Holdings.*Company research.*Portfolio summary.*Sources.*Coverage &amp; methodology/,
  );
  for (const [path, bytes] of Object.entries(files)) {
    assert.doesNotMatch(path, /vbaProject|externalLink|connections/i);
    assert.doesNotMatch(strFromU8(bytes), /<f(?:\s|>)/);
  }
  assert.match(strFromU8(files["xl/worksheets/sheet1.xml"]), /inlineStr/);
});

test("an explicit empty subset exports no company evidence or positions", () => {
  const result = buildPortfolioResearchPackage(document(), {
    selectedRowIds: [],
  });
  assert.equal(result.positions.length, 0);
  assert.equal(result.companies.length, 0);
  assert.equal(result.sources.length, 0);
  assert.equal(result.coverage.selected_company_coverage_pct, null);
});

test("filings-only partial results remain research but do not imply financial-weight coverage", () => {
  const input = document();
  input.snapshot.companies[0].metrics = {
    revenue: { value: null, unit: "USD", classification: "unavailable" },
    cash: { value: 500, unit: "USD", classification: "not_applicable" },
  };
  const bundle = buildPortfolioResearchPackage(input);
  assert.equal(bundle.coverage.selected_companies_with_research, 2);
  assert.equal(bundle.coverage.selected_companies_with_financial_evidence, 1);
  assert.equal(bundle.coverage.selected_researched_weight_pct, 20);
  assert.equal(bundle.coverage.full_document.availableWeight, 20);
  assert.equal(
    bundle.coverage.company_field_coverage.find(
      (item) => item.metric === "cash",
    ).available_companies,
    0,
  );
  assert.match(
    portfolioMarkdown(bundle),
    /Selected weight with financial evidence: 20/,
  );
});

test("100 issuers export all evidence even when the source sheet exceeds 10,000 rows", () => {
  const holdings = Array.from({ length: 100 }, (_, index) => ({
    ticker: `T${index}`,
  }));
  const entries = Object.fromEntries(
    holdings.map((holding, index) => [
      holding.ticker,
      {
        cik: String(index + 1).padStart(10, "0"),
        name: `Fixture company ${index}`,
      },
    ]),
  );
  const rows = resolvePortfolioRows(createPortfolioRows(holdings), entries);
  const companies = rows.map((row) => ({
    ...company(row.resolution.cik, row.resolution.ticker, row.resolution.name),
    metrics: Object.fromEntries(
      Array.from({ length: 21 }, (_, metric) => [
        `metric${metric}`,
        {
          value: 10,
          unit: "USD",
          classification: "calculated",
          formula: "Sum of six reported inputs",
          sources: Array.from({ length: 6 }, (_, part) => ({
            ...source,
            tag: `Metric${metric}Part${part}`,
          })),
        },
      ]),
    ),
  }));
  const bundle = buildPortfolioResearchPackage({
    name: "100-company fixture",
    rows,
    allocation: { basis: "equal" },
    snapshot: {
      generated_at: "2026-09-07T15:00:00Z",
      basis: "annual",
      companies,
    },
  });
  assert.equal(bundle.positions.length, 100);
  assert.equal(bundle.companies.length, 100);
  assert.equal(bundle.positions[0].analysis_weight_pct, 1);
  assert.equal(bundle.sources.length, 12700);
  const sheets = unzipSync(portfolioXlsx(bundle));
  const sourceSheet = strFromU8(sheets["xl/worksheets/sheet4.xml"]);
  assert.equal((sourceSheet.match(/<row r=/g) || []).length, 12701);
  assert.match(sourceSheet, /0000000100/);
});
