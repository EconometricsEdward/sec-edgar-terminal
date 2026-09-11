import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFinancialComparison,
  buildMetricRelationship,
  buildPeerBenchmarks,
  financialToolIssuers,
  peerBenchmarksCsv,
} from "../src/utils/portfolioFinancialTools.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";
import {
  createPortfolioRows,
  resolvePortfolioRows,
} from "../src/utils/portfolioModel.js";
import { parsePortfolioCsv } from "../src/utils/portfolioFiles.js";

const cik = (value) => String(value).padStart(10, "0");
const point = (value, end = "2025-12-31", unit = "%") => ({
  value,
  unit,
  classification: "reported",
  period: end ? { end } : null,
  sources: [
    { documentUrl: "https://www.sec.gov/Archives/edgar/data/1/report.htm" },
  ],
});
function fixture() {
  const directory = Object.fromEntries(
    ["A", "B", "C", "D", "E", "F", "G"].map((ticker, index) => [
      ticker,
      { cik: String(index + 1), name: `Company ${ticker}` },
    ]),
  );
  directory.FUND = { cik: "9", name: "A fund", isFund: true };
  const rows = resolvePortfolioRows(
    createPortfolioRows(Object.keys(directory).map((ticker) => ({ ticker }))),
    directory,
  );
  const companies = [
    {
      cik: cik(1),
      sicDescription: "Technology",
      metrics: {
        revenueGrowth: point(0, "2024-12-31"),
        netMargin: point(-5, "2024-12-31"),
        currentRatio: point(1, "2024-12-31", "x"),
      },
    },
    {
      cik: cik(2),
      sicDescription: "Technology",
      metrics: { revenueGrowth: point(10), netMargin: point(5) },
    },
    {
      cik: cik(3),
      sicDescription: "Technology",
      metrics: {
        revenueGrowth: point(10),
        netMargin: { ...point(100), classification: "unavailable" },
      },
    },
    {
      cik: cik(4),
      sicDescription: "Retail",
      metrics: { revenueGrowth: point(30), netMargin: point(15, "2025-09-30") },
    },
    {
      cik: cik(5),
      sicDescription: "Banking",
      lens: "banking",
      metrics: {
        revenueGrowth: point(999),
        netMargin: point(99),
        loanDeposits: point(50),
        currentRatio: point(10, "2025-12-31", "x"),
      },
    },
    {
      cik: cik(6),
      sicDescription: "Technology",
      metrics: { netMargin: point(7) },
    },
    {
      cik: cik(7),
      sicDescription: "Technology",
      metrics: { revenueGrowth: point(20, null), netMargin: point(20, null) },
    },
  ].map((company) => ({
    name: `Company ${company.cik}`,
    status: "ready",
    kind: "company",
    lens: "corporate",
    ...company,
  }));
  return buildPortfolioAnalytics(rows, { basis: "none" }, companies, {
    capturedAt: "2026-09-08T00:00:00Z",
  });
}

test("industry benchmarks recompute exact cohort statistics and midrank ties", () => {
  const report = fixture();
  const before = JSON.stringify(report);
  const peer = buildPeerBenchmarks(report, {
    metricId: "revenueGrowth",
    industry: "Technology",
  });
  assert.equal(peer.cohortCount, 5);
  assert.equal(peer.measuredCount, 4);
  assert.equal(peer.eligibleCount, 5);
  assert.equal(peer.missingCount, 1);
  assert.equal(peer.notApplicableCount, 0);
  assert.equal(peer.median, 10);
  assert.equal(peer.p25, 7.5);
  assert.equal(peer.p75, 12.5);
  assert.deepEqual(
    peer.observations.map((item) => [
      item.value,
      item.percentile,
      item.differenceFromMedian,
    ]),
    [
      [20, 87.5, 10],
      [10, 50, 0],
      [10, 50, 0],
      [0, 12.5, -10],
    ],
  );
  assert.equal(JSON.stringify(report), before);
});

