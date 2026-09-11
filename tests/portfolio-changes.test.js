import test from "node:test";
import assert from "node:assert/strict";
import {
  createPortfolioBaseline,
  advancePortfolioBaseline,
  comparePortfolioResearch,
  validatePortfolioBaseline,
  PORTFOLIO_BASELINE_LIMIT,
} from "../src/utils/portfolioChanges.js";

const url =
  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000079/aapl-20260627.htm";
const newUrl =
  "https://www.sec.gov/Archives/edgar/data/320193/000032019326000080/aapl-update.htm";
const period = { kind: "annual", start: "2024-09-29", end: "2025-09-27" };
const rows = [
  {
    id: "apple",
    input: { ticker: "AAPL", notes: "PRIVATE NOTE", weight_pct: 99 },
    resolution: { cik: "0000320193", ticker: "AAPL", status: "resolved" },
    excluded: false,
  },
];
const company = (overrides = {}) => ({
  cik: "0000320193",
  name: "Apple Inc.",
  ticker: "AAPL",
  kind: "company",
  status: "ready",
  refreshStatus: "checked",
  cache: { status: "fresh" },
  period,
  metrics: {
    revenue: {
      value: 100,
      unit: "USD",
      label: "Revenue",
      classification: "reported",
      period,
      sources: [{ documentUrl: url, tag: "Revenue", taxonomy: "us-gaap" }],
      calculations: [],
    },
  },
  filings: [
    {
      accession: "0000320193-26-000079",
      form: "10-K",
      filingDate: "2026-08-07",
      documentUrl: url,
    },
  ],
  ...overrides,
});
const snapshot = (companies = [company()], overrides = {}) => ({
  schema_version: "edgar.portfolio.v1",
  generated_at: "2026-09-08T12:00:00.000Z",
  basis: "annual",
  companies,
  ...overrides,
});
const compare = (after, before = company(), options = {}) =>
  comparePortfolioResearch(
    createPortfolioBaseline(snapshot([before])),
    snapshot([after], options),
    rows,
  );

test("full A, full B, partial C, full D compares D with the last successful B capture", () => {
  const captures = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map(
    (date, index) => {
      const issuer = company();
      issuer.metrics.revenue.value = (index + 1) * 100;
      return snapshot([issuer], { generated_at: `${date}T12:00:00.000Z` });
    },
  );
  captures[2].cancelled = true;
  captures[2].companies[0].refreshStatus = "not_checked";
  let document = {
    snapshot: null,
    lastCheckedAt: null,
    comparisonBaseline: null,
  };
  for (const [index, next] of captures.entries()) {
    const complete = index !== 2;
    const baseline = advancePortfolioBaseline(document, next, complete);
    document = {
      snapshot: next,
      lastCheckedAt: complete ? next.generated_at : document.lastCheckedAt,
      comparisonBaseline: baseline,
    };
    assert.equal(baseline.capturedAt, captures[index < 2 ? 0 : 1].generated_at);
  }
  const comparison = comparePortfolioResearch(
    document.comparisonBaseline,
    document.snapshot,
    rows,
  );
  assert.equal(comparison.counts.revision, 1);
  assert.equal(comparison.changes[0].beforeValue, 200);
  assert.equal(comparison.changes[0].afterValue, 400);
});

test("unfinished and incompatible prior snapshots cannot become successful comparison checkpoints", () => {
  const unfinished = snapshot([company({ refreshStatus: "not_checked" })]);
  const next = snapshot([company()], {
    generated_at: "2026-09-09T12:00:00.000Z",
  });
  assert.equal(
    advancePortfolioBaseline(
      { snapshot: unfinished, lastCheckedAt: unfinished.generated_at },
      next,
      false,
    ),
    null,
  );
  assert.equal(
    advancePortfolioBaseline(
      { snapshot: snapshot(), lastCheckedAt: snapshot().generated_at },
      { ...next, basis: "ttm" },
      false,
    ),
    null,
  );
  const preserved = createPortfolioBaseline(snapshot());
  assert.equal(
    advancePortfolioBaseline(
      {
        snapshot: unfinished,
        lastCheckedAt: null,
        comparisonBaseline: preserved,
      },
      next,
      false,
    ),
    preserved,
  );
  assert.equal(
    advancePortfolioBaseline(
      { snapshot: unfinished, lastCheckedAt: null },
      next,
      true,
    ).capturedAt,
    next.generated_at,
  );
});

