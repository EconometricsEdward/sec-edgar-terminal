import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioRows,
  resolvePortfolioRows,
  applyDuplicateDecision,
} from "../src/utils/portfolioModel.js";
import { buildPortfolioAnalytics } from "../src/utils/portfolioAnalytics.js";

const directory = {
  A: { cik: "1", name: "Company A" },
  B: { cik: "2", name: "Company B" },
  C: { cik: "3", name: "Company C" },
  D: { cik: "4", name: "Company D" },
  E: { cik: "5", name: "Company E" },
  F: { cik: "6", name: "Company F" },
  G: { cik: "7", name: "Company G" },
  "CL-A": { cik: "8", name: "Two share classes" },
  "CL-B": { cik: "8", name: "Two share classes" },
  FUND: { cik: "9", name: "Example Fund", isFund: true },
};
const cik = (value) => String(value).padStart(10, "0");
const rows = (holdings) =>
  resolvePortfolioRows(createPortfolioRows(holdings), directory);
const point = (value, unit = "%", extra = {}) => ({
  value,
  unit,
  classification: "reported",
  ...extra,
});
const company = (id, metrics = { netIncome: point(1, "USD") }, extra = {}) => ({
  cik: cik(id),
  name: `Company ${id}`,
  ticker: null,
  kind: "company",
  lens: "corporate",
  status: "ready",
  period: { kind: "annual", end: "2025-12-31" },
  sicDescription: `Industry ${id}`,
  metrics,
  ...extra,
});
const metric = (result, id = "revenueGrowth") =>
  result.metrics.find((item) => item.id === id);
const condition = (result, id = "negativeNetIncome") =>
  result.conditions.find((item) => item.id === id);
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("metric applicability partitions identified operating issuers for filtered analytics", () => {
  const result = buildPortfolioAnalytics(
    rows(["A", "B", "C", "CL-A", "CL-B", "FUND"].map((ticker) => ({ ticker }))),
    { basis: "none" },
    [
      company(1, { revenueGrowth: point(0) }),
      company(2, { revenueGrowth: point(99, "%", { status: "unavailable" }) }),
      company(3, {}, { lens: "banking" }),
      company(8, { revenueGrowth: point(12) }),
    ],
  );
  const growth = metric(result);
  assert.deepEqual(growth.eligibleCiks.sort(), [cik(1), cik(2), cik(8)]);
  assert.deepEqual(growth.missingCiks, [cik(2)]);
  assert.deepEqual(growth.notApplicableCiks, [cik(3)]);
  assert.equal(
    growth.observations.length + growth.missingCiks.length,
    growth.eligibleCiks.length,
  );
  assert.equal(
    growth.eligibleCiks.length + growth.notApplicableCiks.length,
    result.operatingIssuerCount,
  );
  assert.equal(new Set(growth.eligibleCiks).size, growth.eligibleCiks.length);
  assert.equal(
    growth.observations.find((entry) => entry.cik === cik(1)).value,
    0,
  );
});

test("unweighted issuer distributions have exact interpolated quartiles without invented allocation", () => {
  const input = rows(["A", "B", "C", "D"].map((ticker) => ({ ticker })));
  const companies = [0, 10, 20, 30].map((value, index) =>
    company(index + 1, { revenueGrowth: point(value) }),
  );
  const before = JSON.stringify({ input, companies });
  const result = buildPortfolioAnalytics(input, { basis: "none" }, companies);
  const growth = metric(result);
  assert.equal(result.holdingCount, 4);
  assert.equal(result.operatingIssuerCount, 4);
  assert.equal(result.weighted, false);
  assert.equal(growth.median, 15);
  assert.equal(growth.p25, 7.5);
  assert.equal(growth.p75, 22.5);
  assert.equal(growth.min, 0);
  assert.equal(growth.max, 30);
  assert.equal(growth.availableCount, 4);
  assert.equal(growth.missingCount, 0);
  assert.equal(growth.coveredWeightPct, null);
  assert.deepEqual(
    growth.bins.map((bin) => bin.count),
    [0, 1, 2, 1],
  );
  assert.ok(growth.bins.every((bin) => bin.weightPct === null));
  assert.equal(result.concentration.hhi, null);
  assert.equal(result.concentration.effectiveIssuerCount, null);
  assert.equal(result.concentration.knownWeightPct, null);
  assert.equal(JSON.stringify({ input, companies }), before);
});

