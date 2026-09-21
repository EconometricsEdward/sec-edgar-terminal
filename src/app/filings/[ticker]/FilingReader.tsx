"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChartNoAxesCombined,
  ExternalLink,
  GitCompareArrows,
  Plus,
  Search,
  X,
} from "lucide-react";
import { disclosureWordDiff } from "../../../utils/disclosureResearch.js";
import { isBrokerDealerAnnualForm } from "../../../utils/brokerDealerForms.js";
import BrokerDealerAnalytics from "../../../components/broker-dealer/BrokerDealerAnalytics";
import styles from "../reader.module.css";

type Props = {
  ticker: string;
  filing: any;
  archive?: string;
  prior?: any;
  priorArchive?: string;
  initialSelection?: { view?: string; query?: string; section?: string; page?: number; document?: string };
  comparisonBasis?: "year" | "previous";
  onComparisonChange?: (basis: "year" | "previous") => void;
  selectionReason?: string;
  onClose: () => void;
  onCollect: (filing: any, passage: any) => void;
};

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const parts: any[] = [];
  let offset = 0;
  let found = haystack.indexOf(needle);
  while (found >= 0) {
    parts.push(text.slice(offset, found));
    parts.push(
      <mark key={found}>{text.slice(found, found + query.length)}</mark>,
    );
    offset = found + query.length;
    found = haystack.indexOf(needle, offset);
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

function ChangePassage({
  change,
  data,
  query,
  onCollect,
}: {
  change: any;
  data: any;
  query: string;
  onCollect: Props["onCollect"];
}) {
  const diff = useMemo(
    () => disclosureWordDiff(change.before || "", change.after || ""),
    [change.before, change.after],
  );
  const sectionId = change.section === "Risk factors" ? "risk" : "mda";
  return (
    <article className={styles.passage}>
      <div className={styles.passageHeader}>
        <span>{change.section}</span>
        <strong className={styles.changeType}>
          {change.type === "modified" ? "Revised" : change.type}
        </strong>
      </div>
      {change.before && (
        <div className={styles.version}>
          <span className={styles.versionLabel}>
            Before · {data.prior?.reportDate || data.prior?.filingDate}
          </span>
          <p>
            {diff
              .filter((part) => part.kind !== "added")
              .map((part, i) =>
                part.kind === "removed" ? (
                  <del key={i}>
                    <Highlight text={part.text} query={query} />
                  </del>
                ) : (
                  <span key={i}>
                    <Highlight text={part.text} query={query} />
                  </span>
                ),
              )}
          </p>
          <button
            type="button"
            className={styles.collect}
            onClick={() =>
              onCollect(data.prior, {
                index: change.index,
                sectionId,
                section: change.section,
                text: change.before,
                change: change.type,
                version: "before",
              })
            }
          >
            <Plus size={13} /> Collect prior passage
          </button>
        </div>
      )}
      {change.after && (
        <div className={styles.version}>
          <span className={styles.versionLabel}>
            After · {data.filing.reportDate || data.filing.filingDate}
          </span>
          <p>
            {diff
              .filter((part) => part.kind !== "removed")
              .map((part, i) =>
                part.kind === "added" ? (
                  <ins key={i}>
                    <Highlight text={part.text} query={query} />
                  </ins>
                ) : (
                  <span key={i}>
                    <Highlight text={part.text} query={query} />
                  </span>
                ),
              )}
          </p>
          <button
            type="button"
            className={styles.collect}
            onClick={() =>
              onCollect(data.filing, {
                index: change.index,
                sectionId,
                section: change.section,
                text: change.after,
                change: change.type,
                version: "after",
              })
            }
          >
            <Plus size={13} /> Collect current passage
          </button>
        </div>
      )}
      <p className={styles.caption}>
        {change.type === "unmatched"
          ? "This amendment passage could not be matched to a prior paragraph. Amendments can omit unchanged sections."
          : change.reason}
      </p>
    </article>
  );
}

function ReaderSession({
  ticker,
  filing,
  archive,
  prior,
  priorArchive,
  initialSelection,
  comparisonBasis = "year",
  onComparisonChange,
  selectionReason,
  onClose,
  onCollect,
}: Props) {
  const isBrokerDealer = isBrokerDealerAnnualForm(filing.form);
  const initialQuery = typeof initialSelection?.query === 'string' && initialSelection.query.length <= 200 && !/[\u0000-\u001f\u007f]/.test(initialSelection.query) ? initialSelection.query : '';
  const [view, setView] = useState(isBrokerDealer && initialSelection?.view === 'analytics' ? 'analytics' : !isBrokerDealer && initialSelection?.view === 'changes' ? 'changes' : 'document');
  const [documentName, setDocumentName] = useState(initialSelection?.document || '');
  const requestView = view === "changes" ? "changes" : "document";
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [section, setSection] = useState(/^(all|other|risk|mda|notes|8k:\d\.\d{2})$/.test(initialSelection?.section || '') ? initialSelection!.section! : 'all');
  const [page, setPage] = useState(Number.isInteger(initialSelection?.page) && initialSelection!.page! >= 1 && initialSelection!.page! <= 1000 ? initialSelection!.page! : 1);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      ticker,
      accession: filing.accession,
      view: requestView,
      query,
      section,
      page: String(page),
    });
    if (documentName) params.set("document", documentName);
    if (archive) params.set("archive", archive);
    if (filing.filingDate) params.set("filed", filing.filingDate);
    if (prior?.accession) params.set("prior", prior.accession);
    if (priorArchive) params.set("priorArchive", priorArchive);
    if (prior?.filingDate) params.set("priorFiled", prior.filingDate);
    fetch(`/api/filings-reader?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "The filing could not be read.");
        return result;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
        body.current?.scrollTo({ top: 0, behavior: "instant" });
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setError(failure.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [
    ticker,
    filing.accession,
    filing.filingDate,
    archive,
    prior?.accession,
    prior?.filingDate,
    priorArchive,
    requestView,
    documentName,
    query,
    section,
    page,
    attempt,
  ]);

  const documents = data?.documents || [];
  const selectedDocument = documents.find((document: any) => document.name === documentName) || data?.selectedDocument;
  const sourceUrl = selectedDocument?.url || (isBrokerDealer ? undefined : filing.documentUrl);
  const analysisParams = new URLSearchParams({ accession: filing.accession });
  if (archive) analysisParams.set("archive", archive);
  if (filing.filingDate) analysisParams.set("filed", filing.filingDate);
  if (selectedDocument?.name) analysisParams.set("document", selectedDocument.name);
  const analysisIdentity = data?.company?.cik || data?.cik || ticker;
  const comparison = data?.comparison;
  const total =
    view === "document"
      ? data?.coverage?.matchedParagraphs || 0
      : comparison?.matchedChanges || 0;
  const pageSize =
    view === "document"
      ? data?.coverage?.pageSize || 8
      : comparison?.pageSize || 8;
  const currentPage =
    view === "document" ? data?.coverage?.page || 1 : comparison?.page || 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const availableSections =
    view === "changes"
      ? [
          { id: "risk", label: "Risk Factors" },
          { id: "mda", label: "MD&A" },
        ]
      : [
          ...(data?.sections || []),
          { id: "other", label: "Other / unclassified" },
        ];

  return (
    <section className={styles.reader} aria-label="Filing reader">
      <div className={styles.heading}>
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {ticker} <span>{filing.form}</span>
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={styles.iconButton}
          aria-label="Close filing reader"
        >
          <X size={18} />
        </button>
      </div>
      <dl className={styles.metadata}>
        <div>
          <dt>Filed</dt>
          <dd>{filing.filingDate || "Not reported"}</dd>
        </div>
        <div>
          <dt>Reporting period</dt>
          <dd>{filing.reportDate || "Not reported"}</dd>
        </div>
        <div className={styles.accession}>
          <dt>Accession</dt>
          <dd>{filing.accession}</dd>
        </div>
      </dl>
      <div className={styles.sources}>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {selectedDocument?.format === "pdf" ? "Original SEC PDF" : "SEC original"} <ExternalLink size={12} />
          </a>
        )}
        {filing.indexUrl && (
          <a href={filing.indexUrl} target="_blank" rel="noopener noreferrer">
            Filing & exhibits <ExternalLink size={12} />
          </a>
        )}
        {isBrokerDealer && <Link href={`/analysis/${encodeURIComponent(analysisIdentity)}?${analysisParams}`} prefetch={false}>Open financial analysis <ExternalLink size={12} /></Link>}
      </div>
      {documents.length > 0 && <div className={styles.documentControl}>
        <label htmlFor={`${id}-document`}>Filing document</label>
        <select id={`${id}-document`} value={selectedDocument?.name || ""} onChange={event => {
          setDocumentName(event.target.value);
          setPage(1);
          setSection("all");
        }}>
          {documents.map((document: any) => <option key={document.name} value={document.name}>{document.description || document.name}{document.format ? ` · ${String(document.format).toUpperCase()}` : ""}</option>)}
        </select>
      </div>}
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Filing reader views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "document"}
          aria-controls={`${id}-panel`}
          onClick={() => {
            setView("document");
            setPage(1);
            setSection("all");
          }}
        >
          <BookOpen size={15} /> Document
        </button>
        {isBrokerDealer && <button type="button" role="tab" aria-selected={view === "analytics"} aria-controls={`${id}-panel`} onClick={() => { setView("analytics"); setPage(1); setSection("all"); }}><ChartNoAxesCombined size={15} /> Financials</button>}
        {!isBrokerDealer && <button
          type="button"
          role="tab"
          aria-selected={view === "changes"}
          aria-controls={`${id}-panel`}
          onClick={() => {
            setView("changes");
            setPage(1);
            setSection("all");
          }}
        >
          <GitCompareArrows size={15} /> Changes
        </button>}
      </div>
      {view === "changes" && onComparisonChange && (
        <div className={styles.comparisonControl}>
          <label>
            Comparison basis
            <select
              value={comparisonBasis}
              onChange={(e) =>
                onComparisonChange(e.target.value as "year" | "previous")
              }
            >
              <option value="year">Same reporting season</option>
              <option value="previous">Previous same-form report</option>
            </select>
          </label>
          {!prior && (
            <p>
              {selectionReason ||
                "Load earlier history to find a comparable report."}
            </p>
          )}
        </div>
      )}
      {view !== "analytics" && <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draftQuery.trim());
          setPage(1);
        }}
      >
        <label htmlFor={`${id}-search`}>Find text or a phrase</label>
        <div className={styles.search}>
          <input
            id={`${id}-search`}
            maxLength={200}
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="e.g. liquidity or credit facility"
          />
          <button type="submit" aria-label="Find text in this filing">
            <Search size={16} />
          </button>
        </div>
        <label className={styles.sectionFilter} htmlFor={`${id}-section`}>
          Section
          <select
            id={`${id}-section`}
            value={section}
            onChange={(event) => {
              setSection(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">
              {view === "changes" ? "Risk Factors + MD&A" : "Whole document"}
            </option>
            {availableSections.map((option: any) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {query && (
          <button
            type="button"
            className={styles.clearQuery}
            onClick={() => {
              setQuery("");
              setDraftQuery("");
              setPage(1);
            }}
          >
            Clear “{query}”
          </button>
        )}
      </form>}
      <div
        ref={body}
        className={styles.body}
        id={`${id}-panel`}
        role="tabpanel"
        aria-label={
          view === "analytics" ? "Broker-dealer financial analysis" : view === "document" ? "Document passages" : "Passage changes"
        }
        aria-busy={loading}
      >
        {loading ? (
          <div className={styles.message} role="status">
            Reading the SEC{" "}
            {view === "changes" ? "reports and comparing passages" : "document"}
            …
          </div>
        ) : error ? (
          <div className={styles.message} role="alert">
            <strong>Document not reviewed</strong>
            <p>{error}</p>
            <button
              type="button"
              className={styles.retry}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          data && (
            <>
              {data.extraction && <div className={styles.extractionNotice} role="status">
                <strong>{data.extraction.status === "scanned" || data.extraction.status === "no-text" ? "Readable text unavailable" : data.extraction.status === "unsupported" ? "Document format not supported" : "Document extraction coverage"}</strong>
                <p>{typeof data.extraction.pagesRead === "number" ? `${data.extraction.pagesRead} pages read${typeof data.extraction.pageCount === "number" ? ` of ${data.extraction.pageCount}` : ""}. ` : ""}{data.extraction.message || data.extraction.reason || "Only extracted text is available in this reader. Tables, scanned pages and other unsupported content require the original document."}</p>
                {data.extraction.ocrPages > 0 && <p>{data.extraction.ocrPages} pages use optical text recognition. Check extracted digits and labels against the original PDF.</p>}
                {data.extraction.limitations?.length > 0 && <ul>{data.extraction.limitations.map((limit: string) => <li key={limit}>{limit}</li>)}</ul>}
              </div>}
              {view === "analytics" ? <BrokerDealerAnalytics analysis={data.brokerDealerAnalysis} filing={data.filing || filing} compact /> : view === "document" ? (
                <>
                  <p className={styles.caption}>
                    {total.toLocaleString()} {query ? "matching " : ""}passages
                    {section !== "all" ? " in the selected section" : ""} ·{" "}
                    {(data.coverage?.totalParagraphs || 0).toLocaleString()} extracted
                    overall.
                  </p>
                  <details className={styles.coverage}>
                    <summary>Reader coverage</summary>
                    <p>{data.coverage.extraction}</p>
                    {data.format === "xml-fields" && (
                      <p>
                        This XML filing is shown as labeled fields. Use the SEC
                        original for ownership tables, transaction groupings and
                        footnote references.
                      </p>
                    )}
                    {data.coverage.splitParagraphs && (
                      <p>
                        Very long paragraphs are divided into labeled parts; the
                        extracted text remains available across pages.
                      </p>
                    )}
                  </details>
                  {!total && (
                    <div className={styles.message}>
                      {query ? "No matching text in the extracted document." : "No readable passages are available for this document."} Scanned pages, unrecognized sections and exhibits still require the SEC original.
                    </div>
                  )}
                  {(data.paragraphs || []).map((passage: any) => (
                    <article
                      key={`${passage.index}:${passage.part}`}
                      className={styles.passage}
                    >
                      <div className={styles.passageHeader}>
                        <span>{passage.section}</span>
                        <span>
                          {passage.page ? `PDF p. ${passage.page} · ` : ""}¶{passage.index + 1}
                          {passage.parts > 1
                            ? ` · part ${passage.part}/${passage.parts}`
                            : ""}
                        </span>
                      </div>
                      <p>
                        <Highlight text={passage.text} query={query} />
                      </p>
                      <div className={styles.passageActions}>
                        <button
                          type="button"
                          className={styles.collect}
                          onClick={() => onCollect({ ...data.filing, documentUrl: data.format === "pdf-text" && passage.page ? `${sourceUrl}#page=${passage.page}` : sourceUrl }, passage)}
                        >
                          <Plus size={13} /> Collect passage
                        </button>
                        {(passage.beforeContext || passage.afterContext) && (
                          <details className={styles.context}>
                            <summary>Surrounding text</summary>
                            {passage.beforeContext && (
                              <div>
                                <span>Previous passage</span>
                                <p>
                                  <Highlight
                                    text={passage.beforeContext}
                                    query={query}
                                  />
                                </p>
                              </div>
                            )}
                            {passage.afterContext && (
                              <div>
                                <span>Next passage</span>
                                <p>
                                  <Highlight
                                    text={passage.afterContext}
                                    query={query}
                                  />
                                </p>
                              </div>
                            )}
                          </details>
                        )}
                      </div>
                    </article>
                  ))}
                </>
              ) : (
                <>
                  <div className={styles.comparisonSummary}>
                    <strong>
                      {comparison.status === "reviewed"
                        ? "Passage comparison"
                        : comparison.status === "fetch-failed"
                          ? "Prior document not reviewed"
                          : comparison.status === "section-unavailable"
                            ? "Comparable sections not identified"
                            : "Comparison unavailable"}
                    </strong>
                    <p>{comparison.reason}</p>
                    {data.prior && (
                      <a
                        href={data.prior.documentUrl || data.prior.indexUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Baseline: {data.prior.form} · period{" "}
                        {data.prior.reportDate || "not reported"} · filed{" "}
                        {data.prior.filingDate} <ExternalLink size={12} />
                      </a>
                    )}
                    {comparison.limitation && (
                      <details className={styles.coverage}>
                        <summary>Comparison coverage and limits</summary>
                        <p>{comparison.limitation}</p>
                        {comparison.coverage.map((row: any) => (
                          <p key={row.section}>
                            {row.section}: current{" "}
                            {row.currentFound
                              ? `${row.currentParagraphs} paragraphs`
                              : "not identified"}
                            ; prior{" "}
                            {row.priorFound
                              ? `${row.priorParagraphs} paragraphs`
                              : "not identified"}
                            {row.referenceOnly
                              ? "; includes references to another report"
                              : ""}
                            {row.truncated ? "; paragraph limit reached" : ""}.
                          </p>
                        ))}
                      </details>
                    )}
                  </div>
                  {comparison.status === "fetch-failed" && (
                    <button
                      type="button"
                      className={styles.retry}
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      Retry prior report
                    </button>
                  )}
                  {comparison.status === "reviewed" && (
                    <p className={styles.caption}>
                      {comparison.totalChanges} detected changes
                      {comparison.truncated ? " · bounded comparison" : ""}.{" "}
                      {total}{" "}
                      {query || section !== "all"
                        ? "match these filters in the displayed change set"
                        : "available to review"}
                      . Repeated paragraphs are suppressed.
                    </p>
                  )}
                  {comparison.status === "reviewed" && !total && (
                    <div className={styles.message}>
                      {query || section !== "all"
                        ? "No detected changes match these filters."
                        : "No changes were detected within the comparable extracted sections."}{" "}
                      This does not establish that the full filing is unchanged.
                    </div>
                  )}
                  {comparison.changes.map((change: any) => (
                    <ChangePassage
                      key={change.index}
                      change={change}
                      data={data}
                      query={query}
                      onCollect={onCollect}
                    />
                  ))}
                </>
              )}
            </>
          )
        )}
      </div>
      {view !== "analytics" && !loading && !error && total > 0 && (
        <div className={styles.pagination}>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {currentPage} of {pages}
          </span>
          <button
            type="button"
            disabled={currentPage >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

export default function FilingReader(props: Props) {
  return (
    <ReaderSession
      key={`${props.ticker}:${props.filing.accession}`}
      {...props}
    />
  );
}
