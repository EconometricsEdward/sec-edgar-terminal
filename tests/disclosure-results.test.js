import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDisclosureResults,
  disclosureReviewId,
  exportDisclosureResultsCsv,
  hasDisclosureChanges,
  sortDisclosureResults,
} from "../src/utils/disclosureResults.js";

const settings = { query: "liquidity", section: "all", scope: "paragraph" };
const filing = (extra = {}) => ({
  ticker: "JPM",
  cik: "19617",
  accession: "0001",
  primaryDoc: "report.htm",
  companyName: "JPMorgan Chase",
  form: "10-K",
  filingDate: "2026-02-01",
  reportDate: "2025-12-31",
  status: "reviewed",
  matched: true,
  matchCount: 2,
  evidenceRevision: "full-v1",
  previews: [
    {
      index: 4,
      text: "Liquidity of $20 billion",
      priorText: "",
      section: "MD&A",
      change: "unchanged",
      relevance: 2,
    },
  ],
  ...extra,
});

test("result triage distinguishes searched, candidates and fetch/section/baseline gaps", () => {
  const rows = [
    filing(),
    filing({ accession: "2", matched: false, matchCount: 0 }),
    filing({ accession: "3", status: "index-candidate", matched: undefined }),
    filing({ accession: "4", status: "fetch-failed", matched: undefined }),
    filing({ accession: "5", comparisonError: "prior unavailable" }),
  ];
  const model = buildDisclosureResults(rows, {}, settings);
  assert.equal(model.results.length, 3);
  assert.deepEqual(model.summary, {
    verified: 2,
    indexed: 0,
    candidates: 1,
    gaps: 1,
    personallyReviewed: 0,
  });
  assert.equal(
    buildDisclosureResults(rows, { scope: "verified" }, settings).results
      .length,
    3,
  );
  assert.equal(
    buildDisclosureResults(rows, { scope: "gaps" }, settings).results.length,
    2,
  );
  assert.equal(
    buildDisclosureResults(rows, { scope: "all" }, settings).results.length,
    5,
  );
});
test("change filter includes prior passages that no longer satisfy query", () => {
  const removed = filing({ matched: false, queryRemovedCount: 1 });
  assert.equal(hasDisclosureChanges(removed), true);
  assert.equal(
    buildDisclosureResults([removed], {}, settings, {}, true).results.length,
    1,
  );
  assert.equal(
    buildDisclosureResults(
      [removed],
      { change: "query-removed" },
      settings,
      {},
      true,
    ).results.length,
    1,
  );
  assert.equal(
    buildDisclosureResults([removed], { change: "removed" }, settings, {}, true)
      .results.length,
    0,
  );
});
test("facet counts respect candidate/verified scope and other selections", () => {
  const rows = [
    filing(),
    filing({ ticker: "BAC", accession: "2", form: "10-Q" }),
    filing({
      ticker: "BAC",
      accession: "3",
      status: "index-candidate",
      form: "10-Q",
    }),
  ];
  const model = buildDisclosureResults(
    rows,
    { scope: "verified", form: "10-Q" },
    settings,
  );
  assert.equal(model.results.length, 1);
  assert.deepEqual(
    model.facets.company.map(({ value, count }) => [value, count]),
    [
      ["all", 1],
      ["BAC", 1],
      ["JPM", 0],
    ],
  );
  assert.equal(
    model.facets.scope.find((f) => f.value === "candidates").count,
    1,
  );
  assert.equal(model.facets.form.find((f) => f.value === "10-K").count, 1);
});
test("preview filter only searches loaded preview quotation text", () => {
  const row = filing({
    companyName: "Hidden Company",
    previews: [
      { index: 1, text: "Available covenant", priorText: "Old liquidity" },
    ],
  });
  assert.equal(
    buildDisclosureResults([row], { text: "old LIQUIDITY" }, settings).results
      .length,
    0,
  );
  assert.equal(
    buildDisclosureResults(
      [{ ...row, previews: [{ ...row.previews[0], change: "removed" }] }],
      { text: "old LIQUIDITY" },
      settings,
    ).results.length,
    1,
  );
  assert.equal(
    buildDisclosureResults([row], { text: "Hidden Company" }, settings).results
      .length,
    0,
  );
});
test("relevance uses all-passage aggregate ahead of truncated preview scores", () => {
  const high = filing({
    accession: "high",
    signals: { maxRelevance: 30 },
    previews: [{ relevance: 1 }],
  });
  const low = filing({
    accession: "low",
    signals: { maxRelevance: 10 },
    previews: [{ relevance: 10 }],
  });
  assert.equal(sortDisclosureResults([low, high])[0].accession, "high");
  assert.equal(
    sortDisclosureResults([
      filing({
        accession: "zero",
        signals: { maxRelevance: 0 },
        previews: [{ relevance: 99 }],
      }),
      low,
    ])[0].accession,
    "low",
  );
});
test("sorts tolerate unavailable signals and do not mutate source array", () => {
  const a = filing({
    accession: "a",
    signals: { closestTerms: null, concrete: 0, recognized: 0 },
  });
  const b = filing({
    accession: "b",
    signals: { closestTerms: 4, concrete: 3, recognized: 2 },
    additions: 2,
  });
  const rows = [a, b];
  for (const sort of ["proximity", "specificity", "section", "added"])
    assert.equal(sortDisclosureResults(rows, sort)[0].accession, "b");
  assert.deepEqual(rows, [a, b]);
});
test("SEC relevance is retained as candidates are verified without mixing passage scores", () => {
  const rows = [
    filing({ accession: "second", indexRank: 2, signals: { maxRelevance: 9999 } }),
    filing({ accession: "first", status: "index-candidate", indexRank: 1, indexScore: 0.1, previews: [] }),
    filing({ accession: "third", status: "index-candidate", indexRank: 3, indexScore: 999 }),
  ];
  assert.deepEqual(sortDisclosureResults(rows).map(row => row.accession), ["first", "second", "third"]);
  assert.deepEqual(sortDisclosureResults(rows.map(row => ({ ...row, status: "reviewed" }))).map(row => row.accession), ["first", "second", "third"]);
});
test("prepared and SEC results fuse ordinal positions and reward independently found matches", () => {
  const rows = [
    filing({ accession: "sec-only", indexRank: 1, indexScore: 999999 }),
    filing({ accession: "prepared-only", status: "indexed-match", preparedRank: 2 }),
    filing({ accession: "both", indexRank: 3, preparedRank: 3 }),
  ];
  assert.deepEqual(sortDisclosureResults(rows).map(row => row.accession), ["both", "sec-only", "prepared-only"]);
});
test("unranked SEC candidates sort by SEC score without comparing against document relevance", () => {
  const rows = [
    filing({ accession: "candidate-low", status: "index-candidate", indexScore: 2 }),
    filing({ accession: "candidate-high", status: "index-candidate", indexScore: 20 }),
    filing({ accession: "verified", signals: { maxRelevance: 1 } }),
  ];
  assert.deepEqual(sortDisclosureResults(rows).map(row => row.accession), ["verified", "candidate-high", "candidate-low"]);
});
test("prepared passages are searchable evidence with distinct coverage and no full-document review claim", () => {
  const indexed = filing({ accession: "prepared", status: "indexed-match", preparedRank: 1, indexedAt: "2026-09-15T00:00:00Z" });
  const model = buildDisclosureResults([indexed], {}, settings);
  assert.equal(model.results.length, 1);
  assert.equal(model.summary.indexed, 1);
  assert.equal(model.summary.verified, 0);
  assert.equal(model.summary.gaps, 0);
  assert.equal(buildDisclosureResults([indexed], { scope: "verified" }, settings).results.length, 0);
  assert.equal(buildDisclosureResults([indexed], { scope: "indexed" }, settings).results.length, 1);
  assert.equal(buildDisclosureResults([indexed], {}, settings, {}, true).results.length, 0);
  assert.ok(exportDisclosureResultsCsv([indexed], settings).includes("prepared_passage_rank"));
});
test("review identity follows exact query scope and complete evidence revision", () => {
  const row = filing();
  const id = disclosureReviewId(row, settings);
  assert.equal(
    id,
    disclosureReviewId(
      { ...row, observedAt: "new fetch time" },
      { ...settings, depth: 20 },
    ),
  );
  assert.notEqual(
    id,
    disclosureReviewId(row, { ...settings, query: "covenant" }),
  );
  assert.notEqual(
    id,
    disclosureReviewId(row, { ...settings, scope: "document" }),
  );
  assert.notEqual(
    id,
    disclosureReviewId(row, { ...settings, section: "risk" }),
  );
  assert.notEqual(
    id,
    disclosureReviewId(row, { ...settings, comparison: "previous-report" }),
  );
  assert.notEqual(
    id,
    disclosureReviewId({ ...row, evidenceRevision: "new-full-text" }, settings),
  );
  assert.notEqual(
    id,
    disclosureReviewId({ ...row, accession: "different" }, settings),
  );
  const reviewed = { [id]: "2026-09-07T00:00:00Z" };
  assert.equal(
    buildDisclosureResults([row], { review: "reviewed" }, settings, reviewed)
      .results.length,
    1,
  );
  assert.equal(
    buildDisclosureResults([row], { review: "unreviewed" }, settings, reviewed)
      .results.length,
    0,
  );
  assert.equal(
    buildDisclosureResults(
      [row],
      { review: "unreviewed" },
      { ...settings, query: "covenant" },
      reviewed,
    ).results.length,
    1,
  );
});
test("legacy review fingerprint reopens when loaded evidence changes", () => {
  const row = filing({ evidenceRevision: undefined });
  assert.notEqual(
    disclosureReviewId(row, settings),
    disclosureReviewId(
      { ...row, previews: [{ index: 4, text: "Changed evidence" }] },
      settings,
    ),
  );
  assert.notEqual(
    disclosureReviewId(row, settings),
    disclosureReviewId({ ...row, queryRemovedCount: 1 }, settings),
  );
});
test("CSV manifest preserves unknown coverage, query settings and guards spreadsheet formulas", () => {
  const row = filing({
    ticker: "=DANGER()",
    status: "index-candidate",
    matched: undefined,
    matchCount: undefined,
  });
  const csv = exportDisclosureResultsCsv(
    [row],
    settings,
    {},
    { scope: "candidates" },
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("'" + row.ticker));
  assert.ok(csv.includes('"unknown"'));
  assert.ok(csv.includes("Filtered filing manifest; previews only"));
  assert.ok(csv.includes('""query"":""liquidity""'));
  assert.ok(csv.includes('""scope"":""candidates""'));
});