test("share classes combine issuer exposure and never duplicate financial observations or conditions", () => {
  const input = rows([
    { ticker: "CL-A", weight_pct: 20 },
    { ticker: "CL-B", weight_pct: 30 },
    { ticker: "A", weight_pct: 50 },
  ]);
  const result = buildPortfolioAnalytics(input, { basis: "weights" }, [
    company(8, { revenueGrowth: point(10), netIncome: point(-1, "USD") }),
    company(1, { revenueGrowth: point(30), netIncome: point(2, "USD") }),
  ]);
  assert.equal(result.issuerCount, 2);
  assert.equal(result.holdingCount, 3);
  assert.equal(result.concentration.complete, true);
  assert.equal(result.concentration.hhi, 5000);
  assert.equal(result.concentration.effectiveIssuerCount, 2);
  assert.equal(result.concentration.largestIssuerWeightPct, 50);
  assert.equal(result.concentration.topFiveIssuerWeightPct, 100);
  assert.equal(metric(result).median, 20);
  assert.equal(metric(result).availableCount, 2);
  assert.equal(condition(result).matchedCount, 1);
  assert.equal(condition(result).measuredCount, 2);
  assert.equal(condition(result).knownMatchedWeightPct, 50);
  assert.deepEqual(condition(result).rowIds, ["position-1", "position-2"]);
  const classBin = metric(result).bins.find(
    (bin) => bin.label === "10% to <25%",
  );
  assert.equal(classBin.count, 1);
  assert.equal(classBin.weightPct, 50);
  assert.deepEqual(classBin.rowIds, ["position-1", "position-2"]);
  assert.equal(result.coverage.periodEnds[0].count, 2);
});

test("partial weights retain known percentage points and leave unknown-only buckets unavailable", () => {
  const result = buildPortfolioAnalytics(
    rows([
      { ticker: "A", weight_pct: 60 },
      { ticker: "B" },
      { ticker: "C", weight_pct: 20 },
    ]),
    { basis: "weights", normalize: true },
    [
      company(1, { revenueGrowth: point(5), netIncome: point(2, "USD") }),
      company(2, { revenueGrowth: point(30), netIncome: point(-2, "USD") }),
      company(3, {}, { status: "failed" }),
    ],
  );
  assert.equal(result.concentration.knownWeightPct, 80);
  assert.equal(result.concentration.missingWeightRows, 1);
  assert.equal(result.concentration.complete, false);
  assert.equal(result.concentration.hhi, null);
  assert.equal(metric(result).median, 17.5);
  assert.equal(metric(result).coveredWeightPct, 60);
  assert.equal(metric(result).missingCount, 1);
  assert.equal(metric(result).bins.at(-1).weightPct, null);
  assert.equal(condition(result).knownMatchedWeightPct, null);
  assert.equal(
    result.concentration.industries.find(
      (group) => group.label === "Industry 2",
    ).weightPct,
    null,
  );
  assert.match(result.warnings.join(" "), /no covered subset is reweighted/i);
});

test("HHI requires complete reviewed 100% allocation; explicit normalization uses saved model weights", () => {
  const input = rows([
    { ticker: "A", weight_pct: 60 },
    { ticker: "B", weight_pct: 20 },
  ]);
  const original = buildPortfolioAnalytics(input, { basis: "weights" });
  assert.equal(original.concentration.hhi, null);
  assert.equal(original.concentration.topTenIssuerWeightPct, 80);
  assert.match(original.concentration.reason, /100%/);
  const normalized = buildPortfolioAnalytics(input, {
    basis: "weights",
    normalize: true,
  });
  assert.equal(normalized.concentration.complete, true);
  assert.equal(normalized.concentration.largestIssuerWeightPct, 75);
  assert.equal(normalized.concentration.hhi, 6250);
  assert.equal(normalized.concentration.effectiveIssuerCount, 1.6);
  const over = buildPortfolioAnalytics(
    rows([{ ticker: "A", weight_pct: 120 }]),
    { basis: "weights" },
  );
  assert.equal(over.concentration.hhi, null);
  assert.equal(over.concentration.knownWeightPct, 120);
  const zero = buildPortfolioAnalytics(rows([{ ticker: "A", weight_pct: 0 }]), {
    basis: "weights",
  });
  assert.equal(zero.concentration.hhi, null);
  assert.equal(zero.concentration.knownWeightPct, 0);
});

