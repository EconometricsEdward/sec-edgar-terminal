import test from "node:test";
import assert from "node:assert/strict";
import {
  benchmarkDistribution,
  researchMetricComparison,
  compatibleMapSample,
} from "../src/utils/compareBenchmarks.js";

const period = (end = "2025-12-31", start = "2025-01-01", kind = "annual") => ({
  start,
  end,
  kind,
});
function entry(ticker, value, options = {}) {
  const p = options.period || period();
  const point = (v) => ({ value: v, period: p, sources: [], ...options.point });
  return {
    ticker,
    loading: false,
    error: null,
    index: 0,
    period: p,
    data: {
      cik: options.cik || ticker,
      name: ticker,
      lens: "corporate",
      metrics: {
        netIncome: [point(value)],
        totalAssets: [point(value)],
        roe: [point(options.y ?? value)],
      },
    },
  };
}
const peerSettings = { focus: "FOCUS", benchmark: "peers" };

test("focus benchmark never includes the focus value in its median or minimum peer count", () => {
  const entries = [entry("FOCUS", 1000), entry("A", 10), entry("B", 20)];
  const compared = researchMetricComparison(entries, "netIncome", peerSettings);
  assert.equal(compared.peerMedian, 15);
  assert.equal(compared.cells[0].delta, 985);
  assert.deepEqual(compared.benchmarkMembers, ["A", "B"]);
  assert.equal(compared.benchmarkCount, 2);
  const insufficient = researchMetricComparison(
    entries.slice(0, 2),
    "netIncome",
    peerSettings,
  );
  assert.equal(insufficient.reference, null);
  assert.match(insufficient.reason, /two compatible other issuers/);
  assert.equal(insufficient.cells[0].rank, null);
});

test("selected-issuer median and ticker reference modes retain their meaning", () => {
  const entries = [entry("FOCUS", 1000), entry("A", 10), entry("B", 20)];
  assert.equal(
    researchMetricComparison(entries, "netIncome", { benchmark: "median" })
      .reference,
    20,
  );
  assert.equal(
    researchMetricComparison(entries, "netIncome", { benchmark: "A" })
      .reference,
    10,
  );
});

test("padded CIK aliases cannot duplicate a peer or smuggle focus into its own benchmark", () => {
  const entries = [
    entry("FOCUS", 100, { cik: "0000123" }),
    entry("FOCUS.B", 100, { cik: "123" }),
    entry("A", 10, { cik: "4" }),
    entry("B", 20, { cik: "5" }),
    entry("B.B", 20, { cik: "0005" }),
  ];
  const study = benchmarkDistribution(entries, "netIncome", {
    focus: "FOCUS.B",
  });
  assert.equal(study.focus.ticker, "FOCUS");
  assert.equal(study.median, 15);
  assert.equal(study.count, 2);
  assert.match(study.cohort[1].reason, /Same SEC issuer/);
  assert.equal(study.cohort[1].included, false);
  assert.equal(study.cohort[4].included, false);
  assert.equal(
    researchMetricComparison(entries, "netIncome", { benchmark: "median" })
      .count,
    3,
  );
});

test("missing focus and failed peer coverage are explicit rather than zero-filled", () => {
  const failed = {
    ticker: "FAILED",
    loading: false,
    error: "SEC error",
    data: null,
    index: -1,
    period: null,
  };
  const entries = [entry("FOCUS", 0), entry("A", 10), failed];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.focus.point.value, 0);
  assert.equal(study.median, null);
  assert.equal(study.cohort[2].reason, "fetch failed");
  assert.match(
    benchmarkDistribution(entries, "netIncome", { focus: "ABSENT" }).reason,
    /not in the selected/,
  );
});

test("unrelated reporting dates are excluded and all included reporting ends must fit one 45-day span", () => {
  const entries = [
    entry("FOCUS", 100),
    entry("A", 10),
    entry("B", 20),
    entry("OLD", 1, { period: period("2025-06-30", "2024-07-01") }),
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.median, 15);
  assert.match(study.cohort[3].reason, /45 days/);
  const spanning = [
    entry("FOCUS", 100, { period: period("2025-12-15", "2024-12-16") }),
    entry("A", 10, { period: period("2025-11-15", "2024-11-16") }),
    entry("B", 20, { period: period("2026-01-15", "2025-01-16") }),
  ];
  assert.match(
    benchmarkDistribution(spanning, "netIncome", peerSettings).reason,
    /45 days/,
  );
});

test("mixed reporting bases cannot be pooled even when endpoints agree", () => {
  const entries = [
    entry("FOCUS", 100),
    entry("A", 10),
    entry("QUARTER", 20, {
      period: period("2025-12-31", "2025-10-01", "quarter"),
    }),
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.median, null);
  assert.match(study.cohort[2].reason, /bases differ/);
});

