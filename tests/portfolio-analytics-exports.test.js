import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import {
  buildPortfolioResearchPackage,
  portfolioAnalyticsCsv,
  portfolioXlsx,
} from "../src/utils/portfolioExports.js";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";

const capturedAt = "2026-09-08T02:24:00.098Z";
const secSource =
  "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm";
const directory = {
  AAA: { cik: "1", name: "Alpha, Inc." },
  AAB: { cik: "1", name: "Alpha, Inc." },
  BBB: { cik: "2", name: "Beta Bank" },
  CCC: { cik: "3", name: "No captured research" },
  FUND: { cik: "4", name: "Direct Fund", isFund: true },
};
const point = (value, unit, extra = {}) => ({
  value,
  unit,
  classification: "calculated",
  period: { end: "2025-12-31" },
  sources: [{ documentUrl: secSource }],
  ...extra,
});
function document() {
  return {
    name: "Observation export fixture",
    rows: resolvePortfolioRows(
      createPortfolioRows([
        { ticker: "AAA", weight_pct: 25, notes: "PRIVATE_NOTE_SENTINEL" },
        { ticker: "AAB", weight_pct: 15 },
        { ticker: "BBB", weight_pct: 30 },
        { ticker: "CCC", weight_pct: 20 },
        { ticker: "FUND", weight_pct: 10 },
      ]),
      directory,
    ),
    allocation: { basis: "weights", normalize: false },
    research: { basis: "annual" },
    snapshot: {
      generated_at: capturedAt,
      basis: "annual",
      companies: [
        {
          cik: "0000000001",
          name: "Alpha, Inc.",
          status: "partial",
          kind: "company",
          lens: "corporate",
          period: { end: "2025-09-30" },
          metrics: {
            currentRatio: point(0, "x"),
            netMargin: point(-12.5, "%", {
              sources: [{ documentUrl: "https://unverified.example/report" }],
            }),
            roe: point(99, "%", { classification: "unavailable" }),
            revenueGrowth: point(50, "USD"),
          },
        },
        {
          cik: "0000000002",
          name: "Beta Bank",
          status: "partial",
          kind: "company",
          lens: "banking",
          period: { end: "2025-12-31" },
          metrics: {
            loanDeposits: point(0, "%"),
            currentRatio: point(99, "x"),
          },
        },
      ],
    },
  };
}

// The upload parser is intentionally bounded to 100 holdings. Read exported
// observation rows in small batches without relaxing the importer limits.
function csvObservationRows(bundle) {
  const lines = portfolioAnalyticsCsv(bundle).trimEnd().split("\r\n");
  const observations = lines.filter((line) =>
    line.startsWith("metric_observation,"),
  );
  return observations.flatMap((line) => {
    const parsed = parsePortfolioCsv(`${lines[0]}\r\n${line}`);
    return parsed.records.map((record) =>
      Object.fromEntries(
        parsed.headers.map((header, index) => [header, record[index]]),
      ),
    );
  });
}
const worksheet = (bundle) =>
  strFromU8(unzipSync(portfolioXlsx(bundle))["xl/worksheets/sheet7.xml"]);

test("metric exports contain one row per issuer and measure, with literal zero, missing and not-applicable distinguished", () => {
  const bundle = buildPortfolioResearchPackage(document());
  const observations = csvObservationRows(bundle);
  assert.equal(observations.length, 32);
  assert.equal(
    new Set(observations.map((row) => `${row.cik}:${row.metric}`)).size,
    32,
  );
  const get = (cik, metric) =>
    observations.find((row) => row.cik === cik && row.metric === metric);
  const ratio = get("0000000001", "currentRatio");
  assert.equal(ratio.ticker, "AAA / AAB");
  assert.equal(ratio.company, "Alpha, Inc.");
  assert.equal(ratio.observation_status, "available");
  assert.equal(ratio.value, "0");
  assert.equal(ratio.unit, "x");
  assert.equal(ratio.period, "2025-12-31");
  assert.equal(ratio.source_url, secSource);
  assert.equal(ratio.known_weight_pct, "40");
  assert.equal(ratio.research_captured_at, capturedAt);
  const margin = get("0000000001", "netMargin");
  assert.equal(margin.value, "-12.5");
  assert.equal(margin.source_url, "");
  for (const metric of ["roe", "revenueGrowth"]) {
    const row = get("0000000001", metric);
    assert.equal(row.observation_status, "missing");
    assert.equal(row.value, "");
    assert.equal(row.period, "");
    assert.equal(row.source_url, "");
  }
  assert.equal(get("0000000002", "loanDeposits").value, "0");
  assert.equal(
    get("0000000002", "currentRatio").observation_status,
    "not_applicable",
  );
  assert.equal(get("0000000002", "currentRatio").value, "");
  assert.ok(
    observations
      .filter((row) => row.cik === "0000000003")
      .every((row) => row.observation_status === "missing" && row.value === ""),
  );
  assert.ok(
    observations
      .filter((row) => row.cik === "0000000004")
      .every(
        (row) =>
          row.observation_status === "not_applicable" && row.value === "",
      ),
  );
  assert.doesNotMatch(portfolioAnalyticsCsv(bundle), /PRIVATE_NOTE_SENTINEL/);
});

