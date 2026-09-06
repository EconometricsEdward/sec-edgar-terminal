import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisBrief,
  analysisBriefHtml,
  analysisBriefCsv,
  briefMetricKeys,
  briefSectionKeys,
  safeBriefSecUrl,
} from "../src/utils/analysisBrief.js";

const periods = [2025, 2024, 2023, 2022, 2021].map((year) => ({
  kind: "annual",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  fp: "FY",
  asOf: "2026-03-01",
}));
const source = (year, value, extra = {}) => ({
  taxonomy: "us-gaap",
  tag: "NetIncomeLoss",
  value,
  unit: "USD",
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  filed: `${year + 1}-02-01`,
  accession: `0000000001-${year + 1}-000001`,
  form: "10-K",
  documentUrl: `https://www.sec.gov/Archives/edgar/data/1/${year}/annual.htm`,
  ...extra,
});
const fixture = () => ({
  ticker: "TEST",
  name: "Test Company",
  cik: "0000000001",
  lens: "corporate",
  basis: "annual",
  periods,
  observedAt: "2026-03-01T12:00:00Z",
  note: "Custom tags remain missing.",
  highlights: ["netIncome", "totalAssets", "operatingCashFlow"],
  definitions: [
    {
      key: "netIncome",
      label: "Net income",
      format: "currency",
      category: "income",
    },
    {
      key: "totalAssets",
      label: "Total assets",
      format: "currency",
      category: "balance",
    },
    {
      key: "operatingCashFlow",
      label: "Operating cash flow",
      format: "currency",
      category: "cashflow",
    },
  ],
  metrics: {
    netIncome: periods.map((period, i) => ({
      period,
      value: i ? i * 10 : -25,
      classification: "reported",
      sources: [source(Number(period.end.slice(0, 4)), i ? i * 10 : -25)],
    })),
    totalAssets: periods.map((period) => ({
      period,
      value: 1000,
      classification: "reported",
      sources: [
        source(Number(period.end.slice(0, 4)), 1000, {
          tag: "Assets",
          start: null,
        }),
      ],
    })),
    operatingCashFlow: periods.map((period) => ({
      period,
      value: null,
      classification: "unavailable",
      sources: [],
      reason: "Operating cash flow tag unavailable.",
    })),
  },
});
const settings = (extra = {}) => ({
  basis: "annual",
  end: "latest",
  asOf: "2026-03-01",
  units: "raw",
  ...extra,
});

test("Brief selection reproduces chosen metrics and four periods ending at the selected date", () => {
  const report = buildAnalysisBrief(
    fixture(),
    settings({
      briefTitle: "Credit review",
      briefMetrics: ["netIncome", "operatingCashFlow"],
    }),
    1,
  );
  assert.equal(report.title, "Credit review");
  assert.deepEqual(report.keys, ["netIncome", "operatingCashFlow"]);
  assert.deepEqual(
    report.periods.map((p) => p.end),
    ["2024-12-31", "2023-12-31", "2022-12-31", "2021-12-31"],
  );
  assert.equal(report.selectedAvailable, 1);
  assert.equal(report.selectedTotal, 2);
  assert.match(report.path, /end=2024-12-31/);
  assert.equal(report.rows[1].points[0].value, null);
  assert.match(report.rows[1].points[0].reason, /tag unavailable/);
  assert.match(analysisBriefHtml(report), /2021-12-31/);
});

test("Brief keeps raw numbers, instant balance dates, source units and missing-data explanations", () => {
  const report = buildAnalysisBrief(fixture(), settings(), 0);
  const csv = analysisBriefCsv(report);
  assert.ok(csv.includes('"-25"'));
  assert.ok(!csv.includes('"\'-25"'));
  assert.match(csv, /"Instant","2025-12-31"/);
  assert.match(csv, /"us-gaap:Assets","1000","USD","Instant"/);
  assert.match(csv, /Operating cash flow tag unavailable/);
  assert.match(csv, /2026-02-01/);
  assert.match(csv, /0000000001-2026-000001/);
  assert.match(csv, /2026-03-01T12:00:00Z/);
});

