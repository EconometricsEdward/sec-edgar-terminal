"use client";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowUpRight, CheckCircle2, Download, ExternalLink, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { parseDisclosureQuery } from "../../utils/disclosureQuery.js";
import { filingEvidenceId } from "../../utils/disclosureNotebook.js";
import { safeDisclosureSourceUrl } from "../../utils/disclosureCollections.js";
import { buildDisclosureResults, defaultDisclosureResultFilters, disclosurePreviewText, disclosureResultPreviews, exportDisclosureResultsCsv } from "../../utils/disclosureResults.js";
import { Highlight } from "./DisclosureHighlight";
import { downloadDisclosure } from "./disclosureDownload";
import type { Filing, Passage, SearchSettings } from "./disclosureTypes";
import s from "./disclosures.module.css";
import r from "./DisclosureResults.module.css";

type Filters = ReturnType<typeof defaultDisclosureResultFilters>;
type Props = {
  filings: Filing[];
  settings: SearchSettings;
  changesOnly: boolean;
  open: (filing: Filing, settings: SearchSettings, passage?: { index: number; side: "current" | "prior" }) => void;
  onVerifyCandidates?: () => void;
  selectedId?: string;
  busy?: boolean;
};

function PassagePreview({ passage, terms, read }: { passage: Passage; terms: string[]; read: () => void }) {
  return <button className={r.passage} onClick={read}>
    <span className={r.passageMeta}><span>{passage.section || "Filing passage"}</span><span>{passage.change === "removed" ? "Prior filing" : "Original filing text"}</span></span>
    <span className={r.quote}><Highlight text={disclosurePreviewText(passage)} terms={passage.matchedTerms?.length ? passage.matchedTerms : terms} />{passage.previewTruncated ? "…" : ""}</span>
    <span className={r.passageMeta}><span>{passage.change && !["unchanged", "uncompared"].includes(passage.change) ? `${passage.change} · ` : ""}{passage.matchedTerms?.length ? `Matches ${passage.matchedTerms.slice(0, 4).join(", ")}` : "Matching disclosure passage"}</span><span className={r.readPassage}>Read in context <ArrowUpRight size={12} /></span></span>
  </button>;
}

const reviewedFilings = {};