test("the seventh worksheet appends metric evidence without changing existing sheet positions", () => {
  const bundle = buildPortfolioResearchPackage(document());
  const files = unzipSync(portfolioXlsx(bundle));
  const names = [
    ...strFromU8(files["xl/workbook.xml"]).matchAll(/name="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(names, [
    "Holdings",
    "Company research",
    "Portfolio summary",
    "Sources",
    "Coverage &amp; methodology",
    "Analytics",
    "Metric observations",
  ]);
  const output = strFromU8(files["xl/worksheets/sheet7.xml"]);
  assert.equal((output.match(/<row r=/g) || []).length, 33);
  for (const expected of [
    "observation_status",
    "source_url",
    "known_weight_pct",
    "0000000001",
    "currentRatio",
    "not_applicable",
    "missing",
    "2025-12-31",
    secSource,
  ])
    assert.ok(output.includes(expected), expected);
  assert.doesNotMatch(output, /unverified\.example|PRIVATE_NOTE_SENTINEL/);
});

test("the captured 100-company demo exports all 800 metric observations with matching applicability and coverage", () => {
  const demo = JSON.parse(
    fs.readFileSync(
      new URL(
        "../public/portfolio/portfolio-demo-100-results.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const bundle = buildPortfolioResearchPackage({
    name: "Captured demo",
    rows: demo.rows,
    allocation: { basis: "none", normalize: false },
    research: { basis: "annual" },
    snapshot: demo.snapshot,
  });
  const observations = csvObservationRows(bundle);
  assert.equal(observations.length, 800);
  assert.equal(new Set(observations.map((row) => row.cik)).size, 100);
  for (const metric of bundle.analytics.metrics) {
    const group = observations.filter((row) => row.metric === metric.id);
    assert.equal(group.length, 100);
    assert.equal(
      group.filter((row) => row.observation_status === "available").length,
      metric.availableCount,
    );
    assert.equal(
      group.filter((row) => row.observation_status === "missing").length,
      metric.missingCount,
    );
    assert.equal(
      group.filter((row) => row.observation_status === "not_applicable").length,
      metric.notApplicableCount,
    );
    for (const row of group) {
      assert.equal(row.unit, metric.unit);
      assert.equal(row.known_weight_pct, "");
      if (row.observation_status !== "available") {
        assert.equal(row.value, "");
        assert.equal(row.period, "");
        assert.equal(row.source_url, "");
      } else {
        const expected = metric.observations.find(
          (entry) => entry.cik === row.cik,
        );
        assert.equal(Number(row.value), expected.value);
        assert.equal(row.period, expected.periodEnd || "");
        assert.equal(row.source_url, expected.sourceUrl || "");
      }
    }
  }
  assert.equal((worksheet(bundle).match(/<row r=/g) || []).length, 801);
});

test("count-only metric observations preserve research while excluding all supplied allocation details", () => {
  const input = document();
  Object.assign(input.rows[0].input, {
    weight_pct: 87.6543,
    market_value: 98765432,
    shares: 34567,
    currency: "XYZ",
    as_of_date: "2023-02-17",
  });
  const bundle = buildPortfolioResearchPackage(input, {
    includeAllocations: false,
  });
  const observations = csvObservationRows(bundle);
  assert.equal(observations.length, 32);
  assert.ok(observations.every((row) => row.known_weight_pct === ""));
  assert.ok(observations.some((row) => row.source_url === secSource));
  for (const output of [portfolioAnalyticsCsv(bundle), worksheet(bundle)])
    assert.doesNotMatch(
      output,
      /87\.6543|98765432|34567|XYZ|2023-02-17|PRIVATE_NOTE_SENTINEL/,
    );
});

test("selected and empty exports omit the full observation grid and unselected identities", () => {
  const input = document();
  input.rows[2].resolution.name = "UNSELECTED_ISSUER_SENTINEL";
  input.snapshot.companies[1].name = "UNSELECTED_ISSUER_SENTINEL";
  for (const selectedRowIds of [[input.rows[0].id], []]) {
    const bundle = buildPortfolioResearchPackage(input, { selectedRowIds });
    assert.equal(csvObservationRows(bundle).length, 0);
    const output = worksheet(bundle);
    assert.equal((output.match(/<row r=/g) || []).length, 2);
    assert.match(output, /not_included_for_selected_export/);
    assert.match(
      output,
      /Portfolio-wide analytics require a full-portfolio export/,
    );
    assert.doesNotMatch(
      output,
      /UNSELECTED_ISSUER_SENTINEL|0000000002|Beta Bank/,
    );
  }
});

test("metric observation exports retain formula-looking company names as literal text", () => {
  const input = document();
  input.snapshot.companies[0].name = '=HYPERLINK("https://bad.example","run")';
  input.rows[0].resolution.name = input.snapshot.companies[0].name;
  input.rows[1].resolution.name = input.snapshot.companies[0].name;
  const bundle = buildPortfolioResearchPackage(input);
  const csv = portfolioAnalyticsCsv(bundle);
  assert.match(csv, /'=HYPERLINK/);
  const output = worksheet(bundle);
  assert.match(output, /HYPERLINK/);
  assert.doesNotMatch(output, /<f(?:\s|>)/);
  assert.match(output, /inlineStr/);
});
