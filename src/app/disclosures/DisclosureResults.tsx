"use client";
import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
} from "lucide-react";
import { parseDisclosureQuery } from "../../utils/disclosureQuery.js";
import { filingEvidenceId } from "../../utils/disclosureNotebook.js";
import {
  buildDisclosureResults,
  defaultDisclosureResultFilters,
  disclosurePreviewText,
  disclosureResultPreviews,
  disclosureReviewId,
  exportDisclosureResultsCsv,
} from "../../utils/disclosureResults.js";
import { Highlight } from "./DisclosureReader";
import { downloadDisclosure } from "./DisclosureLibrary";
import type { Filing, SearchSettings } from "./disclosureTypes";
import s from "./disclosures.module.css";
import r from "./DisclosureResults.module.css";

type Filters = ReturnType<typeof defaultDisclosureResultFilters>;
export default function DisclosureResults({
  filings,
  settings,
  changesOnly,
  reviewedFilings = {},
  onReview,
  open,
  onVerifyCandidates,
  selectedId,
  busy = false,
}: {
  filings: Filing[];
  settings: SearchSettings;
  changesOnly: boolean;
  reviewedFilings?: Record<string, string>;
  onReview: (id: string, reviewed: boolean) => void;
  open: (
    filing: Filing,
    settings: SearchSettings,
    passage?: { index: number; side: "current" | "prior" },
  ) => void;
  onVerifyCandidates?: () => void;
  selectedId?: string;
  busy?: boolean;
}) {
  const [filters, setFilters] = useState(defaultDisclosureResultFilters);
  const [visibleCount, setVisibleCount] = useState(24);
  const terms = useMemo(() => {
    try {
      return parseDisclosureQuery(settings.query).positive;
    } catch {
      return [];
    }
  }, [settings.query]);
  const model = useMemo(
    () =>
      buildDisclosureResults(
        filings,
        filters,
        settings,
        reviewedFilings,
        changesOnly,
      ),
    [filings, filters, settings, reviewedFilings, changesOnly],
  );
  function patch(key: keyof Filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setVisibleCount(24);
  }
  const facetLabels = {
    scope: "Document coverage",
    company: "Company",
    form: "Filing form",
    change: "Language change",
    language: "Automated wording",
    review: "My review queue",
  };
  const activeFilters = Object.entries(filters).some(
    ([key, value]) => value !== defaultDisclosureResultFilters()[key],
  );
  return (
    <>
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>
            {changesOnly ? "Disclosure changes" : "Research results"}
          </span>
          <h2>{model.results.length} documents in view</h2>
          <p className={s.muted} aria-live="polite">
            {model.summary.verified} successfully searched ·{" "}
            {model.summary.candidates} unverified candidates ·{" "}
            {model.summary.gaps} with coverage gaps
          </p>
        </div>
        <div className={r.actions}>
          {onVerifyCandidates &&
            filings.some((f) =>
              ["index-candidate", "fetch-failed"].includes(f.status || ""),
            ) && (
              <button disabled={busy} onClick={onVerifyCandidates}>
                <RefreshCw size={14} /> Retry / verify next 12
              </button>
            )}
          <button
            disabled={!model.results.length}
            onClick={() =>
              downloadDisclosure(
                "disclosure-result-manifest.csv",
                exportDisclosureResultsCsv(
                  model.results,
                  settings,
                  reviewedFilings,
                  { ...filters, changesOnly },
                ),
                "text/csv;charset=utf-8",
              )
            }
          >
            <Download size={14} /> Export filtered manifest (
            {model.results.length})
          </button>
        </div>
      </div>
      <div className={r.filters}>
        <label>
          Sort evidence
          <select
            value={filters.sort}
            onChange={(e) => patch("sort", e.target.value)}
          >
            <option value="relevance">Evidence relevance</option>
            <option value="date">Newest filing</option>
            <option value="added">Newly added language</option>
            <option value="section">Recognized section</option>
            <option value="proximity">Term proximity</option>
            <option value="specificity">Amounts & dates</option>
          </select>
        </label>
        <label>
          My review queue
          <select
            value={filters.review}
            onChange={(e) => patch("review", e.target.value)}
          >
            {model.facets.review.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} ({f.count})
              </option>
            ))}
          </select>
        </label>
        <label className={r.previewFilter}>
          <span>
            <Search size={12} /> Filter loaded preview text
          </span>
          <input
            type="search"
            placeholder="Phrase within the displayed excerpts"
            value={filters.text}
            onChange={(e) => patch("text", e.target.value)}
            aria-describedby="disclosure-preview-filter-help"
          />
        </label>
      </div>
      <p id="disclosure-preview-filter-help" className={r.help}>
        Preview filtering checks up to three loaded excerpts per document. Run
        the main search to search full filing text. Counts below honor your
        other filters; coverage gaps may overlap successfully searched documents
        when the baseline failed.
      </p>
      <details className={r.refine} open={activeFilters || undefined}>
        <summary>Refine company, form, coverage & wording</summary>
        <div className={r.filters}>
          {(["scope", "company", "form", "change", "language"] as const).map(
            (key) => (
              <label key={key}>
                {facetLabels[key]}
                <select
                  value={filters[key]}
                  onChange={(e) => patch(key, e.target.value)}
                >
                  {model.facets[key].map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label} ({f.count})
                    </option>
                  ))}
                </select>
              </label>
            ),
          )}
        </div>
      </details>
      <div className={r.queue}>
        <p>
          {model.summary.personallyReviewed} of {model.summary.verified}{" "}
          searched documents reviewed by you for this query and evidence
          version. Review marks are saved in this browser.
        </p>
        {activeFilters && (
          <button
            onClick={() => {
              setFilters(defaultDisclosureResultFilters());
              setVisibleCount(24);
            }}
          >
            Reset result filters
          </button>
        )}
      </div>
      <p className={r.help}>
        Ranking reflects term proximity, recognized sections, and concrete
        amounts or dates. Automated wording labels require source review;
        neither labels nor rank measure risk.
      </p>
      {changesOnly && (
        <p className={r.help}>
          Repeated wording is suppressed in the default view. “No longer matches
          query” may include a revised passage whose text still exists.
          Candidates await verification before change claims can be made.
        </p>
      )}
      {!model.results.length && (
        <div className={s.empty}>
          {busy
            ? "Completed searches will appear as each company finishes."
            : "No documents meet these result filters. Reset the filters or inspect coverage gaps before concluding that disclosure is absent."}
        </div>
      )}
      {model.results.slice(0, visibleCount).map((filing) => {
        const id = filingEvidenceId(filing);
        const reviewId = disclosureReviewId(filing, settings);
        const reviewedAt = reviewedFilings[reviewId];
        const candidate = filing.status === "index-candidate";
        const searched = filing.status === "reviewed";
        const previews = disclosureResultPreviews(filing);
        return (
          <article
            key={id}
            className={`${s.resultCard} ${r.card}`}
            data-selected={selectedId === id}
          >
            <button
              className={`${s.resultOpen} ${r.heading}`}
              onClick={() => open(filing, settings)}
              aria-label={`Read ${filing.ticker} ${filing.form} filed ${filing.filingDate}`}
            >
              <div className={s.row}>
                <strong>
                  {filing.ticker} <span>{filing.form}</span>
                </strong>
                <span className={s.muted}>Filed {filing.filingDate}</span>
              </div>
              <p className={s.companyName}>{filing.companyName}</p>
              <div
                className={r.coverage}
                data-state={
                  candidate ? "candidate" : searched ? "searched" : "gap"
                }
              >
                {candidate
                  ? "Index candidate · filing text not yet verified"
                  : searched
                    ? `${filing.matchCount || 0} matching passages in the searched scope`
                    : filing.status === "section-unavailable"
                      ? "Requested section unavailable"
                      : "Filing text not successfully searched"}
              </div>
              <div className={s.resultMeta}>
                <span>
                  Reporting period {filing.reportDate || "not provided"}
                </span>
                {settings.mode === "index" && <span>{filing.primaryDoc}</span>}
              </div>
            </button>
            <div className={r.body}>
              <div className={r.changes}>
                {(filing.additions || 0) > 0 && (
                  <span>{filing.additions} added</span>
                )}
                {(filing.revisions || 0) > 0 && (
                  <span>{filing.revisions} revised</span>
                )}
                {(filing.removedCount || 0) > 0 && (
                  <span>{filing.removedCount} removed</span>
                )}
                {(filing.queryRemovedCount || 0) > 0 && (
                  <span>{filing.queryRemovedCount} no longer match query</span>
                )}
                {(filing.unchanged || 0) > 0 && (
                  <span>{filing.unchanged} repeated</span>
                )}
              </div>
              {filing.reason && <p className={r.problem}>{filing.reason}</p>}
              {filing.comparisonError && (
                <p className={r.problem}>
                  Comparison gap: {filing.comparisonError}
                </p>
              )}
              {searched && !filing.pair?.prior && !filing.comparisonError && (
                <p className={r.help}>
                  Baseline:{" "}
                  {filing.pair?.reason ||
                    "No comparable earlier filing was available in this search."}
                </p>
              )}
              {candidate && (
                <p className={r.help}>
                  An SEC index hit does not verify the selected section, exact
                  Boolean query, or changed wording. Open this document to
                  verify it.
                </p>
              )}
              {previews.map((passage) => (
                <button
                  key={`${passage.change === "removed" ? "prior" : "current"}:${passage.index}`}
                  className={r.passage}
                  onClick={() =>
                    open(filing, settings, {
                      index: passage.index,
                      side: passage.change === "removed" ? "prior" : "current",
                    })
                  }
                >
                  <span className={r.passageMeta}>
                    <span>
                      {passage.section || "Section not identified"} ·{" "}
                      {passage.change === "removed"
                        ? "Prior filing"
                        : "Current filing"}
                    </span>
                    <span>{passage.change}</span>
                  </span>
                  <span className={r.quote}>
                    <Highlight
                      text={disclosurePreviewText(passage)}
                      terms={terms}
                    />
                    {passage.previewTruncated ? "…" : ""}
                  </span>
                  <span className={r.passageMeta}>
                    <span>
                      {passage.label || "Unclassified wording"} · automated
                    </span>
                    <span>
                      Read this passage <ArrowUpRight size={12} />
                    </span>
                  </span>
                </button>
              ))}
              {searched && !previews.length && (
                <p className={r.help}>
                  {filing.matched
                    ? "Matching text is available in the reader."
                    : "The extracted text was searched successfully; no current passages matched this query and section."}
                </p>
              )}
              {searched && filing.signals && (
                <details className={r.ranking}>
                  <summary>Why this evidence ranks here</summary>
                  <p>
                    {filing.signals.recognized || 0} matching excerpts in
                    recognized sections; {filing.signals.concrete || 0} with
                    amounts or dates.
                    {filing.signals.closestTerms != null
                      ? ` Closest matching terms: ${filing.signals.closestTerms} words apart.`
                      : " Term proximity is unavailable."}{" "}
                    Ranking uses signals from all matching excerpts, including
                    those beyond these previews.
                  </p>
                </details>
              )}
              <div className={r.footer}>
                <button onClick={() => open(filing, settings)}>
                  {candidate
                    ? "Verify & read document"
                    : searched
                      ? "Open evidence reader"
                      : "Retry in reader"}
                  <ArrowUpRight size={14} />
                </button>
                {searched && (
                  <button
                    aria-pressed={Boolean(reviewedAt)}
                    onClick={() => onReview(reviewId, !reviewedAt)}
                  >
                    {reviewedAt ? <CheckCircle2 size={14} /> : null}
                    {reviewedAt ? "Reviewed by me · undo" : "Mark reviewed"}
                  </button>
                )}
              </div>
              {reviewedAt && searched && (
                <small>
                  Reviewed {new Date(reviewedAt).toLocaleString()}. New query or
                  evidence changes reopen review.
                </small>
              )}
            </div>
          </article>
        );
      })}
      {model.results.length > visibleCount && (
        <button
          className={s.loadMore}
          onClick={() => setVisibleCount((n) => n + 24)}
        >
          Show {Math.min(24, model.results.length - visibleCount)} more
          documents ({model.results.length - visibleCount} remaining)
        </button>
      )}
    </>
  );
}