test("conflicting identities never borrow financial evidence from a supplied matching CIK", () => {
  const result = buildPortfolioAnalytics(
    rows([
      { ticker: "A", weight_pct: 80 },
      { ticker: "UNKNOWN", cik: "1", weight_pct: 20 },
    ]),
    { basis: "weights" },
    [company(1, { revenueGrowth: point(-10), netIncome: point(-1, "USD") })],
  );
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.issuerCount, 1);
  assert.equal(metric(result).availableCount, 1);
  assert.equal(metric(result).coveredWeightPct, 80);
  assert.equal(condition(result).knownMatchedWeightPct, 80);
  assert.deepEqual(condition(result).rowIds, ["position-1"]);
  assert.equal(result.concentration.hhi, null);
  const unresolved = result.coverage.statuses.find(
    (entry) => entry.id === "unresolved",
  );
  assert.equal(unresolved.weightPct, 20);
  assert.equal(unresolved.count, 1);
  assert.equal(
    result.coverage.missingRows.find((entry) => entry.rowId === "position-2")
      .reason,
    "Confirm this position's identity before matching company evidence.",
  );
});

test("missing, unsupported, incorrectly classified and wrong-unit financial values never become observations", () => {
  const data = [
    company(1, { revenueGrowth: point(null), netIncome: point(null, "USD") }),
    company(2, { revenueGrowth: point(""), netIncome: point("", "USD") }),
    company(3, {
      revenueGrowth: point(-10, "%", { classification: "unavailable" }),
      netIncome: point(-10, "USD", { classification: "unavailable" }),
    }),
    company(
      4,
      { revenueGrowth: point(-10), netIncome: point(-10, "USD") },
      { status: "failed" },
    ),
    company(5, {
      revenueGrowth: point(-10, "USD"),
      netIncome: point(-10, "%"),
    }),
    company(6, {
      revenueGrowth: point(Infinity),
      netIncome: point(-Infinity, "USD"),
    }),
    company(7, { revenueGrowth: point(0), netIncome: point(0, "USD") }),
  ];
  const result = buildPortfolioAnalytics(
    rows(["A", "B", "C", "D", "E", "F", "G"].map((ticker) => ({ ticker }))),
    { basis: "none" },
    data,
  );
  assert.equal(metric(result).availableCount, 1);
  assert.equal(metric(result).median, 0);
  assert.equal(metric(result).missingCount, 6);
  assert.equal(condition(result).measuredCount, 1);
  assert.equal(condition(result).matchedCount, 0);
  assert.equal(condition(result).missingCount, 6);
  const empty = buildPortfolioAnalytics(rows([{ ticker: "A" }]), {}, [
    company(1, {}),
  ]);
  for (const entry of empty.metrics) {
    assert.equal(entry.availableCount, 0);
    for (const key of ["median", "p25", "p75", "min", "max"])
      assert.equal(entry[key], null);
  }
});

test("business-model exclusions and explicit not-applicable values are distinct from missing financial coverage", () => {
  const result = buildPortfolioAnalytics(
    rows(["A", "B", "C", "D"].map((ticker) => ({ ticker }))),
    {},
    [
      company(
        1,
        {
          currentRatio: point(2, "x"),
          loanDeposits: point(70),
          netIncome: point(-1, "USD"),
        },
        { lens: "banking" },
      ),
      company(2, {
        currentRatio: point(3, "x", { classification: "not_applicable" }),
        netIncome: point(-1, "USD", { status: "not_applicable" }),
      }),
      company(3, { currentRatio: point(null, "x"), loanDeposits: point(90) }),
      company(4, { currentRatio: point(1.5, "x"), loanDeposits: point(80) }),
    ],
  );
  const liquidity = metric(result, "currentRatio");
  assert.equal(liquidity.notApplicableCount, 2);
  assert.equal(liquidity.eligibleCount, 2);
  assert.equal(liquidity.availableCount, 1);
  assert.equal(liquidity.missingCount, 1);
  assert.equal(liquidity.median, 1.5);
  assert.equal(metric(result, "loanDeposits").median, 70);
  assert.equal(metric(result, "loanDeposits").availableCount, 1);
  assert.equal(metric(result, "loanDeposits").notApplicableCount, 3);
  assert.equal(condition(result).notApplicableCount, 1);
  assert.equal(condition(result).matchedCount, 1);
});