test("Omitted notes and evidence never leak into HTML or CSV", () => {
  const data = fixture();
  const report = buildAnalysisBrief(
    data,
    settings({ briefSections: ["metrics"] }),
    0,
    "PRIVATE_NOTE_UNSELECTED",
    [
      {
        label: "PRIVATE_EVIDENCE_UNSELECTED",
        point: data.metrics.netIncome[0],
        notes: "UNSELECTED_EVIDENCE_NOTE",
      },
    ],
  );
  for (const output of [analysisBriefHtml(report), analysisBriefCsv(report)]) {
    assert.doesNotMatch(
      output,
      /PRIVATE_NOTE_UNSELECTED|PRIVATE_EVIDENCE_UNSELECTED|UNSELECTED_EVIDENCE_NOTE/,
    );
    assert.doesNotMatch(output, /2024-12-31/);
  }
  assert.equal(report.evidence.length, 0);
  assert.equal(report.periods.length, 1);
});

test("Brief escapes analyst HTML and rejects deceptive SEC URLs", () => {
  const data = fixture();
  data.name = "<img src=x onerror=alert(1)>";
  data.metrics.netIncome[0].sources[0].documentUrl =
    "https://www.sec.gov.evil.example/unsafe";
  const report = buildAnalysisBrief(
    data,
    settings({ briefTitle: '<script>alert("bad")</script>' }),
    0,
    '<svg onload="alert(1)">',
  );
  const output = analysisBriefHtml(report);
  assert.doesNotMatch(output, /<script>|<img |<svg /);
  assert.match(output, /&lt;script&gt;/);
  assert.doesNotMatch(output, /sec\.gov\.evil/);
  for (const url of [
    "javascript:alert(1)",
    "//www.sec.gov/file",
    "https://user@www.sec.gov/file",
    "http://www.sec.gov/file",
    "https://www.sec.gov:444/file",
    "https://www.sec.gov@evil.example/file",
  ])
    assert.equal(safeBriefSecUrl(url), "");
  assert.equal(
    safeBriefSecUrl("https://data.sec.gov/api/test"),
    "https://data.sec.gov/api/test",
  );
});

test("CSV neutralizes formula text even after whitespace while preserving raw negative figures", () => {
  const data = fixture();
  data.definitions[0].label = ' \t=HYPERLINK("https://evil.example")';
  const csv = analysisBriefCsv(
    buildAnalysisBrief(
      data,
      settings({ briefTitle: "+FORMULA", briefSections: ["metrics", "notes"] }),
      0,
      "\n@SUM(1,2)",
    ),
  );
  assert.ok(csv.includes('"\'+FORMULA"'));
  assert.ok(csv.includes("\"' \t=HYPERLINK"));
  assert.ok(csv.includes('"\'\n@SUM(1,2)"'));
  assert.ok(csv.includes('"-25"'));
});

test("Saved evidence preserves its own basis and cutoff instead of adopting the current report view", () => {
  const data = fixture();
  const point = {
    ...data.metrics.netIncome[1],
    period: {
      kind: "ytd",
      start: "2024-01-01",
      end: "2024-06-30",
      asOf: "2024-08-15",
    },
  };
  const report = buildAnalysisBrief(
    data,
    settings({ briefSections: ["evidence"] }),
    0,
    "",
    [
      {
        label: "Earlier interim review",
        point,
        format: "currency",
        notes: "Analyst's review",
      },
    ],
  );
  assert.equal(report.evidence[0].period.kind, "ytd");
  assert.equal(report.evidence[0].originalCutoff, "2024-08-15");
  const html = analysisBriefHtml(report),
    csv = analysisBriefCsv(report);
  assert.match(html, /Original filing cutoff: 2024-08-15/);
  assert.match(
    csv,
    /"annual","ytd","2024-01-01","2024-06-30","2026-03-01","2024-08-15"/,
  );
  assert.match(html, /does not re-filter/);
});