test("equal and same-day captures have no manufactured changes, while exact-period revisions retain both sources", () => {
  assert.equal(compare(company()).changes.length, 0);
  const changed = company();
  changed.metrics.revenue.value = 125;
  changed.metrics.revenue.sources[0].documentUrl = newUrl;
  const result = compare(changed);
  assert.equal(result.counts.revision, 1);
  assert.deepEqual(result.changes[0].beforeSources, [url]);
  assert.deepEqual(result.changes[0].afterSources, [newUrl]);
  assert.equal(result.changes[0].beforeValue, 100);
  assert.equal(result.changes[0].afterValue, 125);
  assert.equal(result.changes[0].growth, undefined);
});

test("new reporting periods, changed units, and changed formulas are never same-period value revisions", () => {
  for (const change of ["period", "unit", "formula", "tag"]) {
    const next = company();
    next.metrics.revenue.value = 150;
    if (change === "period") {
      next.period = { ...period, end: "2026-09-26" };
      next.metrics.revenue.period = next.period;
    }
    if (change === "unit") next.metrics.revenue.unit = "EUR";
    if (change === "formula")
      next.metrics.revenue.formula = "Component A + Component B";
    if (change === "tag")
      next.metrics.revenue.sources[0].tag = "DifferentRevenueDefinition";
    const result = compare(next);
    assert.equal(result.counts.revision, 0, change);
    assert.equal(
      result.counts[change === "period" ? "period" : "coverage"],
      1,
      change,
    );
  }
  assert.equal(
    compare(company(), company(), { basis: "ttm" }).state,
    "incompatible",
  );
});

test("missing reporting periods or linked source evidence never produce verified numerical revisions", () => {
  const unknownBefore = company({ period: {} });
  unknownBefore.metrics.revenue.period = {};
  const unknownAfter = structuredClone(unknownBefore);
  unknownAfter.metrics.revenue.value = 200;
  assert.equal(compare(unknownAfter, unknownBefore).counts.revision, 0);
  const noSource = company();
  noSource.metrics.revenue.value = 200;
  noSource.metrics.revenue.sources[0].documentUrl = undefined;
  const result = compare(noSource);
  assert.equal(result.counts.revision, 0);
  assert.equal(result.counts.coverage, 1);
  assert.match(result.changes[0].title, /source verification/);
});

test("newly observed filings are accession-deduplicated, even when their filing date precedes the capture", () => {
  const next = company();
  const observed = {
    accession: "0000320193-26-000080",
    form: "8-K",
    filingDate: "2026-01-01",
    documentUrl: newUrl,
  };
  next.filings.push(observed, observed);
  next.latestAnnualFiling = next.filings[0];
  const result = compare(next);
  assert.equal(result.counts.filing, 1);
  assert.match(
    result.changes[0].description,
    /does not necessarily mean newly filed/,
  );
  assert.equal(result.changes[0].after, observed.accession);
});

test("unknown, missing, failed, stale and unchecked results cannot claim fresh financial revisions", () => {
  for (const overrides of [
    { status: "failed" },
    { refreshStatus: "not_checked" },
    { refreshStatus: "pending" },
    { cache: { status: "stale" } },
    { cache: { status: "unavailable" } },
  ]) {
    const next = company(overrides);
    next.metrics.revenue.value = 200;
    const result = compare(next);
    assert.equal(result.counts.revision, 0);
    assert.equal(result.uncheckedIssuers, 1);
    assert.equal(result.changes[0].fresh, false);
  }
  const absent = comparePortfolioResearch(
    createPortfolioBaseline(snapshot()),
    snapshot([]),
    rows,
  );
  assert.equal(absent.uncheckedIssuers, 1);
  assert.match(
    absent.changes[0].description,
    /Missing research is not evidence/,
  );
  const missingValue = company();
  missingValue.metrics.revenue.value = null;
  const result = compare(missingValue);
  assert.equal(result.counts.coverage, 1);
  assert.equal(result.changes[0].after, "Unavailable");
  assert.equal(result.counts.revision, 0);
});

