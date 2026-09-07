"use client";

import { useState } from "react";
import { BookOpenCheck, Plus, Save, X } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import {
  ANALYSIS_QUESTION_LIMIT,
  ANALYSIS_QUESTION_EVIDENCE_LIMIT,
  ANALYSIS_QUESTION_STATUSES,
  analysisQuestionStarters,
  questionEvidenceContext,
  questionEvidenceId,
  questionEvidenceSnapshot,
  questionRevision,
  updateAnalysisQuestion,
} from "../../utils/analysisQuestions.js";
import styles from "./AnalysisResearchQuestions.module.css";

const statusLabel = (status) =>
  ({ open: "Open", "in-progress": "In progress", resolved: "Resolved by you" })[
    status
  ];

export default function AnalysisResearchQuestions({
  data,
  settings,
  index,
  questions = [],
  evidence = [],
  onSave,
  onInspect,
  ready = true,
}: any) {
  const [draft, setDraft] = useState<any>(null);
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [filter, setFilter] = useState("all");
  const period = data.periods[index];
  const financialEvidence = evidence.filter(
    (entry) => entry?.point && typeof entry.label === "string",
  );
  const start = (question = null, title = "") => {
    setStatus("");
    setConflict(false);
    setDraft(
      question
        ? {
            ...JSON.parse(JSON.stringify(question)),
            original: questionRevision(question),
            isNew: false,
          }
        : {
            id: `question-${crypto.randomUUID()}`,
            title,
            conclusion: "",
            status: "open",
            evidence: [],
            original: "",
            isNew: true,
          },
    );
  };
  const apply = (action) => {
    let result: any;
    const saved = onSave((current) => {
      result = updateAnalysisQuestion(current, action);
      return result.questions;
    });
    setStatus(
      !saved
        ? "Could not save this question. Your draft is kept; try again or copy its text before leaving."
        : result?.reason || "Could not update this question.",
    );
    setConflict(
      Boolean(saved && result && !result.ok && action.type !== "add"),
    );
    return saved && result?.ok;
  };
  const saveDraft = (event) => {
    event.preventDefault();
    const now = new Date().toISOString();
    const question: any = {
      id: draft.id,
      title: draft.title.trim(),
      conclusion: draft.conclusion,
      status: draft.status,
      evidence: draft.evidence.map(questionEvidenceSnapshot),
      updatedAt: now,
    };
    if (draft.status === "resolved") question.reviewedAt = now;
    if (
      apply({
        type: draft.isNew ? "add" : "edit",
        id: draft.id,
        expectedRevision: draft.original,
        question,
      })
    )
      setDraft(null);
  };
  const inspect = (entry) =>
    onInspect?.({
      definition: { label: entry.label, format: entry.format || "currency" },
      point: {
        ...entry.point,
        sources:
          entry.point.sources ||
          (entry.point.source ? [entry.point.source] : []),
      },
      notes: entry.notes || entry.text || "",
      analysisSettings: entry.analysisSettings ?? null,
    });
  const evidenceCard = (entry, removable = false) => {
    const context = questionEvidenceContext(entry, settings, period);
    return (
      <li key={questionEvidenceId(entry)}>
        <div>
          <button
            type="button"
            onClick={() => inspect(entry)}
            disabled={!onInspect}
          >
            {entry.label} ·{" "}
            {analysisValue(
              entry.point?.value,
              entry.format || "currency",
              settings.units,
            )}
          </button>
          <small>
            {context.end} · {context.basis} · original cutoff: {context.cutoff}
          </small>
          {(context.differentPeriod ||
            context.differentBasis ||
            context.differentCutoff) && (
            <small className={styles.context}>
              Saved evidence differs from the current view. Its original figures
              and sources are preserved.
            </small>
          )}
          {context.savedAt && (
            <small>Collected {context.savedAt.slice(0, 10)}</small>
          )}
        </div>
        {removable && (
          <button
            type="button"
            onClick={() =>
              setDraft({
                ...draft,
                evidence: draft.evidence.filter(
                  (item) =>
                    questionEvidenceId(item) !== questionEvidenceId(entry),
                ),
              })
            }
            aria-label={`Detach ${entry.label}`}
          >
            <X size={14} />
          </button>
        )}
      </li>
    );
  };
  const visible = questions.filter(
    (question) => filter === "all" || question.status === filter,
  );
  return (
    <section
      className={styles.board}
      aria-labelledby="analysis-questions-heading"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            Turn observations into a research conclusion
          </p>
          <h3 id="analysis-questions-heading">
            <BookOpenCheck size={20} /> Research question board
          </h3>
        </div>
        <span>
          {questions.length}/{ANALYSIS_QUESTION_LIMIT} questions
        </span>
      </div>
      <p className={styles.description}>
        Keep a question, your conclusion and the exact financial evidence
        together. Questions stay private in this browser until you select them
        for an exported brief. “Resolved” records your judgment; it does not
        verify a conclusion.
      </p>
      {!draft && (
        <>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={!ready || questions.length >= ANALYSIS_QUESTION_LIMIT}
              onClick={() => start()}
            >
              <Plus size={15} /> Add research question
            </button>
            <label>
              Show questions
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                {ANALYSIS_QUESTION_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {questions.length === 0 && (
            <div className={styles.starters}>
              <p>Start with a question that matters to {data.ticker}:</p>
              {analysisQuestionStarters(data.lens).map((title) => (
                <button
                  type="button"
                  key={title}
                  disabled={!ready}
                  onClick={() => start(null, title)}
                >
                  {title}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {draft && (
        <form className={styles.editor} onSubmit={saveDraft}>
          <h4>
            {draft.isNew ? "New research question" : "Edit research question"}
          </h4>
          <label>
            Question
            <input
              required
              maxLength={240}
              value={draft.title}
              onChange={(event) =>
                setDraft({ ...draft, title: event.target.value })
              }
            />
          </label>
          <label>
            Your conclusion or open issue
            <textarea
              rows={4}
              maxLength={12000}
              value={draft.conclusion}
              onChange={(event) =>
                setDraft({ ...draft, conclusion: event.target.value })
              }
              placeholder="What does the evidence support, and what remains uncertain?"
            />
          </label>
          <label>
            Research status
            <select
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value })
              }
            >
              {ANALYSIS_QUESTION_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>
              Attach collected financial evidence ({draft.evidence.length}/
              {ANALYSIS_QUESTION_EVIDENCE_LIMIT})
            </legend>
            <p className={styles.description}>
              Each attachment is a separate saved copy, retaining its original
              reporting period, cutoff and SEC inputs.
            </p>
            {financialEvidence.length ? (
              <div className={styles.choices}>
                {financialEvidence.map((entry) => {
                  const id = questionEvidenceId(entry);
                  const attached = draft.evidence.some(
                    (item) => questionEvidenceId(item) === id,
                  );
                  return (
                    <label className={styles.choice} key={id}>
                      <input
                        type="checkbox"
                        checked={attached}
                        disabled={
                          !attached &&
                          draft.evidence.length >=
                            ANALYSIS_QUESTION_EVIDENCE_LIMIT
                        }
                        onChange={() =>
                          setDraft({
                            ...draft,
                            evidence: attached
                              ? draft.evidence.filter(
                                  (item) => questionEvidenceId(item) !== id,
                                )
                              : [
                                  ...draft.evidence,
                                  questionEvidenceSnapshot(entry),
                                ],
                          })
                        }
                      />
                      <span>
                        {entry.label}
                        <small>
                          {entry.point.period?.end || "Period not recorded"} ·{" "}
                          {analysisValue(
                            entry.point.value,
                            entry.format || "currency",
                            settings.units,
                          )}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className={styles.description}>
                Open a financial figure and choose “Collect this evidence” to
                make it available here. You can save a question before attaching
                evidence.
              </p>
            )}
            <ul className={styles.evidence}>
              {draft.evidence.map((entry) => evidenceCard(entry, true))}
            </ul>
          </fieldset>
          <div className={styles.actions}>
            <button type="submit" disabled={!ready || !draft.title.trim()}>
              <Save size={15} /> Save question
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setStatus("");
                setConflict(false);
              }}
            >
              Cancel edits
            </button>
            {conflict && (
              <button
                type="button"
                onClick={() => {
                  const current = questions.find(
                    (question) => question.id === draft.id,
                  );
                  if (current) start(current);
                  else
                    setStatus(
                      "This question was removed. Copy your draft into a new question if you want to keep it.",
                    );
                }}
              >
                Load saved question
              </button>
            )}
          </div>
          <p className={styles.description}>
            Question edits are saved when you select “Save question.” Notes
            above autosave separately.
          </p>
        </form>
      )}
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}
      <div className={styles.list}>
        {visible.map((question) => (
          <article key={question.id} className={styles.question}>
            <div className={styles.heading}>
              <h4>{question.title}</h4>
              <span>{statusLabel(question.status)}</span>
            </div>
            <p className={styles.conclusion}>
              {question.conclusion || "No conclusion recorded yet."}
            </p>
            <p className={styles.description}>
              Updated {question.updatedAt.slice(0, 10)}
              {question.reviewedAt
                ? ` · resolved by you ${question.reviewedAt.slice(0, 10)}`
                : ""}
            </p>
            {question.evidence.length ? (
              <ul className={styles.evidence}>
                {question.evidence.map((entry) => evidenceCard(entry))}
              </ul>
            ) : (
              <p className={styles.description}>
                No financial evidence attached.
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                disabled={!ready || Boolean(draft)}
                onClick={() => start(question)}
              >
                Edit question
              </button>
              <button
                type="button"
                disabled={!ready || Boolean(draft)}
                onClick={() =>
                  apply({
                    type: "remove",
                    id: question.id,
                    expectedRevision: questionRevision(question),
                  })
                }
              >
                Remove question
              </button>
            </div>
          </article>
        ))}
      </div>
      {questions.length > 0 && visible.length === 0 && (
        <p className={styles.description}>No questions have this status.</p>
      )}
    </section>
  );
}
