import test from "node:test";
import assert from "node:assert/strict";
import {
  PORTFOLIO_SCHEMA_VERSION,
  PORTFOLIO_COLUMNS,
  normalizePortfolioInput,
  createPortfolioRows,
  resolvePortfolioRows,
  resolvePortfolioRowCandidate,
  duplicateGroups,
  applyDuplicateDecision,
  undoPortfolioMerge,
  allocationSummary,
  validatePortfolioRow,
  portfolioNumber,
} from "../src/utils/portfolioModel.js";

const directory = {
  AAPL: { cik: "320193", name: "Apple Inc." },
  MSFT: { cik: "789019", name: "Microsoft Corporation" },
  "BRK-A": { cik: "1067983", name: "Berkshire Hathaway Inc." },
  "BRK-B": { cik: "1067983", name: "Berkshire Hathaway Inc." },
  APLE: { cik: "1418121", name: "Apple Hospitality REIT, Inc." },
  ARKK: { cik: "1579982", name: "ARK Innovation ETF", isFund: true },
};
const canonical = (holdings, other = {}) =>
  normalizePortfolioInput({
    schema_version: PORTFOLIO_SCHEMA_VERSION,
    holdings,
    ...other,
  });
const rows = (holdings) =>
  resolvePortfolioRows(
    createPortfolioRows(canonical(holdings).holdings),
    directory,
  );
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const companies = {
  "0000320193": {
    status: "ready",
    kind: "company",
    sicDescription: "Electronic Computers",
    metrics: { revenue: { value: 100 }, debt: { value: null } },
  },
  "0000789019": { status: "failed", kind: "company" },
  "0001067983": {
    status: "partial",
    kind: "company",
    sicDescription: "Insurance",
    metrics: { revenue: { value: 80 }, debt: { value: 0 } },
  },
};

test("canonical ticker-only inputs retain all optional columns without inventing an allocation", () => {
  const input = canonical([
    { ticker: " AAPL " },
    { ticker: "MSFT", weight_pct: "12.5", notes: " private " },
  ]);
  assert.deepEqual(Object.keys(input.holdings[0]), PORTFOLIO_COLUMNS);
  assert.equal(input.holdings[0].ticker, "AAPL");
  assert.equal(input.holdings[1].weight_pct, "12.5");
  assert.equal(input.holdings[1].notes, "private");
  assert.deepEqual(input.allocation, { basis: "none", normalize: false });
  const summary = allocationSummary(
    rows([{ ticker: "AAPL" }, { ticker: "MSFT" }]),
    input.allocation,
    companies,
  );
  assert.equal(summary.mode, "universe");
  assert.equal(summary.allocatedWeight, null);
  assert.equal(summary.topFiveWeightPct, null);
  assert.equal(summary.coverage.availableWeight, null);
  assert.equal(summary.companyCount, 2);
  assert.equal(summary.coverage.availableCompanies, 1);
  assert.ok(summary.allocations.every((row) => row.weightPct === null));
});

test("schema validates finite types, bounded cells, 100 rows, modes and explicit row decisions", () => {
  assert.equal(
    canonical(Array.from({ length: 100 }, () => ({ ticker: "AAPL" }))).holdings
      .length,
    100,
  );
  for (const input of [
    { schema_version: "edgar.portfolio.v9", holdings: [] },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: Array.from({ length: 101 }, () => ({})),
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [{ ticker: { executable: true } }],
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [{ ticker: "A".repeat(2001) }],
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [{ shares: Infinity }],
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [],
      allocation: { basis: "auto" },
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [],
      allocation: { normalize: "false" },
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [],
      research: { basis: "latest" },
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [{}],
      row_choices: [{ index: 1, duplicateChoice: "keep" }],
    },
    {
      schema_version: PORTFOLIO_SCHEMA_VERSION,
      holdings: [{}, {}],
      row_choices: [
        { index: 0, duplicateChoice: "keep" },
        { index: 0, duplicateChoice: "remove" },
      ],
    },
  ])
    assert.throws(() => normalizePortfolioInput(input));
  const accepted = canonical([{ ticker: "AAPL" }, { ticker: "AAPL" }], {
    row_choices: [
      { index: 0, duplicateChoice: "keep" },
      { index: 1, duplicateChoice: "keep" },
    ],
  });
  assert.equal(
    duplicateGroups(
      createPortfolioRows(accepted.holdings, accepted.row_choices),
    )[0].decided,
    true,
  );
});

