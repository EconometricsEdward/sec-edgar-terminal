"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  ExternalLink,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Copy,
  Link2,
} from "lucide-react";
import { disclosureWordDiff } from "../../utils/disclosureResearch.js";
import {
  highlightParts,
  parseDisclosureQuery,
} from "../../utils/disclosureQuery.js";
import { passageEvidenceId } from "../../utils/disclosureNotebook.js";
import {
  disclosureReaderFilters,
  disclosurePassageAnchor,
  disclosurePassageSide,
  disclosureReaderNavigation,
  disclosurePassageCitation,
  makeDisclosurePassageUrl,
} from "../../utils/disclosureReaderState.js";
import {
  queryParams,
  type Filing,
  type Passage,
  type SearchSettings,
  type DisclosureNotebook,
} from "./disclosureTypes";
import s from "./disclosures.module.css";
import r from "./disclosureReader.module.css";
import DisclosureQuantities from "./DisclosureQuantities";

type ReaderFilters = {
  section: string;
  change: string;
  language: string;
  find: string;
};
export type DisclosureReaderState = {
  index?: number;
  side?: string;
  baselineAccession?: string;
  filters?: ReaderFilters;
};
type ReaderFiling = Filing & {
  unfilteredTotalPassages?: number;
  availableSections?: { id: string; label: string }[];
  requestedPassageFound?: boolean;
};

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
  initialState,
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
  onReviewed?: (filing: Filing, settings?: SearchSettings) => void;
  initialState?: DisclosureReaderState;
  close: () => void;
}) {
  const [data, setData] = useState<ReaderFiling | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [collection, setCollection] = useState(
    notebook.collections[0]?.id || "default",
  );
  const [filters, setFilters] = useState<ReaderFilters>(() =>
    disclosureReaderFilters(
      initialState?.filters || { change: changesOnly ? "changed" : "all" },
    ),
  );
  const [findDraft, setFindDraft] = useState(filters.find);
  const [target, setTarget] = useState<{ index: number; side: string } | null>(
    () =>
      Number.isInteger(initialState?.index) && Number(initialState?.index) >= 0
        ? {
            index: Number(initialState?.index),
            side: initialState?.side || "current",
          }
        : null,
  );
  const [activePassage, setActivePassage] = useState(0);
  const [copyNotice, setCopyNotice] = useState("");
  const [copyFallback, setCopyFallback] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const readerRef = useRef<HTMLElement | null>(null);
  const pageFocus = useRef<"first" | "last" | null>("first");
  const displayed = data
    ? { ...data, ticker: filing.ticker || data.ticker }
    : filing;
  const setReaderFilters = (next: Partial<ReaderFilters>) => {
    setTarget(null);
    setPage(1);
    setActivePassage(0);
    setFilters((current) => disclosureReaderFilters({ ...current, ...next }));
  };
  const copy = async (title: string, text: string) => {
    setCopyFallback(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice(`${title} copied.`);
    } catch {
      setCopyNotice(
        "Clipboard access was unavailable. Select and copy the text below.",
      );
      setCopyFallback({ title, text });
    }
  };
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
    params.set("readerSection", filters.section);
    params.set("readerChange", filters.change);
    params.set("readerLanguage", filters.language);
    params.set("readerFind", filters.find);
    if (target) {
      params.set("passageIndex", String(target.index));
      params.set("passageSide", target.side);
    }
    if (initialState?.baselineAccession)
      params.set("baselineAccession", initialState.baselineAccession);
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
          onReviewed?.(result, settings);
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
    filters,
    target,
    initialState?.baselineAccession,
    onReviewed,
    page,
    retry,
    settings,
  ]);
  const passages = data?.matches || [];
  const availableSections = data?.availableSections || [];
  const sectionOptions =
    filters.section !== "all" &&
    !availableSections.some((section) => section.id === filters.section)
      ? [
          ...availableSections,
          {
            id: filters.section,
            label: `${filters.section}${data ? " · no matching passages" : ""}`,
          },
        ]
      : availableSections;
  const currentPage = data?.page || page;
  const pages = Math.max(
    1,
    Math.ceil((data?.totalPassages || 0) / (data?.pageSize || 12)),
  );
  const focusPassage = (index: number) => {
    readerRef.current
      ?.querySelectorAll<HTMLElement>("[data-reader-passage]")
      [index]?.focus();
  };
  const turnPage = (next: number, focus: "first" | "last" = "first") => {
    pageFocus.current = focus;
    setTarget(null);
    setPage(next);
  };
  const movePassage = (direction: -1 | 1) => {
    const next = activePassage + direction;
    if (next >= 0 && next < passages.length) focusPassage(next);
    else if (direction < 0 && currentPage > 1)
      turnPage(currentPage - 1, "last");
    else if (direction > 0 && currentPage < pages) turnPage(currentPage + 1);
  };
  useEffect(() => {
    if (!data) return;
    const elements = readerRef.current?.querySelectorAll<HTMLElement>(
      "[data-reader-passage]",
    );
    if (!elements?.length) return;
    if (target) {
      if (data.requestedPassageFound)
        readerRef.current
          ?.querySelector<HTMLElement>(
            `#disclosure-passage-${target.side}-${target.index}`,
          )
          ?.focus();
      else readerRef.current?.focus();
    } else if (pageFocus.current) {
      elements[pageFocus.current === "last" ? elements.length - 1 : 0]?.focus();
    }
    pageFocus.current = null;
  }, [data, target]);
  useEffect(() => {
    readerRef.current?.focus();
  }, []);
  return (
    <aside
      ref={readerRef}
      tabIndex={-1}
      className={s.reader}
      aria-label="Filing evidence reader"
      aria-busy={loading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (
          (event.target as HTMLElement).closest(
            "input,textarea,select,button,a,summary",
          )
        )
          return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const next = disclosureReaderNavigation(
          event.key,
          (event.target as HTMLElement).closest("[data-reader-passage]")
            ? activePassage
            : -1,
          passages.length,
        );
        if (next !== null) {
          event.preventDefault();
          focusPassage(next);
        }
      }}
    >
      <div className={s.readerTop}>
        <div>
          <span className={s.eyebrow}>Evidence reader</span>
          <h2>
            {displayed.ticker || `CIK ${displayed.cik}`}{" "}
            <span>{displayed.form}</span>
          </h2>
        </div>
        <button onClick={close} aria-label="Close filing reader">
          <X size={18} />
        </button>
      </div>
      <p className={s.muted}>{displayed.companyName}</p>
      <dl className={s.sourceGrid}>
        <div>
          <dt>Filed</dt>
          <dd>{displayed.filingDate || "Loading…"}</dd>
        </div>
        <div>
          <dt>Reporting period</dt>
          <dd>{displayed.reportDate || "Not supplied"}</dd>
        </div>
        <div>
          <dt>Accession</dt>
          <dd>{displayed.accession}</dd>
        </div>
        <div>
          <dt>Document</dt>
          <dd>{displayed.primaryDoc}</dd>
        </div>
      </dl>
      <a
        className={s.sourceLink}
        href={displayed.documentUrl}
        target="_blank"
        rel="noreferrer"
      >
        Original SEC document <ExternalLink size={13} />
      </a>
      <details className={r.filterPanel}>
        <summary>
          Filter all passages{" "}
          <span>
            {Object.values(filters).filter((value) => value && value !== "all")
              .length || "No"}{" "}
            active filters
          </span>
        </summary>
        <form
          className={r.filters}
          aria-label="Filter all filing passages"
          onSubmit={(event) => {
            event.preventDefault();
            setReaderFilters({ find: findDraft });
          }}
        >
          <label>
            Reader section
            <select
              value={filters.section}
              onChange={(event) =>
                setReaderFilters({ section: event.target.value })
              }
            >
              <option value="all">All matching sections</option>
              {sectionOptions.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Passage change
            <select
              value={filters.change}
              onChange={(event) =>
                setReaderFilters({ change: event.target.value })
              }
            >
              {[
                ["all", "All wording"],
                ["changed", "Added, revised or removed"],
                ["added", "Added"],
                ["revised", "Revised"],
                ["removed", "Removed / prior only"],
                ["unchanged", "Repeated"],
                ["unavailable", "Comparison unavailable / unmatched"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Automated language label
            <select
              value={filters.language}
              onChange={(event) =>
                setReaderFilters({ language: event.target.value })
              }
            >
              {[
                "all",
                "Reported-event wording",
                "Hypothetical wording",
                "Mixed language",
                "Unclassified wording",
              ].map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All language" : value}
                </option>
              ))}
            </select>
          </label>
          <label className={r.find}>
            Find literal text in matching quotations
            <div>
              <input
                type="search"
                value={findDraft}
                maxLength={200}
                onChange={(event) => setFindDraft(event.target.value)}
                placeholder="e.g. $200 million"
              />
              <button type="submit">Apply</button>
            </div>
          </label>
          <div className={r.filterFooter}>
            <p>
              Filters cover every matching passage before pagination. Labels are
              wording heuristics.
            </p>
            <button
              type="button"
              onClick={() => {
                setFindDraft("");
                setReaderFilters({
                  section: "all",
                  change: "all",
                  language: "all",
                  find: "",
                });
              }}
            >
              Reset reader filters
            </button>
          </div>
        </form>
      </details>
      <p role="status" aria-live="polite" className={s.muted}>
        {copyNotice}
      </p>
      {copyFallback && (
        <div className={r.copyFallback}>
          <label>
            {copyFallback.title}
            <textarea
              readOnly
              value={copyFallback.text}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button onClick={() => setCopyFallback(null)}>Close copy text</button>
        </div>
      )}
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
          </div>
          {target && data.requestedPassageFound === false && (
            <p role="status" className={s.error}>
              The linked passage was not found within this query and these
              reader filters. Clear the reader filters or review the original
              filing; a different paragraph has not been substituted.
            </p>
          )}
          <p className={s.muted}>
            {data.totalPassages || 0} of{" "}
            {data.unfilteredTotalPassages ?? data.totalPassages ?? 0}{" "}
            query-matching passages remain after reader filters;{" "}
            {data.matches?.length || 0} shown on this page. {data.matchCount || 0}{" "}
            matching passages · {data.removedCount || 0} prior passages
            unmatched in current sections · {data.unchanged || 0} repeated.{" "}
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
              Changes are paragraph matches, not a legal redline. Only case and
              whitespace are normalized for exact matches; signs, decimal
              points, currencies and other punctuation are preserved. “Added”
              and “removed” mean unmatched in identified sections; moved or
              split passages can appear as changes. Partial amendments do not
              establish additions or removals.
            </p>
          </details>
          {!passages.length && (
            <div className={s.empty}>
              {data.status === "section-unavailable"
                ? data.reason
                : data.unfilteredTotalPassages
                  ? "No query-matching passage satisfies these reader filters. Reset the filters to see all matching wording."
                  : "No passage satisfied the full query in the selected scope. An index candidate is not a verified match."}
            </div>
          )}
          {passages.length > 0 && (
            <div className={r.navigation}>
              <button
                onClick={() => movePassage(-1)}
                disabled={activePassage <= 0 && currentPage <= 1}
              >
                <ChevronLeft size={14} /> Previous passage
              </button>
              <button
                onClick={() => movePassage(1)}
                disabled={
                  activePassage >= passages.length - 1 && currentPage >= pages
                }
              >
                Next passage <ChevronRight size={14} />
              </button>
              <p>
                Focus a passage, then use ↑ / ↓ or Home / End within this page.
                Escape closes the reader.
              </p>
            </div>
          )}
          {passages.map((passage, passagePosition) => {
            const id = passageEvidenceId(data, passage);
            const reviewed = notebook.labels[id];
            const label = reviewed?.label || passage.label;
            const saved = notebook.collections
              .find((c) => c.id === collection)
              ?.items.some((item) => item.id === id);
            return (
              <article
                className={`${s.passage} ${r.passage}`}
                key={id}
                id={disclosurePassageAnchor(passage)}
                data-reader-passage
                tabIndex={0}
                aria-label={`${passage.section}, ${passage.change}, ${disclosurePassageSide(passage)} extracted paragraph ${passage.index + 1}`}
                onFocus={() => setActivePassage(passagePosition)}
              >
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
                <div className={r.actions}>
                  <button
                    onClick={() => {
                      try {
                        void copy(
                          "Passage link",
                          makeDisclosurePassageUrl({
                            filing: displayed,
                            passage,
                            settings,
                            filters,
                            origin: window.location.origin,
                          }),
                        );
                      } catch (error) {
                        setCopyNotice(
                          error instanceof Error
                            ? error.message
                            : "Could not create a source link.",
                        );
                      }
                    }}
                  >
                    <Link2 size={14} /> Copy passage link
                  </button>
                  <button
                    onClick={() => {
                      try {
                        void copy(
                          "Source citation",
                          disclosurePassageCitation(displayed, passage),
                        );
                      } catch (error) {
                        setCopyNotice(
                          error instanceof Error
                            ? error.message
                            : "Could not create a source citation.",
                        );
                      }
                    }}
                  >
                    <Copy size={14} /> Copy quotation & citation
                  </button>
                </div>
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
                <DisclosureQuantities filing={displayed} passage={passage} />
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
                    onCollect(
                      displayed,
                      { ...passage, label },
                      settings,
                      collection,
                    )
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
                disabled={currentPage <= 1}
                onClick={() => turnPage(currentPage - 1)}
              >
                <ChevronLeft size={15} /> Previous
              </button>
              <span>
                Passage page {currentPage} / {pages}
              </span>
              <button
                disabled={currentPage >= pages}
                onClick={() => turnPage(currentPage + 1)}
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