test("funds stay direct concentration positions and never receive ordinary company financial diagnostics", () => {
  const result = buildPortfolioAnalytics(
    rows([
      { ticker: "A", weight_pct: 50 },
      { ticker: "FUND", weight_pct: 50 },
    ]),
    { basis: "weights" },
    [
      company(1, { revenueGrowth: point(10), netIncome: point(-1, "USD") }),
      company(
        9,
        { revenueGrowth: point(90), netIncome: point(-99, "USD") },
        { kind: "fund" },
      ),
    ],
  );
  assert.equal(result.concentration.complete, true);
  assert.equal(result.concentration.hhi, 5000);
  assert.equal(result.fundCount, 1);
  assert.equal(result.operatingIssuerCount, 1);
  assert.equal(metric(result).median, 10);
  assert.equal(metric(result).eligibleCount, 1);
  assert.equal(condition(result).matchedCount, 1);
  assert.equal(condition(result).knownMatchedWeightPct, 50);
  assert.equal(
    result.coverage.statuses.find((entry) => entry.id === "funds").weightPct,
    50,
  );
  assert.match(
    result.warnings.join(" "),
    /Underlying fund holdings are not included/,
  );
});

test("industry and status groups conserve included known weights and identify unknown or unsupported coverage", () => {
  const input = rows([
    { ticker: "A", weight_pct: 30 },
    { ticker: "B", weight_pct: 20 },
    { ticker: "C", weight_pct: 10 },
    { ticker: "FUND", weight_pct: 10 },
    { ticker: "UNKNOWN", weight_pct: 30 },
  ]);
  const result = buildPortfolioAnalytics(input, { basis: "weights" }, [
    company(1, undefined, { sicDescription: "Shared industry" }),
    company(
      2,
      {},
      {
        sicDescription: "Shared industry",
        status: "partial",
        filings: [{ form: "10-K" }],
      },
    ),
    company(3, {}, { sicDescription: null, industry: null, status: "failed" }),
  ]);
  assert.equal(
    result.concentration.industries.find(
      (entry) => entry.label === "Shared industry",
    ).count,
    2,
  );
  assert.equal(
    result.concentration.industries.find(
      (entry) => entry.label === "Shared industry",
    ).weightPct,
    50,
  );
  assert.equal(
    result.concentration.industries.find(
      (entry) => entry.label === "Unclassified",
    ).weightPct,
    10,
  );
  assert.equal(
    result.coverage.statuses.find((entry) => entry.id === "filings-only")
      .weightPct,
    20,
  );
  assert.equal(
    result.coverage.statuses.reduce(
      (total, entry) => total + (entry.weightPct ?? 0),
      0,
    ),
    100,
  );
  assert.equal(
    result.concentration.industries.reduce(
      (total, entry) => total + (entry.weightPct ?? 0),
      0,
    ),
    100,
  );
  assert.equal(
    result.coverage.statuses.reduce((total, entry) => total + entry.count, 0),
    5,
  );
});

test("excluded and merged source rows cannot change denominators or financial drilldowns", () => {
  const original = rows([
    { ticker: "A", weight_pct: 20 },
    { ticker: "A", weight_pct: 30 },
    { ticker: "B", weight_pct: 50 },
  ]);
  const pending = buildPortfolioAnalytics(original, { basis: "weights" });
  assert.equal(pending.concentration.complete, false);
  assert.equal(pending.concentration.knownWeightPct, 50);
  const merged = applyDuplicateDecision(
    original,
    ["position-1", "position-2"],
    "merge",
  );
  merged[1].excluded = false; // Analytics still honors the merge marker defensively.
  merged[1].duplicateChoice = "keep";
  const result = buildPortfolioAnalytics(merged, { basis: "weights" }, [
    company(1, { netIncome: point(-1, "USD") }),
    company(2),
  ]);
  assert.equal(result.holdingCount, 2);
  assert.equal(result.concentration.knownWeightPct, 100);
  assert.equal(result.concentration.hhi, 5000);
  assert.deepEqual(condition(result).rowIds, ["position-1"]);
});

