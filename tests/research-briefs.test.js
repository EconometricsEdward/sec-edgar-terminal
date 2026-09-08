import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_BRIEFS_KEY,
  RESEARCH_BRIEF_STORAGE_LIMIT,
  readResearchBriefs,
  validateResearchBriefs,
  writeResearchBrief,
  createResearchBrief,
  createBriefSource,
  isBriefSourceUrl,
  briefJson,
  briefMarkdown,
} from "../src/utils/researchBriefs.js";
const now = "2026-09-08T16:00:00.000Z";
const url = "https://www.sec.gov/Archives/edgar/data/320193/example.htm";
const source = (input = {}) =>
  createBriefSource(
    {
      id: "source-a",
      label: "Apple annual filing",
      url,
      notes: "Private source annotation",
      annotation: "contradicts",
      origin: "Analysis",
      capturedAt: "2026-09-07T14:00:00.000Z",
      ...input,
    },
    now,
  );
const brief = (input = {}) =>
  createResearchBrief({
    id: "brief-a",
    title: "Cash flow research",
    ticker: "AAPL",
    cik: "0000320193",
    question: "UNSHARED question content",
    thesis: "UNSHARED thesis content",
    risks: "UNSHARED risks content",
    nextSteps: "UNSHARED next step content",
    sources: [source()],
    now,
    ...input,
  });
function storage() {
  const map = new Map([["unrelated", "keep"]]);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    map,
  };
}
function create(db, input = {}) {
  return writeResearchBrief(db, { mode: "create", brief: brief(input), now });
}

test("versioned briefs save locally without altering unrelated research", () => {
  const db = storage();
  assert.deepEqual(readResearchBriefs(null), {
    version: 1,
    briefs: [],
    activeId: null,
  });
  const saved = create(db);
  assert.equal(saved.activeId, "brief-a");
  assert.equal(
    saved.briefs[0].sources[0].capturedAt,
    "2026-09-07T14:00:00.000Z",
  );
  assert.equal(db.getItem("unrelated"), "keep");
  assert.deepEqual(readResearchBriefs(db.getItem(RESEARCH_BRIEFS_KEY)), saved);
});

test("fresh reads preserve independent changes and reject stale edits, deletes, and duplicates", () => {
  const db = storage();
  const first = create(db).briefs[0];
  create(db, { id: "brief-b", title: "Second brief" });
  const updated = writeResearchBrief(db, {
    mode: "update",
    id: first.id,
    expectedUpdatedAt: first.updatedAt,
    patch: { thesis: "New thesis" },
    now,
  });
  assert.equal(updated.briefs.length, 2);
  assert.equal(
    updated.briefs.find((b) => b.id === first.id).updatedAt,
    "2026-09-08T16:00:00.001Z",
  );
  const before = db.getItem(RESEARCH_BRIEFS_KEY);
  for (const mode of ["update", "delete", "duplicate"])
    assert.throws(
      () =>
        writeResearchBrief(db, {
          mode,
          id: first.id,
          expectedUpdatedAt: first.updatedAt,
          patch: { thesis: "Stale" },
          now,
        }),
      /changed in another tab/,
    );
  assert.equal(db.getItem(RESEARCH_BRIEFS_KEY), before);
});

test("duplicate keeps source provenance and content but creates independent identity and timestamps", () => {
  const db = storage(),
    first = create(db).briefs[0];
  const next = writeResearchBrief(db, {
    mode: "duplicate",
    id: first.id,
    expectedUpdatedAt: first.updatedAt,
    newId: "brief-copy",
    now: "2026-09-09T16:00:00.000Z",
  });
  const copy = next.briefs[0];
  assert.equal(copy.id, "brief-copy");
  assert.equal(copy.title, "Cash flow research (copy)");
  assert.equal(copy.createdAt, "2026-09-09T16:00:00.000Z");
  assert.deepEqual(copy.sources, first.sources);
  assert.equal(copy.thesis, first.thesis);
  writeResearchBrief(db, {
    mode: "delete",
    id: copy.id,
    expectedUpdatedAt: copy.updatedAt,
    now,
  });
  assert.equal(
    readResearchBriefs(db.getItem(RESEARCH_BRIEFS_KEY)).briefs[0].id,
    first.id,
  );
});

test("SEC link validation rejects lookalike domains, credentials, scripts, ports, and unsafe object keys", () => {
  for (const candidate of [
    "javascript:alert(1)",
    "http://www.sec.gov/a",
    "https://sec.gov.evil.test/a",
    "https://evil@www.sec.gov/a",
    "https://www.sec.gov:8443/a",
    "/analysis/AAPL",
    "data:text/html,test",
    "https://www.sec.gov/a\nforged",
    " https://www.sec.gov/a",
  ]) {
    assert.equal(isBriefSourceUrl(candidate), false);
    assert.throws(() => source({ url: candidate }), /HTTPS on SEC.gov/);
  }
  for (const candidate of [
    url,
    "https://data.sec.gov/api/x",
    "https://sec.gov/a",
  ])
    assert.equal(isBriefSourceUrl(candidate), true);
  assert.throws(
    () => createResearchBrief(JSON.parse('{"__proto__":{"polluted":true}}')),
    /Unsafe field/,
  );
  assert.throws(
    () =>
      validateResearchBriefs(
        JSON.parse(
          '{"version":1,"briefs":[],"activeId":null,"constructor":{}}',
        ),
      ),
    /Unsafe field/,
  );
  assert.throws(() => source({ capturedAt: "yesterday" }), /timestamp/);
});

