"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Link2, RefreshCw, Search } from "lucide-react";
import { buildThirteenFMarketConnections, THIRTEEN_F_MARKET_CATEGORIES } from "../../utils/thirteenFMarketConnections.js";
import { cache13FReview, deleteCached13FReview, readCached13FReview, valid13FReviewSnapshot } from "../../utils/thirteenFReviewClient.js";
import MarketPositioning from "./ThirteenFMarketPositioning";
import s from "./ThirteenFMarketConnections.module.css";

const PAGE_SIZE = 50;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—";
const percent = (value: unknown) => finite(value) ? value > 0 && value < .01 ? "<0.01%" : `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: value > 0 && value < 1 ? 2 : 1 })}%` : "—";
const money = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }) : "—";
const labels: Record<string, string> = { unchecked: "Not yet reviewed", unavailable: "Evidence unavailable", unresolved: "Issuer link unverified", no_filing: "No eligible filing", no_matches: "No passage found", linked: "Market connection", disclosure_only: "Disclosure only", partial: "Partial filing review" };
const finished = (status: string) => ["complete", "complete_with_gaps"].includes(status);
function date(value: unknown, time = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "Unavailable";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" as const } : {}), timeZone: "UTC" }) : "Unavailable";
}
function apiUrl(cik: string, period: string, params: Record<string, string | number | null | undefined> = {}) {
  const query = new URLSearchParams({ cik });
  if (period) query.set("period", period);
  for (const [key, value] of Object.entries(params)) if (value !== "" && value != null) query.set(key, String(value));
  return `/api/fund-13f/market-review?${query}`;
}
async function readJson(response: Response) {
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || result?.message || (typeof result?.error === "string" ? result.error : "The saved review is temporarily unavailable. Please try again."));
  return result;
}
type Props = { data?: any; cik?: string; period?: string; active: boolean; onSnapshot?: (snapshot: any) => void; onInspectCompany: (holding: any, report?: any) => void; preview: (active: boolean) => ReactNode; evidence: (member: any, market: any, report?: any) => ReactNode };

/** Publications load independently of the manager report. Only tiny progress
 * metadata is polled; changed publications and selected evidence load on demand. */
