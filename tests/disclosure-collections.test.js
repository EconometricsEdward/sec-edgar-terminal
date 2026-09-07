import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyDisclosureNotebook,
  writeDisclosureNotebook,
  DISCLOSURE_NOTEBOOK_KEY,
} from "../src/utils/disclosureNotebook.js";
import {
  bulkDisclosureEvidence,
  createDisclosureCollection,
  disclosureBriefDefaults,
  disclosureEvidenceSnapshot,
  disclosureTags,
  filterDisclosureEvidence,
  renameDisclosureCollection,
  reorderDisclosureEvidence,
  safeDisclosureSourceUrl,
  saveDisclosureAnnotations,
  saveDisclosureBriefDraft,
} from "../src/utils/disclosureCollections.js";
import {
  buildDisclosureBrief,
  disclosureBriefCsv,
  disclosureBriefHtml,
} from "../src/utils/disclosureBrief.js";

const evidence = (id, overrides = {}) => ({
  id,
  ticker: "JPM",
  companyName: "JPMorgan",
  cik: "19617",
  accession: `acc-${id}`,
  form: "10-K",
  filingDate: "2026-02-14",
  reportDate: "2025-12-31",
  section: "Risk Factors",
  quote: `Current wording ${id}`,
  priorQuote: "Archived prior wording",
  comparisonAccession: "prior-acc",
  change: "revised",
  languageLabel: "Mixed language",
  labelReviewed: false,
  observedAt: "2026-09-07T12:00:00Z",
  documentUrl: "https://www.sec.gov/Archives/edgar/data/19617/report.htm",
  notes: "",
  tags: "liquidity",
  settings: {
    query: "liquidity AND waiver",
    tickers: "JPM",
    mode: "companies",
    start: "2025-01-01",
    end: "2026-09-07",
    forms: "10-K,10-Q",
    section: "risk",
    scope: "paragraph",
    depth: 8,
    amendments: false,
  },
  ...overrides,
});
const notebook = () => ({
  ...emptyDisclosureNotebook(),
  collections: [
    {
      id: "first",
      name: "Bank review",
      items: [
        evidence("a"),
        evidence("b", { ticker: "BAC", tags: "funding, follow-up" }),
        evidence("c", { change: "removed", tags: "liquidity, follow-up" }),
      ],
    },
    { id: "second", name: "Memo evidence", items: [] },
  ],
});
const selection = (items) =>
  Object.fromEntries(
    items.map((item) => [item.id, disclosureEvidenceSnapshot(item)]),
  );