test("Source deduplication preserves multiple distinct inputs and optional intermediate calculations", () => {
  const data = fixture();
  const src = data.metrics.netIncome[0].sources[0];
  data.metrics.netIncome[0].sources = [
    src,
    src,
    { ...src, tag: "OtherInput", value: 40 },
  ];
  data.metrics.netIncome[0].calculations = [
    {
      start: "2025-01-01",
      end: "2025-12-31",
      value: -25,
      formula: "INTERNAL_CALCULATION_TEST",
    },
  ];
  const plain = buildAnalysisBrief(
    data,
    settings({ briefSections: ["metrics"], briefMetrics: ["netIncome"] }),
    0,
  );
  assert.equal(plain.sources.length, 2);
  assert.deepEqual(plain.rows[0].points[0].refs, [1, 2]);
  assert.doesNotMatch(analysisBriefHtml(plain), /INTERNAL_CALCULATION_TEST/);
  assert.match(analysisBriefCsv(plain), /INTERNAL_CALCULATION_TEST/);
  const detailed = buildAnalysisBrief(
    data,
    settings({
      briefSections: ["metrics", "sources"],
      briefMetrics: ["netIncome"],
    }),
    0,
  );
  assert.match(analysisBriefHtml(detailed), /INTERNAL_CALCULATION_TEST/);
});

test("Evidence settings distinguish an explicit latest-available cutoff from missing legacy metadata", () => {
  const data = fixture();
  const report = buildAnalysisBrief(
    data,
    settings({ briefSections: ["evidence"] }),
    0,
    "",
    [
      {
        label: "Latest",
        point: data.metrics.netIncome[0],
        analysisSettings: { asOf: "" },
        collectedAt: "2026-03-02T10:00:00Z",
      },
      {
        label: "Fixed cutoff",
        point: data.metrics.netIncome[0],
        analysisSettings: { asOf: "2026-02-15" },
      },
      {
        label: "Legacy",
        point: {
          ...data.metrics.netIncome[0],
          period: { ...periods[0], asOf: undefined },
        },
      },
    ],
  );
  assert.equal(
    report.evidence[0].originalCutoff,
    "Latest available when collected",
  );
  assert.equal(report.evidence[1].originalCutoff, "2026-02-15");
  assert.match(report.evidence[2].originalCutoff, /Not recorded/);
  assert.match(analysisBriefCsv(report), /2026-03-02T10:00:00Z/);
});

test("Legacy single-source evidence retains its original SEC reference in the report", () => {
  const data = fixture();
  const point = {
    ...data.metrics.totalAssets[0],
    source: data.metrics.totalAssets[0].sources[0],
    sources: undefined,
  };
  const report = buildAnalysisBrief(
    data,
    settings({ briefSections: ["evidence"] }),
    0,
    "",
    [{ label: "Legacy assets", point }],
  );
  assert.equal(report.evidence[0].instant, true);
  assert.equal(report.sources.length, 1);
  assert.match(analysisBriefHtml(report), /us-gaap:Assets/);
  assert.match(analysisBriefCsv(report), /0000000001-2026-000001/);
});

test("Brief defaults recover unknown industry selections and reject unavailable periods", () => {
  const data = fixture();
  assert.deepEqual(briefMetricKeys(data, { briefMetrics: ["notDefined"] }), [
    "netIncome",
    "totalAssets",
    "operatingCashFlow",
  ]);
  assert.deepEqual(
    briefSectionKeys({ briefSections: ["notes", "notes", "notASection"] }),
    ["notes"],
  );
  assert.throws(
    () => buildAnalysisBrief(data, settings(), -1),
    /available reporting period/,
  );
  const report = buildAnalysisBrief(
    data,
    settings({ briefSections: ["notes"] }),
    0,
    "My note",
  );
  assert.equal(report.sources.length, 0);
  assert.equal(report.rows.length, 0);
});
