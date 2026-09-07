import test from "node:test";
import assert from "node:assert/strict";
import {
  disclosureSearchIdentity,
  summarizeDisclosureCoverage,
  mergeDisclosureBatch,
  upsertDisclosureCompany,
  replaceDisclosureFiling,
  disclosureCoverageRows,
  exportDisclosureCoverage,
  makeDisclosureSession,
  readDisclosureSession,
} from "../src/utils/disclosureCoverage.js";
const settings = {
  mode: "companies",
  tickers: "JPM BAC",
  query: "liquidity",
  forms: "10-K",
  start: "2020-01-01",
  end: "2026-09-07",
  depth: 2,
};
const file = (id, overrides = {}) => ({
  ticker: "JPM",
  cik: "19617",
  accession: id,
  primaryDoc: "report.htm",
  filingDate: `202${id}-02-01`,
  status: "reviewed",
  matched: true,
  previews: [],
  ...overrides,
});
const company = (filings, extra = {}) => ({
  ticker: "JPM",
  cik: "19617",
  filings,
  eligible: 6,
  nextCursor: "4",
  remaining: 4,
  limited: true,
  ...extra,
});
test("continuation merges distinct documents and retries replace exact filing evidence without inflating coverage", () => {
  const first = company([
    file("4"),
    file("3", { status: "fetch-failed", matched: false }),
  ]);
  const next = mergeDisclosureBatch(
    first,
    company(
      [file("3"), file("2", { status: "section-unavailable", matched: false })],
      { nextCursor: "2", remaining: 3 },
    ),
  );
  assert.equal(next.selected, 3);
  assert.equal(next.reviewed, 2);
  assert.equal(next.fetchFailed, 0);
  assert.equal(next.sectionUnavailable, 1);
  assert.equal(next.firstObserved, "2023-02-01");
  assert.equal(next.nextCursor, "2");
  const updated = replaceDisclosureFiling(
    [next],
    file("2", { matched: false, comparisonError: "Prior fetch failed" }),
  )[0];
  assert.equal(updated.reviewed, 3);
  assert.equal(updated.matched, 2);
  assert.equal(updated.comparisonFailed, 1);
  assert.equal(updated.nextCursor, "2");
  assert.equal(updated.remaining, 3);
});
test("canonical issuer aliases count once and different issuers cannot be merged", () => {
  const first = company([file("4")]);
  const merged = upsertDisclosureCompany(
    [first],
    company([file("3")], { ticker: "AMJB" }),
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].ticker, "JPM");
  assert.ok(merged[0].filings.every((f) => f.ticker === "JPM"));
  assert.throws(
    () => mergeDisclosureBatch(first, { ...first, cik: "other" }),
    /different SEC/,
  );
  const rows = disclosureCoverageRows(
    ["JPM", "AMJB", "BAC"],
    { AMJB: "JPM" },
    merged,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].state, "not-reviewed");
  assert.equal(rows[1].reviewed, 0);
});
test("successfully searched no-match, missing section, fetch failure and baseline gaps remain distinct", () => {
  const cases = [
    [file("4", { matched: false }), "reviewed", 1, 0],
    [file("4", { status: "fetch-failed", matched: false }), "partial", 0, 0],
    [
      file("4", { status: "section-unavailable", matched: false }),
      "partial",
      0,
      0,
    ],
    [file("4", { comparisonError: "timeout" }), "partial", 1, 1],
  ];
  for (const [f, state, reviewed, matched] of cases) {
    const row = disclosureCoverageRows(["JPM"], {}, [
      company([f], { limited: false, nextCursor: null }),
    ])[0];
    assert.equal(row.state, state);
    assert.equal(row.reviewed, reviewed);
    assert.equal(row.matched, matched);
  }
  assert.equal(
    summarizeDisclosureCoverage(company([file("4"), file("4")])).selected,
    1,
  );
});
test("coverage export retains denominator and bounded-history context, and neutralizes spreadsheet formulas", () => {
  const rows = disclosureCoverageRows(["JPM"], {}, [
    company([file("4")], { error: "=SUM(1,2)", historyLimited: true }),
  ]);
  const csv = exportDisclosureCoverage(rows, settings);
  assert.match(csv, /Successfully reviewed/);
  assert.match(csv, /First observed within this search/);
  assert.match(csv, /History limited/);
  assert.match(csv, /'=SUM/);
  assert.match(csv, /liquidity/);
});
test("tab sessions preserve continuation and query semantics without running an index search", () => {
  const raw = makeDisclosureSession(
    settings,
    [company([file("4")])],
    { AMJB: "JPM" },
    "2026-09-07T12:00:00Z",
  );
  const restored = readDisclosureSession(raw);
  assert.equal(restored.companies[0].nextCursor, "4");
  assert.equal(restored.aliases.AMJB, "JPM");
  assert.equal(
    disclosureSearchIdentity(settings),
    disclosureSearchIdentity({ ...settings, comparison: "annual-season" }),
  );
  assert.notEqual(
    disclosureSearchIdentity(settings),
    disclosureSearchIdentity({ ...settings, comparison: "previous-report" }),
  );
  assert.notEqual(
    disclosureSearchIdentity(settings),
    disclosureSearchIdentity({ ...settings, section: "risk" }),
  );
  assert.equal(
    makeDisclosureSession({ ...settings, mode: "index" }, [], {}),
    null,
  );
  assert.throws(() => readDisclosureSession('{"version":1}'), /invalid/);
  assert.throws(() => readDisclosureSession(" ".repeat(3500001)), /size/);
});
