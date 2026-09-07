"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import {
  QUERY_COACH_EXAMPLE,
  inspectDisclosureQuery,
  testDisclosureSample,
} from "../../utils/disclosureQueryCoach.js";
import s from "./DisclosureQueryCoach.module.css";

type Trace = {
  id: string;
  kind: string;
  label: string;
  passed: boolean;
  excluded: boolean;
  count?: number;
  children: Trace[];
};

function TraceNode({ node }: { node: Trace }) {
  return (
    <li>
      <div className={s.traceLine}>
        <span className={node.passed ? s.pass : s.fail}>
          {node.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
          {node.kind === "term"
            ? node.passed
              ? "Present"
              : "Absent"
            : node.passed
              ? "Satisfied"
              : "Not satisfied"}
        </span>
        <span>
          {node.label}
          {node.kind === "term" && (
            <small>
              {` · ${node.count} occurrence${node.count === 1 ? "" : "s"}`}
              {node.excluded ? " · within a negated condition" : ""}
            </small>
          )}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TraceNode key={child.id} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function DisclosureQueryCoach({
  query,
  scope,
  onQueryChange,
}: {
  query: string;
  scope: "paragraph" | "document";
  onQueryChange: (query: string) => void;
}) {
  const [sample, setSample] = useState("");
  const [unitIndex, setUnitIndex] = useState(0);
  const inspection = useMemo(() => inspectDisclosureQuery(query), [query]);
  const result = useMemo(
    () => testDisclosureSample(query, sample, scope),
    [query, sample, scope],
  );
  const selected = result.units[Math.min(unitIndex, result.units.length - 1)];
  return (
    <div className={s.coach}>
      <div
        className={s.feedback}
        aria-live="polite"
        id="disclosure-query-feedback"
      >
        {inspection.valid ? (
          <span className={s.pass}>
            <CheckCircle2 size={14} /> Syntax ready ·{" "}
            {inspection.parsed?.terms.length} term
            {inspection.parsed?.terms.length === 1 ? "" : "s"} ·{" "}
            {scope === "paragraph"
              ? "same paragraph"
              : "selected document text"}
          </span>
        ) : (
          <span className={s.fail}>
            <CircleHelp size={14} /> {inspection.error}
          </span>
        )}
      </div>
      <details className={s.details}>
        <summary>Understand & test this query</summary>
        <div className={s.body}>
          <h3>What the search requires</h3>
          {inspection.valid ? (
            <p className={s.explanation}>{inspection.explanation}</p>
          ) : (
            <p>Correct the syntax above to see the search logic.</p>
          )}
          <p className={s.hint}>
            Uppercase AND requires both conditions; OR accepts either; NOT
            reverses the condition that follows it. Parentheses control groups.
            Adjacent words mean AND, commas mean OR, and quotes keep a phrase
            together. Literal, case-insensitive matching does not infer meaning:
            “no waiver” still contains “waiver”.
          </p>
          <div className={s.sampleHeader}>
            <h3>Try a passage before searching</h3>
            <button
              type="button"
              onClick={() => {
                onQueryChange(QUERY_COACH_EXAMPLE.query);
                setSample(QUERY_COACH_EXAMPLE.text);
                setUnitIndex(0);
              }}
            >
              Load example query & text
            </button>
          </div>
          <label>
            Sample text · processed only in this browser
            <textarea
              aria-label="Query test sample"
              rows={4}
              value={sample}
              maxLength={30000}
              placeholder="Paste a passage here. Separate paragraphs with a blank line."
              onChange={(event) => {
                setSample(event.target.value);
                setUnitIndex(0);
              }}
            />
          </label>
          <p className={s.hint}>
            This test sends no SEC request and does not save your sample. It
            checks words and Boolean logic only. Filing, date, company, and
            section coverage must still be verified in actual results. Blank
            lines separate sample paragraphs.
          </p>
          {result.units.length > 0 && (
            <div className={s.sampleResults}>
              <div className={s.sampleHeader}>
                <strong role="status">
                  {scope === "paragraph"
                    ? `${result.matched} of ${result.units.length} sample paragraphs match`
                    : result.matched
                      ? "Sample document text matches"
                      : "Sample document text does not match"}
                </strong>
                <button
                  type="button"
                  onClick={() => {
                    setSample("");
                    setUnitIndex(0);
                  }}
                >
                  Clear sample
                </button>
              </div>
              {result.units.length > 1 && (
                <label>
                  Inspect sample paragraph
                  <select
                    value={selected?.id ?? 0}
                    onChange={(event) =>
                      setUnitIndex(Number(event.target.value))
                    }
                  >
                    {result.units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        Paragraph {unit.id + 1} ·{" "}
                        {unit.passed ? "matches" : "does not match"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selected && (
                <>
                  <p className={s.passage}>
                    {selected.parts.map((part, index) =>
                      part.match ? (
                        <mark key={index}>{part.text}</mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </p>
                  <p className={s.hint}>
                    Highlights show every query term, including exclusions. A
                    missing alternative can still satisfy an OR group; a
                    satisfied exclusion requires its entire condition to be
                    false.
                  </p>
                  <ul className={s.trace} aria-label="Query condition results">
                    <TraceNode node={selected.trace} />
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