test("actual incomplete source durations remain visible but do not enter the peer median", () => {
  const invalid = entry("BAD", 10000, {
    point: {
      classification: "reported",
      sources: [
        {
          start: "2025-04-01",
          end: "2025-12-31",
          unit: "USD",
          tag: "NetIncomeLoss",
          taxonomy: "us-gaap",
        },
      ],
    },
  });
  const entries = [
    entry("FOCUS", 100),
    entry("A", 10),
    entry("B", 20),
    invalid,
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.median, 15);
  assert.match(study.cohort[3].reason, /actual reported flow durations/);
  const compared = researchMetricComparison(entries, "netIncome", peerSettings);
  assert.equal(compared.cells[3].point.value, 10000);
  assert.equal(compared.cells[3].delta, null);
  assert.equal(compared.excludedCount, 1);
});

test("reported observations preserve their exact evidence and surface definition differences", () => {
  const source = (tag = "NetIncomeLoss") => ({
    start: "2025-01-01",
    end: "2025-12-31",
    unit: "USD",
    taxonomy: "us-gaap",
    tag,
    filed: "2026-02-01",
    accession: "0000000001-26-000001",
  });
  const entries = [
    entry("FOCUS", 100, {
      point: { classification: "reported", sources: [source()] },
    }),
    entry("A", 10, {
      point: { classification: "reported", sources: [source()] },
    }),
    entry("B", 20, {
      point: { classification: "reported", sources: [source("ProfitLoss")] },
    }),
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.median, 15);
  assert.equal(study.peers[0].point, entries[1].data.metrics.netIncome[0]);
  assert.equal(study.definitionsDiffer, true);
  assert.match(study.definitionNote, /accounting scope/);
});

test("leave-one-out sensitivity recalculates the exact retained cohort and suppresses one-peer estimates", () => {
  const entries = [
    entry("FOCUS", 40),
    entry("A", 10),
    entry("B", 20),
    entry("C", 30),
    entry("D", 100),
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.median, 25);
  const removed = study.sensitivity.find((row) => row.omitted === "D");
  assert.deepEqual(removed.members, ["A", "B", "C"]);
  assert.equal(removed.median, 20);
  assert.equal(removed.shift, -5);
  assert.equal(removed.focusDelta, 20);
  const small = benchmarkDistribution(
    entries.slice(0, 3),
    "netIncome",
    peerSettings,
  );
  assert.equal(small.sensitivity[0].median, null);
  assert.match(small.sensitivity[0].reason, /Fewer than two/);
});

test("sample quartiles use explicit linear interpolation only with four other issuers", () => {
  const entries = [
    entry("FOCUS", 40),
    entry("A", 10),
    entry("B", 20),
    entry("C", 30),
    entry("D", 100),
  ];
  const study = benchmarkDistribution(entries, "netIncome", peerSettings);
  assert.equal(study.q1, 17.5);
  assert.equal(study.q3, 47.5);
  assert.equal(study.min, 10);
  assert.equal(study.max, 100);
  assert.equal(
    benchmarkDistribution(entries.slice(0, 4), "netIncome", peerSettings).q1,
    null,
  );
});

test("peer-map medians use the same complete-pair sample on both axes", () => {
  const entries = [
    entry("A", 1, { y: 10 }),
    entry("B", 3, { y: 30 }),
    entry("XONLY", 100),
  ];
  entries[2].data.metrics.roe[0].value = null;
  const sample = compatibleMapSample(entries, "netIncome", "roe");
  assert.equal(sample.xMedian, 2);
  assert.equal(sample.yMedian, 20);
  assert.deepEqual(sample.members, ["A", "B"]);
  assert.equal(sample.count, 2);
  assert.equal(sample.rows[2].included, false);
});

test("peer-map guides require two unique complete and compatible observations", () => {
  const entries = [
    entry("A", 1, { cik: "123" }),
    entry("ALIAS", 1, { cik: "000123" }),
  ];
  const sample = compatibleMapSample(entries, "netIncome", "roe");
  assert.equal(sample.count, 1);
  assert.equal(sample.total, 1);
  assert.equal(sample.xMedian, null);
  assert.match(sample.reason, /two issuers/);
  const dates = compatibleMapSample(
    [
      entries[0],
      entry("OTHER", 10, { period: period("2025-06-30", "2024-07-01") }),
    ],
    "netIncome",
    "roe",
  );
  assert.equal(dates.count, 2);
  assert.equal(dates.yMedian, null);
  assert.match(dates.reason, /45 days/);
});

test("bank balance ratios do not inherit irrelevant reporting duration exclusions", () => {
  const entries = [
    entry("FOCUS", 100),
    entry("A", 10, { period: period("2025-12-31", "2025-02-01") }),
    entry("B", 20),
  ];
  assert.equal(
    benchmarkDistribution(entries, "totalAssets", peerSettings).median,
    15,
  );
});
