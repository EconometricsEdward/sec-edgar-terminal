import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisNotesDirty,
  createAnalysisNotesDraft,
  editAnalysisNotesDraft,
  observeAnalysisNotes,
  persistAnalysisNotes,
} from "../src/utils/analysisNotes.js";
import {
  emptyWorkspace,
  writeWorkspace,
} from "../src/utils/researchWorkspace.js";

function store(initial = emptyWorkspace()) {
  let raw = JSON.stringify(initial);
  let writes = 0;
  const storage = {
    getItem: () => raw,
    setItem: (_, value) => {
      raw = value;
      writes++;
    },
  };
  return {
    update: (fn) => {
      try {
        writeWorkspace(storage, fn);
        return true;
      } catch {
        return false;
      }
    },
    read: () => JSON.parse(raw),
    external: (value) => {
      raw = JSON.stringify(value);
    },
    writes: () => writes,
  };
}

test("opening notes or reverting an unsaved empty draft does not create a saved company", () => {
  const storage = store();
  const loaded = observeAnalysisNotes(createAnalysisNotesDraft("", false), "");
  assert.equal(loaded.ready, true);
  assert.equal(analysisNotesDirty(loaded), false);
  const reverted = editAnalysisNotesDraft(
    editAnalysisNotesDraft(loaded, "draft"),
    "",
  );
  assert.equal(analysisNotesDirty(reverted), false);
  const result = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: reverted.notes,
    expectedNotes: reverted.savedNotes,
  });
  assert.equal(result.ok, true);
  assert.equal(storage.writes(), 0);
  assert.deepEqual(storage.read(), emptyWorkspace());
});

test("the notes write preserves fresh evidence, metadata, saved state, peers, and other companies", () => {
  const evidence = [{ id: "new-evidence", notes: "Own evidence note" }];
  const baseline = { period: "2026-06-30" };
  const storage = store({
    version: 1,
    companies: {
      JPM: {
        ticker: "JPM",
        name: "Stored company name",
        saved: false,
        notes: "old",
        evidence,
        analysisBaseline: baseline,
      },
      AAPL: { notes: "Other company" },
    },
    peerGroups: [{ name: "Banks", tickers: ["JPM", "BAC"] }],
  });
  assert.equal(
    persistAnalysisNotes(storage.update, {
      ticker: "JPM",
      name: "Rendered company name",
      cik: "19617",
      notes: "new",
      expectedNotes: "old",
    }).ok,
    true,
  );
  const result = storage.read();
  assert.equal(result.companies.JPM.notes, "new");
  assert.equal(result.companies.JPM.name, "Stored company name");
  assert.equal(result.companies.JPM.saved, false);
  assert.deepEqual(result.companies.JPM.evidence, evidence);
  assert.deepEqual(result.companies.JPM.analysisBaseline, baseline);
  assert.deepEqual(result.companies.AAPL, { notes: "Other company" });
  assert.deepEqual(result.peerGroups, [
    { name: "Banks", tickers: ["JPM", "BAC"] },
  ]);
});

test("a stale tab cannot overwrite new notes even before its storage event is delivered", () => {
  const storage = store({
    ...emptyWorkspace(),
    companies: { JPM: { notes: "Another tab" } },
  });
  const result = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: "Local draft",
    expectedNotes: "Original",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflictNotes, "Another tab");
  assert.equal(storage.read().companies.JPM.notes, "Another tab");
  const draft = observeAnalysisNotes(
    editAnalysisNotesDraft(createAnalysisNotesDraft("Original"), "Local draft"),
    "Another tab",
  );
  assert.equal(draft.notes, "Local draft");
  assert.equal(draft.status, "conflict");
  assert.equal(
    editAnalysisNotesDraft(draft, "Continue editing").status,
    "conflict",
  );
});

test("conflict resolution checks the last shown saved value and detects a second external edit", () => {
  const storage = store({
    ...emptyWorkspace(),
    companies: { JPM: { notes: "Third version" } },
  });
  const staleResolution = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: "Local draft",
    expectedNotes: "Second version",
  });
  assert.equal(staleResolution.status, "conflict");
  assert.equal(storage.read().companies.JPM.notes, "Third version");
  const approvedResolution = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: "Local draft",
    expectedNotes: staleResolution.conflictNotes,
  });
  assert.equal(approvedResolution.ok, true);
  assert.equal(storage.read().companies.JPM.notes, "Local draft");
});

test("reverting a conflicted draft to the original text still protects it from the newer saved value", () => {
  const draft = observeAnalysisNotes(
    editAnalysisNotesDraft(createAnalysisNotesDraft("Original"), "Local"),
    "External",
  );
  const reverted = editAnalysisNotesDraft(draft, "Original");
  assert.equal(analysisNotesDirty(reverted), true);
  assert.equal(reverted.status, "conflict");
  assert.equal(
    observeAnalysisNotes(reverted, "External again").notes,
    "Original",
  );
  const resolved = editAnalysisNotesDraft(reverted, "External");
  assert.equal(analysisNotesDirty(resolved), false);
  assert.equal(resolved.status, "saved");
});

test("external changes are adopted only with no draft, or when both edits converge", () => {
  const pristine = createAnalysisNotesDraft("Old");
  assert.equal(observeAnalysisNotes(pristine, "External").notes, "External");
  const typing = editAnalysisNotesDraft(pristine, "Shared result");
  const merged = observeAnalysisNotes(typing, "Shared result");
  assert.equal(merged.status, "saved");
  assert.equal(analysisNotesDirty(merged), false);
  const unchanged = observeAnalysisNotes(typing, "Old");
  assert.equal(unchanged.status, "saving");
  assert.equal(unchanged.notes, "Shared result");
});

test("failed storage never acknowledges or discards a draft, and does not schedule an automatic retry", () => {
  const typing = editAnalysisNotesDraft(
    createAnalysisNotesDraft("Original"),
    "Keep this draft",
  );
  const result = persistAnalysisNotes(() => false, {
    ticker: "JPM",
    notes: typing.notes,
    expectedNotes: typing.savedNotes,
  });
  const failed = { ...typing, ...result };
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.notes, "Keep this draft");
  assert.equal(failed.savedNotes, "Original");
  assert.equal(analysisNotesDirty(failed), true);
  assert.equal(observeAnalysisNotes(failed, "Original").status, "unavailable");
});

test("clearing existing notes is a deliberate edit and removing a company elsewhere creates a conflict", () => {
  const storage = store({
    ...emptyWorkspace(),
    companies: { JPM: { notes: "Existing", evidence: [1] } },
  });
  const result = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: "",
    expectedNotes: "Existing",
  });
  assert.equal(result.ok, true);
  assert.equal(storage.read().companies.JPM.notes, "");
  assert.deepEqual(storage.read().companies.JPM.evidence, [1]);
  storage.external(emptyWorkspace());
  const removed = persistAnalysisNotes(storage.update, {
    ticker: "JPM",
    notes: "Still editing",
    expectedNotes: "Existing",
  });
  assert.equal(removed.status, "conflict");
  assert.equal(removed.conflictNotes, "");
  assert.deepEqual(storage.read().companies, {});
});