test("exact tickers and transparent class aliases resolve while company names always require review", () => {
  const resolved = rows([
    { ticker: "aapl", company_name: "Apple" },
    { ticker: "BRK.B" },
    { company_name: "Microsoft" },
    { company_name: "Apple" },
  ]);
  assert.equal(resolved[0].resolution.status, "resolved");
  assert.equal(resolved[0].resolution.cik, "0000320193");
  assert.equal(resolved[1].resolution.ticker, "BRK-B");
  assert.match(resolved[1].resolution.warnings[0], /alias/);
  assert.equal(resolved[2].resolution.status, "review");
  assert.equal(resolved[3].resolution.status, "review");
  assert.equal(resolved[3].resolution.candidates.length, 2);
  const selected = resolvePortfolioRowCandidate(
    resolved[3],
    resolved[3].resolution.candidates[0],
  );
  assert.equal(selected.resolution.status, "resolved");
  assert.equal(selected.resolution.userReviewed, true);
  assert.equal(selected.input.company_name, "Apple");
  assert.throws(() =>
    resolvePortfolioRowCandidate(resolved[2], { cik: "123", ticker: "FAKE" }),
  );
});

test("conflicting ticker, CIK, name and unknown instruments remain explicit without discarding valid rows", () => {
  const result = rows([
    { ticker: "AAPL", cik: "789019" },
    { ticker: "AAPL", company_name: "Microsoft" },
    { ticker: "UNKNOWN", cik: "320193" },
    { ticker: "BTC-USD" },
    { ticker: "MSFT", cik: "not-a-cik" },
    { ticker: "MSFT" },
    {},
  ]);
  assert.deepEqual(
    result.map((row) => row.resolution.status),
    [
      "conflict",
      "conflict",
      "conflict",
      "unresolved",
      "conflict",
      "resolved",
      "unresolved",
    ],
  );
  assert.equal(result[5].resolution.cik, "0000789019");
  assert.equal(result.length, 7);
});

test("CIK-only identities do not fabricate share classes, and unknown CIK requires SEC verification", () => {
  const result = rows([
    { cik: "1067983" },
    { cik: "1234567" },
    { ticker: "ARKK" },
  ]);
  assert.equal(result[0].resolution.status, "resolved");
  assert.equal(result[0].resolution.ticker, "");
  assert.equal(result[1].resolution.needsVerification, true);
  assert.equal(result[1].resolution.cik, "0001234567");
  assert.equal(result[2].resolution.kind, "fund");
  assert.match(result[2].resolution.warnings[0], /ordinary company/);
  const verifiedFund = allocationSummary(
    result,
    { basis: "equal" },
    { "0001234567": { status: "unsupported", kind: "fund" } },
  );
  assert.equal(verifiedFund.fundCount, 2);
  assert.equal(verifiedFund.companyCount, 1);
  assert.equal(verifiedFund.coverage.availableWeight, 0);
});

test("supplied percentage points produce correct security and issuer concentration across share classes", () => {
  const result = allocationSummary(
    rows([
      { ticker: "BRK.A", weight_pct: 20 },
      { ticker: "BRK-B", weight_pct: 30 },
      { ticker: "AAPL", weight_pct: 40 },
      { ticker: "MSFT", weight_pct: 10 },
    ]),
    { basis: "weights" },
    companies,
  );
  assert.equal(result.valid, true);
  assert.equal(result.originalWeightTotal, 100);
  assert.equal(result.companyCount, 3);
  assert.equal(result.issuers[0].cik, "0001067983");
  assert.equal(result.issuers[0].weightPct, 50);
  assert.deepEqual(result.issuers[0].tickers, ["BRK-A", "BRK-B"]);
  assert.equal(result.topFiveWeightPct, 100);
  assert.equal(result.coverage.availableWeight, 90);
  assert.equal(result.fieldCoverage.revenue.availableWeight, 90);
  assert.equal(result.fieldCoverage.debt.availableWeight, 50);
  assert.equal(result.fieldCoverage.debt.availableCompanies, 1);
  assert.equal(
    result.distribution.find((item) => item.label === "Insurance").weightPct,
    50,
  );
});