test("reporting periods and freshness are deterministic at the captured date and preserve missing dates", () => {
  const input = rows(["A", "B", "C", "D"].map((ticker) => ({ ticker })));
  const companies = [
    company(
      1,
      { revenueGrowth: point(10) },
      { period: { kind: "annual", end: "2020-12-31" } },
    ),
    company(
      2,
      { revenueGrowth: point(20) },
      {
        period: { kind: "annual", end: "2025-12-31" },
        cache: { status: "stale" },
      },
    ),
    company(
      3,
      { revenueGrowth: point(30) },
      { period: { kind: "ttm", end: "2025-12-31" } },
    ),
    company(4, {}, { period: { kind: "annual", end: "2026-02-31" } }),
  ];
  const result = buildPortfolioAnalytics(input, {}, companies, {
    capturedAt: "2026-09-08T00:00:00Z",
  });
  assert.equal(result.coverage.staleCount, 3);
  assert.equal(
    result.coverage.periodEnds.find((group) => group.end === "2025-12-31")
      .count,
    2,
  );
  assert.equal(result.coverage.periodEnds.at(-1).end, "Unavailable");
  assert.equal(result.capturedAt, "2026-09-08T00:00:00Z");
  assert.match(result.warnings.join(" "), /span 2 reporting dates/);
  assert.equal(
    buildPortfolioAnalytics(input, {}, companies).coverage.staleCount,
    1,
  );
  assert.equal(
    buildPortfolioAnalytics(input, {}, companies, { capturedAt: "invalid" })
      .capturedAt,
    null,
  );
});

test("financial evidence observations retain resolved ticker fallback, metric period and safe SEC source", () => {
  const result = buildPortfolioAnalytics(rows([{ ticker: "A" }]), {}, [
    company(1, {
      revenueGrowth: point(5, "%", {
        period: { end: "2025-09-30" },
        sources: [
          { documentUrl: "https://sec.gov.evil.example/fake" },
          { documentUrl: "https://user:password@www.sec.gov/fake" },
          {
            documentUrl: "https://www.sec.gov/Archives/edgar/data/1/source.htm",
          },
        ],
      }),
    }),
  ]);
  const observation = metric(result).observations[0];
  assert.equal(observation.ticker, "A");
  assert.equal(observation.periodEnd, "2025-09-30");
  assert.equal(
    observation.sourceUrl,
    "https://www.sec.gov/Archives/edgar/data/1/source.htm",
  );
});

test("100 positions remain complete with issuer-based concentration and full metric drilldown", () => {
  const input = Array.from({ length: 100 }, (_, index) => ({
    id: `position-${index + 1}`,
    input: { ticker: `T${index + 1}` },
    resolution: {
      status: "resolved",
      kind: "company",
      ticker: `T${index + 1}`,
      cik: cik(index + 1),
      name: `Company ${index + 1}`,
    },
    excluded: false,
    duplicateChoice: null,
  }));
  const result = buildPortfolioAnalytics(
    input,
    { basis: "equal" },
    input.map((_, index) =>
      company(index + 1, { revenueGrowth: point(index) }),
    ),
  );
  assert.equal(result.concentration.hhi, 100);
  assert.equal(result.concentration.effectiveIssuerCount, 100);
  assert.equal(result.concentration.topFiveIssuerWeightPct, 5);
  assert.equal(result.concentration.topTenIssuerWeightPct, 10);
  assert.equal(metric(result).median, 49.5);
  assert.equal(metric(result).coveredWeightPct, 100);
  assert.equal(
    metric(result).bins.flatMap((entry) => entry.rowIds).length,
    100,
  );
});

test("quartiles remain finite for supported extreme finite observations", () => {
  const result = buildPortfolioAnalytics(
    rows([{ ticker: "A" }, { ticker: "B" }]),
    {},
    [
      company(1, { revenueGrowth: point(-1e308) }),
      company(2, { revenueGrowth: point(1e308) }),
    ],
  );
  assert.equal(metric(result).median, 0);
  close(metric(result).p25 / 1e308, -0.5);
  close(metric(result).p75 / 1e308, 0.5);
});
