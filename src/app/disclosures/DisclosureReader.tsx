"use client";
import { useEffect, useMemo, useState } from "react";
import {
  BookmarkPlus,
  ExternalLink,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { disclosureWordDiff } from "../../utils/disclosureResearch.js";
import {
  highlightParts,
  parseDisclosureQuery,
} from "../../utils/disclosureQuery.js";
import { passageEvidenceId } from "../../utils/disclosureNotebook.js";
import {
  queryParams,
  type Filing,
  type Passage,
  type SearchSettings,
  type DisclosureNotebook,
} from "./disclosureTypes";
import s from "./disclosures.module.css";

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text || "", terms).map((p, i) =>
        p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

export default function DisclosureReader({
  filing,
  settings,
  changesOnly,
  notebook,
  onCollect,
  onLabel,
  onReviewed,
  close,
}: {
  filing: Filing;
  settings: SearchSettings;
  changesOnly: boolean;
  notebook: DisclosureNotebook;
  onCollect: (
    filing: Filing,
    passage: Passage,
    settings: SearchSettings,
    collection: string,
  ) => void;
  onLabel: (id: string, label: string) => void;
  onReviewed?: (filing: Filing) => void;
  close: () => void;
}) {
  const [data, setData] = useState<Filing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [collection, setCollection] = useState(
    notebook.collections[0]?.id || "default",
  );
  const [hideRepeated, setHideRepeated] = useState(changesOnly);
  const terms = useMemo(() => {
    try {
      return parseDisclosureQuery(settings.query).positive;
    } catch {
      return [];
    }
  }, [settings.query]);
  useEffect(() => {
    const abort = new AbortController();
    const params = queryParams(settings);
    params.set("action", "document");
    params.set("ticker", filing.ticker || filing.cik);
    params.set("accession", filing.accession);
    params.set("document", filing.primaryDoc);
    params.set("page", String(page));
    setLoading(true);
    setError("");
    setData(null);
    fetch(`/api/disclosure-research?${params}`, { signal: abort.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Could not open this filing.");
        return result;
      })
      .then((result) => {
        if (!abort.signal.aborted) {
          setData(result);
          if (result.page === 1) onReviewed?.(result);
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    filing.accession,
    filing.cik,
    filing.primaryDoc,
    filing.ticker,
    onReviewed,
    page,
    retry,
    settings,
  ]);
  const passages = (data?.matches || []).filter(
    (p) => !hideRepeated || p.change !== "unchanged",
  );
  const pages = Math.max(
    1,
    Math.ceil((data?.totalPassages || 0) / (data?.pageSize || 12)),
  );
  return (
    <aside className={s.reader} aria-label="Filing evidence reader">
      <div className={s.readerTop}>
        <div>
          <span className={s.eyebrow}>Evidence reader</span>
          <h2>
            {filing.ticker || `CIK ${filing.cik}`} <span>{filing.form}</span>
          </h2>
        </div>
        <button onClick={close} aria-label="Close filing reader">
          <X size={18} />
        </button>
      </div>
      <p className={s.muted}>{filing.companyName}</p>
      <dl className={s.sourceGrid}>
        <div>
          <dt>Filed</dt>
          <dd>{filing.filingDate}</dd>
        </div>
        <div>
          <dt>Reporting period</dt>
          <dd>{filing.reportDate || "Not supplied"}</dd>
        </div>
        <div>
          <dt>Accession</dt>
          <dd>{filing.accession}</dd>
        </div>
        <div>
          <dt>Document</dt>
          <dd>{filing.primaryDoc}</dd>
        </div>
      </dl>
      <a
        className={s.sourceLink}
        href={filing.documentUrl}
        target="_blank"
        rel="noreferrer"
      >
        Original SEC document <ExternalLink size={13} />
      </a>
      {loading && (
        <div role="status" className={s.loading}>
          Reading the filing and checking comparable prior wording…
        </div>
      )}
      {error && (
        <div role="alert" className={s.error}>
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>
            <RefreshCw size={14} /> Retry reader
          </button>
        </div>
      )}
      {data && (
        <>
          <div className={s.readerControls}>
            <label>
              Save evidence to
              <select
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
              >
                {notebook.collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={hideRepeated}
                onChange={(e) => setHideRepeated(e.target.checked)}
              />{" "}
              Hide repeated wording
            </label>
          </div>
          <p className={s.muted}>
            {data.matchCount || 0} matching passages · {data.removedCount || 0}{" "}
            prior passages unmatched in current sections · {data.unchanged || 0}{" "}
            repeated.{" "}
            {data.queryRemovedCount
              ? `${data.queryRemovedCount} prior matches were revised without the query language.`
              : ""}
          </p>
          <details className={s.method}>
            <summary>Comparison & extraction coverage</summary>
            <p>{data.pair?.reason}</p>
            {data.pair?.prior && (
              <p>
                Baseline:{" "}
                <a
                  href={data.pair.prior.documentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {data.pair.prior.form} · period {data.pair.prior.reportDate} ·
                  filed {data.pair.prior.filingDate} ↗
                </a>
                <br />
                {data.pair.prior.accession}
              </p>
            )}
            {data.comparisonError && (
              <p className={s.error}>{data.comparisonError}</p>
            )}
            <p>{data.extraction}</p>
            <p>
              Current sections:{" "}
              {data.sections?.map((x) => x.label).join(", ") ||
                "No recognized headings"}
              . Prior sections:{" "}
              {data.pair?.coverage?.priorSections
                .map((x) => x.label)
                .join(", ") || "Not available"}
              .
            </p>
            <p>
              Changes are paragraph matches, not a legal redline. Punctuation
              and case are normalized. “Added” and “removed” mean unmatched in
              identified sections; moved or split passages can appear as
              changes. Partial amendments do not establish additions or
              removals.
            </p>
          </details>
          {!passages.length && (
            <div className={s.empty}>
              {data.status === "section-unavailable"
                ? data.reason
                : data.totalPassages
                  ? "This page contains only repeated wording. Show it or move to the next page."
                  : "No passage satisfied the full query in the selected scope. An index candidate is not a verified match."}
            </div>
          )}
          {passages.map((passage) => {
            const id = passageEvidenceId(data, passage);
            const reviewed = notebook.labels[id];
            const label = reviewed?.label || passage.label;
            const saved = notebook.collections
              .find((c) => c.id === collection)
              ?.items.some((item) => item.id === id);
            return (
              <article className={s.passage} key={id}>
                <div className={s.row}>
                  <strong>{passage.section}</strong>
                  <span className={s.badge} data-change={passage.change}>
                    {passage.change}
                  </span>
                </div>
                <div className={s.signals}>
                  {passage.reasons.map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))}
                </div>
                {passage.change === "removed" && (
                  <p className={s.muted}>
                    Quotation from the prior filing linked above.
                  </p>
                )}
                <blockquote>
                  <Highlight
                    text={
                      passage.change === "removed"
                        ? passage.priorText || ""
                        : passage.text
                    }
                    terms={terms}
                  />
                </blockquote>
                {(passage.beforeContext || passage.afterContext) && (
                  <details>
                    <summary>Read surrounding paragraphs</summary>
                    {passage.beforeContext && (
                      <p className={s.context}>
                        <Highlight text={passage.beforeContext} terms={terms} />
                      </p>
                    )}
                    <p className={s.muted}>
                      ↑ Before the quoted passage · After the quoted passage ↓
                    </p>
                    {passage.afterContext && (
                      <p className={s.context}>
                        <Highlight text={passage.afterContext} terms={terms} />
                      </p>
                    )}
                  </details>
                )}
                {["revised", "added", "removed"].includes(passage.change) && (
                  <details open={changesOnly}>
                    <summary>Word changes against prior report</summary>
                    <div className={s.diff}>
                      {disclosureWordDiff(
                        passage.priorText || "",
                        passage.text,
                      ).map((part, i) =>
                        part.kind === "removed" ? (
                          <del key={i}>{part.text}</del>
                        ) : part.kind === "added" ? (
                          <ins key={i}>{part.text}</ins>
                        ) : (
                          <span key={i}>{part.text}</span>
                        ),
                      )}
                    </div>
                    <p className={s.muted}>
                      Underlined green = added · struck red = removed
                    </p>
                  </details>
                )}
                <details>
                  <summary>
                    {label} ·{" "}
                    {reviewed?.reviewed
                      ? "analyst reviewed"
                      : "automated, review label"}
                  </summary>
                  <p className={s.muted}>
                    A transparent wording heuristic, not verification of an
                    event or a risk score. Review the full passage and source.
                  </p>
                  <label>
                    Reviewed language label
                    <select
                      value={label}
                      onChange={(e) => onLabel(id, e.target.value)}
                    >
                      {[
                        "Reported-event wording",
                        "Hypothetical wording",
                        "Mixed language",
                        "Unclassified wording",
                      ].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => onLabel(id, label)}>
                    Confirm this label
                  </button>
                </details>
                <button
                  className={s.collectButton}
                  disabled={saved}
                  onClick={() =>
                    onCollect(data, { ...passage, label }, settings, collection)
                  }
                >
                  <BookmarkPlus size={15} />{" "}
                  {saved ? "Saved to collection" : "Save this passage"}
                </button>
              </article>
            );
          })}
          {pages > 1 && (
            <div className={s.pagination}>
              <button
                disabled={page <= 1}
                onClick={() => setPage((n) => n - 1)}
              >
                <ChevronLeft size={15} /> Previous
              </button>
              <span>
                Passage page {page} / {pages}
              </span>
              <button
                disabled={page >= pages}
                onClick={() => setPage((n) => n + 1)}
              >
                Next <ChevronRight size={15} />
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}