test("weights below or above 100 warn without cash assumptions, and explicit normalization preserves inputs", () => {
  const input = rows([
    { ticker: "AAPL", weight_pct: "12.5" },
    { ticker: "MSFT", weight_pct: "37.5" },
  ]);
  const supplied = allocationSummary(input, { basis: "weights" }, companies);
  assert.equal(supplied.allocations[0].weightPct, 12.5);
  assert.equal(supplied.allocatedWeight, 50);
  assert.equal(supplied.coverage.availableWeight, 12.5);
  assert.match(supplied.warnings.join(" "), /50%, not 100%/);
  assert.match(supplied.warnings.join(" "), /not assumed to be cash/);
  const normalized = allocationSummary(
    input,
    { basis: "weights", normalize: true },
    companies,
  );
  assert.equal(normalized.normalized, true);
  assert.equal(normalized.allocations[0].weightPct, 25);
  assert.equal(normalized.originalWeightTotal, 50);
  assert.equal(normalized.coverage.availableWeight, 25);
  assert.equal(input[0].input.weight_pct, "12.5");
  assert.match(normalized.assumptions[0], /Explicitly normalized/);
  const over = allocationSummary(rows([{ ticker: "AAPL", weight_pct: 120 }]), {
    basis: "weights",
  });
  assert.equal(over.allocatedWeight, 120);
  assert.match(over.warnings.join(" "), /120%, not 100%/);
});

test("missing weights retain known allocations and cannot normalize the covered subset", () => {
  const result = allocationSummary(
    rows([
      { ticker: "AAPL", weight_pct: 60 },
      { ticker: "MSFT" },
      { ticker: "UNKNOWN", weight_pct: 20 },
    ]),
    { basis: "weights", normalize: true },
    companies,
  );
  assert.equal(result.normalized, false);
  assert.equal(result.allocations[0].weightPct, 60);
  assert.equal(result.allocations[1].weightPct, null);
  assert.equal(result.allocations[2].weightPct, 20);
  assert.equal(result.allocatedWeight, 80);
  assert.equal(result.coverage.availableWeight, 60);
  assert.equal(result.coverage.weightPct, 60);
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.allocationComplete, false);
  assert.equal(result.valid, false);
});

test("equal weights are an explicit model and a missing company never reweights available companies", () => {
  const result = allocationSummary(
    rows([{ ticker: "AAPL" }, { ticker: "MSFT" }, { ticker: "BRK-B" }]),
    { basis: "equal" },
    companies,
  );
  assert.equal(result.mode, "weighted");
  assert.match(result.label, /explicit assumption/);
  assert.match(result.assumptions[0], /not supplied holdings weights/);
  close(result.allocatedWeight, 100);
  close(result.allocations[0].weightPct, 100 / 3);
  close(result.coverage.availableWeight, 200 / 3);
});

test("comparable market values derive weights, while mixed currencies or incompatible dates never combine", () => {
  const values = [
    {
      ticker: "AAPL",
      market_value: 1200,
      currency: "usd",
      as_of_date: "2026-09-01",
    },
    {
      ticker: "MSFT",
      market_value: 800,
      currency: "USD",
      as_of_date: "2026-09-01",
    },
  ];
  const good = allocationSummary(
    rows(values),
    { basis: "market_value" },
    companies,
  );
  assert.equal(good.valid, true);
  assert.equal(good.valueTotal, 2000);
  assert.equal(good.allocations[0].weightPct, 60);
  assert.equal(good.coverage.availableWeight, 60);
  for (const replacement of [
    { currency: "EUR" },
    { currency: "" },
    { as_of_date: "2026-08-31" },
    { as_of_date: "" },
    { market_value: "" },
  ]) {
    const rejected = allocationSummary(
      rows([values[0], { ...values[1], ...replacement }]),
      { basis: "market_value" },
    );
    assert.equal(rejected.allocatedWeight, null);
    assert.equal(rejected.valid, false);
    assert.ok(rejected.warnings.length);
  }
});

