export const ANALYSIS_QUESTION_LIMIT = 30;
export const ANALYSIS_QUESTION_EVIDENCE_LIMIT = 20;
export const ANALYSIS_QUESTION_STATUSES = ["open", "in-progress", "resolved"];

const object = (value) =>
  value != null && typeof value === "object" && !Array.isArray(value);
const iso = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const requireValid = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Reject invalid imports rather than silently removing a researcher's work. */
export function validateAnalysisQuestion(question, validateEvidence) {
  requireValid(object(question), "A research question must be an object.");
  requireValid(
    typeof question.id === "string" &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(question.id),
    "A research question ID is invalid.",
  );
  requireValid(
    typeof question.title === "string" &&
      question.title.trim().length > 0 &&
      question.title.length <= 240,
    "Research questions need a title of up to 240 characters.",
  );
  requireValid(
    typeof question.conclusion === "string" &&
      question.conclusion.length <= 12000,
    "Research conclusions must be text of up to 12,000 characters.",
  );
  requireValid(
    ANALYSIS_QUESTION_STATUSES.includes(question.status),
    "A research question status is invalid.",
  );
  requireValid(
    iso(question.updatedAt) &&
      (question.reviewedAt === undefined || iso(question.reviewedAt)),
    "Research question dates are invalid.",
  );
  requireValid(
    Array.isArray(question.evidence) &&
      question.evidence.length <= ANALYSIS_QUESTION_EVIDENCE_LIMIT,
    "A question supports up to 20 evidence snapshots.",
  );
  for (const entry of question.evidence) {
    requireValid(
      object(entry) && typeof entry.label === "string" && object(entry.point),
      "A question contains invalid financial evidence.",
    );
    requireValid(
      entry.point.value == null ||
        (typeof entry.point.value === "number" &&
          Number.isFinite(entry.point.value)),
      "Question evidence contains an invalid financial value.",
    );
    if (validateEvidence) validateEvidence(entry);
  }
  return question;
}

export function validateAnalysisQuestions(questions, validateEvidence) {
  requireValid(
    Array.isArray(questions) && questions.length <= ANALYSIS_QUESTION_LIMIT,
    "A company supports up to 30 research questions.",
  );
  const ids = new Set();
  for (const question of questions) {
    validateAnalysisQuestion(question, validateEvidence);
    requireValid(
      !ids.has(question.id),
      "Research question IDs must be unique.",
    );
    ids.add(question.id);
  }
  return questions;
}

export const questionRevision = (question) =>
  question ? JSON.stringify(question) : "";
export const questionEvidenceId = (entry) =>
  JSON.stringify([
    entry.analysisId || "",
    entry.label,
    entry.point,
    entry.analysisSettings || null,
    entry.collectedAt || "",
  ]);

/** Deep copies preserve the evidence even when the notebook item is later removed or re-collected. */
export function questionEvidenceSnapshot(entry) {
  if (!object(entry) || !object(entry.point))
    throw new Error("Choose collected financial evidence.");
  return JSON.parse(JSON.stringify(entry));
}

/** Apply against the latest stored list; never overwrite an independently edited question. */
export function updateAnalysisQuestion(questions, action) {
  const current = Array.isArray(questions) ? questions : [];
  const found = current.find((question) => question.id === action.id);
  if (
    action.type !== "add" &&
    (!found || questionRevision(found) !== action.expectedRevision)
  ) {
    return {
      ok: false,
      questions: current,
      reason:
        "This question changed in another tab. Your draft is kept. Load the saved version before editing it again.",
    };
  }
  if (action.type === "remove")
    return {
      ok: true,
      questions: current.filter((question) => question.id !== action.id),
      reason: "Question removed.",
    };
  if (
    action.type === "add" &&
    (found || current.length >= ANALYSIS_QUESTION_LIMIT)
  )
    return {
      ok: false,
      questions: current,
      reason: found
        ? "This question was already saved."
        : "A company can have up to 30 research questions. Remove one before adding another.",
    };
  try {
    validateAnalysisQuestion(action.question);
  } catch (error) {
    return { ok: false, questions: current, reason: error.message };
  }
  if (action.question.id !== action.id)
    return {
      ok: false,
      questions: current,
      reason: "Question identity does not match.",
    };
  return {
    ok: true,
    questions:
      action.type === "add"
        ? [...current, action.question]
        : current.map((question) =>
            question.id === action.id ? action.question : question,
          ),
    reason: "Question and evidence saved.",
  };
}

export function questionEvidenceContext(entry, settings, period) {
  const evidencePeriod = entry.point?.period || {};
  const basis =
    entry.analysisSettings?.basis ||
    evidencePeriod.kind ||
    "Basis not recorded";
  const cutoff =
    typeof entry.analysisSettings?.asOf === "string"
      ? entry.analysisSettings.asOf || "Latest available when collected"
      : evidencePeriod.asOf || "Cutoff not recorded";
  const differentPeriod = Boolean(
    evidencePeriod.end && evidencePeriod.end !== period?.end,
  );
  const differentBasis =
    basis !== "Basis not recorded" && basis !== settings.basis;
  const originalAsOf = entry.analysisSettings?.asOf ?? evidencePeriod.asOf;
  const differentCutoff =
    originalAsOf != null && originalAsOf !== (settings.asOf || "");
  return {
    basis,
    cutoff,
    end: evidencePeriod.end || "Period not recorded",
    differentPeriod,
    differentBasis,
    differentCutoff,
    savedAt: entry.collectedAt || "",
  };
}

export function analysisQuestionStarters(lens) {
  return lens === "bank"
    ? [
        "What explains the change in earnings?",
        "How are loan growth and deposit funding changing?",
        "What does the reserve evidence show?",
        "Which reporting gaps still need a filing review?",
      ]
    : lens === "insurance"
      ? [
          "What explains the change in earnings?",
          "How is the balance sheet funding the business?",
          "Which underwriting or reserve disclosures need review?",
          "Which reporting gaps still need a filing review?",
        ]
      : [
          "Is earnings growth translating into operating cash?",
          "What explains the change in earnings per share?",
          "How is the company funding investment and shareholder returns?",
          "Which reporting gaps still need a filing review?",
        ];
}