test("zero and negative observations remain measured; N/A and missing have separate exact denominators", () => {
  const peer = buildPeerBenchmarks(fixture(), { metricId: "netMargin" });
  assert.equal(peer.cohortCount, 7);
  assert.equal(peer.eligibleCount, 6);
  assert.equal(peer.measuredCount, 5);
  assert.equal(peer.missingCount, 1);
  assert.equal(peer.notApplicableCount, 1);
  assert.equal(peer.min, -5);
  assert.equal(peer.max, 20);
  assert.equal(peer.median, 7);
  assert.ok(
    !peer.observations.some((item) => item.value === 100 || item.value === 99),
  );
});

test("reporting-end filters are inclusive and disclose outside-range and undated exclusions", () => {
  const peer = buildPeerBenchmarks(fixture(), {
    metricId: "revenueGrowth",
    periodFrom: "2025-12-31",
    periodTo: "2025-12-31",
  });
  assert.equal(peer.availableBeforeDateCount, 5);
  assert.equal(peer.measuredCount, 3);
  assert.equal(peer.outsidePeriodCount, 1);
  assert.equal(peer.undatedExcludedCount, 1);
  assert.equal(peer.unavailableOrNotApplicableCount, 2);
  assert.equal(peer.median, 10);
  assert.ok(peer.observations.every((item) => item.periodEnd === "2025-12-31"));
});

test("invalid or reversed reporting-end ranges never produce a misleading benchmark", () => {
  for (const options of [
    { periodFrom: "2025-02-30" },
    { periodTo: "2025/12/31" },
    { periodFrom: "2026-01-01", periodTo: "2025-12-31" },
  ]) {
    const peer = buildPeerBenchmarks(fixture(), options);
    assert.ok(peer.error);
    assert.equal(peer.measuredCount, 0);
    assert.equal(peer.median, null);
  }
});

test("one-company and empty cohorts do not imply meaningful peer ranks", () => {
  const one = buildPeerBenchmarks(fixture(), {
    metricId: "netMargin",
    industry: "Retail",
  });
  assert.equal(one.median, 15);
  assert.equal(one.observations[0].percentile, null);
  const empty = buildPeerBenchmarks(fixture(), {
    metricId: "netMargin",
    industry: "Banking",
  });
  assert.equal(empty.measuredCount, 0);
  assert.equal(empty.notApplicableCount, 1);
  assert.equal(empty.median, null);
  assert.equal(empty.p25, null);
});

test("share classes, duplicate observations and unverified outsider identities never inflate peer counts", () => {
  const report = fixture();
  report.concentration.issuers.push({
    ...report.concentration.issuers[0],
    cik: "1",
    name: "Duplicate share class",
  });
  const growth = report.metrics.find((item) => item.id === "revenueGrowth");
  growth.observations.push({ ...growth.observations[0], cik: "1", value: 999 });
  growth.observations.push({
    cik: "12345",
    value: 100,
    name: "Outside portfolio",
  });
  growth.observations.push({ cik: cik(6), value: Infinity, name: "Nonfinite" });
  assert.equal(financialToolIssuers(report).length, 7);
  const peer = buildPeerBenchmarks(report, { metricId: "revenueGrowth" });
  assert.equal(peer.measuredCount, 5);
  assert.equal(peer.max, 30);
});

test("metric relationships pair by CIK intersection with explicit date coverage", () => {
  const relationship = buildMetricRelationship(fixture());
  assert.equal(relationship.cohortCount, 7);
  assert.equal(relationship.xAvailableCount, 5);
  assert.equal(relationship.yAvailableCount, 5);
  assert.equal(relationship.points.length, 4);
  assert.equal(relationship.unavailablePairCount, 3);
  assert.equal(relationship.mismatchedPeriodCount, 1);
  assert.equal(relationship.unknownPeriodCount, 1);
  assert.deepEqual(
    relationship.points.map((item) => [item.cik, item.x, item.y]),
    [
      [cik(1), 0, -5],
      [cik(2), 10, 5],
      [cik(4), 30, 15],
      [cik(7), 20, 20],
    ],
  );
  assert.ok(
    relationship.points.every(
      (item) => item.xPoint.sourceUrl && item.yPoint.sourceUrl,
    ),
  );
});