test("negative quantities and malformed numbers or dates remain visible and unsupported", () => {
  for (const invalid of [
    NaN,
    Infinity,
    "1e2",
    "0x10",
    "=1+1",
    "12.5%",
    "1,000",
  ])
    assert.equal(portfolioNumber(invalid), null);
  assert.equal(portfolioNumber("0"), 0);
  assert.equal(portfolioNumber(".25"), 0.25);
  for (const field of ["shares", "market_value", "weight_pct"]) {
    const input = rows([
      { ticker: "AAPL", weight_pct: 60, [field]: -1 },
      { ticker: "MSFT", weight_pct: 40 },
    ]);
    assert.equal(validatePortfolioRow(input[0]).valid, false);
    const result = allocationSummary(input, { basis: "weights" });
    assert.equal(result.allocations.length, 2);
    assert.equal(result.allocations[0].weightPct, null);
    assert.equal(result.allocations[1].weightPct, 40);
    assert.equal(result.valid, false);
    assert.equal(result.issues[0].code, "negative_unsupported");
  }
  assert.equal(
    validatePortfolioRow(
      rows([{ ticker: "AAPL", as_of_date: "2026-02-30" }])[0],
    ).valid,
    false,
  );
});

test("shares alone remain metadata even when all other company data is available", () => {
  const positions = rows([
    { ticker: "AAPL", shares: 10 },
    { ticker: "MSFT", shares: 20 },
  ]);
  const result = allocationSummary(positions, { basis: "none" }, companies);
  assert.equal(result.allocatedWeight, null);
  assert.match(
    result.warnings.join(" "),
    /No price, position value, or portfolio weight is inferred/,
  );
  const asValues = allocationSummary(
    positions,
    { basis: "market_value" },
    companies,
  );
  assert.equal(asValues.valid, false);
  assert.equal(asValues.allocatedWeight, null);
});

test("duplicate securities require explicit keep, remove or compatible merge without issuer double-counting", () => {
  const input = rows([
    { ticker: "BRK.B", weight_pct: 20, notes: "Lot A" },
    { ticker: "BRK-B", weight_pct: 30, notes: "Lot B" },
    { ticker: "AAPL", weight_pct: 50 },
  ]);
  const duplicate = duplicateGroups(input)[0];
  assert.equal(duplicate.canMerge, true);
  assert.equal(duplicate.decided, false);
  const pending = allocationSummary(input, { basis: "weights" }, companies);
  assert.equal(pending.allocations[0].weightPct, null);
  assert.equal(pending.allocations[2].weightPct, 50);
  assert.equal(pending.valid, false);
  const kept = allocationSummary(
    applyDuplicateDecision(input, duplicate.rowIds, "keep"),
    { basis: "weights" },
    companies,
  );
  assert.equal(kept.valid, true);
  assert.equal(kept.allocatedWeight, 100);
  assert.equal(kept.companyCount, 2);
  assert.equal(
    kept.issuers.find((issuer) => issuer.cik === "0001067983").weightPct,
    50,
  );
  const mergedRows = applyDuplicateDecision(input, duplicate.rowIds, "merge");
  assert.equal(mergedRows[0].input.weight_pct, 50);
  assert.equal(mergedRows[0].mergedInputs[0].weight_pct, 20);
  assert.equal(mergedRows[0].input.notes, "Lot A\nLot B");
  assert.equal(mergedRows[1].excluded, true);
  assert.equal(
    allocationSummary(mergedRows, { basis: "weights" }).allocatedWeight,
    100,
  );
  const removed = applyDuplicateDecision(input, input[1].id, "remove");
  assert.equal(
    allocationSummary(removed, { basis: "weights" }).allocatedWeight,
    70,
  );
});

