"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, ChartNoAxesCombined, Check, ChevronDown, FileSpreadsheet, FileText, Landmark, Layers3, LoaderCircle, Search, X } from "lucide-react";
import type { ReportDocument, ReportFormat, ReportKind, ReportSearchResult } from "../../utils/reportTypes";
import { reportMatchesSelection } from "../../utils/reportRequest.js";
import styles from "./reports.module.css";

type ExportFormat = "pdf" | "xlsx";
type Basis = "annual" | "ttm" | "quarter";
type SearchResponse = { query: string; kind: ReportKind; results: ReportSearchResult[]; warning?: string; truncated?: boolean };

const KINDS = [
  { id: "company" as const, label: "Company", Icon: Building2, placeholder: "Search a company name, ticker or CIK", detail: "Financial statements, performance and financial risk" },
  { id: "nport" as const, label: "N-PORT fund", Icon: Layers3, placeholder: "Search a fund name, ticker or SEC series", detail: "A fund’s reported portfolio and concentration" },
  { id: "13f" as const, label: "13F manager", Icon: Landmark, placeholder: "Search an institutional manager name or CIK", detail: "An institutional manager’s disclosed securities" },
  { id: "market" as const, label: "Market report", Icon: ChartNoAxesCombined, placeholder: "Market report", detail: "Sector fundamentals and CFTC positioning across financial and commodity markets" },
];
const MARKET_SELECTION: ReportSearchResult = { kind: "market", id: "MARKET", name: "Market overview", cik: "", detail: "Sector fundamentals and futures positioning" };

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const plainNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function canSearchIdentity(query: string, kind: ReportKind) {
  const normalized = query.trim();
  return normalized.length >= 2 || (kind === "company" && /^[a-z]$/i.test(normalized));
}

function formatValue(value: unknown, unit: ReportFormat = "text") {
  if (value == null || value === "") return "Unavailable";
  if (unit === "date") {
    const date = new Date(String(value));
    return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : String(value);
  }
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "Unavailable";
  if (unit === "percent") return `${plainNumber.format(value * 100)}%`;
  if (unit === "ratio") return `${plainNumber.format(value)}×`;
  if (unit === "usd") return `${value < 0 ? "−" : ""}$${compactNumber.format(Math.abs(value))}`;
  return plainNumber.format(value);
}

function safeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["sec.gov", "cftc.gov", "secedgarterminal.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null;
  } catch { return null; }
}

function reportMatches(value: unknown, selected: ReportSearchResult, basis: Basis): value is ReportDocument {
  if (!value || typeof value !== "object") return false;
  const report = value as ReportDocument;
  return reportMatchesSelection(report, { kind: selected.kind, id: selected.id, basis })
    && report.entity?.cik?.replace(/^0+/, "") === selected.cik.replace(/^0+/, "")
    && (!selected.seriesId || report.entity.seriesId === selected.seriesId)
    && Array.isArray(report.sections) && Array.isArray(report.sources) && Array.isArray(report.summary)
    && Array.isArray(report.highlights) && Array.isArray(report.notes)
    && ["ready", "partial"].includes(report.coverage?.status) && !!report.period;
}