test("bounded validation and storage failures preserve previous data", () => {
  const db = storage();
  create(db);
  const previous = db.getItem(RESEARCH_BRIEFS_KEY);
  assert.throws(() => create(db, { title: "x".repeat(201) }), /title/);
  assert.throws(() => create(db, { title: "" }), /title/);
  assert.throws(() => create(db, { thesis: false }), /thesis/);
  assert.throws(() => create(db, { question: "x".repeat(12001) }), /text/);
  assert.throws(
    () =>
      create(db, {
        sources: Array.from({ length: 101 }, (_, i) =>
          source({ id: `s-${i}` }),
        ),
      }),
    /large/,
  );
  assert.throws(
    () => readResearchBriefs("x".repeat(RESEARCH_BRIEF_STORAGE_LIMIT + 1)),
    /1 MiB/,
  );
  assert.throws(() => readResearchBriefs('{"version":5}'), /version/);
  assert.throws(
    () =>
      writeResearchBrief(
        {
          ...db,
          setItem() {
            throw new Error("Quota");
          },
        },
        { mode: "create", brief: brief({ id: "b" }), now },
      ),
    /previous saved data are preserved/,
  );
  assert.equal(db.getItem(RESEARCH_BRIEFS_KEY), previous);
});

test("private writing is absent from default exports and included only by explicit opt-in", () => {
  const value = brief();
  for (const exportContent of [
    briefJson(value, { now }),
    briefMarkdown(value, { now }),
  ]) {
    for (const text of [
      value.question,
      value.thesis,
      value.risks,
      value.nextSteps,
      value.sources[0].notes,
      "contradicts",
    ])
      assert.ok(!exportContent.includes(text));
    assert.ok(exportContent.includes(url));
    assert.ok(exportContent.includes(value.sources[0].capturedAt));
    assert.ok(exportContent.includes(now));
  }
  const included = JSON.parse(briefJson(value, { includePrivate: true, now }));
  assert.equal(included.private_writing_included, true);
  assert.equal(included.brief.thesis, value.thesis);
  assert.equal(included.brief.sources[0].annotation, "contradicts");
  assert.ok(
    briefMarkdown(value, { includePrivate: true, now }).includes(
      "UNSHARED thesis content",
    ),
  );
});

test("markdown neutralizes injected HTML and markdown while retaining precise source URLs", () => {
  const value = brief({
    title: "<img src=x onerror=alert(1)> [link](javascript:evil)",
    thesis: "<script>alert(1)</script>\n# forged heading",
    sources: [source({ label: "[click](javascript:evil)" })],
  });
  const text = briefMarkdown(value, { includePrivate: true, now });
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes("<img"));
  assert.ok(text.includes("&lt;script&gt;"));
  assert.ok(text.includes("\\# forged heading"));
  assert.ok(text.includes(`(<${url}>)`));
});

test("50-brief and aggregate byte limits are enforced before the storage mutation", () => {
  const db = storage();
  for (let index = 0; index < 50; index++) create(db, { id: `b-${index}` });
  const before = db.getItem(RESEARCH_BRIEFS_KEY);
  assert.throws(() => create(db, { id: "too-many" }), /up to 50/);
  assert.equal(db.getItem(RESEARCH_BRIEFS_KEY), before);
  const large = {
    version: 1,
    activeId: null,
    briefs: Array.from({ length: 30 }, (_, index) =>
      brief({
        id: `large-${index}`,
        question: "a".repeat(12000),
        thesis: "b".repeat(12000),
        risks: "c".repeat(12000),
        nextSteps: "d".repeat(12000),
      }),
    ),
  };
  assert.throws(() => validateResearchBriefs(large), /1 MiB/);
});

test("adding a selected source excludes unrelated vault text and retains a literal URL", () => {
  const selected = createBriefSource(
    {
      url,
      title: "Saved source",
      text: "Secret company notes",
      capturedAt: now,
      origin: "Disclosures",
    },
    now,
  );
  assert.equal(selected.notes, "");
  assert.equal(selected.url, url);
  assert.equal(selected.origin, "Disclosures");
  assert.ok(!JSON.stringify(selected).includes("Secret company notes"));
});

test("current unsaved draft exports identify their state without claiming a save", () => {
  const value = brief();
  const json = JSON.parse(briefJson(value, { now, unsaved: true }));
  assert.equal(json.content_state, "unsaved-draft");
  const markdown = briefMarkdown(value, { now, unsaved: true });
  assert.ok(markdown.includes("Draft base timestamp:"));
  assert.ok(!markdown.includes("Last saved:"));
});