test("incompatible duplicate currencies, dates, and missing allocation fields cannot merge", () => {
  const first = {
    ticker: "AAPL",
    weight_pct: 20,
    market_value: 100,
    currency: "USD",
    as_of_date: "2026-09-01",
  };
  for (const change of [
    { currency: "EUR" },
    { as_of_date: "2026-08-01" },
    { weight_pct: "" },
    { market_value: -20 },
  ]) {
    const input = rows([first, { ...first, ...change }]);
    assert.equal(duplicateGroups(input)[0].canMerge, false);
    assert.throws(() =>
      applyDuplicateDecision(
        input,
        input.map((row) => row.id),
        "merge",
      ),
    );
  }
  const distinctClasses = rows([
    { ticker: "BRK-A", weight_pct: 20 },
    { ticker: "BRK-B", weight_pct: 30 },
  ]);
  assert.equal(duplicateGroups(distinctClasses).length, 0);
  assert.throws(() =>
    applyDuplicateDecision(
      distinctClasses,
      distinctClasses.map((row) => row.id),
      "merge",
    ),
  );
});

test("100 positions remain bounded, aggregate shareclasses by issuer and preserve failed-company coverage", () => {
  const fixtureDirectory = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `X${index}`,
      { cik: String(index + 1), name: `Company ${index}` },
    ]),
  );
  const input = createPortfolioRows(
    canonical(
      Array.from({ length: 100 }, (_, index) => ({ ticker: `X${index}` })),
    ).holdings,
  );
  const resolved = resolvePortfolioRows(input, fixtureDirectory);
  const evidence = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      String(index + 1).padStart(10, "0"),
      {
        status: index === 22 ? "failed" : "ready",
        metrics: { assets: { value: index === 41 ? null : index } },
      },
    ]),
  );
  const summary = allocationSummary(resolved, { basis: "equal" }, evidence);
  assert.equal(summary.holdingCount, 100);
  assert.equal(summary.companyCount, 100);
  assert.equal(summary.coverage.availableCompanies, 98);
  assert.equal(summary.coverage.availableWeight, 98);
  assert.equal(summary.fieldCoverage.assets.availableCompanies, 98);
  assert.equal(summary.fieldCoverage.assets.availableWeight, 98);
  assert.equal(summary.topFiveWeightPct, 5);
});

test("issuer-only positions alongside a share class require duplicate review instead of fabricated ownership", () => {
  const positions = rows([
    { cik: "1067983", weight_pct: 60 },
    { ticker: "BRK-B", weight_pct: 40 },
  ]);
  const group = duplicateGroups(positions)[0];
  assert.match(group.key, /possible-issuer-duplicate/);
  assert.equal(group.canMerge, false);
  assert.equal(
    allocationSummary(positions, { basis: "weights" }).allocatedWeight,
    null,
  );
  const kept = allocationSummary(
    applyDuplicateDecision(positions, group.rowIds, "keep"),
    { basis: "weights" },
  );
  assert.equal(kept.allocatedWeight, 100);
  assert.equal(kept.companyCount, 1);
  assert.equal(kept.issuers[0].weightPct, 100);
});

test("multiple supplied allocation fields flag inconsistent proportions while keeping the selected basis", () => {
  const positions = rows([
    { ticker: "AAPL", weight_pct: 20, market_value: 500, currency: "USD" },
    { ticker: "MSFT", weight_pct: 80, market_value: 500, currency: "USD" },
  ]);
  const byWeights = allocationSummary(positions, { basis: "weights" });
  assert.match(byWeights.warnings.join(" "), /different relative allocations/);
  assert.equal(byWeights.allocations[0].weightPct, 20);
  const byValues = allocationSummary(positions, { basis: "market_value" });
  assert.equal(byValues.allocations[0].weightPct, 50);
});

test("field coverage excludes empty metric values and conflicting rows even if another position shares their CIK", () => {
  const positions = rows([
    { ticker: "AAPL", weight_pct: 60 },
    { ticker: "UNKNOWN", cik: "320193", weight_pct: 40 },
  ]);
  const result = allocationSummary(
    positions,
    { basis: "weights" },
    {
      "0000320193": {
        status: "ready",
        metrics: {
          empty: { value: "" },
          missing: { value: null },
          valid: { value: 0 },
        },
      },
    },
  );
  assert.equal(result.fieldCoverage.empty.availableCompanies, 0);
  assert.equal(result.fieldCoverage.missing.availableCompanies, 0);
  assert.equal(result.fieldCoverage.valid.availableWeight, 60);
  assert.equal(result.coverage.availableWeight, 60);
  assert.equal(result.reviewRequired, true);
});

