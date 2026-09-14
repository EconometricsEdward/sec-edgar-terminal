"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
} from "lucide-react";
import { comparePortfolioResearch } from "../../../utils/portfolioChanges.js";
import { downloadText } from "../../../utils/download.js";
import styles from "./PortfolioChanges.module.css";

const WINDOWS = [7, 30, 60] as const;
const KIND_LABELS: Record<string, string> = {
  filing: "SEC filing",
  revision: "Financial revision",
  period: "Reporting period",
  coverage: "Evidence coverage",
};

function displayDate(value: string | null | undefined, withTime = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Date unavailable";
  return new Date(value).toLocaleString(undefined, withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" });
}

function cutoffDate(anchor: string | null | undefined, days: number) {
  const time = Date.parse(anchor || "");
  if (!Number.isFinite(time)) return "0000-00-00";
  return new Date(time - days * 86400000).toISOString().slice(0, 10);
}

function observation(value: string, kind: string) {
  if (kind !== "period") return value;
  try {
    const period = JSON.parse(value);
    return [
      period.kind?.toUpperCase(),
      period.start && `from ${period.start}`,
      period.end && `ending ${period.end}`,
    ].filter(Boolean).join(" · ") || "Period unavailable";
  } catch {
    return value;
  }
}

function signed(value: number | null | undefined, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sourceLinks(change: any) {
  return [...new Set([...(change.beforeSources || []), ...(change.afterSources || [])])];
}

type Props = {
  baseline: any;
  allocation?: any;
  snapshot: any;
  rows: any[];
  onInspectCompany: (rowId: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
};

type CftcState = {
  loading: boolean;
  data: any | null;
  error: string;
};

export default function PortfolioChanges({
  baseline,
  allocation,
  snapshot,
  rows,
  onInspectCompany,
  onRefresh,
  refreshing = false,
}: Props) {
  const comparison = useMemo(
    () => comparePortfolioResearch(baseline, snapshot, rows),
    [baseline, snapshot, rows],
  );
  const [source, setSource] = useState<"all" | "sec" | "cftc">("all");
  const [company, setCompany] = useState("all");
  const [windowDays, setWindowDays] = useState<number>(30);
  const [limit, setLimit] = useState(20);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [exportMessage, setExportMessage] = useState("");
  const [cftc, setCftc] = useState<CftcState>({ loading: false, data: null, error: "" });

  const anchorDate = comparison.capturedAt || snapshot?.generated_at || null;
  const cutoff = cutoffDate(anchorDate, windowDays);
  const weights = useMemo(
    () => allocation?.basis && allocation.basis !== "none"
      ? Object.fromEntries((allocation.issuers || []).map((item: any) => [item.cik, item.weightPct]))
      : {},
    [allocation],
  );

  const filingIndex = useMemo(() => {
    const map = new Map<string, any>();
    for (const issuer of snapshot?.companies || []) {
      const filings = [
        ...(issuer.filings || []),
        issuer.latestAnnualFiling,
        issuer.latestInterimFiling,
      ].filter(Boolean);
      for (const filing of filings) {
        if (filing?.accession && !map.has(`${issuer.cik}:${filing.accession}`))
          map.set(`${issuer.cik}:${filing.accession}`, filing);
      }
    }
    return map;
  }, [snapshot]);

  const secEvents = useMemo(() => {
    const observed = String(comparison.capturedAt || "").slice(0, 10);
    return (comparison.changes || []).flatMap((change: any) => {
      const filing = change.kind === "filing"
        ? filingIndex.get(`${change.cik}:${change.after}`)
        : null;
      const eventDate = filing?.filingDate || observed;
      if (!eventDate || eventDate < cutoff) return [];
      return [{
        ...change,
        source: "sec",
        eventDate,
        filing,
        knownWeightPct: typeof weights[change.cik] === "number" ? weights[change.cik] : null,
      }];
    });
  }, [comparison, filingIndex, cutoff, weights]);

  const priorityCompanies = useMemo(() => {
    const rowByCik = new Map(
      (rows || []).map((row: any) => [row.resolution?.cik, row]),
    );
    const ordered: any[] = [];
    const seen = new Set<string>();
    const add = (row: any) => {
      const ticker = row?.resolution?.ticker;
      const cik = row?.resolution?.cik;
      if (!ticker || !/^\d{10}$/.test(cik || "") || seen.has(cik)) return;
      if (row.excluded || row.mergedInto || row.duplicateChoice === "remove") return;
      seen.add(cik);
      ordered.push({ ticker, cik, rowId: row.id });
    };
    for (const change of comparison.changes || []) add(rowByCik.get(change.cik));
    for (const row of rows || []) add(row);
    return ordered.slice(0, 24);
  }, [comparison, rows]);

  useEffect(() => {
    if (comparison.state !== "ready" || !priorityCompanies.length) {
      setCftc({ loading: false, data: null, error: "" });
      return;
    }
    const controller = new AbortController();
    setCftc((current) => ({ ...current, loading: true, error: "" }));
    fetch("/api/v1/cftc/portfolio-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companies: priorityCompanies, days: windowDays }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "CFTC market context is unavailable.");
        return body;
      })
      .then((data) => setCftc({ loading: false, data, error: "" }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setCftc({
          loading: false,
          data: null,
          error: error instanceof Error ? error.message : "CFTC market context is unavailable.",
        });
      });
    return () => controller.abort();
  }, [comparison.state, priorityCompanies, windowDays]);

  const allEvents = useMemo(() => {
    const market = (cftc.data?.events || []).map((event: any) => ({
      ...event,
      eventDate: event.reportDate,
      knownWeightPct: typeof weights[event.cik] === "number" ? weights[event.cik] : null,
    }));
    return [...secEvents, ...market].sort((a: any, b: any) =>
      String(b.eventDate).localeCompare(String(a.eventDate)) ||
      (a.source === b.source ? String(a.ticker).localeCompare(String(b.ticker)) : a.source === "sec" ? -1 : 1),
    );
  }, [secEvents, cftc.data, weights]);

  const companyOptions = useMemo(
    () => [...new Map(allEvents.map((event: any) => [event.cik || event.ticker, {
      id: event.cik || event.ticker,
      label: event.ticker || event.companyName,
    }])).values()] as { id: string; label: string }[],
    [allEvents],
  );
  const filtered = useMemo(
    () => allEvents.filter((event: any) =>
      (source === "all" || event.source === source) &&
      (company === "all" || (event.cik || event.ticker) === company),
    ),
    [allEvents, source, company],
  );
  const counts = useMemo(() => ({
    companies: new Set(allEvents.map((event: any) => event.cik || event.ticker)).size,
    sec: allEvents.filter((event: any) => event.source === "sec").length,
    cftc: allEvents.filter((event: any) => event.source === "cftc").length,
  }), [allEvents]);

  function toggleDetails(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setSource("all");
    setCompany("all");
    setLimit(20);
  }

  function exportChanges() {
    const header = [
      "date", "source", "ticker", "company", "change_type", "title", "description",
      "earlier", "current", "net_contract_change", "net_oi_change_pp", "primary_source",
    ];
    const lines = filtered.map((event: any) => [
      event.eventDate,
      event.source.toUpperCase(),
      event.ticker,
      event.companyName,
      event.source === "sec" ? KIND_LABELS[event.kind] || event.kind : "CFTC positioning",
      event.title,
      event.description,
      event.source === "sec" ? event.before : event.priorDate,
      event.source === "sec" ? event.after : event.reportDate,
      event.source === "cftc" ? event.netChange : "",
      event.source === "cftc" ? event.netPctChange : "",
      event.source === "cftc" ? event.cftcSource : event.afterSources?.[0] || event.beforeSources?.[0] || "",
    ].map(csvCell).join(","));
    downloadText(
      "portfolio-recent-changes.csv",
      [header.join(","), ...lines].join("\n"),
      "text/csv;charset=utf-8",
    );
    setExportMessage(`Exported ${filtered.length} recent change${filtered.length === 1 ? "" : "s"}.`);
  }

  const startingPoint = comparison.baselineAt === comparison.capturedAt && !comparison.changes.length;

  return (
    <section className={styles.root} aria-labelledby="portfolio-changes-heading">
      <header className={styles.header}>
        <div className={styles.headingCopy}>
          <p className={styles.eyebrow}>RECENT RESEARCH ACTIVITY</p>
          <h3 id="portfolio-changes-heading">What changed?</h3>
          <p>Recent SEC evidence changes and filing-linked CFTC market context, ordered by date and stripped down to what needs attention.</p>
        </div>
        {onRefresh && (
          <button type="button" className={styles.refreshButton} onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? styles.spinning : ""} aria-hidden="true" />
            {refreshing ? "Refreshing research…" : "Refresh all research"}
          </button>
        )}
      </header>

      {comparison.state === "needs_baseline" ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}><RefreshCw size={20} aria-hidden="true" /></div>
          <div>
            <h4>Your next complete refresh starts the change feed.</h4>
            <p>{snapshot ? "Run a complete refresh to compare this capture with newly retrieved SEC evidence." : "Run research to create the first capture. The next successful full refresh will reveal newly observed filings and comparable evidence changes."}</p>
          </div>
        </div>
      ) : comparison.state === "incompatible" ? (
        <div className={styles.warning} role="status">{comparison.warnings.join(" ")}</div>
      ) : (
        <>
          <div className={styles.contextBar}>
            <div>
              <span className={styles.contextLabel}>Compared with</span>
              <strong>{displayDate(comparison.baselineAt, true)}</strong>
            </div>
            <span className={styles.contextDivider} aria-hidden="true" />
            <div>
              <span className={styles.contextLabel}>Current capture</span>
              <strong>{displayDate(comparison.capturedAt, true)}</strong>
            </div>
            <div className={styles.checkState}>
              <span className={comparison.uncheckedIssuers ? styles.dotWarn : styles.dotReady} aria-hidden="true" />
              {comparison.checkedIssuers} checked{comparison.uncheckedIssuers ? ` · ${comparison.uncheckedIssuers} need retry` : ""}
            </div>
          </div>

          <div className={styles.summary} aria-label="Recent change summary">
            <div><strong>{counts.companies}</strong><span>companies with activity</span></div>
            <div><strong>{counts.sec}</strong><span>SEC evidence changes</span></div>
            <div><strong>{cftc.loading ? "…" : counts.cftc}</strong><span>CFTC context changes</span></div>
          </div>

          {!!comparison.warnings.length && (
            <div className={styles.warning} role="status">
              {comparison.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}
            </div>
          )}

          <div className={styles.toolbar}>
            <div className={styles.sourceTabs} aria-label="Data source filter">
              {(["all", "sec", "cftc"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={source === value ? styles.sourceTabActive : styles.sourceTab}
                  aria-pressed={source === value}
                  onClick={() => { setSource(value); setLimit(20); }}
                >
                  {value === "all" ? "All updates" : value.toUpperCase()}
                </button>
              ))}
            </div>
            <label className={styles.compactField}>
              <span>Company</span>
              <select value={company} onChange={(event) => { setCompany(event.target.value); setLimit(20); }}>
                <option value="all">All companies</option>
                {companyOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <label className={styles.compactField}>
              <span>Window</span>
              <select value={windowDays} onChange={(event) => { setWindowDays(Number(event.target.value)); setLimit(20); }}>
                {WINDOWS.map((days) => <option key={days} value={days}>Last {days} days</option>)}
              </select>
            </label>
            <button type="button" className={styles.iconButton} onClick={exportChanges} disabled={!filtered.length} title="Export visible changes">
              <Download size={16} aria-hidden="true" />
              Export
            </button>
          </div>

          <div className={styles.feedMeta}>
            <span>{filtered.length} recent update{filtered.length === 1 ? "" : "s"}</span>
            {cftc.loading && <span className={styles.loadingText}><span className={styles.pulse} aria-hidden="true" /> Adding CFTC context…</span>}
            {!cftc.loading && cftc.data?.coverage?.limited && <span>CFTC scan prioritized {cftc.data.coverage.requested} issuers with recent SEC changes first.</span>}
          </div>
          {cftc.error && <p className={styles.quietWarning} role="status">CFTC context could not be added right now: {cftc.error} SEC changes remain available.</p>}
          {exportMessage && <p className={styles.statusMessage} role="status">{exportMessage}</p>}

          {!filtered.length ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>{source === "cftc" ? <Activity size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}</div>
              <div>
                <h4>{allEvents.length ? "No recent updates match these filters." : startingPoint ? "Your comparison point is ready." : "No recent changes observed."}</h4>
                <p>{allEvents.length ? "Try a wider recent window or another source." : startingPoint ? "After the next complete refresh, recent SEC evidence changes will appear here. CFTC context is added only where filing evidence supports a candidate market connection." : `Nothing in the captured evidence falls inside the last ${windowDays} days. This does not rule out changes outside the data covered here.`}</p>
                {(source !== "all" || company !== "all") && <button type="button" className={styles.textButton} onClick={clearFilters}>Clear filters</button>}
              </div>
            </div>
          ) : (
            <ol className={styles.timeline}>
              {filtered.slice(0, limit).map((event: any) => {
                const isCftc = event.source === "cftc";
                const isOpen = expanded.has(event.id);
                const links = isCftc ? [] : sourceLinks(event);
                const delta = !isCftc && typeof event.beforeValue === "number" && typeof event.afterValue === "number"
                  ? event.afterValue - event.beforeValue
                  : null;
                return (
                  <li key={event.id} className={styles.event}>
                    <div className={`${styles.sourceMark} ${isCftc ? styles.cftcMark : styles.secMark}`} aria-hidden="true">
                      {isCftc ? <Activity size={16} /> : <FileText size={16} />}
                    </div>
                    <div className={styles.eventBody}>
                      <div className={styles.eventTopline}>
                        <span className={styles.ticker}>{event.ticker || event.companyName}</span>
                        <span className={isCftc ? styles.cftcBadge : styles.secBadge}>{isCftc ? "CFTC" : "SEC"}</span>
                        <span className={styles.typeLabel}>{isCftc ? "Positioning" : KIND_LABELS[event.kind] || "Evidence"}</span>
                        <time dateTime={event.eventDate}>{displayDate(event.eventDate)}</time>
                      </div>
                      <div className={styles.eventHeadline}>
                        <div>
                          <h4>{event.title}</h4>
                          <p>{event.description}</p>
                        </div>
                        <button type="button" className={styles.detailsButton} onClick={() => toggleDetails(event.id)} aria-expanded={isOpen}>
                          Details <ChevronDown size={14} className={isOpen ? styles.chevronOpen : ""} aria-hidden="true" />
                        </button>
                      </div>

                      <div className={styles.quickFacts}>
                        {isCftc ? (
                          <>
                            <span><small>1W net</small><strong>{signed(event.netChange)} contracts</strong></span>
                            <span><small>Net / OI change</small><strong>{event.netPctChange === null ? "Unavailable" : `${signed(event.netPctChange, 2)} pp`}</strong></span>
                            <span><small>Market</small><strong>{event.contractName}</strong></span>
                          </>
                        ) : (
                          <>
                            {event.filing?.form && <span><small>Form</small><strong>{event.filing.form}</strong></span>}
                            {delta !== null && <span><small>Observed revision</small><strong>{signed(delta, 2)} {event.unit || ""}</strong></span>}
                            {event.knownWeightPct !== null && <span><small>Known allocation</small><strong>{event.knownWeightPct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</strong></span>}
                          </>
                        )}
                      </div>

                      {isOpen && (
                        <div className={styles.detailsPanel}>
                          {isCftc ? (
                            <>
                              <div className={styles.detailGrid}>
                                <div><small>Prior CFTC report</small><strong>{displayDate(event.priorDate)}</strong></div>
                                <div><small>Current CFTC report</small><strong>{displayDate(event.reportDate)}</strong></div>
                                <div><small>Long change</small><strong>{signed(event.longChange)} contracts</strong></div>
                                <div><small>Short change</small><strong>{signed(event.shortChange)} contracts</strong></div>
                              </div>
                              <div className={styles.connectionNote}>
                                <strong>Why this market is shown</strong>
                                <p>{event.candidate?.reason}</p>
                                {event.candidate?.reviewQuestion && <p><b>Review question:</b> {event.candidate.reviewQuestion}</p>}
                              </div>
                              <div className={styles.linkRow}>
                                {event.candidate?.filing?.url && <a href={event.candidate.filing.url} target="_blank" rel="noreferrer">SEC evidence <ExternalLink size={12} aria-hidden="true" /></a>}
                                {event.cftcSource && <a href={event.cftcSource} target="_blank" rel="noreferrer">CFTC source <ExternalLink size={12} aria-hidden="true" /></a>}
                                <Link href={event.marketPath}>Open positioning workspace <ExternalLink size={12} aria-hidden="true" /></Link>
                              </div>
                              <p className={styles.disclaimer}>Aggregate futures positioning is market context only. It is not the company’s own position, hedge size, cash flow, or a price forecast.</p>
                            </>
                          ) : (
                            <>
                              <div className={styles.detailGrid}>
                                <div><small>Earlier capture</small><strong>{observation(event.before, event.kind)}</strong></div>
                                <div><small>Current capture</small><strong>{observation(event.after, event.kind)}</strong></div>
                              </div>
                              <div className={styles.linkRow}>
                                {links.map((url: string, index: number) => <a key={url} href={url} target="_blank" rel="noreferrer">SEC source{links.length > 1 ? ` ${index + 1}` : ""} <ExternalLink size={12} aria-hidden="true" /></a>)}
                                {!links.length && <span>No linked SEC document in this capture.</span>}
                              </div>
                            </>
                          )}
                          {event.rowId && <button type="button" className={styles.inspectButton} onClick={() => onInspectCompany(event.rowId)}>Inspect company</button>}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {filtered.length > 20 && (
            <button type="button" className={styles.showMore} onClick={() => setLimit(limit >= filtered.length ? 20 : Math.min(filtered.length, limit + 20))}>
              {limit >= filtered.length ? "Show first 20" : `Show more · ${Math.min(limit, filtered.length)} of ${filtered.length}`}
            </button>
          )}

          <p className={styles.method}>
            SEC changes compare two completed research captures and keep filing/document provenance. CFTC context uses the latest official report and an exact one-week comparison only when a candidate company-market connection is supported by an SEC annual filing. The recent window is anchored to the current research capture.
          </p>
        </>
      )}
    </section>
  );
}