export default function DisclosureResults({ filings, settings, changesOnly, open, onVerifyCandidates, selectedId, busy = false }: Props) {
  const [filters, setFilters] = useState(defaultDisclosureResultFilters);
  const [visibleCount, setVisibleCount] = useState(24);
  const deferredText = useDeferredValue(filters.text);
  const terms = useMemo(() => { try { return parseDisclosureQuery(settings.query).positive; } catch { return []; } }, [settings.query]);
  const model = useMemo(() => buildDisclosureResults(filings, { ...filters, text: deferredText }, settings, reviewedFilings, changesOnly), [filings, filters, deferredText, settings, changesOnly]);
  function patch(key: keyof Filters, value: string) { setFilters(current => ({ ...current, [key]: value })); setVisibleCount(24); }
  const activeFilters = Object.entries(filters).some(([key, value]) => key !== "sort" && value !== defaultDisclosureResultFilters()[key]);
  const facetLabels = { company: "Company", form: "Filing form", change: "Language change", language: "Automated wording" };
  return <div className={r.results}>
    <div className={`${s.panelHeading} ${r.resultsHeading}`}>
      <div>
        <h2>{model.results.length.toLocaleString()} filing{model.results.length === 1 ? "" : "s"}{busy ? " so far" : " in view"}</h2>
        <p className={r.resultSummary} aria-live="polite">
          {model.summary.verified > 0 && <span><CheckCircle2 size={12} />{model.summary.verified} verified document{model.summary.verified === 1 ? "" : "s"}</span>}
          {model.summary.indexed > 0 && <span>{model.summary.indexed} prepared passage match{model.summary.indexed === 1 ? "" : "es"}</span>}
          {model.summary.candidates > 0 && <span>{model.summary.candidates} awaiting text verification</span>}
          {model.summary.gaps > 0 && <span>{model.summary.gaps} coverage gap{model.summary.gaps === 1 ? "" : "s"}</span>}
        </p>
      </div>
      <div className={r.actions}>
        {onVerifyCandidates && filings.some(f => ["index-candidate", "fetch-failed"].includes(f.status || "") || settings.comparison !== "none" && f.status === "indexed-match") && <button disabled={busy} onClick={onVerifyCandidates}><RefreshCw size={14} /> Check more passages</button>}
        <button disabled={!model.results.length} title="Export filtered filing manifest with sources and loaded excerpts" onClick={() => downloadDisclosure("disclosure-result-manifest.csv", exportDisclosureResultsCsv(model.results, settings, reviewedFilings, { ...filters, changesOnly }), "text/csv;charset=utf-8")}><Download size={14} /> Export results</button>
      </div>
    </div>
    <div className={r.toolbar}>
      <label>Sort by<select value={filters.sort} onChange={e => patch("sort", e.target.value)}><option value="relevance">Most relevant</option><option value="date">Newest filing</option><option value="added">Newly added language</option><option value="section">Recognized section</option><option value="proximity">Term proximity</option><option value="specificity">Amounts & dates</option></select></label>
      <details className={r.refine}>
        <summary><SlidersHorizontal size={14} /> Refine results{activeFilters ? " · active" : ""}</summary>
        <div className={r.refineBody}>
      <label>Show<select value={filters.scope} onChange={e => patch("scope", e.target.value)}>{model.facets.scope.map(f => <option key={f.value} value={f.value}>{f.label} ({f.count})</option>)}</select></label>

          <div className={r.filters}>{(["company", "form", "change", "language"] as const).map(key => <label key={key}>{facetLabels[key]}<select value={filters[key]} onChange={e => patch(key, e.target.value)}>{model.facets[key].map(f => <option key={f.value} value={f.value}>{f.label} ({f.count})</option>)}</select></label>)}</div>
          <label className={r.previewFilter}><span><Search size={12} /> Filter loaded excerpts</span><input type="search" placeholder="Words within the loaded previews" value={filters.text} onChange={e => patch("text", e.target.value)} aria-describedby="disclosure-preview-filter-help" /></label>
          <p id="disclosure-preview-filter-help" className={r.help}>Checks up to three loaded excerpts per document. Use the main search to search filing text.</p>
        </div>
      </details>
      {activeFilters && <button className={r.reset} onClick={() => { setFilters(defaultDisclosureResultFilters()); setVisibleCount(24); }}>Clear filters</button>}
    </div>
    {!model.results.length && <div className={s.empty}>{busy ? "Finding matching filings. Results appear as soon as they are available." : "No filings meet these result filters. Clear filters, try a shorter topic, broaden the date range, or inspect coverage gaps."}</div>}
    {model.results.slice(0, visibleCount).map(filing => {
      const id = filingEvidenceId(filing);
      const candidate = filing.status === "index-candidate";
      const indexed = filing.status === "indexed-match";
      const searched = filing.status === "reviewed";
      const previews = disclosureResultPreviews(filing) as Passage[];
      const source = safeDisclosureSourceUrl(filing.documentUrl);
      const readPassage = (passage: Passage) => open(filing, settings, { index: passage.index, side: passage.change === "removed" ? "prior" : "current" });
      return <article key={id} className={`${s.resultCard} ${r.card}`} data-selected={selectedId === id} data-coverage={candidate ? "candidate" : indexed ? "indexed" : searched ? "verified" : "gap"}>
        <button className={`${s.resultOpen} ${r.heading}`} onClick={() => open(filing, settings)} aria-label={`Read ${filing.companyName || filing.ticker} ${filing.form} filed ${filing.filingDate}`}>
          <div className={r.cardIdentity}><span className={r.companyTitle}>{filing.companyName || filing.ticker}</span><span className={r.filingForm}>{filing.form}</span></div>
          <div className={r.documentMeta}><strong>{filing.ticker || `CIK ${filing.cik}`}</strong><span>Filed {filing.filingDate}</span>{filing.reportDate && <span>Period ended {filing.reportDate}</span>}</div>
        </button>
        <div className={r.body}>
          <div className={r.coverage} data-state={candidate ? "candidate" : indexed ? "indexed" : searched ? "searched" : "gap"}>
            {searched && <CheckCircle2 size={12} />}
            {candidate ? "SEC index candidate · text verification pending" : indexed ? "Prepared passage match · full filing not yet searched" : searched ? `${filing.matchCount || 0} matching passage${filing.matchCount === 1 ? "" : "s"} · document verified` : filing.status === "section-unavailable" ? "Requested section unavailable" : "Filing text not successfully searched"}
          </div>
          <div className={r.changes}>
            {(filing.additions || 0) > 0 && <span>{filing.additions} added</span>}{(filing.revisions || 0) > 0 && <span>{filing.revisions} revised</span>}{(filing.removedCount || 0) > 0 && <span>{filing.removedCount} removed</span>}{(filing.queryRemovedCount || 0) > 0 && <span>{filing.queryRemovedCount} no longer match query</span>}{changesOnly && (filing.unchanged || 0) > 0 && <span>{filing.unchanged} repeated</span>}
          </div>
          {previews[0] && <PassagePreview passage={previews[0]} terms={terms} read={() => readPassage(previews[0])} />}
          {previews.length > 1 && <details className={r.morePassages}><summary>{previews.length - 1} more matching excerpt{previews.length > 2 ? "s" : ""}</summary>{previews.slice(1).map(passage => <PassagePreview key={`${passage.change}:${passage.index}`} passage={passage} terms={terms} read={() => readPassage(passage)} />)}</details>}
          {candidate && <p className={r.candidateNote}>The SEC search index identified this filing. Open it to verify your query and section against the original text.</p>}
          {searched && !previews.length && <p className={r.help}>{filing.matched ? "Matching text is available in the reader." : "No current passages matched in the extracted text and selected section."}</p>}
          {(filing.reason || filing.comparisonError) && <p className={r.problem}>{filing.reason}{filing.comparisonError ? ` Comparison unavailable: ${filing.comparisonError}` : ""}</p>}
          {(searched || indexed) && <details className={r.ranking}>
            <summary>Match details & source coverage</summary>
            {Number.isFinite(filing.indexRank) && <p>SEC discovery position: {Number(filing.indexRank)}. This position is retained when the filing text is verified.</p>}
            {Number.isFinite(filing.preparedRank) && <p>Prepared passage search position: {Number(filing.preparedRank)}.</p>}
            {filing.signals && <p>{filing.signals.recognized || 0} matching excerpts in recognized sections; {filing.signals.concrete || 0} with amounts or dates.{filing.signals.closestTerms != null ? ` Closest terms: ${filing.signals.closestTerms} words apart.` : ""} Document ranking uses all available matching excerpts.</p>}
            {indexed && <p>These original passages matched the query within prepared text. Coverage is limited to the indexed passages; open the filing for full verification.{filing.indexedAt ? ` Prepared ${new Date(filing.indexedAt).toLocaleString()}.` : ""}</p>}
            {searched && settings.comparison !== "none" && !filing.pair?.prior && !filing.comparisonError && <p>Comparison: {filing.pair?.reason || "No comparable earlier filing was available in this search."}</p>}
            {previews.some(passage => passage.label) && <p>Automated wording: {[...new Set(previews.map(passage => passage.label).filter(Boolean))].join("; ")}. This describes language, not a risk conclusion.</p>}
          </details>}
          <div className={r.footer}>
            <div className={r.readActions}><button onClick={() => open(filing, settings)}>{candidate ? "Read & check filing" : indexed ? "Open full filing" : searched ? "Read filing" : "Retry in reader"}<ArrowUpRight size={13} /></button>
              {(searched || indexed) && (settings.comparison === "none" || !settings.comparison) && <button onClick={() => open(filing, { ...settings, comparison: "annual-season" })}>Compare wording</button>}
              {source && <a href={source} target="_blank" rel="noopener noreferrer">SEC source <ExternalLink size={12} /></a>}
            </div>
          </div>
        </div>
      </article>;
    })}
    <details className={r.searchMethod}>
      <summary>About relevance & coverage</summary>
      <p>Search relevance combines the positions returned by SEC discovery and prepared passage search. A match in both sources moves up the list. Within either source, its original relevance order is retained as the full filing is verified. Detailed company searches use term proximity, recognized sections, and concrete amounts or dates. Ranking is a reading aid and does not measure risk.</p>
      <p>Verified documents were searched in the selected scope. Prepared passage matches come from a previously indexed subset; open the full filing to verify complete coverage. SEC candidates have no verified passage yet. Wording labels are automated; read the quotation in context, including qualifications and negations.</p>
      {changesOnly && <p>Repeated wording is suppressed in this view. A passage that no longer matches the query may still exist in revised form. Candidates need a filing comparison before any change is established.</p>}
    </details>
    {model.results.length > visibleCount && <button className={s.loadMore} onClick={() => setVisibleCount(n => n + 24)}>Show {Math.min(24, model.results.length - visibleCount)} more filings ({model.results.length - visibleCount} remaining)</button>}
  </div>;
}