test("filings-only partial research never counts as financial evidence by count or weight", () => {
  const positions = rows([
    { ticker: "AAPL", weight_pct: 60 },
    { ticker: "MSFT", weight_pct: 40 },
  ]);
  const evidence = {
    "0000320193": {
      status: "partial",
      period: null,
      metrics: {
        revenue: { value: null, classification: "unavailable" },
        invalid: { value: Infinity },
        notApplicable: { value: 0, classification: "not_applicable" },
        blank: { value: "" },
      },
      filings: [{ form: "10-K", filingDate: "2026-08-01" }],
    },
    "0000789019": {
      status: "partial",
      period: { end: "2026-06-30" },
      metrics: { debt: { value: 0, classification: "reported" } },
    },
  };
  const summary = allocationSummary(positions, { basis: "weights" }, evidence);
  assert.equal(summary.coverage.availableCompanies, 1);
  assert.equal(summary.coverage.companyPct, 50);
  assert.equal(summary.coverage.availableWeight, 40);
  assert.equal(summary.fieldCoverage.notApplicable.availableCompanies, 0);
  assert.equal(summary.fieldCoverage.debt.availableCompanies, 1);
  assert.equal(summary.fieldCoverage.debt.availableWeight, 40);
  assert.match(summary.coverage.companyDefinition, /Filings-only/);
});

test("largest-five concentration is explicitly a known subtotal when allocations are incomplete", () => {
  const summary = allocationSummary(
    rows([
      { ticker: "AAPL", weight_pct: 25 },
      { ticker: "MSFT", weight_pct: "" },
      { ticker: "BRK-B", weight_pct: 15 },
    ]),
    { basis: "weights" },
  );
  assert.equal(summary.topFiveWeightPct, 40);
  assert.equal(summary.allocationComplete, false);
  assert.match(summary.topFiveWeightDefinition, /known subtotal/);
  const unavailable = allocationSummary(rows([{ ticker: "AAPL" }]), {
    basis: "weights",
  });
  assert.equal(unavailable.topFiveWeightPct, null);
});

test("merged source positions cannot be counted twice and undo restores every original input", () => {
  const positions = rows([
    { ticker: "AAPL", weight_pct: 20, notes: "Original A" },
    { ticker: "AAPL", weight_pct: 30, notes: "Original B" },
    { ticker: "AAPL", weight_pct: 50, notes: "Original C" },
  ]);
  const merged = applyDuplicateDecision(
    positions,
    positions.map((row) => row.id),
    "merge",
  );
  assert.deepEqual(
    merged[0].mergedRowIds,
    positions.map((row) => row.id),
  );
  assert.equal(merged[1].mergedInto, merged[0].id);
  const accidentallyReincluded = merged.map((row) => ({
    ...row,
    excluded: false,
    duplicateChoice: "keep",
  }));
  assert.equal(
    allocationSummary(accidentallyReincluded, { basis: "weights" })
      .allocatedWeight,
    100,
  );
  assert.equal(
    allocationSummary(accidentallyReincluded, { basis: "weights" })
      .holdingCount,
    1,
  );
  assert.throws(
    () =>
      applyDuplicateDecision(accidentallyReincluded, [merged[1].id], "keep"),
    /already included/,
  );
  const restored = undoPortfolioMerge(merged, merged[0].id);
  assert.deepEqual(
    restored.map((row) => row.input),
    positions.map((row) => row.input),
  );
  assert.ok(
    restored.every(
      (row) => !row.excluded && !row.mergedInto && !row.mergedInputs,
    ),
  );
  assert.equal(duplicateGroups(restored)[0].decided, false);
  assert.throws(
    () => undoPortfolioMerge([merged[0]], merged[0].id),
    /incomplete/,
  );
});
