import test from "node:test";
import assert from "node:assert/strict";
import {
  bulkComparePins,
  checkedCompareSelection,
  compareAnnotations,
  compareBriefDefaults,
  compareMemo,
  comparePinSnapshot,
  compareTags,
  filterComparePins,
  reorderComparePins,
  saveCompareAnnotations,
  saveCompareBrief,
  saveCompareMemo,
} from "../src/utils/compareLibrary.js";
import {
  buildCompareBrief,
  compareBriefCsv,
  compareBriefHtml,
  safeCompareSourceUrl,
} from "../src/utils/compareBrief.js";

const pin = (id, ticker = "JPM", patch = {}) => ({
  id,
  ticker,
  cik: ticker === "JPM" ? "19617" : "70858",
  name: `${ticker} Company`,
  metric: "equityAssets",
  label: "Equity / assets",
  format: "percent",
  notes: "Review capital",
  tags: "Capital, follow-up",
  savedAt: "2026-09-07T12:00:00.000Z",
  version: "compare-v1",
  settings: { basis: "annual", asOf: "2025-02-01", benchmark: "median" },
  point: {
    value: 7.12345678,
    classification: "calculated",
    formula: "Equity / assets × 100",
    period: { kind: "annual", start: "2024-01-01", end: "2024-12-31" },
    calculations: [
      {
        formula: "Assets A + B",
        value: 123,
        start: "2024-01-01",
        end: "2024-12-31",
      },
    ],
    sources: [
      {
        tag: "StockholdersEquity",
        value: 71,
        unit: "USD",
        end: "2024-12-31",
        filed: "2025-01-31",
        form: "10-K",
        accession: "0000019617-25-000001",
        documentUrl: "https://www.sec.gov/Archives/edgar/data/19617/report.htm",
      },
    ],
  },
  ...patch,
});
const notebook = () => ({
  version: 1,
  searches: [],
  collectionName: "Bank funding review",
  notes: "Memo",
  pins: [
    pin("a"),
    pin("b", "BAC"),
    pin("c", "JPM", {
      metric: "netIncome",
      label: "Net income",
      tags: "Earnings",
    }),
  ],
});
const select = (...pins) =>
  Object.fromEntries(
    pins.map((value) => [value.id, comparePinSnapshot(value)]),
  );

test("evidence facets combine exact company/metric/tag with notes, dates and accession search", () => {
  const n = notebook();
  assert.deepEqual(
    filterComparePins(n.pins, {
      company: "JPM",
      metric: "equityAssets",
      tag: "capital",
      search: "2024-12-31",
    }).map((p) => p.id),
    ["a"],
  );
  assert.equal(
    filterComparePins(n.pins, { search: "0000019617-25" }).length,
    3,
  );
  assert.equal(filterComparePins(n.pins, { tag: "cap" }).length, 0);
  assert.deepEqual(compareTags("Funding, funding, Capital, CAPITAL"), [
    "funding",
    "CAPITAL",
  ]);
});

test("bulk changes affect selected evidence only, including observations hidden by filters", () => {
  const n = notebook(),
    selected = select(n.pins[0], n.pins[2]);
  const tagged = bulkComparePins(n, {
    selected,
    action: "tag",
    tags: "Reviewed, capital",
  });
  assert.equal(tagged.pins[1], n.pins[1]);
  assert.match(tagged.pins[0].tags, /Reviewed/);
  assert.equal(
    compareTags(tagged.pins[0].tags).filter(
      (tag) => tag.toLowerCase() === "capital",
    ).length,
    1,
  );
  const removed = bulkComparePins(n, { selected, action: "remove" });
  assert.deepEqual(
    removed.pins.map((p) => p.id),
    ["b"],
  );
  assert.equal(n.pins.length, 3);
});

test("bulk updates reject stale or missing evidence and oversized tags before any mutation", () => {
  const n = notebook(),
    selected = select(n.pins[0]);
  assert.throws(
    () =>
      checkedCompareSelection(
        [{ ...n.pins[0], notes: "Another tab" }],
        selected,
      ),
    /changed/,
  );
  assert.throws(
    () => bulkComparePins({ ...n, pins: [] }, { selected, action: "remove" }),
    /removed/,
  );
  assert.throws(
    () =>
      bulkComparePins(n, { selected, action: "tag", tags: "x".repeat(301) }),
    /300/,
  );
  assert.throws(
    () => bulkComparePins(n, { selected: {}, action: "remove" }),
    /Select/,
  );
  assert.equal(n.pins[0].notes, "Review capital");
});

test("annotations use optimistic conflict checks and preserve unrelated fresh data", () => {
  const n = notebook(),
    base = compareAnnotations(n.pins[0]);
  const fresh = {
    ...n,
    notes: "Concurrent memo",
    pins: n.pins.map((p) => (p.id === "a" ? { ...p, futureField: 42 } : p)),
  };
  const saved = saveCompareAnnotations(fresh, "a", base, {
    notes: "My draft",
    tags: "reviewed",
  });
  assert.equal(saved.notes, "Concurrent memo");
  assert.equal(saved.pins[0].futureField, 42);
  assert.equal(saved.pins[0].notes, "My draft");
  assert.throws(
    () =>
      saveCompareAnnotations(saved, "a", base, { notes: "Stale", tags: "" }),
    /changed/,
  );
  assert.throws(
    () => saveCompareAnnotations({ ...n, pins: [] }, "a", base, base),
    /removed/,
  );
  assert.throws(
    () =>
      saveCompareAnnotations(n, "a", base, {
        notes: "a".repeat(8001),
        tags: "",
      }),
    /8,000/,
  );
});