test("same-period-end option excludes differing and unknown dates without filling missing pairs", () => {
  const relationship = buildMetricRelationship(fixture(), {
    matchingPeriodOnly: true,
  });
  assert.equal(relationship.pairedBeforeDateCount, 4);
  assert.equal(relationship.dateExcludedCount, 2);
  assert.equal(relationship.points.length, 2);
  assert.ok(relationship.points.every((point) => point.samePeriodEnd));
  const industry = buildMetricRelationship(fixture(), {
    industry: "Retail",
    matchingPeriodOnly: true,
  });
  assert.equal(industry.cohortCount, 1);
  assert.equal(industry.points.length, 0);
  assert.equal(industry.dateExcludedCount, 1);
});

test("comparison preserves explicit order, rejects outsiders, deduplicates CIK and caps at four issuers", () => {
  const comparison = buildFinancialComparison(fixture(), [
    "7",
    "1",
    cik(7),
    "999",
    "5",
    "6",
    "2",
  ]);
  assert.deepEqual(
    comparison.companies.map((issuer) => issuer.cik),
    [7, 1, 5, 6].map(cik),
  );
  assert.equal(comparison.metrics.length, 8);
  const growth = comparison.metrics.find((item) => item.id === "revenueGrowth");
  assert.deepEqual(
    growth.values.map((point) => point?.value ?? null),
    [20, 0, null, null],
  );
  assert.deepEqual(growth.statuses, [
    "available",
    "available",
    "not-applicable",
    "missing",
  ]);
  assert.equal(buildFinancialComparison(fixture()).companies.length, 0);
});

test("comparison distinguishes bank current-ratio N/A from missing corporate data and retains dates and SEC links", () => {
  const comparison = buildFinancialComparison(fixture(), ["1", "5", "6"]);
  const ratio = comparison.metrics.find((item) => item.id === "currentRatio");
  assert.deepEqual(ratio.statuses, ["available", "not-applicable", "missing"]);
  assert.equal(ratio.unit, "x");
  assert.equal(ratio.values[0].periodEnd, "2024-12-31");
  assert.equal(
    ratio.values[0].sourceUrl,
    "https://www.sec.gov/Archives/edgar/data/1/report.htm",
  );
});

test("older reports without issuer applicability metadata disclose the unknown distinction", () => {
  const report = fixture();
  for (const metric of report.metrics) {
    delete metric.eligibleCiks;
    delete metric.missingCiks;
    delete metric.notApplicableCiks;
  }
  const peer = buildPeerBenchmarks(report);
  assert.equal(peer.eligibleCount, null);
  assert.equal(peer.missingCount, null);
  assert.equal(peer.notApplicableCount, null);
  assert.equal(peer.unavailableOrNotApplicableCount, 2);
  const comparison = buildFinancialComparison(report, ["1", "5"]);
  assert.deepEqual(
    comparison.metrics.find((item) => item.id === "currentRatio").statuses,
    ["available", "unknown"],
  );
});

test("benchmark CSV exports the filtered cohort, units, exact coverage and evidence without portfolio allocations", () => {
  const report = fixture();
  const peer = buildPeerBenchmarks(report, {
    metricId: "revenueGrowth",
    industry: "Technology",
    periodFrom: "2025-01-01",
  });
  const csv = peerBenchmarksCsv(peer, report.capturedAt);
  const parsed = parsePortfolioCsv(csv);
  const rows = [parsed.headers, ...parsed.records];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.length === 23));
  const headers = rows[0];
  const first = Object.fromEntries(
    headers.map((header, index) => [header, rows[1][index]]),
  );
  assert.equal(first["SEC industry"], "Technology");
  assert.equal(first["Captured at"], "2026-09-08T00:00:00Z");
  assert.equal(first["Cohort companies"], "5");
  assert.equal(first["Measured companies"], "2");
  assert.equal(first["Unavailable applicable companies"], "1");
  assert.equal(first["Not applicable companies"], "0");
  assert.equal(first["Outside date range"], "1");
  assert.equal(first["Undated excluded"], "1");
  assert.ok(!/market_value|shares|notes|weight_pct/i.test(csv));
});