test("collection filters combine company, exact tag, change and archived quotation search", () => {
  const items = notebook().collections[0].items;
  assert.deepEqual(
    filterDisclosureEvidence(items, {
      company: "JPM",
      tag: "FOLLOW-UP",
      change: "removed",
      search: "archived prior",
    }).map((item) => item.id),
    ["c"],
  );
  assert.equal(filterDisclosureEvidence(items, { tag: "fund" }).length, 0);
  assert.equal(
    filterDisclosureEvidence(items, { search: "acc-b" })[0].ticker,
    "BAC",
  );
  assert.deepEqual(disclosureTags("funding, Funding, , credit"), [
    "Funding",
    "credit",
  ]);
});
test("new and renamed collections preserve unrelated research and reject stale names", () => {
  const data = notebook();
  const created = createDisclosureCollection(data, "third", " New review ");
  assert.equal(created.collections[2].name, "New review");
  assert.strictEqual(created.searches, data.searches);
  assert.throws(
    () => createDisclosureCollection(data, "first", "duplicate"),
    /identifier/,
  );
  assert.throws(() => createDisclosureCollection(data, "third", " "), /name/);
  const renamed = renameDisclosureCollection(
    created,
    "first",
    "Bank review",
    "Refinancing review",
  );
  assert.strictEqual(renamed.collections[0].items, data.collections[0].items);
  assert.throws(
    () => renameDisclosureCollection(renamed, "first", "Bank review", "stale"),
    /renamed elsewhere/,
  );
});
test("annotation save modifies notes and tags only, retaining archived source snapshots", () => {
  const data = notebook();
  const before = data.collections[0].items[0];
  const next = saveDisclosureAnnotations(
    data,
    "first",
    "a",
    { notes: "", tags: "liquidity" },
    { notes: "Follow up with MD&A", tags: "liquidity, research" },
  );
  assert.deepEqual(next.collections[0].items[0], {
    ...before,
    notes: "Follow up with MD&A",
    tags: "liquidity, research",
  });
  assert.strictEqual(next.collections[0].items[0].settings, before.settings);
  assert.equal(before.notes, "");
});
test("latest-storage annotation conflicts preserve the other tab and permit an explicit reviewed override", () => {
  let raw = JSON.stringify(notebook());
  const storage = {
    getItem: (key) => {
      assert.equal(key, DISCLOSURE_NOTEBOOK_KEY);
      return raw;
    },
    setItem: (_key, value) => {
      raw = value;
    },
  };
  writeDisclosureNotebook(storage, (latest) =>
    saveDisclosureAnnotations(
      latest,
      "first",
      "a",
      { notes: "", tags: "liquidity" },
      { notes: "Other tab", tags: "liquidity" },
    ),
  );
  const previous = raw;
  assert.throws(
    () =>
      writeDisclosureNotebook(storage, (latest) =>
        saveDisclosureAnnotations(
          latest,
          "first",
          "a",
          { notes: "", tags: "liquidity" },
          { notes: "My draft", tags: "liquidity" },
        ),
      ),
    /changed in another tab/,
  );
  assert.equal(raw, previous);
  const kept = writeDisclosureNotebook(storage, (latest) =>
    saveDisclosureAnnotations(
      latest,
      "first",
      "a",
      { notes: "Other tab", tags: "liquidity" },
      { notes: "My draft", tags: "liquidity" },
    ),
  );
  assert.equal(kept.collections[0].items[0].notes, "My draft");
});
test("annotation saves reject removed passages and oversized drafts without a partial write", () => {
  const data = notebook();
  assert.throws(
    () =>
      saveDisclosureAnnotations(
        data,
        "first",
        "gone",
        { notes: "", tags: "" },
        { notes: "draft", tags: "" },
      ),
    /moved or removed/,
  );
  assert.throws(
    () =>
      saveDisclosureAnnotations(
        data,
        "first",
        "a",
        { notes: "", tags: "liquidity" },
        { notes: "x".repeat(12001), tags: "" },
      ),
    /12,000/,
  );
  assert.equal(data.collections[0].items[0].notes, "");
});
test("bulk copy and move keep collection order, original IDs and all source provenance", () => {
  const data = notebook();
  const chosen = selection([
    data.collections[0].items[2],
    data.collections[0].items[0],
  ]);
  const copied = bulkDisclosureEvidence(data, {
    sourceId: "first",
    targetId: "second",
    action: "copy",
    selected: chosen,
  });
  assert.deepEqual(
    copied.collections[1].items.map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(
    copied.collections[1].items[1],
    data.collections[0].items[2],
  );
  assert.equal(copied.collections[0].items.length, 3);
  const moved = bulkDisclosureEvidence(data, {
    sourceId: "first",
    targetId: "second",
    action: "move",
    selected: chosen,
  });
  assert.deepEqual(
    moved.collections[0].items.map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    moved.collections[1].items.map((item) => item.id),
    ["a", "c"],
  );
});
test("bulk writes reject stale evidence snapshots and duplicate destination IDs", () => {
  const data = notebook();
  const selected = selection([data.collections[0].items[0]]);
  const changed = saveDisclosureAnnotations(
    data,
    "first",
    "a",
    { notes: "", tags: "liquidity" },
    { notes: "Concurrent note", tags: "liquidity" },
  );
  for (const action of ["move", "copy", "tag", "remove"])
    assert.throws(
      () =>
        bulkDisclosureEvidence(changed, {
          sourceId: "first",
          targetId: "second",
          action,
          selected,
          tags: "new",
        }),
      /changed in another tab/,
    );
  const copied = bulkDisclosureEvidence(data, {
    sourceId: "first",
    targetId: "second",
    action: "copy",
    selected,
  });
  assert.throws(
    () =>
      bulkDisclosureEvidence(copied, {
        sourceId: "first",
        targetId: "second",
        action: "move",
        selected,
      }),
    /already contains/,
  );
  assert.equal(copied.collections[0].items.length, 3);
});
test("bulk tag appends to current tags; empty selections and tag overflow are rejected", () => {
  const data = notebook();
  const tagged = bulkDisclosureEvidence(data, {
    sourceId: "first",
    action: "tag",
    selected: selection(data.collections[0].items),
    tags: "liquidity, follow-up",
  });
  assert.equal(tagged.collections[0].items[0].tags, "liquidity, follow-up");
  assert.equal(
    tagged.collections[0].items[1].tags,
    "funding, follow-up, liquidity",
  );
  assert.throws(
    () =>
      bulkDisclosureEvidence(data, {
        sourceId: "first",
        action: "remove",
        selected: {},
      }),
    /Select at least/,
  );
  assert.throws(
    () =>
      bulkDisclosureEvidence(data, {
        sourceId: "first",
        action: "tag",
        selected: selection(data.collections[0].items),
        tags: "x".repeat(301),
      }),
    /exceed 300/,
  );
});
test("reordering reads current evidence while refusing stale collection order", () => {
  const data = notebook();
  const noted = saveDisclosureAnnotations(
    data,
    "first",
    "a",
    { notes: "", tags: "liquidity" },
    { notes: "Keep this note", tags: "liquidity" },
  );
  const next = reorderDisclosureEvidence(noted, "first", "a", 1, [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(
    next.collections[0].items.map((item) => item.id),
    ["b", "a", "c"],
  );
  assert.equal(next.collections[0].items[1].notes, "Keep this note");
  assert.throws(
    () => reorderDisclosureEvidence(next, "first", "a", 1, ["a", "b", "c"]),
    /order changed/,
  );
});
test("brief draft persistence rejects concurrent changes and preserves evidence", () => {
  const data = notebook();
  const base = disclosureBriefDefaults(data.collections[0]);
  const values = {
    ...base,
    title: "Liquidity review",
    researchQuestion: "Has refinancing language changed?",
    conclusions: "Follow up on maturity dates.",
    groupBy: "company",
  };
  const saved = saveDisclosureBriefDraft(data, "first", base, values);
  assert.deepEqual(saved.collections[0].brief, values);
  assert.strictEqual(saved.collections[0].items, data.collections[0].items);
  assert.throws(
    () =>
      saveDisclosureBriefDraft(saved, "first", base, {
        ...values,
        title: "Stale edit",
      }),
    /changed in another tab/,
  );
  assert.throws(
    () =>
      saveDisclosureBriefDraft(data, "first", base, { ...values, title: "" }),
    /title/,
  );
});
test("brief exports honor an explicit selection, preserve saved order and never default an empty selection to everything", () => {
  const collection = notebook().collections[0];
  const brief = buildDisclosureBrief(collection, {
    selectedIds: ["c", "a"],
    exportedAt: "2026-09-07T15:00:00Z",
  });
  assert.deepEqual(
    brief.items.map((item) => item.id),
    ["a", "c"],
  );
  assert.equal(brief.filingCount, 2);
  assert.equal(brief.companyCount, 1);
  assert.equal(brief.totalSaved, 3);
  assert.equal(
    buildDisclosureBrief(collection, { selectedIds: [] }).items.length,
    0,
  );
  assert.equal(buildDisclosureBrief(collection).items.length, 3);
  const html = disclosureBriefHtml(brief);
  assert.match(html, /1 other saved passages omitted/);
  assert.doesNotMatch(html, /Current wording b/);
});
test("company and primary-tag brief groups keep the first encountered group and preserve order within it", () => {
  const collection = notebook().collections[0];
  const byCompany = buildDisclosureBrief(collection, {
    settings: { groupBy: "company" },
  });
  assert.deepEqual(
    byCompany.groups.map((group) => group.items.map((item) => item.id)),
    [["a", "c"], ["b"]],
  );
  const byTopic = buildDisclosureBrief(collection, {
    settings: { groupBy: "topic" },
  });
  assert.deepEqual(
    byTopic.groups.map((group) => group.label),
    ["liquidity", "funding"],
  );
  assert.deepEqual(
    byTopic.groups[0].items.map((item) => item.id),
    ["a", "c"],
  );
  const csv = disclosureBriefCsv(byCompany);
  assert.ok(csv.indexOf('"acc-a"') < csv.indexOf('"acc-c"'));
  assert.ok(csv.indexOf('"acc-c"') < csv.indexOf('"acc-b"'));
});
test("brief HTML contains original filing dates, prior wording, annotation distinctions and complete settings", () => {
  const collection = notebook().collections[0];
  const brief = buildDisclosureBrief(collection, {
    exportedAt: "2026-09-07T15:00:00Z",
    settings: {
      title: "Bank financing review",
      narrative: "My interpretation",
      conclusions: "Needs review.",
    },
  });
  const html = disclosureBriefHtml(brief);
  for (const text of [
    "Bank financing review",
    "My interpretation",
    "Needs review.",
    "2026-02-14",
    "2025-12-31",
    "prior-acc",
    "Archived prior wording",
    "liquidity AND waiver",
    "automated, unreviewed label",
    "Complete saved evidence snapshot",
    "Archived prior-report passage",
  ])
    assert.ok(html.includes(text), text);
  assert.equal(
    disclosureBriefHtml(brief),
    html,
    "the same prepared brief yields the exact preview/download HTML",
  );
});
test("brief export escapes scripts and limits clickable source URLs to HTTPS SEC hosts", () => {
  const item = evidence("unsafe", {
    quote: "<img src=x onerror=alert(1)>",
    notes: "<script>alert(1)</script>",
    documentUrl: "javascript:alert(1)",
  });
  const brief = buildDisclosureBrief(
    { name: "<b>Memo</b>", items: [item] },
    { settings: { title: "<script>title</script>" } },
  );
  const html = disclosureBriefHtml(brief);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /SEC source link unavailable/);
  for (const url of [
    "https://www.sec.gov.evil.test/x",
    "https://evil.test/sec.gov",
    "http://www.sec.gov/x",
    "https://user:pass@www.sec.gov/x",
    "https://www.sec.gov:8443/x",
    "javascript:alert(1)",
  ])
    assert.equal(safeDisclosureSourceUrl(url), "");
  assert.equal(
    safeDisclosureSourceUrl("https://www.sec.gov/Archives/x.htm"),
    "https://www.sec.gov/Archives/x.htm",
  );
});
test("structured brief CSV defuses spreadsheet formulas and preserves provenance and analyst fields", () => {
  const item = evidence("one", {
    notes: '=HYPERLINK("bad")',
    tags: "\t+formula",
    quote: 'Line 1\nLine 2, quoted "value"',
  });
  const brief = buildDisclosureBrief(
    { name: "Memo", items: [item] },
    {
      settings: {
        title: "@bad",
        researchQuestion: "=QUESTION",
        narrative: "-narrative",
        conclusions: "+conclusion",
      },
    },
  );
  const csv = disclosureBriefCsv(brief);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"'\t\+formula/);
  assert.match(csv, /"'@bad"/);
  assert.match(csv, /"'=QUESTION"/);
  for (const column of [
    "evidence_snapshot",
    "search_settings",
    "prior_quotation",
    "comparison_accession",
    "research_question",
    "exported_at",
  ])
    assert.ok(csv.includes(column));
  assert.match(csv, /Line 1\nLine 2, quoted ""value""/);
});