test("cancelled captures compare only checked issuers, and issuer identity deduplicates share classes", () => {
  const next = company();
  next.metrics.revenue.value = 110;
  const baseline = createPortfolioBaseline(snapshot());
  const result = comparePortfolioResearch(
    baseline,
    snapshot([next], { cancelled: true }),
    [...rows, { ...rows[0], id: "second-share-class" }],
  );
  assert.equal(result.checkedIssuers, 1);
  assert.equal(result.counts.revision, 1);
  assert.match(result.warnings[0], /cancelled/);
  assert.equal(
    comparePortfolioResearch(baseline, snapshot([next]), [
      { ...rows[0], excluded: true },
    ]).changes.length,
    0,
  );
});

test("first captures and unsuccessful earlier issuer checks explain why there is no comparable baseline", () => {
  assert.equal(
    comparePortfolioResearch(null, snapshot(), rows).state,
    "needs_baseline",
  );
  assert.equal(
    comparePortfolioResearch(createPortfolioBaseline(snapshot()), null, rows)
      .state,
    "needs_baseline",
  );
  const next = company();
  next.metrics.revenue.value = 200;
  const result = compare(next, company({ refreshStatus: "not_checked" }));
  assert.equal(result.counts.coverage, 1);
  assert.equal(result.counts.revision, 0);
  assert.match(result.changes[0].description, /first observation/);
});

test("100-issuer checkpoints are compact and exclude allocations, notes, and calculation input values", () => {
  const companies = Array.from({ length: 100 }, (_, index) => {
    const item = company({
      cik: String(index + 1).padStart(10, "0"),
      notes: "PRIVATE NOTE",
      allocation: 99,
    });
    item.metrics.revenue.sources[0].documentUrl = `https://www.sec.gov/Archives/edgar/data/${index + 1}/annual-report.htm`;
    item.filings = Array.from({ length: 30 }, (_, filingIndex) => ({
      accession: `${item.cik}-26-${String(filingIndex + 1).padStart(6, "0")}`,
      documentUrl: `https://www.sec.gov/Archives/edgar/data/${index + 1}/filing-${filingIndex}.htm`,
      form: "8-K",
      filingDate: "2026-09-01",
    }));
    item.metrics = Object.fromEntries(
      Array.from({ length: 25 }, (_, metric) => [
        `metric${metric}`,
        {
          ...item.metrics.revenue,
          value: metric,
          calculations: [
            {
              label: "Calculation",
              formula: "A + B",
              value: 314159,
              sources: [{ value: 271828 }],
            },
          ],
        },
      ]),
    );
    return item;
  });
  const baseline = createPortfolioBaseline(snapshot(companies));
  const serialized = JSON.stringify(baseline);
  assert.ok(
    new TextEncoder().encode(serialized).length < PORTFOLIO_BASELINE_LIMIT,
  );
  assert.equal(baseline.companies.length, 100);
  assert.equal(baseline.sources.length, 100);
  assert.equal(baseline.companies[0].filings.length, 30);
  for (const privateField of ["PRIVATE NOTE", "allocation", "314159", "271828"])
    assert.equal(serialized.includes(privateField), false);
});

test("untrusted checkpoints reject external URLs, unknown fields, invalid pool references, and excessive size", () => {
  const baseline = createPortfolioBaseline(snapshot());
  for (const url of [
    "javascript:alert(1)",
    "https://sec.gov.evil.test/",
    "https://user@sec.gov/a",
    "http://sec.gov/a",
  ]) {
    const bad = structuredClone(baseline);
    bad.sources[0] = url;
    assert.throws(() => validatePortfolioBaseline(bad), /SEC.gov/);
  }
  const badIndex = structuredClone(baseline);
  badIndex.companies[0].metrics.revenue.sources = [99];
  assert.throws(() => validatePortfolioBaseline(badIndex), /metric is invalid/);
  const privateData = { ...baseline, notes: "secret" };
  assert.throws(
    () => validatePortfolioBaseline(privateData),
    /unsupported field/,
  );
  const unsafe = JSON.parse(
    JSON.stringify(baseline).replace(
      '"metrics":{',
      '"metrics":{"__proto__":{},',
    ),
  );
  assert.throws(() => validatePortfolioBaseline(unsafe), /Unsafe/);
  const large = structuredClone(baseline);
  large.definitions = Array.from({ length: 80 }, () => "x".repeat(15999));
  assert.throws(() => validatePortfolioBaseline(large), /1 MiB/);
});
