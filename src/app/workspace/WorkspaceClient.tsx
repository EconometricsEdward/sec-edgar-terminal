"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  CheckCircle2,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react";
import { useWorkspace } from "../../components/research/WorkspaceProvider";
import ResearchVault from "../../components/site/ResearchVault";
import { validTicker } from "../../utils/researchWorkspace.js";
import { loadClassifiedTickerMap } from "../../utils/tickerMapLoader.js";
import {
  MARKET_SAVED_KEY,
  parseMarketSaved,
} from "../../utils/marketResearch.js";
import {
  companyReview,
  consolidatedWatchlist,
  FUND_SHELF_KEY,
  parseFundShelf,
  toggleFundShelf,
  removeFundFromShelf,
} from "../../utils/workspaceReview.js";
import styles from "./workspace.module.css";
import {
  HUB_VIEWS,
  hubDestination,
  parseHubLocation,
} from "../../utils/researchHubNavigation.js";

const PortfolioResearch = dynamic(
  () => import("./portfolio/PortfolioResearch"),
  { loading: () => <p role="status">Opening Portfolio Research…</p> },
);
const HubOverview = dynamic(() => import("./HubOverview"), {
  loading: () => <p role="status">Opening your research overview…</p>,
});
const ResearchInbox = dynamic(() => import("./ResearchInbox"), {
  loading: () => <p role="status">Opening your review inbox…</p>,
});
const ResearchBriefs = dynamic(() => import("./ResearchBriefs"), {
  loading: () => <p role="status">Opening your research briefs…</p>,
});

import { nextWatchlistBatch } from "../../utils/hubResearchTools.js";