test("memo and brief drafts protect concurrent saved edits and enforce bounds", () => {
  const n = notebook(),
    memo = compareMemo(n),
    brief = compareBriefDefaults(n);
  const next = saveCompareMemo(n, memo, {
    collectionName: "New title",
    notes: "Longer memo",
  });
  assert.equal(next.collectionName, "New title");
  assert.throws(() => saveCompareMemo(next, memo, memo), /changed/);
  assert.throws(
    () => saveCompareMemo(n, memo, { ...memo, collectionName: " " }),
    /1–120/,
  );
  const saved = saveCompareBrief(n, brief, {
    ...brief,
    narrative: "My analysis",
    groupBy: "company",
  });
  assert.equal(saved.brief.narrative, "My analysis");
  assert.equal(saved.pins, n.pins);
  assert.throws(() => saveCompareBrief(saved, brief, brief), /changed/);
  assert.throws(
    () =>
      saveCompareBrief(n, brief, { ...brief, narrative: "x".repeat(12001) }),
    /invalid/,
  );
  assert.throws(
    () => saveCompareBrief(n, brief, { ...brief, groupBy: "risk-score" }),
    /grouping/,
  );
});

test("reordering acts on collection order and rejects stale order", () => {
  const n = notebook(),
    order = n.pins.map((p) => p.id);
  const next = reorderComparePins(n, "c", -1, order);
  assert.deepEqual(
    next.pins.map((p) => p.id),
    ["a", "c", "b"],
  );
  assert.equal(next.pins[1], n.pins[2]);
  assert.throws(
    () => reorderComparePins(next, "c", -1, order),
    /order changed/,
  );
  assert.equal(reorderComparePins(n, "a", -1, order), n);
});

test("brief selection respects saved order and grouping while omitting unselected observations", () => {
  const n = notebook();
  const brief = buildCompareBrief(n, {
    selectedIds: ["c", "a"],
    exportedAt: "2026-09-07T12:00:00Z",
  });
  assert.deepEqual(
    brief.items.map((p) => p.id),
    ["a", "c"],
  );
  assert.equal(brief.omittedCount, 1);
  assert.equal(brief.companyCount, 1);
  assert.equal(brief.sourceCount, 1);
  n.pins[0].notes = "Later edit";
  assert.equal(brief.items[0].notes, "Review capital");
  assert.equal(buildCompareBrief(n).items.length, 0);
  const grouped = buildCompareBrief(n, {
    selectedIds: ["a", "b", "c"],
    settings: { ...compareBriefDefaults(n), groupBy: "company" },
  });
  assert.deepEqual(
    grouped.groups.map((g) => [g.label, g.items.map((p) => p.id)]),
    [
      ["JPM", ["a", "c"]],
      ["BAC", ["b"]],
    ],
  );
});

test("HTML brief preserves exact quantities, source dates, calculations, settings and custom metrics", () => {
  const n = notebook();
  n.pins[0].metric = "netIncomeCommonSizeincome";
  n.pins[0].notes = "=DO-NOT-EXECUTE() <script>alert(1)</script>";
  const brief = buildCompareBrief(n, {
    selectedIds: ["a"],
    settings: {
      ...compareBriefDefaults(n),
      researchQuestion: "A < B?",
      narrative: "My thesis",
      conclusions: "Next steps",
    },
    exportedAt: "2026-09-07T12:00:00Z",
  });
  const html = compareBriefHtml(brief);
  assert.match(html, /7\.12345678/);
  assert.match(html, /2025-02-01/);
  assert.match(html, /0000019617-25-000001/);
  assert.match(html, /Assets A \+ B/);
  assert.match(html, /netIncomeCommonSizeincome|Original comparison settings/);
  assert.match(html, /A &lt; B\?/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /My thesis/);
  assert.match(compareBriefCsv(brief), /netIncomeCommonSizeincome/);
  assert.doesNotMatch(html, /BAC Company/);
});

test("exports only link exact SEC hosts and remove credential, port, script and lookalike URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "https://www.sec.gov.evil.test/x",
    "https://user@www.sec.gov/x",
    "https://www.sec.gov:8443/x",
    "http://www.sec.gov/x",
  ])
    assert.equal(safeCompareSourceUrl(value), "");
  assert.equal(
    safeCompareSourceUrl("https://sec.gov/Archives/test"),
    "https://sec.gov/Archives/test",
  );
  const n = notebook();
  n.pins[0].point.sources[0].documentUrl = "javascript:alert(1)";
  const brief = buildCompareBrief(n, { selectedIds: ["a"] });
  assert.doesNotMatch(compareBriefHtml(brief), /href="javascript/);
  assert.doesNotMatch(compareBriefCsv(brief), /javascript:/);
});

test("structured CSV includes analyst fields and original evidence with spreadsheet formula protection", () => {
  const n = notebook();
  n.pins[0].notes = ' =HYPERLINK("evil")';
  n.pins[0].point.value = -12.5;
  n.pins[0].point.sources.push({
    ...n.pins[0].point.sources[0],
    tag: "Assets",
    value: 997,
  });
  const brief = buildCompareBrief(n, {
    selectedIds: ["a"],
    settings: {
      ...compareBriefDefaults(n),
      title: "@bad",
      narrative: "Line one\nLine two",
    },
  });
  const csv = compareBriefCsv(brief);
  assert.match(csv, /"'@bad"/);
  assert.match(csv, /"' =HYPERLINK/);
  assert.match(csv, /"-12\.5"/);
  assert.match(csv, /"original_settings"/);
  assert.match(csv, /2025-02-01/);
  assert.match(csv, /"intermediate_calculations"/);
  assert.match(csv, /"Assets"/);
  assert.doesNotMatch(csv, /BAC Company/);
  assert.equal((csv.match(/"JPM Company"/g) || []).length, 2);
});
