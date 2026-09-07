import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAnalysisQuestions,
  questionRevision,
  questionEvidenceSnapshot,
  questionEvidenceContext,
  updateAnalysisQuestion,
} from "../src/utils/analysisQuestions.js";

const question = (id = "question-one", extra = {}) => ({
  id,
  title: "Is growth turning into cash?",
  conclusion: "Review cash conversion.",
  status: "open",
  evidence: [],
  updatedAt: "2026-09-07T10:00:00.000Z",
  ...extra,
});
const evidence = () => ({
  label: "Operating cash flow",
  analysisId: "stable",
  format: "currency",
  analysisSettings: { basis: "annual", asOf: "2025-03-01" },
  collectedAt: "2025-03-02T10:00:00Z",
  point: {
    value: 150,
    period: { kind: "annual", start: "2024-01-01", end: "2024-12-31" },
    sources: [
      {
        value: 150,
        tag: "NetCashProvidedByUsedInOperatingActivities",
        filed: "2025-02-01",
        accession: "0000000001-25-000001",
      },
    ],
  },
});

test("Question evidence is an independent deep snapshot with original cutoff and sources", () => {
  const original = evidence();
  const saved = questionEvidenceSnapshot(original);
  original.point.value = 200;
  original.point.sources[0].accession = "replacement";
  original.analysisSettings.asOf = "2026-01-01";
  assert.equal(saved.point.value, 150);
  assert.equal(saved.point.sources[0].accession, "0000000001-25-000001");
  assert.equal(saved.analysisSettings.asOf, "2025-03-01");
  const context = questionEvidenceContext(
    saved,
    { basis: "quarter", asOf: "" },
    { end: "2025-12-31" },
  );
  assert.equal(context.differentPeriod, true);
  assert.equal(context.differentBasis, true);
  assert.equal(context.differentCutoff, true);
  assert.equal(context.cutoff, "2025-03-01");
});

test("Question edits apply to current storage without discarding other questions", () => {
  const old = question();
  const other = question("question-two");
  const edited = question("question-one", {
    conclusion: "Cash supports the finding.",
    status: "resolved",
    reviewedAt: "2026-09-07T12:00:00Z",
  });
  const result = updateAnalysisQuestion([old, other], {
    type: "edit",
    id: old.id,
    expectedRevision: questionRevision(old),
    question: edited,
  });
  assert.equal(result.ok, true);
  assert.equal(result.questions[0].conclusion, edited.conclusion);
  assert.deepEqual(result.questions[1], other);
  assert.equal(
    updateAnalysisQuestion(result.questions, {
      type: "remove",
      id: old.id,
      expectedRevision: questionRevision(edited),
    }).questions.length,
    1,
  );
});

test("Concurrent edits and deletes preserve latest saved work and reject stale drafts", () => {
  const original = question();
  const newer = question("question-one", {
    conclusion: "Newer external conclusion.",
  });
  for (const type of ["edit", "remove"]) {
    const result = updateAnalysisQuestion([newer], {
      type,
      id: original.id,
      expectedRevision: questionRevision(original),
      question: original,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.questions, [newer]);
    assert.match(result.reason, /another tab/);
  }
  assert.equal(
    updateAnalysisQuestion([], {
      type: "edit",
      id: original.id,
      expectedRevision: questionRevision(original),
      question: original,
    }).ok,
    false,
  );
});

test("Question imports reject invalid statuses, duplicate identities, invalid evidence and oversized lists", () => {
  for (const invalid of [
    question("one", { status: "approved" }),
    question("one", { title: " " }),
    question("one", { updatedAt: "yesterday" }),
    question("one", {
      evidence: [{ label: "Invalid", point: { value: Infinity } }],
    }),
    question("one", { evidence: Array.from({ length: 21 }, evidence) }),
  ])
    assert.throws(() => validateAnalysisQuestions([invalid]));
  assert.throws(
    () => validateAnalysisQuestions([question(), question()]),
    /unique/,
  );
  assert.throws(
    () =>
      validateAnalysisQuestions(
        Array.from({ length: 31 }, (_, i) => question(`question-${i}`)),
      ),
    /30/,
  );
  let validated = 0;
  validateAnalysisQuestions(
    [question("one", { evidence: [evidence()] })],
    (entry) => {
      assert.equal(entry.point.value, 150);
      validated++;
    },
  );
  assert.equal(validated, 1);
  const full = Array.from({ length: 30 }, (_, i) => question(`question-${i}`));
  assert.equal(
    updateAnalysisQuestion(full, {
      type: "add",
      id: "new",
      question: question("new"),
    }).ok,
    false,
  );
});