export default function WorkspaceClient() {
  const { data, ready, error, update } = useWorkspace();
  const [ticker, setTicker] = useState("");
  const [market, setMarket] = useState<any>({ watchlist: [] });
  const [funds, setFunds] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [storageError, setStorageError] = useState("");
  const [filter, setFilter] = useState("all");
  const [watchQuery, setWatchQuery] = useState("");
  const [hubView, setHubView] = useState("overview");
  const [visitedViews, setVisitedViews] = useState(["overview"]);
  const [portfolioRequest, setPortfolioRequest] = useState<any>(null);
  const [briefRequest, setBriefRequest] = useState<any>(null);
  const navigationSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const restoreRoute = () => {
      const requested = parseHubLocation(window.location.href);
      setHubView(requested.view);
      setVisitedViews((current) =>
        current.includes(requested.view)
          ? current
          : [...current, requested.view],
      );
      if (requested.view === "portfolios")
        setPortfolioRequest({
          ...requested,
          nonce: ++navigationSequence.current,
        });
      if (requested.view === "briefs" && requested.briefId)
        setBriefRequest({
          briefId: requested.briefId,
          nonce: ++navigationSequence.current,
        });
    };
    restoreRoute();
    const read = () => {
      const failures: string[] = [];
      try {
        setMarket(parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY)));
      } catch {
        failures.push("Market watchlist could not be read.");
      }
      try {
        setFunds(parseFundShelf(localStorage.getItem(FUND_SHELF_KEY)));
      } catch {
        failures.push("Funds shelf could not be read.");
      }
      setStorageError(failures.join(" "));
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("research-storage", read);
    window.addEventListener("focus", read);
    window.addEventListener("popstate", restoreRoute);
    window.addEventListener("hashchange", restoreRoute);
    return () => {
      controller.current?.abort();
      window.removeEventListener("storage", read);
      window.removeEventListener("research-storage", read);
      window.removeEventListener("focus", read);
      window.removeEventListener("popstate", restoreRoute);
      window.removeEventListener("hashchange", restoreRoute);
    };
  }, []);
  function navigate(view: string, options: any = {}) {
    const href = hubDestination(view, options);
    if (`${window.location.pathname}${window.location.search}` !== href)
      window.history.pushState(null, "", href);
    setHubView(view);
    setVisitedViews((current) =>
      current.includes(view) ? current : [...current, view],
    );
    if (
      view === "portfolios" &&
      (options.portfolioId ||
        options.action ||
        options.rowId ||
        options.portfolioViewId ||
        options.analyticsArea ||
        options.portfolioTab)
    )
      setPortfolioRequest({ ...options, nonce: ++navigationSequence.current });
    if (view === "briefs" && options.briefId)
      setBriefRequest({
        briefId: options.briefId,
        nonce: ++navigationSequence.current,
      });
  }
  function createBrief(draft: any) {
    setBriefRequest({ ...draft, nonce: ++navigationSequence.current });
    navigate("briefs");
  }
  const watchlist = useMemo(
    () => consolidatedWatchlist(data, market, funds),
    [data, market, funds],
  );
  const companies = watchlist.filter((row) => row.kind === "company");
  const visible = watchlist.filter(
    (row) =>
      (filter === "all" ||
        (filter === "fund" && row.kind === "fund") ||
        (filter === "company" && row.kind === "company") ||
        (filter === "attention" &&
          row.kind === "company" &&
          (!row.review.reviewedAt ||
            results[row.ticker]?.count > 0 ||
            results[row.ticker]?.error ||
            (results[row.ticker]?.coverage &&
              !results[row.ticker].coverage.completeSinceReview)))) &&
      `${row.ticker} ${row.name || ""}`
        .toLowerCase()
        .includes(watchQuery.trim().toLowerCase()),
  );

  const unchecked = companies.filter((row) => !results[row.ticker]).length;
  const failedChecks = companies.filter(
    (row) => results[row.ticker]?.error,
  ).length;
  async function checkCompanies(
    requested = nextWatchlistBatch(companies, results),
  ) {
    if (!requested.length) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const selected = requested.slice(0, 20);
    setBusy(true);
    setStatus(
      `Checking ${selected.length} ${selected.length === 1 ? "company" : "companies"} against SEC filing metadata…`,
    );
    setResults((previous) => {
      const next = { ...previous };
      for (const row of selected) delete next[row.ticker];
      return next;
    });
    const queue = [...selected];
    let completed = 0;
    let failed = 0;
    async function worker() {
      while (queue.length && !requestController.signal.aborted) {
        const company = queue.shift();
        if (!company) break;
        const since = company.review.reviewedAt?.slice(0, 10) || "";
        try {
          const response = await fetch(
            `/api/workspace-check?ticker=${encodeURIComponent(company.ticker)}${since ? `&since=${since}` : ""}`,
            {
              signal: AbortSignal.any([
                requestController.signal,
                AbortSignal.timeout(55000),
              ]),
            },
          );
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error || "The filing check failed. Retry this company.",
            );
          if (
            result.ticker !== company.ticker ||
            !result.coverage ||
            !Array.isArray(result.filings)
          )
            throw new Error(
              "The filing check returned an incomplete response. Retry this company.",
            );
          if (!requestController.signal.aborted)
            setResults((previous) => ({
              ...previous,
              [company.ticker]: result,
            }));
          completed++;
        } catch (err) {
          if (!requestController.signal.aborted) {
            failed++;
            setResults((previous) => ({
              ...previous,
              [company.ticker]: {
                error:
                  err instanceof Error
                    ? err.message
                    : "Request failed. Retry this company.",
              },
            }));
          }
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (!requestController.signal.aborted) {
      setBusy(false);
      setStatus(
        `Check finished: ${completed} successful, ${failed} failed. Review baselines are unchanged.`,
      );
    }
  }
  function cancel() {
    controller.current?.abort();
    setBusy(false);
    setStatus(
      "Check stopped. Completed results remain visible; unchecked companies have no result.",
    );
  }
  async function saveEntity(event: React.FormEvent) {
    event.preventDefault();
    const value = ticker.trim().toUpperCase();
    if (!validTicker(value)) {
      setStatus("Enter an exact company or fund ticker, such as JPM or VOO.");
      return;
    }
    setSaving(true);
    setStatus(`Resolving ${value} in the SEC directory…`);
    try {
      const map = await loadClassifiedTickerMap();
      const entity = map[value];
      if (!entity)
        throw new Error(
          `No exact SEC ticker matched ${value}. Use the global search to find a company by name.`,
        );
      if (entity.isFund) {
        const current = parseFundShelf(localStorage.getItem(FUND_SHELF_KEY));
        if (!current.includes(value))
          setFunds(toggleFundShelf(localStorage, value));
        window.dispatchEvent(new Event("research-storage"));
      } else {
        if (
          Object.values(data.companies).filter((c) => c.saved).length >= 20 &&
          !data.companies[value]?.saved
        )
          throw new Error(
            "Workspace supports 20 saved companies. Unsave a company before adding another.",
          );
        const ok = update((workspace) => ({
          ...workspace,
          companies: {
            ...workspace.companies,
            [value]: {
              ...workspace.companies[value],
              ticker: value,
              name: entity.name,
              cik: entity.cik,
              saved: true,
            },
          },
        }));
        if (!ok) return;
        window.dispatchEvent(new Event("research-storage"));
      }
      setTicker("");
      setStatus(
        `${value} saved to your ${entity.isFund ? "Funds shelf" : "company watchlist"}.`,
      );
    } catch (err) {
      setStatus(
        err instanceof Error
          ? err.message
          : "The ticker could not be saved. Retry.",
      );
    } finally {
      setSaving(false);
    }
  }
  function unsave(row: any) {
    try {
      if (row.kind === "fund")
        setFunds(removeFundFromShelf(localStorage, row.ticker));
      else if (
        !update((workspace) => ({
          ...workspace,
          companies: {
            ...workspace.companies,
            [row.ticker]: { ...workspace.companies[row.ticker], saved: false },
          },
        }))
      )
        return;
      window.dispatchEvent(new Event("research-storage"));
      setStatus(
        `${row.ticker} unsaved from ${row.kind === "fund" ? "Funds" : "Workspace"}. Notes, evidence, and review baselines are retained.`,
      );
    } catch (err) {
      setStatus(
        err instanceof Error ? err.message : "Could not update the saved list.",
      );
    }
  }
  return (
    <div
      className={styles.page}
      data-research-workspace
      onClickCapture={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const anchor = (event.target as Element).closest?.("a");
        if (
          !anchor ||
          anchor.target === "_blank" ||
          anchor.hasAttribute("download")
        )
          return;
        const destination = new URL(anchor.href, window.location.href);
        if (
          destination.origin !== window.location.origin ||
          destination.pathname !== "/workspace"
        )
          return;
        event.preventDefault();
        const route = parseHubLocation(destination.href);
        navigate(route.view, route);
      }}
    >
      <div className={styles.heading}>
        <h1>Research Hub</h1>
        <label className={styles.hubSwitcher}>
          <span>Workspace</span>
          <select
            value={hubView}
            onChange={(event) => navigate(event.target.value)}
          >
            {HUB_VIEWS.map(([view, label]) => (
              <option key={view} value={view}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Link href="/workspace?view=library" className={styles.secondary}>
          Saved evidence <ArrowUpRight size={16} />
        </Link>
      </div>
      <div hidden={hubView !== "overview"}>
        <HubOverview watchlist={watchlist} onNavigate={navigate} />
      </div>
      <div hidden={hubView !== "portfolios"}>
        {visitedViews.includes("portfolios") && (
          <PortfolioResearch
            active={hubView === "portfolios"}
            watchlist={watchlist}
            navigationRequest={portfolioRequest}
            onCreateBrief={createBrief}
          />
        )}
      </div>
      <div hidden={hubView !== "inbox"}>
        {visitedViews.includes("inbox") && (
          <ResearchInbox
            watchlist={watchlist}
            onNavigate={navigate}
            onCreateBrief={createBrief}
          />
        )}
      </div>
      <div hidden={hubView !== "briefs"}>
        {visitedViews.includes("briefs") && (
          <ResearchBriefs request={briefRequest} onNavigate={navigate} />
        )}
      </div>
      <div hidden={hubView !== "watchlist"} className={styles.legacyWorkspace}>
        <div className={styles.summary} aria-label="Saved research overview">
          <div>
            <Bookmark size={18} />
            <strong>{ready ? companies.length : "—"}</strong>
            <span>Companies followed</span>
          </div>
          <div>
            <Wallet size={18} />
            <strong>{ready ? funds.length : "—"}</strong>
            <span>Funds on your shelf</span>
          </div>
          <div>
            <CheckCircle2 size={18} />
            <strong>
              {ready
                ? companies.filter((c) => c.review.reviewedAt).length
                : "—"}
            </strong>
            <span>Companies with a review</span>
          </div>
        </div>
        <section className={styles.panel} aria-labelledby="watchlist-title">
          <div className={styles.sectionHeading}>
            <div>
              <h2 id="watchlist-title">Your watchlist</h2>
              <p>
                Saved companies from Workspace and Market, plus your Funds
                shelf.
              </p>
            </div>
            <div className={styles.actions}>
              {busy ? (
                <button className={styles.secondary} onClick={cancel}>
                  Stop checking
                </button>
              ) : (
                <button
                  className={styles.secondary}
                  disabled={!ready || !unchecked}
                  onClick={() => checkCompanies()}
                >
                  <RefreshCw size={15} />{" "}
                  {unchecked
                    ? `Check next ${Math.min(20, unchecked)} companies`
                    : "No unchecked companies"}
                </button>
              )}
              {!busy && !unchecked && !failedChecks && companies.length > 0 && (
                <button
                  className={styles.secondary}
                  onClick={() => {
                    setResults({});
                    checkCompanies(companies.slice(0, 20));
                  }}
                >
                  Start a new check pass
                </button>
              )}
              {!busy && failedChecks > 0 && (
                <button
                  className={styles.secondary}
                  onClick={() =>
                    checkCompanies(
                      nextWatchlistBatch(companies, results, "failed"),
                    )
                  }
                >
                  Retry failed checks ({failedChecks})
                </button>
              )}
            </div>
          </div>
          <p>
            {companies.length - unchecked - failedChecks} checked successfully ·{" "}
            {unchecked} unchecked · {failedChecks} failed this visit. Each batch
            checks up to 20 companies, with two requests at a time.
          </p>
          <div className={styles.toolbar}>
            <form onSubmit={saveEntity}>
              <label htmlFor="watch-ticker" className={styles.srOnly}>
                Company or fund ticker to save
              </label>
              <Search size={17} aria-hidden="true" />
              <input
                id="watch-ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder="Save a ticker: JPM, VOO…"
                maxLength={15}
                autoComplete="off"
              />
              <button className={styles.primary} disabled={!ready || saving}>
                {saving ? "Resolving…" : "Save ticker"}
              </button>
            </form>
            <label>
              Show
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All saved entities</option>
                <option value="company">Companies</option>
                <option value="fund">Funds</option>
                <option value="attention">Needs attention</option>
              </select>
            </label>
          </div>
          <div className={styles.toolbar}>
            <label>
              Find saved entities{" "}
              <input
                type="search"
                value={watchQuery}
                onChange={(event) => setWatchQuery(event.target.value)}
                placeholder="Ticker or company name"
                maxLength={160}
              />
            </label>
          </div>
          <p role="status" className={styles.status}>
            {error || storageError || status}
          </p>
          {!ready && <p role="status">Loading your watchlist…</p>}
          {ready && !watchlist.length && (
            <div className={styles.empty}>
              <Bookmark size={28} />
              <h3>Start with a company or fund you follow</h3>
              <p>
                Save a ticker above. In Analysis, use “Mark reviewed” to
                preserve a financial baseline. Your notes stay in this browser.
              </p>
              <Link href="/analysis/JPM" prefetch={false}>
                Explore JPMorgan analysis <ArrowUpRight size={15} />
              </Link>
            </div>
          )}
          {ready && watchlist.length > 0 && !visible.length && (
            <p className={styles.empty}>No saved entities match this filter.</p>
          )}
          <div className={styles.companyGrid}>
            {visible.map((row: any) => {
              const result = results[row.ticker];
              const review = companyReview(data.companies[row.ticker]);
              const href =
                row.kind === "fund"
                  ? `/fund/${row.ticker}`
                  : `/analysis/${row.ticker}`;
              return (
                <article
                  key={`${row.kind}:${row.ticker}`}
                  className={styles.company}
                >
                  <div className={styles.companyTitle}>
                    <Link href={href} prefetch={false}>
                      {row.ticker}
                      <ArrowUpRight size={17} />
                    </Link>
                    <span>
                      {row.kind === "fund" ? "Fund" : row.sources.join(" + ")}
                    </span>
                  </div>
                  <h3>
                    {result?.name ||
                      row.name ||
                      (row.kind === "fund" ? "Saved fund" : "Saved company")}
                  </h3>
                  {row.kind === "fund" ? (
                    <p>
                      Review historical reported holdings and portfolio
                      concentration in Funds.
                    </p>
                  ) : (
                    <>
                      <p>
                        {review.reviewedAt ? (
                          <>
                            Reviewed{" "}
                            <strong>{review.reviewedAt.slice(0, 10)}</strong>
                            {review.period
                              ? ` · ${review.basis} ending ${review.period}`
                              : ""}
                            {review.asOf
                              ? ` · filing cutoff ${review.asOf}`
                              : ""}
                          </>
                        ) : (
                          "No company review baseline yet. Open Analysis and mark a period reviewed."
                        )}
                      </p>
                      {result?.error && (
                        <p className={styles.failure} role="alert">
                          {result.error}
                        </p>
                      )}
                      {result?.coverage && (
                        <div className={styles.checkResult}>
                          <strong>
                            {result.count == null
                              ? "Recent filings loaded · establish a review baseline in Analysis"
                              : `${result.coverage.completeSinceReview ? "" : "At least "}${result.count} report/event filings after ${result.since}`}
                          </strong>
                          <p>
                            {result.coverage.loaded.toLocaleString()} metadata
                            records checked ·{" "}
                            {result.coverage.from || "No dated records"}
                            {result.coverage.to
                              ? ` to ${result.coverage.to}`
                              : ""}
                            .{" "}
                            {result.coverage.archiveOverlap
                              ? "Unloaded archives overlap this review window."
                              : "Archive documents are not included."}
                            {result.coverage.omitted > 0
                              ? ` ${result.coverage.omitted} invalid records or archives were omitted.`
                              : ""}
                          </p>
                          {result.sameDay > 0 && (
                            <p>
                              {result.sameDay} filing(s) on the review date are
                              excluded; filing dates cannot establish whether
                              they arrived before your review.
                            </p>
                          )}
                          {result.filings.length > 0 && (
                            <ul>
                              {result.filings.slice(0, 3).map((filing: any) => (
                                <li key={filing.accession}>
                                  <a
                                    href={filing.documentUrl || filing.indexUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {filing.form} · {filing.filingDate}{" "}
                                    <ArrowUpRight size={12} />
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                          <small>
                            Checked{" "}
                            {result.observedAt?.slice(0, 19).replace("T", " ")}{" "}
                            UTC
                          </small>
                        </div>
                      )}
                    </>
                  )}
                  <div className={styles.rowActions}>
                    <Link href={href} prefetch={false}>
                      {row.kind === "fund" ? "Open holdings" : "Open analysis"}
                    </Link>
                    {row.kind === "company" && (
                      <>
                        <Link prefetch={false} href={`/filings/${row.ticker}`}>
                          Filings
                        </Link>
                        <button
                          disabled={busy}
                          onClick={() => checkCompanies([row])}
                        >
                          Check filings
                        </button>
                      </>
                    )}
                    {(row.kind === "fund" ||
                      row.sources.includes("Workspace")) && (
                      <button onClick={() => unsave(row)}>
                        Unsave
                        {row.sources.includes("Market") ? " Workspace" : ""}
                      </button>
                    )}
                    {row.sources.includes("Market") && (
                      <Link href="/market?screen=watchlist" prefetch={false}>
                        Manage Market list
                      </Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className={styles.footnote}>
            Checks run only when you request them, for up to 20 companies at a
            time. They cover report and event forms in the recent SEC
            submissions feed, not full archived history or financial changes. No
            emails or background notifications are sent.
          </p>
        </section>
      </div>
      <div hidden={hubView !== "library"}>
        <ResearchVault />
      </div>
    </div>
  );
}