export default function ReportsClient({ preview = false }: { preview?: boolean }) {
  const [kind, setKind] = useState<ReportKind>("company");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReportSearchResult[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [searchError, setSearchError] = useState("");
  const [searchWarning, setSearchWarning] = useState("");
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<ReportSearchResult | null>(null);
  const [basis, setBasis] = useState<Basis>("annual");
  const [report, setReport] = useState<ReportDocument | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState("");
  const [downloaded, setDownloaded] = useState<ExportFormat[]>([]);
  const searchController = useRef<AbortController | null>(null);
  const prepareController = useRef<AbortController | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prepareRequest = useRef(0);
  const searchRequest = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const listId = useId();
  const config = KINDS.find(item => item.id === kind)!;
  const searchVisible = open && !selected && canSearchIdentity(query, kind);
  const displayedSources = report?.kind === "market"
    ? report.sources.filter(source => source.id === "market-snapshot" || source.id.startsWith("cftc-"))
    : report?.sources || [];

  useEffect(() => {
    const normalized = query.trim();
    const request = ++searchRequest.current;
    setActiveIndex(-1);
    if (kind === "market" || selected || !canSearchIdentity(normalized, kind)) {
      setResults([]);
      setSearchState("idle");
      setSearchWarning("");
      return;
    }
    setSearchState("loading");
    setResults([]);
    setSearchError("");
    setSearchWarning("");
    const controller = new AbortController();
    searchController.current = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const params = new URLSearchParams({ q: normalized, kind });
        const response = await fetch(`/api/reports/search?${params}`, { signal: controller.signal });
        const data = await response.json();
        if (request !== searchRequest.current) return;
        if (!response.ok) throw new Error(data.error || "Search is unavailable. Please try again.");
        const payload = data as SearchResponse;
        if (payload.kind !== kind || !Array.isArray(payload.results)) throw new Error("The search response could not be verified. Please retry.");
        const valid = payload.results.filter(item => item.kind === kind && typeof item.id === "string" && typeof item.name === "string" && /^\d{1,10}$/.test(item.cik));
        setResults(valid.slice(0, 20));
        setSearchWarning([payload.warning, payload.truncated ? "More matches are available. Refine the name or enter an exact ticker, CIK or fund series." : ""].filter(Boolean).join(" "));
        setSearchState("ready");
      } catch (error) {
        if (request !== searchRequest.current) return;
        setSearchState("error");
        setSearchError(controller.signal.aborted ? "The search took too long. Please retry." : error instanceof Error ? error.message : "Search is unavailable. Please retry.");
      } finally { clearTimeout(timeout); }
    }, 300);
    return () => { clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
  }, [query, kind, selected, searchAttempt]);

  useEffect(() => () => {
    searchRequest.current++;
    prepareRequest.current++;
    searchController.current?.abort();
    prepareController.current?.abort();
    workerRef.current?.terminate();
    if (workerTimer.current) clearTimeout(workerTimer.current);
  }, []);

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  function clearReport() {
    prepareRequest.current++;
    prepareController.current?.abort();
    workerRef.current?.terminate();
    workerRef.current = null;
    if (workerTimer.current) clearTimeout(workerTimer.current);
    setPreparing(false);
    setReport(null);
    setPrepareError("");
    setExportError("");
    setExporting(null);
    setDownloaded([]);
  }

  function changeKind(next: ReportKind) {
    if (kind === next) return;
    clearReport();
    searchRequest.current++;
    searchController.current?.abort();
    setKind(next);
    setQuery("");
    setSelected(next === "market" ? MARKET_SELECTION : null);
    setBasis(next === "market" ? "ttm" : "annual");
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }

  function chooseEntity(entity: ReportSearchResult) {
    clearReport();
    searchRequest.current++;
    searchController.current?.abort();
    setSelected(entity);
    setQuery(entity.ticker ? `${entity.ticker} · ${entity.name}` : entity.name);
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  async function buildReport() {
    if (!selected || preparing) return;
    clearReport();
    const currentEntity = selected;
    const request = ++prepareRequest.current;
    const controller = new AbortController();
    prepareController.current = controller;
    setPreparing(true);
    setOpen(false);
    const timeout = setTimeout(() => controller.abort(), 115000);
    try {
      const params = new URLSearchParams({ kind: currentEntity.kind, id: currentEntity.id, basis });
      const response = await fetch(`/api/reports/prepare?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (request !== prepareRequest.current) return;
      if (!response.ok) throw new Error(data.error || "The report could not be prepared. Please try again.");
      if (!reportMatches(data, currentEntity, basis)) throw new Error("The report identity or structure could not be verified. Please retry.");
      setReport(data);
      requestAnimationFrame(() => resultHeading.current?.focus({ preventScroll: true }));
    } catch (error) {
      if (request !== prepareRequest.current) return;
      setPrepareError(controller.signal.aborted ? "The report took too long to prepare. Try again; previously retrieved source data can be reused." : error instanceof Error ? error.message : "The report could not be prepared. Please try again.");
    } finally {
      clearTimeout(timeout);
      if (request === prepareRequest.current) setPreparing(false);
    }
  }

  function downloadReport(format: ExportFormat) {
    if (!report || exporting) return;
    setExportError("");
    setExporting(format);
    const currentReport = report;
    let worker: Worker;
    const finish = () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      if (workerTimer.current) clearTimeout(workerTimer.current);
      setExporting(null);
    };
    try {
      worker = new Worker(new URL("./reportExport.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      workerTimer.current = setTimeout(() => {
        finish();
        setExportError("This download took too long to create. Please retry.");
      }, 120000);
      worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
        if (workerRef.current !== worker) return;
        if (event.data.error || !event.data.bytes?.byteLength) {
          finish();
          setExportError(event.data.error || "The download could not be created. Please retry.");
          return;
        }
        const bytes = new Uint8Array(event.data.bytes);
        const blob = new Blob([bytes], { type: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const identity = (currentReport.entity.ticker || currentReport.entity.name || currentReport.entity.cik).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 90);
        link.href = url;
        const reportingBasis = ["company", "market"].includes(currentReport.kind) ? `-${currentReport.period.basis}` : "";
        link.download = `${identity}-${currentReport.kind}${reportingBasis}-${currentReport.period.asOf || currentReport.generatedAt.slice(0, 10)}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        setDownloaded(items => items.includes(format) ? items : [...items, format]);
        finish();
      };
      worker.onerror = () => {
        if (workerRef.current !== worker) return;
        finish();
        setExportError("The download could not be created. Please retry.");
      };
      worker.postMessage({ format, report: currentReport });
    } catch {
      finish();
      setExportError("This browser could not start the download. Please retry in a current browser.");
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>EDGAR Terminal reports {preview && <span>Preview</span>}</p>
          <h1>Research you can<br /><em>take with you.</em></h1>
          <p className={styles.lead}>Build a company, fund or market report. Download a structured PDF and an Excel workbook with clear financial statements, trends and reporting dates.</p>
        </div>
        <div className={styles.formatIntro} aria-label="Two download formats">
          <div><FileText size={22} aria-hidden="true" /><span><strong>A report to read</strong><small>PDF · financial overview, charts & context</small></span></div>
          <div><FileSpreadsheet size={22} aria-hidden="true" /><span><strong>A workbook to use</strong><small>Excel · financial statements, ratios & trends</small></span></div>
        </div>
      </header>

      <section className={styles.builder} aria-labelledby="report-search-title">
        <div className={styles.searchHeading}><h2 id="report-search-title">What would you like to report on?</h2><span>01 <span aria-hidden="true">/</span> Choose your subject</span></div>
        <div className={styles.kindTabs} role="group" aria-label="Report type">
          {KINDS.map(item => <button key={item.id} type="button" aria-pressed={kind === item.id} onClick={() => changeKind(item.id)}><item.Icon size={17} aria-hidden="true" />{item.label}</button>)}
        </div>
        <p className={styles.kindDescription}>{config.detail}</p>
        {kind !== "market" && <><div className={styles.searchArea} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
          <div className={styles.searchInput}>
            <Search size={22} aria-hidden="true" />
            <input
              ref={inputRef} role="combobox" aria-label={config.placeholder} aria-autocomplete="list" aria-expanded={searchVisible}
              aria-controls={searchVisible ? listId : undefined} aria-activedescendant={activeIndex >= 0 && searchVisible && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
              placeholder={config.placeholder} value={query} autoComplete="off" maxLength={160}
              onFocus={() => setOpen(true)}
              onChange={event => { clearReport(); searchRequest.current++; searchController.current?.abort(); setSelected(null); setQuery(event.target.value); setOpen(true); }}
              onKeyDown={event => {
                if (event.key === "Escape") { setOpen(false); setActiveIndex(-1); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault(); setOpen(true);
                  if (results.length) setActiveIndex(index => event.key === "ArrowDown" ? Math.min(index + 1, results.length - 1) : Math.max(index - 1, 0));
                }
                if (event.key === "Enter" && open && results.length) {
                  event.preventDefault();
                  if (activeIndex >= 0 || results.length === 1) chooseEntity(results[activeIndex >= 0 ? activeIndex : 0]);
                  else setActiveIndex(0);
                }
              }}
            />
            {searchState === "loading" && !selected ? <LoaderCircle size={20} className={styles.spinner} aria-label="Searching" /> : query && <button type="button" aria-label="Clear search" onClick={() => { clearReport(); searchRequest.current++; searchController.current?.abort(); setQuery(""); setSelected(null); setOpen(true); inputRef.current?.focus(); }}><X size={19} aria-hidden="true" /></button>}
          </div>
          {searchVisible && <div className={styles.searchResults}>
            {searchState === "ready" && results.length > 0 && <p className={styles.srOnly} role="status">{results.length} matching {results.length === 1 ? "identity" : "identities"}. Use the up and down arrows, then Enter to select.</p>}
            <ul id={listId} role="listbox" aria-label="Matching SEC identities">
              {results.map((item, index) => <li key={`${item.kind}:${item.id}`} id={`${listId}-${index}`} role="option" aria-selected={activeIndex === index}>
                <button type="button" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => chooseEntity(item)}>
                  <span className={styles.resultIcon}><config.Icon size={18} aria-hidden="true" /></span>
                  <span className={styles.resultName}><strong>{item.ticker && <b>{item.ticker}</b>}{item.name}</strong><small>{item.detail || `CIK ${item.cik}`}{item.seriesId ? ` · ${item.seriesId}` : ""}</small></span>
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </li>)}
            </ul>
            {searchState === "loading" && <p className={styles.searchMessage} role="status">Finding matching SEC identities…</p>}
            {searchState === "ready" && !results.length && <p className={styles.searchMessage} role="status">No matching {kind === "13f" ? "manager" : kind === "nport" ? "fund" : "company"} found. Try a shorter name, {kind === "13f" ? "or the manager’s SEC CIK" : "a ticker or SEC CIK"}.</p>}
            {searchState === "error" && <div className={styles.searchMessage} role="alert"><p>{searchError}</p><button type="button" onClick={() => setSearchAttempt(value => value + 1)}>Retry search</button></div>}
            {searchWarning && <p className={styles.searchMessage}>{searchWarning}</p>}
          </div>}
        </div>
        <div className={styles.searchHint}><span>{kind === "nport" ? "Select the fund and share class. Holdings are reported at the portfolio series level." : kind === "13f" ? "Search the filing manager, which can represent more than one underlying fund." : "Search across SEC company identities, beyond the site’s example companies."}</span><span>Public SEC records</span></div></>}
        {kind === "market" && <div className={styles.marketIntro}><ChartNoAxesCombined size={28} aria-hidden="true" /><div><h3>The market, in one report</h3><p>Compare sector revenue growth, margins and financial strength, alongside CFTC futures positioning. Sector performance reflects business fundamentals; stock-price returns are not included.</p><p>The report shows the available company universe, fiscal periods and positioning dates so you can assess its coverage.</p></div></div>}

        {selected && <div className={styles.selection}>
          <div className={styles.selectedIdentity}><Check size={18} aria-hidden="true" /><div><strong>{selected.ticker ? `${selected.ticker} · ` : ""}{selected.name}</strong><p>{kind === "market" ? "SEC sector fundamentals and CFTC Commitments of Traders" : `CIK ${selected.cik}${selected.seriesId ? ` · Series ${selected.seriesId}` : ""}`}</p></div></div>
          <div className={styles.buildControls}>
            {(kind === "company" || kind === "market") && <label>Reporting basis<select value={basis} onChange={event => { clearReport(); setBasis(event.target.value as Basis); }}><option value="annual">Latest annual</option><option value="ttm">Trailing twelve months</option>{kind === "company" && <option value="quarter">Latest standalone quarter</option>}</select></label>}
            <button type="button" className={styles.buildButton} disabled={preparing} onClick={buildReport}>{preparing ? <><LoaderCircle size={17} className={styles.spinner} aria-hidden="true" />Preparing report</> : <>{report ? "Rebuild report" : "Build report"}<ArrowRight size={17} aria-hidden="true" /></>}</button>
          </div>
        </div>}
        {preparing && <div className={styles.preparing} role="status"><div><strong>Bringing the report together</strong><p>{kind === "market" ? "Compiling sector fundamentals, checking reporting periods and retrieving CFTC positioning." : "Retrieving reported figures and checking the selected identity. Company reports also check for relevant CFTC market context."}</p></div><button type="button" onClick={clearReport}>Cancel</button></div>}
        {prepareError && <div className={styles.error} role="alert"><p>{prepareError}</p><button type="button" onClick={buildReport}>Try again <ArrowRight size={15} aria-hidden="true" /></button></div>}
      </section>

      {!report && !preparing && <section className={styles.included} aria-label="Report contents">
        <div><p className={styles.eyebrow}>From source to finished report</p><h2>A clear summary.<br />The detail behind it.</h2></div>
        <ol><li><span>01</span><div><h3>Choose the right entity</h3><p>Confirm the SEC company, fund series or institutional manager before building.</p></div></li><li><span>02</span><div><h3>Review the reporting context</h3><p>See the selected period, available figures and any coverage gaps.</p></div></li><li><span>03</span><div><h3>Download both formats</h3><p>Read and share the PDF. Work with structured figures and reported positions in Excel.</p></div></li></ol>
      </section>}

      {report && <section className={styles.report} aria-labelledby="prepared-report-title">
        <header className={styles.reportHeader}><div><p className={styles.eyebrow}>02 / Your report</p><h2 id="prepared-report-title" ref={resultHeading} tabIndex={-1}>{report.title}</h2><p>{report.subtitle}</p></div><span className={`${styles.status} ${report.coverage.status === "partial" ? styles.partial : ""}`}><span aria-hidden="true" />{report.coverage.status === "partial" ? "Ready with coverage gaps" : "Ready to download"}</span></header>
        <div className={styles.reportDates}><p><span>Reporting period</span><strong>{report.period.label}</strong></p><p><span>{report.kind === "market" ? "Snapshot date" : "Period ending"}</span><strong>{formatValue(report.period.asOf, "date")}</strong></p><p><span>{report.kind === "market" ? "Scope" : report.kind === "company" ? "Latest source filing" : "Filed"}</span><strong>{report.kind === "market" ? "Sector fundamentals & CFTC" : formatValue(report.period.filingDate, "date")}</strong></p><p><span>Prepared</span><strong>{formatValue(report.generatedAt, "date")}</strong></p></div>
        <p className={styles.coverage}>{report.coverage.message}</p>
        <div className={styles.downloads}>
          <button type="button" disabled={!!exporting} onClick={() => downloadReport("pdf")}><FileText size={27} aria-hidden="true" /><span><strong>{exporting === "pdf" ? "Creating PDF…" : "Download PDF"}</strong><small>Structured report · ready to read</small></span>{exporting === "pdf" ? <LoaderCircle className={styles.spinner} size={20} aria-hidden="true" /> : downloaded.includes("pdf") ? <Check size={20} aria-label="Downloaded" /> : <ArrowDownToLine size={20} aria-hidden="true" />}</button>
          <button type="button" disabled={!!exporting} onClick={() => downloadReport("xlsx")}><FileSpreadsheet size={27} aria-hidden="true" /><span><strong>{exporting === "xlsx" ? "Creating workbook…" : "Download Excel"}</strong><small>Clean summary · structured financial data</small></span>{exporting === "xlsx" ? <LoaderCircle className={styles.spinner} size={20} aria-hidden="true" /> : downloaded.includes("xlsx") ? <Check size={20} aria-label="Downloaded" /> : <ArrowDownToLine size={20} aria-hidden="true" />}</button>
        </div>
        {exporting && <p className={styles.downloadStatus} role="status">Creating your {exporting === "pdf" ? "PDF report" : "Excel workbook"}…</p>}
        {!exporting && downloaded.length > 0 && <p className={styles.downloadStatus} role="status">{downloaded.map(format => format === "pdf" ? "PDF" : "Excel").join(" and ")} download started. You can download either file again.</p>}
        {exportError && <p className={styles.error} role="alert">{exportError}</p>}
        <div className={styles.metrics}>{report.summary.slice(0, 6).map((metric, index) => <div key={`${metric.label}:${index}`}><span>{metric.label}</span><strong>{formatValue(metric.value, metric.unit)}</strong>{metric.detail && <small>{metric.detail}</small>}</div>)}</div>
        {report.highlights.length > 0 && <div className={styles.highlights}>{report.highlights.slice(0, 4).map((highlight, index) => <article key={index}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{highlight.title}</h3><p>{highlight.text}</p></div></article>)}</div>}
        <div className={styles.contents}><div className={styles.contentsHeading}><h3>Inside the report</h3><p>Open a section for a short preview. Download the workbook for the full exported tables.</p></div>{report.sections.filter(section => section.id !== "observations").map(section => <details key={section.id}><summary><span>{section.title}<small>{section.rows.length.toLocaleString()} {section.rows.length === 1 ? "row" : "rows"}</small></span><ChevronDown size={17} aria-hidden="true" /></summary><div className={styles.sectionPreview}>{section.description && <p>{section.description}</p>}{section.rows.length ? <div className={styles.tableScroll}><table><thead><tr>{section.columns.slice(0, 6).map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{section.rows.slice(0, 5).map((row, index) => <tr key={index}>{section.columns.slice(0, 6).map(column => <td key={column.key}>{formatValue(row[column.key], column.formatKey ? row[column.formatKey] as ReportFormat : column.format)}</td>)}</tr>)}</tbody></table></div> : <p>No supported rows were available for this section.</p>}{(section.rows.length > 5 || section.columns.length > 6) && <p className={styles.previewNote}>Preview shows up to five rows and six columns. The workbook includes the full exported table.</p>}{section.footnote && <p className={styles.previewNote}>{section.footnote}</p>}</div></details>)}</div>
        <details className={styles.sources}><summary>Sources & reporting notes <span>{displayedSources.length.toLocaleString()} references</span></summary><div>{report.notes.map((note, index) => <p key={index}>{note}</p>)}<ul>{displayedSources.slice(0, 8).map((source, index) => { const url = safeSourceUrl(source.url); return <li key={`${source.id}:${index}`}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.label}<ArrowUpRight size={14} aria-hidden="true" /></a> : <span>{source.label}</span>}{source.periodEnd && <small>Period ending {formatValue(source.periodEnd, "date")}</small>}</li>; })}</ul>{displayedSources.length > 8 && <p>Source references are retained in the PDF report.</p>}</div></details>
      </section>}
      <footer className={styles.footerNote}>Reports reflect available public disclosures and their reporting dates. Unsupported figures remain unavailable. N-PORT portfolios and 13F holdings have different coverage; neither is a live portfolio.</footer>
    </div>
  );
}
