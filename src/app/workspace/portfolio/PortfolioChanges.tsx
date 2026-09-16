"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, Download, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { comparePortfolioResearch } from "../../../utils/portfolioChanges.js";
import { buildPortfolioRecentSecEvents, isPortfolioRecentDate } from "../../../utils/portfolioRecentChanges.js";
import { loadPortfolioCftcChanges } from "../../../utils/portfolioCftcChangesClient.js";
import { downloadText } from "../../../utils/download.js";
import styles from "./PortfolioChanges.module.css";

const WINDOWS = [7, 30, 60] as const;
const KIND_LABELS: Record<string, string> = {
  filing: "SEC filing", revision: "Evidence value change", period: "Reporting period", coverage: "Evidence coverage",
};
function displayDate(value: string | null | undefined, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  // SEC filing and COT report dates are calendar dates, not midnight in the viewer's zone.
  return new Date(value).toLocaleString(undefined, withTime
    ? { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }
    : { dateStyle: "medium", timeZone: "UTC" }) + (withTime ? " UTC" : "");
}
function observation(value: string, kind: string) {
  if (kind !== "period") return value;
  try {
    const period = JSON.parse(value);
    return [period.kind?.toUpperCase(), period.start && `from ${period.start}`, period.end && `ending ${period.end}`].filter(Boolean).join(" · ") || "Period unavailable";
  } catch { return value; }
}
function signed(value: number | null | undefined, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function relatedCompanies(event: any): any[] {
  return event.source === "cftc" ? event.relatedCompanies || [event] : [event];
}
function sourceLinks(event: any): string[] {
  return [...new Set<string>([...(event.beforeSources || []), ...(event.afterSources || [])])];
}

type Props = {
  baseline: any; allocation?: any; snapshot: any; rows: any[];
  onInspectCompany: (rowId: string) => void; onRefresh?: () => void; refreshing?: boolean;
};
type CftcState = { key: string; loading: boolean; data: any | null; error: string; retryAt?: number };

export default function PortfolioChanges({ baseline, allocation, snapshot, rows, onInspectCompany, onRefresh, refreshing = false }: Props) {
  const comparison = useMemo(() => comparePortfolioResearch(baseline, snapshot, rows), [baseline, snapshot, rows]);
  const [source, setSource] = useState<"all" | "sec" | "cftc">("all");
  const [company, setCompany] = useState("all");
  const [windowDays, setWindowDays] = useState<number>(30);
  const [limit, setLimit] = useState(20);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [exportMessage, setExportMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [cftcState, setCftc] = useState<CftcState>({ key: "", loading: true, data: null, error: "" });
  const retainedCftc = useRef<{ key: string; data: any; retry: number }>({ key: "", data: null, retry: 0 });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const currentDay = new Date(now).toISOString().slice(0, 10);
  const weights = useMemo(() => allocation?.basis && allocation.basis !== "none"
    ? Object.fromEntries((allocation.issuers || []).map((item: any) => [item.cik, item.weightPct])) : {}, [allocation]);
  const recentSec = useMemo(() => buildPortfolioRecentSecEvents({ comparison, snapshot, rows, windowDays, now, weights }), [comparison, snapshot, rows, windowDays, now, weights]);

  const companies = useMemo(() => {
    const unique = new Map<string, any>();
    for (const row of rows || []) {
      const { ticker, cik } = row.resolution || {};
      if (!ticker || !/^\d{10}$/.test(cik || "") || unique.has(cik) || row.excluded || row.mergedInto || row.duplicateChoice === "remove") continue;
      unique.set(cik, { ticker, cik, rowId: row.id, companyName: row.resolution.name || ticker });
    }
    return [...unique.values()];
  }, [rows]);
  const selectedCompany = companies.some((item) => item.cik === company) ? company : "all";
  // A company/window filter is local: it must not restart the full portfolio's research.
  const requestCompanies = useMemo(() => [...companies].sort((a, b) => a.cik.localeCompare(b.cik))
    .map(({ ticker, cik, rowId }) => ({ ticker, cik, rowId })), [companies]);
  const requestKey = JSON.stringify(requestCompanies);
  const captureKey = snapshot?.generated_at || "";
  // Never briefly render another portfolio's results before its effect runs.
  const cftc = cftcState.key === requestKey ? cftcState : { loading: true, data: null, error: "", retryAt: 0 };
  useEffect(() => {
    const identifiers = JSON.parse(requestKey);
    const previous = retainedCftc.current.key === requestKey ? retainedCftc.current.data : null;
    const retryOnly = retry !== retainedCftc.current.retry;
    retainedCftc.current = { key: requestKey, data: previous, retry };
    if (!identifiers.length || refreshing) {
      setCftc({ key: requestKey, loading: false, data: previous, error: "" });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setCftc({ key: requestKey, loading: true, data: previous, error: "" });
    // Deferring the start also avoids a duplicate request during development Strict Mode remounts.
    const timer = setTimeout(() => {
      loadPortfolioCftcChanges(identifiers, {
        signal: controller.signal, previous, retryOnly,
        onUpdate: (data: any) => {
          if (!active) return;
          retainedCftc.current = { key: requestKey, data, retry };
          setCftc({ key: requestKey, loading: true, data, error: "" });
        },
      }).then((data) => {
        if (!active) return;
        retainedCftc.current = { key: requestKey, data, retry };
        setCftc({ key: requestKey, loading: false, data, error: "" });
      }).catch((error) => {
        if (!active) return;
        setCftc({ key: requestKey, loading: false, data: retainedCftc.current.data,
          error: error instanceof Error ? error.message : "CFTC market context is unavailable.", retryAt: error?.retryAt || 0 });
      });
    }, 0);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [requestKey, captureKey, retry, currentDay, refreshing]);

  const allEvents = useMemo(() => {
    const market = (cftc.data?.events || []).filter((event: any) => isPortfolioRecentDate(event.reportDate, windowDays, now))
      .map((event: any) => ({ ...event, eventDate: event.reportDate, dateBasis: "report" }));
    return [...recentSec.events, ...market].sort((a: any, b: any) => String(b.eventDate).localeCompare(String(a.eventDate))
      || (a.source === b.source ? String(a.title).localeCompare(String(b.title)) : a.source === "sec" ? -1 : 1));
  }, [recentSec.events, cftc.data, windowDays, now]);
  const filtered = useMemo(() => allEvents.filter((event: any) => (source === "all" || event.source === source)
    && (selectedCompany === "all" || relatedCompanies(event).some((item) => item.cik === selectedCompany))), [allEvents, source, selectedCompany]);
  const counts = useMemo(() => ({
    companies: new Set(filtered.flatMap((event: any) => relatedCompanies(event).filter((item) => selectedCompany === "all" || item.cik === selectedCompany).map((item) => item.cik || item.ticker))).size,
    sec: filtered.filter((event: any) => event.source === "sec").length,
    cftc: filtered.filter((event: any) => event.source === "cftc").length,
  }), [filtered, selectedCompany]);
  function toggleDetails(id: string) {
    setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function clearFilters() { setSource("all"); setCompany("all"); setLimit(20); }
  function exportChanges() {
    const header = ["date", "date_basis", "source", "related_tickers", "change_type", "title", "description", "earlier", "current", "net_contract_change", "net_oi_change_percentage_points", "open_interest_change_pct", "report_family", "report_scope", "primary_source", "sec_connection_sources", "sec_connection_excerpts"];
    const lines = filtered.map((event: any) => [
      event.eventDate, event.dateBasis, event.source.toUpperCase(), relatedCompanies(event).map((item) => item.ticker).join("; "),
      event.source === "sec" ? KIND_LABELS[event.kind] || event.kind : "CFTC market context", event.title, event.description,
      event.source === "sec" ? observation(event.before, event.kind) : event.priorDate,
      event.source === "sec" ? observation(event.after, event.kind) : event.reportDate,
      event.source === "cftc" ? event.netChange : "", event.source === "cftc" ? event.netPctChange : "",
      event.source === "cftc" ? event.openInterestChangePct : "", event.family || "", event.reportBasis || "",
      event.source === "cftc" ? event.cftcSource : event.afterSources?.[0] || event.beforeSources?.[0] || "",
      event.source === "cftc" ? relatedCompanies(event).map((item) => item.candidate?.filing?.url).filter(Boolean).join("; ") : "",
      event.source === "cftc" ? relatedCompanies(event).flatMap((item) => (item.candidate?.evidence || []).map((evidence: any) => `${item.ticker}: ${evidence.text}`)).join("; ") : "",
    ].map(csvCell).join(","));
    downloadText("portfolio-recent-changes.csv", [header.join(","), ...lines].join("\n"), "text/csv");
    setExportMessage(`Exported ${filtered.length} recent update${filtered.length === 1 ? "" : "s"}.`);
  }
  const coverage = cftc.data?.coverage;
  const preparation = cftc.data?.preparation;
  const retryBlocked = cftc.loading || !!(cftc.retryAt && cftc.retryAt > now);
  const staleCapture = snapshot?.generated_at && String(snapshot.generated_at).slice(0, 10) < currentDay;

  return (
    <section className={styles.root} aria-labelledby="portfolio-changes-heading">
      <header className={styles.header}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>RECENT UPDATES</p>
          <h3 id="portfolio-changes-heading">What changed?</h3>
          <p>Company filings, changes in collected SEC evidence, and related futures-market moves.</p>
        </div>
        {onRefresh && <button type="button" className={styles.refreshButton} onClick={onRefresh} disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? styles.spinning : ""} aria-hidden="true" />{refreshing ? "Refreshing research…" : "Refresh all research"}
        </button>}
      </header>
      <div className={styles.contextBar}>
        <div><span className={styles.contextLabel}>Recent window</span><strong>Last {windowDays} days · through {displayDate(currentDay)}</strong></div>
        <div><span className={styles.contextLabel}>SEC research captured</span><strong>{displayDate(snapshot?.generated_at, true)}</strong></div>
        <div className={styles.checkState}>{recentSec.checkedIssuers} issuers checked{recentSec.uncheckedIssuers ? ` · ${recentSec.uncheckedIssuers} need retry` : ""}</div>
      </div>
      {staleCapture && <p className={styles.quietWarning}>SEC filings reflect the saved capture. Refresh research to check for filings submitted since {displayDate(snapshot.generated_at)}.</p>}
      {!snapshot && <p className={styles.warning} role="status">Run research to load recent SEC filings for these companies.</p>}
      <div className={styles.summary} aria-label="Recent change summary">
        <div><strong>{counts.companies}</strong><span>related companies</span></div>
        <div><strong>{counts.sec}</strong><span>SEC updates</span></div>
        <div><strong>{cftc.loading && !cftc.data ? "…" : (!cftc.data || cftc.data?.coverage?.checked === 0 || (!cftc.data?.coverage?.marketsChecked && cftc.data?.coverage?.marketUnavailable > 0)) ? "—" : counts.cftc}</strong><span>CFTC market moves</span></div>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.sourceTabs} aria-label="Data source filter">
          {(["all", "sec", "cftc"] as const).map((value) => <button type="button" key={value} className={source === value ? styles.sourceTabActive : styles.sourceTab} aria-pressed={source === value} onClick={() => { setSource(value); setLimit(20); }}>
            {value === "all" ? "All updates" : value === "sec" ? "SEC" : "CFTC markets"}
          </button>)}
        </div>
        <label className={styles.compactField}><span>Company</span><select value={selectedCompany} onChange={(event) => { setCompany(event.target.value); setLimit(20); }}>
          <option value="all">All companies</option>{companies.map((entry) => <option key={entry.cik} value={entry.cik}>{entry.ticker}</option>)}
        </select></label>
        <label className={styles.compactField}><span>Window</span><select value={windowDays} onChange={(event) => { setWindowDays(Number(event.target.value)); setLimit(20); }}>
          {WINDOWS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
        </select></label>
        <button type="button" className={styles.iconButton} onClick={exportChanges} disabled={!filtered.length}><Download size={16} aria-hidden="true" />Export</button>
      </div>
      <div className={styles.feedMeta} aria-live="polite">
        <span>{filtered.length} update{filtered.length === 1 ? "" : "s"}</span>
        {cftc.loading && <span className={styles.loadingText}>{cftc.data ? "Updating CFTC coverage…" : "Loading CFTC coverage…"}</span>}
        {coverage && <span>CFTC: {coverage.checked} of {coverage.totalCompanies ?? companies.length} companies checked{coverage.pending > 0 ? ` · ${coverage.pending} pending` : ""}{coverage.unavailable > 0 ? ` · ${coverage.unavailable} need retry` : ""}.</span>}
        {preparation?.checkedAt && <span>Prepared {displayDate(preparation.checkedAt, true)}</span>}
      </div>
      {cftc.error && <p className={styles.warning} role="status">CFTC update could not finish: {cftc.error}{cftc.data ? " Available results remain visible." : ""} {cftc.retryAt && cftc.retryAt > now ? `Try again after ${displayDate(new Date(cftc.retryAt).toISOString(), true)}.` : ""} <button type="button" className={styles.textButton} disabled={retryBlocked} onClick={() => setRetry((value) => value + 1)}>Retry unfinished checks</button></p>}
      {preparation?.status === "stale" && <p className={styles.quietWarning} role="status">Showing the last prepared CFTC results while background updates catch up. Check report dates before interpreting market moves.</p>}
      {coverage && (coverage.unavailable > 0 || coverage.marketUnavailable > 0 || coverage.staleMarkets > 0 || coverage.partialMarkets > 0) && <p className={styles.quietWarning} role="status">CFTC coverage is incomplete: {coverage.unavailable} company checks unavailable, {coverage.marketUnavailable || 0} markets unavailable{coverage.staleMarkets ? `, ${coverage.staleMarkets} markets have older source data` : ""}{coverage.partialMarkets ? `, ${coverage.partialMarkets} markets have incomplete history` : ""}. Missing data does not mean no change. <button type="button" className={styles.textButton} disabled={retryBlocked} onClick={() => setRetry((value) => value + 1)}>{preparation ? "Check prepared updates" : "Retry unfinished checks"}</button></p>}
      {exportMessage && <p className={styles.statusMessage} role="status">{exportMessage}</p>}
      {!filtered.length ? <div className={styles.empty}>
        <div className={styles.emptyIcon}>{source === "cftc" ? <Activity size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}</div>
        <div><h4>{cftc.loading && source !== "sec" ? "Checking recent market moves…" : "No updates match this view."}</h4>
          <p>{source === "cftc" ? "Only filing-linked markets with a qualifying weekly move appear here. Review coverage before concluding there were no changes." : `No dated updates in the available evidence match these filters for the last ${windowDays} days.`}</p>
          {(source !== "all" || selectedCompany !== "all") && <button type="button" className={styles.textButton} onClick={clearFilters}>Clear filters</button>}
        </div>
      </div> : <ol className={styles.timeline}>
        {filtered.slice(0, limit).map((event: any) => {
          const isCftc = event.source === "cftc", isOpen = expanded.has(event.id);
          const related = relatedCompanies(event);
          const delta = !isCftc && typeof event.beforeValue === "number" && typeof event.afterValue === "number" ? event.afterValue - event.beforeValue : null;
          return <li key={event.id} className={styles.event}>
            <div className={`${styles.sourceMark} ${isCftc ? styles.cftcMark : styles.secMark}`} aria-hidden="true">{isCftc ? <Activity size={16} /> : <FileText size={16} />}</div>
            <div className={styles.eventBody}>
              <div className={styles.eventTopline}>
                <span className={styles.ticker}>{isCftc ? event.contractName : event.ticker || event.companyName}</span>
                <span className={isCftc ? styles.cftcBadge : styles.secBadge}>{isCftc ? "CFTC · Market context" : KIND_LABELS[event.kind] || "SEC"}</span>
                <time dateTime={event.eventDate}>{isCftc ? "Positions as of " : event.dateBasis === "observed" ? "Observed " : "Filed "}{displayDate(event.eventDate)}</time>
              </div>
              <div className={styles.eventHeadline}>
                <div><h4>{event.title}</h4><p>{event.description}</p></div>
                <button type="button" className={styles.detailsButton} onClick={() => toggleDetails(event.id)} aria-expanded={isOpen} aria-controls={`details-${event.id}`}>Details <ChevronDown size={14} className={isOpen ? styles.chevronOpen : ""} aria-hidden="true" /></button>
              </div>
              <div className={styles.quickFacts}>
                {isCftc ? <>
                  <span><small>Weekly net change</small><strong>{signed(event.netChange)} contracts</strong></span>
                  <span><small>Net / open interest</small><strong>{signed(event.netPctChange, 2)} percentage points</strong></span>
                  {typeof event.openInterestChangePct === "number" && <span><small>Open interest</small><strong>{signed(event.openInterestChangePct, 2)}%</strong></span>}
                  <span><small>Related companies</small><strong>{related.map((item) => item.ticker).join(", ")}</strong></span>
                </> : <>
                  {event.filing?.form && <span><small>Form</small><strong>{event.filing.form}</strong></span>}
                  {delta !== null && <span><small>Observed value change</small><strong>{signed(delta, 2)} {event.unit === "%" ? "percentage points" : event.unit || ""}</strong></span>}
                  {typeof event.knownWeightPct === "number" && <span><small>Portfolio allocation</small><strong>{event.knownWeightPct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</strong></span>}
                </>}
              </div>
              {isOpen && <div className={styles.detailsPanel} id={`details-${event.id}`}>
                {isCftc ? <>
                  <div className={styles.detailGrid}>
                    <div><small>Prior observation</small><strong>{displayDate(event.priorDate)}</strong></div><div><small>Current observation</small><strong>{displayDate(event.reportDate)}</strong></div>
                    <div><small>Long change</small><strong>{signed(event.longChange)} contracts</strong></div><div><small>Short change</small><strong>{signed(event.shortChange)} contracts</strong></div>
                    <div><small>Report scope</small><strong>{event.family === "tff" ? "Traders in Financial Futures" : "Disaggregated"} · Futures only · {event.traderGroupLabel}</strong></div>
                    <div><small>Contract / exchange</small><strong>{event.contract} · {event.exchange || event.contractName}</strong></div>
                  </div>
                  {event.refreshWarning && <p className={styles.warning}>{event.refreshWarning}</p>}
                  <div className={styles.connectionNote}><strong>Why this market is shown</strong>
                    {related.map((item) => <div key={item.cik || item.ticker} className={styles.companyConnection}>
                      <p><b>{item.ticker}</b> · {item.candidate?.reason}</p>
                      {item.candidate?.evidence?.map((evidence: any, index: number) => <blockquote key={`${evidence.accession}:${index}`} className={styles.sourceExcerpt}>{evidence.text}</blockquote>)}
                      {item.candidate?.reviewQuestion && <p>{item.candidate.reviewQuestion}</p>}
                      <div className={styles.linkRow}>
                        {item.candidate?.filing?.url && <a href={item.candidate.filing.url} target="_blank" rel="noreferrer">{item.ticker} SEC {item.candidate.filing.form} · {displayDate(item.candidate.filing.filed)} <ExternalLink size={14} aria-hidden="true" /></a>}
                        {item.rowId && <button type="button" className={styles.textButton} onClick={() => onInspectCompany(item.rowId)}>Inspect {item.ticker}</button>}
                      </div>
                    </div>)}
                  </div>
                  <div className={styles.linkRow}>
                    {event.cftcSource && <a href={event.cftcSource} target="_blank" rel="noreferrer">Official CFTC data <ExternalLink size={14} aria-hidden="true" /></a>}
                    <Link href={event.marketPath}>Open this report in positioning <ExternalLink size={14} aria-hidden="true" /></Link>
                  </div>
                  <p className={styles.disclaimer}>These are aggregate futures positions, not the companies’ trades, hedge amounts, or a price forecast. Observation dates are not publication dates: COT is usually released Friday for Tuesday positions.</p>
                </> : <>
                  <div className={styles.detailGrid}>
                    {event.kind === "filing" ? <>
                      <div><small>SEC accession</small><strong>{event.filing?.accession || event.after}</strong></div>
                      <div><small>Reported period / event date</small><strong>{displayDate(event.filing?.reportDate)}</strong></div>
                    </> : <>
                      <div><small>Earlier collected evidence</small><strong>{observation(event.before, event.kind)}</strong></div><div><small>Current collected evidence</small><strong>{observation(event.after, event.kind)}</strong></div>
                    </>}
                  </div>
                  <div className={styles.linkRow}>{sourceLinks(event).map((url, index, links) => <a key={url} href={url} target="_blank" rel="noreferrer">SEC source{links.length > 1 ? ` ${index + 1}` : ""} <ExternalLink size={14} aria-hidden="true" /></a>)}</div>
                  {event.kind === "revision" && <p className={styles.disclaimer}>This is a change in collected evidence for a comparable period. It does not by itself establish a company restatement.</p>}
                  {event.rowId && <button type="button" className={styles.inspectButton} onClick={() => onInspectCompany(event.rowId)}>Inspect company</button>}
                </>}
              </div>}
            </div>
          </li>;
        })}
      </ol>}
      {filtered.length > 20 && <button type="button" className={styles.showMore} onClick={() => setLimit(limit >= filtered.length ? 20 : Math.min(filtered.length, limit + 20))}>{limit >= filtered.length ? "Show first 20" : `Show more · ${Math.min(limit, filtered.length)} of ${filtered.length}`}</button>}
      <details className={styles.methodDetails}>
        <summary>Coverage & how updates are selected</summary>
        <p>Recent means the last {windowDays} calendar days through today (UTC). SEC filings use their actual filing date and are available from the first capture. Filing references cover the records retrieved for each company, not its complete filing archive.</p>
        <p>{comparison.baselineAt ? `Evidence comparisons use the checkpoint from ${displayDate(comparison.baselineAt, true)}. ` : "A completed refresh creates a checkpoint for future evidence comparisons. "}Reporting-period and value changes are dated when observed in the capture; coverage changes are retrieval status, not company developments.</p>
        {!!comparison.warnings.length && comparison.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}
        {recentSec.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}
        {recentSec.coverageEvents.length > 0 && <p>{recentSec.coverageEvents.length} evidence-coverage changes are excluded from the activity count.</p>}
        <p>CFTC shows one event per market, trader category and report, with related companies grouped together. A weekly move qualifies when net positioning as a share of open interest changes by at least 1 percentage point, or total open interest changes by at least 5%. These are display thresholds, not statistical significance or measured company impact. Net equals longs minus shorts; each date uses its own open-interest denominator.</p>
        <p>Connections come from candidate SEC annual-filing passages and need review. Prepared demo results are shared across visitors and updated in the background. Other companies are checked in successive batches of up to 24, with unfinished checks reported above. Weekly comparisons require observations exactly one week apart. Company and window filters use the loaded results without another market-data request.</p>
        {coverage && <p>{coverage.noLink || 0} issuers had no supported market connection; {coverage.noFiling || 0} had no eligible annual filing; {coverage.noComparison || 0} observations lacked a comparable prior week; {coverage.identityMismatch || 0} identity mismatches were excluded.</p>}
        <p><Link href="/workspace/demo/changes" className={styles.textButton}>Read the public 100-company changes summary</Link> for dated findings, coverage, and source links.</p>
      </details>
    </section>
  );
}