export default function ThirteenFSharedMarketReview({ data, cik: suppliedCik, period: suppliedPeriod, active, onSnapshot, onInspectCompany, preview, evidence }: Props) {
  const id = useId();
  const cik = suppliedCik || data?.manager?.cik || "";
  const requestedPeriod = suppliedPeriod ?? data?.selectedPeriod ?? "";
  const [snapshot, setSnapshot] = useState<any>(() => readCached13FReview(cik, requestedPeriod));
  const [loaded, setLoaded] = useState(() => !!readCached13FReview(cik, requestedPeriod));
  const period = snapshot?.job?.period || requestedPeriod || data?.selectedPeriod || "";
  const [pageResponse, setPageResponse] = useState<any>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [marketFilter, setMarketFilter] = useState("");
  const [chosenMarket, setChosenMarket] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [selectedKey, setSelectedKey] = useState("");
  const [savedEvidence, setSavedEvidence] = useState<{ scope: string; value: any } | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailRevision, setDetailRevision] = useState(0);
  const latest = useRef<any>(snapshot);
  const createController = useRef<AbortController | null>(null);
  const evidencePanel = useRef<HTMLElement | null>(null);
  const job = snapshot?.job;
  const reportHash = job?.reportHash || "";
  const evidenceScope = `${cik}:${period}:${reportHash}:${selectedKey}`;
  const result = savedEvidence?.scope === evidenceScope ? savedEvidence.value : null;

  useEffect(() => { const timer = window.setTimeout(() => { setDebouncedQuery(query.trim()); setOffset(0); }, 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => () => { const controller = createController.current; createController.current = null; controller?.abort(); }, []);
  useEffect(() => {
    if (!selectedKey) return;
    evidencePanel.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    evidencePanel.current?.focus({ preventScroll: true });
  }, [selectedKey]);
  useEffect(() => { if (snapshot && onSnapshot) onSnapshot(snapshot); }, [snapshot, onSnapshot]);
  useEffect(() => {
    if (!active || !cik) return;
    let cancelled = false, timer: number | undefined;
    let controller: AbortController | null = null;
    async function request(view: "snapshot" | "progress", version?: string) {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 15_000);
      try {
        const response = await fetch(apiUrl(cik, requestedPeriod, { view, version }), { signal: controller.signal });
        const value = response.status === 404 ? { job: null } : await readJson(response);
        if (value?.job && (value.job.cik !== cik || requestedPeriod && value.job.period !== requestedPeriod)) throw new Error("The saved review did not match this manager and quarter.");
        return value;
      } finally { window.clearTimeout(timeout); }
    }
    async function publication(version?: string) {
      const value = await request("snapshot", version);
      if (cancelled) return;
      if (value?.job && !valid13FReviewSnapshot(value, cik, requestedPeriod)) throw new Error("The saved review could not be verified. Please retry.");
      if (latest.current?.job?.reportHash && value?.job?.reportHash !== latest.current.job.reportHash) { setSelectedKey(""); setOffset(0); setPageResponse(null); }
      if (value?.job) cache13FReview(value, { cik, period: requestedPeriod });
      else deleteCached13FReview(cik, requestedPeriod);
      latest.current = value; setSnapshot(value); setLoaded(true);
    }
    async function poll(initial = false) {
      if (cancelled) return;
      if (document.visibilityState === "hidden") { timer = window.setTimeout(() => void poll(initial), 60_000); return; }
      if (initial) setBusy(true);
      try {
        if (initial || !latest.current?.job) await publication(latest.current?.publicationVersion);
        else {
          const progress = await request("progress");
          if (cancelled) return;
          if (!progress?.job || progress.publicationVersion !== latest.current.publicationVersion || progress.job.reportHash !== latest.current.job.reportHash || progress.job.period !== latest.current.job.period) await publication(progress.publicationVersion);
          else {
            const value = { ...latest.current, job: progress.job };
            latest.current = value; setSnapshot(value);
            cache13FReview(value, { cik, period: requestedPeriod });
          }
        }
        if (!cancelled) setError("");
      } catch (cause) {
        if (!cancelled) { setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "The saved review is taking longer than expected. Previously loaded results remain available."); setLoaded(true); }
      } finally {
        if (!cancelled) {
          setBusy(false);
          const state = latest.current?.job?.status;
          timer = window.setTimeout(() => void poll(), state && !finished(state) && !/paused/.test(state) ? 15_000 : 60_000);
        }
      }
    }
    void poll(true);
    return () => { cancelled = true; window.clearTimeout(timer); controller?.abort(); };
  }, [active, cik, requestedPeriod, revision]);

  const filteredPage = !!marketFilter || status !== "all" || !!debouncedQuery || offset > 0;
  const publicationVersion = snapshot?.publicationVersion || "";
  useEffect(() => {
    if (!active || !filteredPage || !reportHash || !period) { setPageBusy(false); return; }
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setPageBusy(true);
    void fetch(apiUrl(cik, period, { reportHash, market: marketFilter, status: status === "all" ? "" : status, query: debouncedQuery, offset, limit: PAGE_SIZE }), { signal: controller.signal }).then(readJson).then(value => {
      if (cancelled) return;
      if (!valid13FReviewSnapshot(value, cik, period) || value.job.reportHash !== reportHash) throw new Error("This report changed. Update the saved review before opening another page.");
      setPageResponse(value); setError("");
    }).catch(cause => { if (!cancelled) setError(controller.signal.aborted ? "The holding page took too long to load. Previously loaded holdings remain visible." : cause instanceof Error ? cause.message : "The holding page could not be loaded."); }).finally(() => { window.clearTimeout(timeout); if (!cancelled) setPageBusy(false); });
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [active, cik, period, filteredPage, reportHash, publicationVersion, marketFilter, status, debouncedQuery, offset, revision]);

  async function startReview() {
    if (starting) return;
    const controller = new AbortController();
    createController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 70_000);
    setStarting(true); setError("");
    try {
      const value = await readJson(await fetch("/api/fund-13f/market-review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cik, period }), signal: controller.signal }));
      if (!controller.signal.aborted) {
        // POST may return only the new job. Fetch the first full summary page.
        if (value?.job) { latest.current = value; setSnapshot(value); }
        setRevision(previous => previous + 1);
      }
    } catch (cause) {
      if (createController.current === controller) setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Starting the review is taking longer than expected. Retry to join it safely; your request may already have been saved.");
    } finally {
      window.clearTimeout(timeout);
      if (createController.current === controller) { createController.current = null; setStarting(false); }
    }
  }
  const visiblePage = filteredPage && pageResponse?.job?.reportHash === reportHash ? pageResponse : snapshot;
  const rows: any[] = visiblePage?.rows || [];
  const selectedRow = rows.find(row => row.key === selectedKey || row.holding?.key === selectedKey);
  const selectedCheckedAt = selectedRow?.checkedAt || selectedRow?.updatedAt || "";
  useEffect(() => {
    setDetailError("");
    setSavedEvidence(previous => previous?.scope === evidenceScope ? previous : null);
    if (!active || !selectedKey || !reportHash) { setDetailBusy(false); return; }
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setDetailBusy(true);
    void fetch(apiUrl(cik, period, { reportHash, key: selectedKey }), { signal: controller.signal, cache: "no-store" }).then(readJson).then(value => { if (!cancelled) setSavedEvidence({ scope: evidenceScope, value: value?.result || value }); }).catch(cause => { if (!cancelled) setDetailError(controller.signal.aborted ? "The saved evidence request timed out. Please retry." : cause instanceof Error ? cause.message : "The saved evidence could not be loaded."); }).finally(() => { window.clearTimeout(timeout); if (!cancelled) setDetailBusy(false); });
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  }, [active, cik, period, selectedKey, selectedCheckedAt, reportHash, evidenceScope, detailRevision]);

  const report = snapshot?.report;
  const detail = useMemo(() => {
    if (!result?.holding || !report) return null;
    return buildThirteenFMarketConnections({ manager: { cik }, selectedPeriod: period, portfolio: { holdings: [result.holding], totalValueUsd: report.totalValueUsd, complete: report.complete }, coverage: { selectedPeriodComplete: report.complete } }, [result]);
  }, [result, report, cik, period]);
  const markets: any[] = snapshot?.markets || [];
  const selectedMarket = markets.find(market => market.key === chosenMarket) || markets[0];
  const selectedMarketKey = selectedMarket?.key || "";
  useEffect(() => { if (selectedMarketKey && selectedMarketKey !== chosenMarket) setChosenMarket(selectedMarketKey); }, [selectedMarketKey, chosenMarket]);
  function filterMarket(key: string) { setChosenMarket(key); setMarketFilter(key); setOffset(0); setSelectedKey(""); }
  const total = job?.total ?? data?.delivery?.total ?? data?.portfolio?.positionCount ?? data?.portfolio?.holdings?.length ?? 0;
  const coverage = snapshot?.coverage || {};
  const reviewed = job?.reviewed ?? coverage.reviewed ?? 0;
  const complete = finished(job?.status);
  const paused = /paused/.test(job?.status || "");
  const hasFindings = (coverage.checked ?? 0) > 0 || complete;
  const waitingForFirstResult = !!job && !complete && reviewed === 0;
  const detailGroups = [...(detail?.markets || []), ...(detail?.unmapped || [])].filter(group => !marketFilter || group.key === marketFilter);
  const pageTotal = visiblePage?.page?.total ?? rows.length;
  const pageOffset = visiblePage?.page?.offset ?? offset;
  const tableBusy = pageBusy || busy;
  const denominator = report?.complete && finite(report?.totalValueUsd) && report.totalValueUsd > 0 ? report.totalValueUsd : null;

  if (!job) return <div className={s.connections}>
    <section className={s.sharedStart} aria-label="Full shared holding review"><div><strong>Review the complete report</strong><p>Review {total ? `all ${number(total)} holdings` : "every disclosed holding"} in the background. Results appear progressively, remain available to later visitors, and keep running when you leave this page.</p></div><button type="button" className={s.continue} disabled={!active || !loaded || starting || !total || !period} onClick={() => void startReview()}>{starting || !loaded ? <RefreshCw size={14} className={s.spin} /> : <Search size={14} />}{starting ? "Starting shared review…" : !loaded ? "Checking saved review…" : total ? `Review all ${number(total)} holdings` : "Review full report"}</button></section>
    {error && <p className={s.notice} role="alert">{error} <button type="button" className={s.retry} disabled={busy} onClick={() => setRevision(previous => previous + 1)}>Retry saved review</button></p>}
    {data?.portfolio?.holdings?.length && data?.delivery?.holdingsComplete !== false ? preview(active && loaded && !error && !starting) : <p className={s.scopeDates}>{!loaded ? "Opening the saved market review…" : !data ? "Loading the reporting quarter and holding count. Saved market research opens independently." : "Start the shared review to follow every disclosed holding. The complete report value remains the basis for all market shares."}</p>}
  </div>;

  return <div className={s.connections}>
    <header className={s.header}><div><span className={s.eyebrow}><Link2 size={14} />Market connections</span><h3>The markets behind the holdings</h3><p>A shared review of every disclosed holding, with saved SEC evidence and related futures markets.</p></div><span className={s.quarter}>13F snapshot<strong>{date(period)}</strong></span></header>
    <div className={s.overview} aria-label="Saved market connection coverage"><div><span>Related CFTC markets</span><strong>{hasFindings ? number(markets.length) : "—"}</strong></div><div><span>Holdings with market links</span><strong>{hasFindings ? number(coverage.linked ?? 0) : "—"}<small> / {number(total)}</small></strong></div><div><span>Associated disclosed value</span><strong>{hasFindings ? percent(coverage.linkedSharePct) : "—"}</strong></div><p>Shares use the full disclosed report value. They describe holdings with supported connections, not the size or direction of economic exposure.</p></div>
    <div className={s.scan}><div className={s.scanProgress}><div role="status" aria-live="polite">{complete ? <Check size={14} /> : <RefreshCw size={14} className={paused ? undefined : s.spin} />}<span>{complete ? job.status === "complete_with_gaps" ? "Full review finished with coverage gaps" : "Full review finished" : paused ? "Shared review waiting for its next processing window" : job.status === "running" ? "Reviewing SEC disclosures in the background" : "Waiting for a review worker"}<strong>{number(reviewed)} of {number(total)} holdings reviewed{job.cycle > 1 ? " this cycle" : ""}</strong></span></div><progress max={Math.max(total, 1)} value={Math.min(reviewed, total)} aria-label="Full report review progress" /></div><div className={s.scanActions}>{waitingForFirstResult && !paused && job.status !== "running" && <button type="button" className={s.continue} disabled={starting} onClick={() => void startReview()}><RefreshCw size={12} className={starting ? s.spin : undefined} />{starting ? "Resuming…" : "Resume review"}</button>}<button type="button" disabled={busy} onClick={() => setRevision(previous => previous + 1)}><RefreshCw size={12} />Update progress</button></div></div>
    <p className={s.scopeDates}>You can leave this page; the review continues in the background and is shared with later visitors. {job.cycle > 1 ? `Refresh cycle ${number(job.cycle)} · Earlier saved evidence remains visible while sources are checked again. ` : ""}Last saved progress: {date(job.updatedAt, true)}{job.nextAttemptAt && (complete || paused) ? ` · Next check: ${date(job.nextAttemptAt, true)}` : ""}.</p>
    <p className={s.scopeDates}>Company evidence uses the latest eligible annual filing and newer 10-Q. CFTC charts use the latest available weekly positions. Both may postdate the 13F snapshot; each source retains its original dates.</p>
    {error && <p className={s.notice} role="alert">{error} Saved results remain visible.</p>}
    {denominator === null && <p className={s.notice}>A complete report with a positive reconciled value is required for percentage shares. Available holding counts and evidence remain visible.</p>}
    {selectedMarket ? <div className={s.marketGrid}>
      <aside className={s.markets} aria-labelledby={`${id}-markets`}><div className={s.marketListHeading}><h4 id={`${id}-markets`}>Explore a market</h4><span>Associated 13F value</span></div><div className={s.marketList}>{Object.entries(THIRTEEN_F_MARKET_CATEGORIES).map(([category, label]) => { const members = markets.filter(market => market.category === category); return members.length ? <div className={s.category} key={category}><h5>{label}</h5><ul>{members.map(market => <li key={market.key}><button type="button" aria-pressed={selectedMarket.key === market.key} aria-controls={`${id}-selected`} onClick={() => filterMarket(market.key)}><span className={s.marketTitle}><strong>{market.label}</strong><ChevronRight size={14} /></span><span className={s.marketMeta}><span>{number(market.holdingCount ?? market.count)} holdings</span><b>{percent(market.sharePct)}</b></span>{finite(market.sharePct) && <span className={s.shareTrack} aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, market.sharePct))}%` }} /></span>}</button></li>)}</ul></div> : null; })}</div><p className={s.overlap}>A holding may connect to several markets. Market shares overlap and should not be added.</p></aside>
      <section id={`${id}-selected`} className={s.selectedMarket} aria-label={`${selectedMarket.label} market context`}><div className={s.selectedHeading}><div><span>{THIRTEEN_F_MARKET_CATEGORIES[selectedMarket.category as keyof typeof THIRTEEN_F_MARKET_CATEGORIES] || "Market context"}</span><h4>{selectedMarket.label}</h4></div><div><strong>{percent(selectedMarket.sharePct)}</strong><span>of disclosed 13F value</span></div></div><MarketPositioning market={selectedMarket} active={active} initialData={snapshot?.initialChart} /><div className={s.sharedChartFooter}><p>CFTC positioning describes this futures market. It does not reveal this manager’s or an issuer’s positions.</p><button type="button" onClick={() => filterMarket(selectedMarket.key)}>Show {number(selectedMarket.holdingCount ?? selectedMarket.count)} connected holdings<ChevronDown size={13} /></button></div></section>
    </div> : waitingForFirstResult ? <section className={s.sharedStart} aria-label="Review awaiting first results"><div><strong>Waiting for the first saved results</strong><p>This report is queued for review. Connections and source evidence will appear as holdings are checked; the blank totals above do not indicate zero exposure.</p></div></section> : <section className={s.empty}><div className={s.emptyMark} aria-hidden="true"><FileText size={24} /><span /><Link2 size={24} /></div><h4>{complete ? "No verified CFTC connection in the reviewed holdings" : "Connections appear as the review progresses"}</h4><p>Every holding receives a review status. An unverified issuer, unavailable filing, or missing passage remains visible in coverage below. A missing connection does not establish zero exposure.</p></section>}

    <section className={s.coverage} aria-labelledby={`${id}-coverage`}>
      <div className={s.holdingSectionHeading}><div><span className={s.eyebrow}>Full report coverage</span><h4 id={`${id}-coverage`}>Every disclosed holding</h4></div><span>{number(total)} in report</span></div>
      <div className={s.coverageIntro}><p>Holdings are listed in order of reported value. Completed results, unresolved identities, unavailable sources, and holdings awaiting review are all included. Select “View evidence” to read one holding’s saved sources.</p><div className={s.coverageCounts}>{[{ key: "checked", label: "saved filing reviews" }, { key: "unresolved", label: "unverified issuers" }, { key: "unavailable", label: "unavailable" }, { key: "partial", label: "partial reviews" }, { key: "unchecked", label: "not yet reviewed" }].map(item => <span key={item.key}><strong>{number(coverage[item.key] ?? 0)}</strong>{item.label}</span>)}{finite(coverage.checkedSharePct) && <span><strong>{percent(coverage.checkedSharePct)}</strong>of value with filing reviews</span>}</div></div>
      <div className={s.coverageControls}><label className={s.search}><Search size={14} /><input aria-label="Search all disclosed holdings" type="search" value={query} maxLength={100} placeholder="Company, ticker, or CUSIP" onChange={event => { setQuery(event.target.value); setSelectedKey(""); }} /></label><select aria-label="Filter coverage status" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); setSelectedKey(""); }}><option value="all">All coverage statuses</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Filter connected market" value={marketFilter} onChange={event => filterMarket(event.target.value)}><option value="">All holdings and markets</option>{markets.map(market => <option key={market.key} value={market.key}>{market.label}</option>)}</select></div>
      <div className={s.coverageTable} role="region" tabIndex={0} aria-label="Full shared report review statuses" aria-busy={tableBusy}><table><thead><tr><th scope="col">Reported holding</th><th scope="col">Value / 13F share</th><th scope="col">Evidence coverage</th><th scope="col">Saved sources</th></tr></thead><tbody>{rows.map(row => { const holding = row.holding || {}, key = row.key || holding.key; return <tr key={key} data-selected={key === selectedKey}><th scope="row"><button type="button" className={s.companyLink} onClick={() => onInspectCompany(holding, report)}>{holding.issuer}<ArrowUpRight size={12} /></button><small>{holding.cusip} · {holding.classTitle}{holding.putCall ? ` · ${holding.putCall}` : ""}</small></th><td>{money(holding.valueUsd)}<small>{percent(denominator && finite(holding.valueUsd) ? holding.valueUsd / denominator * 100 : null)}</small></td><td><span className={s.status} data-status={row.status}>{labels[row.status] || "Evidence unavailable"}</span><small>{row.message}</small>{row.stale && <small className={s.staleEvidence}>Earlier saved evidence · refresh pending</small>}{row.preservedPrevious && <small className={s.staleEvidence}>Last successful evidence retained; the latest refresh was incomplete.</small>}{row.retryable && !row.terminal && <small>Another source check is scheduled.</small>}{row.checkedAt && <small>Source check: {date(row.checkedAt, true)}</small>}</td><td>{row.status !== "unchecked" && <button type="button" className={s.retry} aria-pressed={key === selectedKey} aria-controls={`${id}-evidence`} onClick={() => setSelectedKey(key)}><FileText size={12} />View evidence</button>}</td></tr>; })}</tbody></table>{!rows.length && <p className={s.emptySearch}>{tableBusy ? "Loading saved holdings…" : "No holdings match these filters."}</p>}</div>
      <div className={s.coverageFooter}><span>{rows.length ? `${number(pageOffset + 1)}–${number(pageOffset + rows.length)} of ${number(pageTotal)} holdings` : "0 holdings"}</span><div><button type="button" aria-label="Previous coverage page" disabled={tableBusy || offset <= 0} onClick={() => { setOffset(Math.max(0, offset - PAGE_SIZE)); setSelectedKey(""); }}><ChevronLeft size={14} /></button><button type="button" aria-label="Next coverage page" disabled={tableBusy || offset + PAGE_SIZE >= pageTotal} onClick={() => { setOffset(offset + PAGE_SIZE); setSelectedKey(""); }}><ChevronRight size={14} /></button></div></div>
    </section>
    {selectedKey && <section ref={evidencePanel} tabIndex={-1} className={s.selectedMarket} id={`${id}-evidence`} aria-label="Selected holding saved evidence" aria-busy={detailBusy}><div className={s.holdingSectionHeading}><div><span className={s.eyebrow}>Saved SEC evidence</span><h4>{selectedRow?.holding?.issuer || result?.holding?.issuer || "Selected holding"}</h4></div><button type="button" className={s.retry} onClick={() => setSelectedKey("")}>Close evidence</button></div>{selectedRow?.stale && <p className={s.notice}>This evidence comes from an earlier review cycle. A source refresh is pending; its original filing and retrieval dates remain unchanged.</p>}{detailBusy && <p className={s.emptySearch} role="status">Loading this holding’s saved evidence…</p>}{detailError && <p className={s.notice} role="alert">{detailError} <button type="button" className={s.retry} onClick={() => setDetailRevision(previous => previous + 1)}>Retry evidence</button></p>}{result && <p className={s.sharedEvidenceDates}>Issuer evidence observed: {date(result.identity?.observedAt, true)} · Company sources checked: {date(result.discovery?.checkedAt, true)}. {result.discovery?.sources?.map((source: any) => `${source.form || "SEC filing"} retrieved ${date(source.retrievedAt, true)}`).join(" · ")}</p>}{detailGroups.map(group => <div key={group.key}><div className={s.sharedEvidenceTitle}><h5>{group.label}</h5><p>{group.family ? "Read the passage and its benchmark qualification together." : "Disclosed business driver without a supported CFTC benchmark."}</p></div>{group.members?.[0] && evidence(group.members[0], group, report)}</div>)}{result && !detailGroups.length && <div className={s.coverageIntro}><p>{detail?.positions?.[0]?.message || selectedRow?.message || "No supported market passage is available for this holding."}</p>{result.discovery?.sources?.map((source: any) => <p key={`${source.accession}:${source.role}`}>{source.form} · Filed {date(source.filed)} · Period ended {date(source.reportDate)} · {source.status === "ready" ? "Source reviewed" : "Source unavailable"}</p>)}</div>}</section>}
    <details className={s.methodology}><summary>How to read the shared review<ChevronDown size={14} /></summary><div><p>One shared review is saved for this manager and reporting quarter. New reporting amendments are reviewed against their updated holdings. Subsequent source checks retain earlier evidence while the refresh progresses; every holding remains visible with its own coverage status.</p><p>Connections require SEC evidence for the exact security’s issuer and a supporting passage in an eligible annual filing or newer 10-Q. Unverified identities, missing sources, and incomplete searches are reported as coverage gaps. “No passage found” describes the bounded filing search and does not establish no economic exposure.</p><p>Market shares use the full reconciled reported 13F value. Each holding is counted once per market, and market shares can overlap. Security classes and option types remain distinct. 13F option values describe the underlying securities, not premiums or delta; puts are not subtracted.</p><p>SEC passages and CFTC positioning provide research context. A related benchmark does not establish exposure to its exact grade, geography, currency, or maturity, and aggregate CFTC reports do not reveal a particular manager’s or company’s positions.</p></div></details>
  </div>;
}
