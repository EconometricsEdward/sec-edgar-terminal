import test from "node:test";
import assert from "node:assert/strict";
import {
  packPortfolioBaseline,
  unpackPortfolioBaseline,
} from "../src/utils/portfolioBaselineCodec.js";
import { validatePortfolioBaseline } from "../src/utils/portfolioChanges.js";

const definition = (unit, classification, formula, tags, calculations = []) =>
  JSON.stringify({ unit, classification, formula, tags, calculations });

function baselineFixture() {
  return {
    schema_version: "edgar.portfolio.baseline.v1",
    capturedAt: "2026-09-12T00:00:00.000Z",
    basis: "annual",
    sources: [
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/report.htm",
      "https://sec.gov/Archives/edgar/data/2/000000000226000002/report.htm",
      "https://data.sec.gov/submissions/CIK0000000001.json",
    ],
    periods: [
      JSON.stringify({
        start: "2025-01-01",
        end: "2025-12-31",
        kind: "annual",
        fy: "2025",
        fp: "FY",
      }),
      "opaque-legacy-period",
    ],
    definitions: [
      definition("USD", "reported", "", ["us-gaap:Revenue"]),
      definition("%", "calculated", "income / revenue", [], [
        ["Income", "", "USD", "reported", "us-gaap", "NetIncomeLoss"],
      ]),
      "opaque-legacy-definition",
    ],
    companies: [
      {
        cik: "0000000001",
        ticker: "ONE",
        name: "Issuer One",
        status: "ready",
        checked: true,
        period: 0,
        metrics: {
          revenue: {
            value: -0,
            unit: "USD",
            label: "Revenue",
            period: 0,
            definition: 0,
            sources: [0, 2],
          },
          netMargin: {
            value: null,
            unit: "%",
            label: "Net margin",
            period: 1,
            definition: 1,
            sources: [],
          },
        },
        filings: ["0000000001-26-000001", "0000000002-26-000002"],
      },
      {
        cik: "0000000002",
        ticker: "TWO",
        name: "Issuer Two",
        status: "failed",
        checked: false,
        period: 1,
        metrics: {},
        filings: [],
      },
    ],
  };
}

test("v2 checkpoint vectors preserve every expanded field and number exactly", () => {
  const baseline = baselineFixture();
  assert.deepEqual(validatePortfolioBaseline(baseline), baseline);
  const packed = packPortfolioBaseline(baseline);
  assert.equal(packed.metricEncoding, "portfolio-checkpoint-tuples-v2");
  assert.ok(Array.isArray(packed.metricDescriptors));
  assert.ok(Array.isArray(packed.metricSchemas));
  assert.ok(Array.isArray(packed.evidenceDescriptors));
  assert.ok(Array.isArray(packed.companies[0]));
  const decoded = unpackPortfolioBaseline(packed);
  assert.deepEqual(decoded, baseline);
  assert.ok(Object.is(decoded.companies[0].metrics.revenue.value, -0));
  assert.deepEqual(validatePortfolioBaseline(packed), baseline);
});

test("frozen v1 checkpoints remain readable and validate through the public schema", () => {
  const baseline = baselineFixture();
  const descriptors = [],
    descriptorIds = new Map();
  const companies = baseline.companies.map((company) => ({
    ...company,
    metrics: Object.fromEntries(
      Object.entries(company.metrics).map(([key, point]) => {
        const signature = JSON.stringify([point.unit, point.label]);
        if (!descriptorIds.has(signature)) {
          descriptorIds.set(signature, descriptors.length);
          descriptors.push([point.unit, point.label]);
        }
        return [
          key,
          [
            point.value,
            descriptorIds.get(signature),
            point.period,
            point.definition,
            point.sources,
          ],
        ];
      }),
    ),
  }));
  const encoded = {
    ...baseline,
    metricEncoding: "portfolio-checkpoint-tuples-v1",
    metricDescriptors: descriptors,
    companies,
  };
  assert.deepEqual(unpackPortfolioBaseline(encoded), baseline);
  assert.deepEqual(validatePortfolioBaseline(encoded), baseline);
});

test("v2 decoding rejects corrupt schemas, vectors, evidence and pooled text", () => {
  const encoded = packPortfolioBaseline(baselineFixture());
  const mutations = [
    (value) => {
      value.companies[0][6] = 999;
    },
    (value) => {
      value.companies[0][7] = "1,zzzz";
    },
    (value) => {
      value.companies[0][7] += ";3,0";
    },
    (value) => {
      value.evidenceDescriptors[0] = "not.base36!";
    },
    (value) => {
      value.definitions[0][0] = 999;
    },
    (value) => {
      value.companies[0][8] = "not-an-accession";
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(encoded);
    mutate(invalid);
    assert.throws(() => validatePortfolioBaseline(invalid), /Invalid/);
  }
});

test("packing cannot erase unsupported company or metric fields", () => {
  const companyField = baselineFixture();
  companyField.companies[0].privateNote = "must remain visible to validation";
  assert.strictEqual(packPortfolioBaseline(companyField), companyField);
  assert.throws(() => validatePortfolioBaseline(companyField), /unsupported/);

  const metricField = baselineFixture();
  metricField.companies[0].metrics.revenue.privateNote = "must remain visible";
  assert.strictEqual(packPortfolioBaseline(metricField), metricField);
  assert.throws(() => validatePortfolioBaseline(metricField), /unsupported/);
});
