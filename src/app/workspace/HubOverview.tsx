"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { filterHubPortfolios } from "../../utils/hubResearchTools.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  CheckCheck,
  ClipboardList,
  Download,
  FileText,
  FolderOpen,
  Layers3,
  Plus,
  Search,
} from "lucide-react";
import {
  readPortfolios,
  PORTFOLIOS_KEY,
} from "../../utils/portfolioStorage.js";
import { readResearchVault } from "../../utils/researchVault.js";
import {
  summarizeHubPortfolio,
  buildHubSearchIndex,
  searchHubResearch,
} from "../../utils/researchHubOverview.js";
import s from "./HubOverview.module.css";

const HubComparison = dynamic(() => import("./HubComparison"), {
  loading: () => <p role="status">Opening portfolio comparison…</p>,
});

type NavigationOptions = {
  analyticsArea?: string;
  portfolioTab?: string;
  rowId?: string;
  portfolioId?: string;
  action?: "new" | "paste" | "watchlist";
};
type Props = {
  watchlist: any[];
  onNavigate: (view: string, options?: NavigationOptions) => void;
};
const day = (value: string | null) => value?.slice(0, 10) || "Not captured";

export default function HubOverview({ watchlist, onNavigate }: Props) {
  const [saved, setSaved] = useState<any>({ portfolios: [], activeId: "" });
  const [entries, setEntries] = useState<any[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [portfolioReadable, setPortfolioReadable] = useState(true);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [portfolioQuery, setPortfolioQuery] = useState("");
  const [portfolioStatus, setPortfolioStatus] = useState("all");
  const [portfolioSort, setPortfolioSort] = useState("recent");
  const [searchKind, setSearchKind] = useState("all");
  const [searchSort, setSearchSort] = useState("relevance");
  const [searchLimit, setSearchLimit] = useState(12);
  const [comparing, setComparing] = useState(false);
  const read = useCallback(() => {
    const failures: string[] = [];
    try {
      setSaved(readPortfolios(localStorage.getItem(PORTFOLIOS_KEY)));
      setPortfolioReadable(true);
    } catch (error) {
      setPortfolioReadable(false);
      failures.push(
        error instanceof Error
          ? error.message
          : "Saved portfolios could not be read.",
      );
    }
    try {
      const vault = readResearchVault(localStorage);
      setEntries(vault.entries);
      failures.push(
        ...vault.issues.map((issue: any) => `${issue.label}: ${issue.message}`),
      );
    } catch {
      setEntries([]);
      failures.push("The research library could not be indexed.");
    }
    setIssues([...new Set(failures)]);
    setReady(true);
  }, []);
  useEffect(() => {
    read();
    window.addEventListener("storage", read);
    window.addEventListener("research-storage", read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("research-storage", read);
      window.removeEventListener("focus", read);
    };
  }, [read]);

  const portfolios = useMemo(
    () =>
      (portfolioReadable ? saved.portfolios : [])
        .map(summarizeHubPortfolio)
        .sort(
          (a: any, b: any) =>
            Number(b.id === saved.activeId) - Number(a.id === saved.activeId) ||
            (b.updatedAt || "").localeCompare(a.updatedAt || ""),
        ),
    [saved, portfolioReadable],
  );
  const index = useMemo(
    () =>
      buildHubSearchIndex({
        portfolios: portfolioReadable ? saved.portfolios : [],
        watchlist,
        entries,
      }),
    [saved, watchlist, entries, portfolioReadable],
  );
  const search = useMemo(
    () =>
      searchHubResearch(index, query, searchLimit, {
        kind: searchKind,
        sort: searchSort,
      }),
    [index, query, searchLimit, searchKind, searchSort],
  );
  const filteredPortfolios = useMemo(
    () =>
      filterHubPortfolios(portfolios, {
        query: portfolioQuery,
        status: portfolioStatus,
        sort: portfolioSort,
      }),
    [portfolios, portfolioQuery, portfolioStatus, portfolioSort],
  );
  const evidenceCount = entries.filter(
    (entry) => entry.type === "evidence",
  ).length;
  const queuedCount = entries.filter((entry) => entry.type === "queue").length;
  const resume = portfolios[0];
  const canCreate = ready && portfolioReadable && portfolios.length < 20;
  const identityReview = portfolios.find(
    (portfolio: any) => portfolio.unresolved,
  );
  const unresearched = portfolios.find(
    (portfolio: any) => !portfolio.hasSnapshot && portfolio.totalCompanies > 0,
  );
  const incomplete = portfolios.find(
    (portfolio: any) => portfolio.hasSnapshot && portfolio.incomplete,
  );
  const nextSteps: {
    title: string;
    detail: string;
    action: string;
    view: string;
    options?: NavigationOptions;
  }[] = [];
  if (identityReview)
    nextSteps.push({
      title: "Confirm your company matches",
      detail: `${identityReview.name} has ${identityReview.unresolved} unresolved ${identityReview.unresolved === 1 ? "position" : "positions"}. Review identities before matching SEC evidence.`,
      action: "Review portfolio",
      view: "portfolios",
      options: { portfolioId: identityReview.id },
    });
  if (unresearched)
    nextSteps.push({
      title: "Capture your first research snapshot",
      detail: `${unresearched.name} has ${unresearched.totalCompanies} resolved operating ${unresearched.totalCompanies === 1 ? "company" : "companies"} ready for research.`,
      action: "Open portfolio",
      view: "portfolios",
      options: { portfolioId: unresearched.id },
    });
  else if (incomplete)
    nextSteps.push({
      title: "Finish checking your evidence",
      detail: `${incomplete.name} has ${incomplete.incomplete} ${incomplete.incomplete === 1 ? "company" : "companies"} with missing, stale, failed, or unchecked retrievals.`,
      action: "Resume research",
      view: "portfolios",
      options: { portfolioId: incomplete.id },
    });
  if (queuedCount)
    nextSteps.push({
      title: "Work through your saved review queue",
      detail: `${queuedCount} ${queuedCount === 1 ? "item is" : "items are"} waiting in your saved research. Open the inbox to review the evidence.`,
      action: "Open inbox",
      view: "inbox",
    });
  if (nextSteps.length < 3 && evidenceCount)
    nextSteps.push({
      title: "Build a brief from your evidence",
      detail:
        "Bring source passages and notes together around a question you want to answer.",
      action: "Open research briefs",
      view: "briefs",
    });
  if (nextSteps.length < 3 && watchlist.length)
    nextSteps.push({
      title: "Check the companies you follow",
      detail: `${watchlist.length} saved ${watchlist.length === 1 ? "entity" : "entities"} across your watchlists and Funds shelf. Review company filings from one place.`,
      action: "Open watchlists",
      view: "watchlist",
    });

  return (
    <section className={s.root} aria-labelledby="hub-overview-title">
      <div className={s.hero}>
        <div className={s.heroCopy}>
          <p className={s.eyebrow}>Your research, ready to continue</p>
          <h2 id="hub-overview-title">Choose your next research question.</h2>
          <p>
            Your portfolios, source evidence, and next steps in one place. Start
            with a company list, or return to the research you have saved.
          </p>
          <div className={s.heroActions}>
            <button
              className={s.primary}
              disabled={!ready || !portfolioReadable}
              onClick={() =>
                onNavigate(
                  "portfolios",
                  resume ? { portfolioId: resume.id } : { action: "new" },
                )
              }
            >
              {resume ? <FolderOpen size={17} /> : <Plus size={17} />}
              {resume ? "Continue research" : "Start a portfolio"}
              <ArrowRight size={16} />
            </button>
            {resume && (
              <button
                className={s.secondary}
                disabled={!canCreate}
                onClick={() => onNavigate("portfolios", { action: "new" })}
              >
                <Plus size={16} /> New portfolio
              </button>
            )}
          </div>
        </div>
        <div className={s.resume}>
          <div className={s.resumeIcon}>
            {resume ? <Layers3 size={24} /> : <ClipboardList size={24} />}
          </div>
          <p className={s.eyebrow}>
            {resume ? "Last active portfolio" : "A simple place to start"}
          </p>
          <h3>{resume ? resume.name : "AAPL, JPM, MSFT…"}</h3>
          <p>
            {resume
              ? `${resume.rowCount} included positions · ${resume.basis} research`
              : "A list of tickers is enough. Review each company match before running research."}
          </p>
          <span className={s.resumeMeta}>
            {resume
              ? `${resume.status} · ${resume.capturedAt ? `captured ${day(resume.capturedAt)}` : "no snapshot yet"}`
              : "Up to 100 positions · no weights required"}
          </span>
        </div>
      </div>

      <nav className={s.toolStrip} aria-label="Research by question">
        {[
          ["concentration", "Where is my exposure concentrated?"],
          ["financial", "How do company fundamentals compare?"],
          ["screener", "Which companies meet my criteria?"],
          ["coverage", "Where is my evidence incomplete?"],
        ].map(([area, label]) => (
          <button
            key={area}
            className={s.secondary}
            disabled={!resume}
            onClick={() =>
              onNavigate("portfolios", {
                portfolioId: resume.id,
                portfolioTab: "analytics",
                analyticsArea: area,
              })
            }
          >
            {label}
            <ArrowRight size={15} />
          </button>
        ))}
        <button
          className={s.secondary}
          disabled={portfolios.length < 2}
          onClick={() => setComparing((value) => !value)}
          aria-expanded={comparing}
        >
          Compare saved portfolios <Layers3 size={16} />
        </button>
        <small>
          {resume
            ? `Portfolio questions open ${resume.name}. Choose a different saved portfolio below.`
            : "Create a portfolio or preview the example to explore these questions."}
        </small>
      </nav>
      {comparing && portfolioReadable && (
        <HubComparison
          documents={saved.portfolios}
          activeId={saved.activeId}
          onNavigate={onNavigate}
        />
      )}

      <section className={s.demoCard} aria-labelledby="hub-demo-title">
        <div className={s.demoCopy}>
          <p className={s.eyebrow}>See what you can build</p>
          <h3 id="hub-demo-title">Explore a hypothetical weighted portfolio</h3>
          <p>
            Start with 100 companies and example weights totaling 100%. Compare
            concentration, scenarios and financial evidence with equal weights
            or company counts.
          </p>
        </div>
        <div className={s.demoActions}>
          <Link href="/workspace/demo" className={s.secondary} prefetch={false}>
            Preview example results <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <div
            className={s.demoDownloads}
            aria-label="Hypothetical weighted portfolio templates"
          >
            <a href="/portfolio/portfolio-demo-100.csv" download>
              <Download size={14} aria-hidden="true" /> Weighted CSV
            </a>
            <a href="/portfolio/portfolio-demo-100.xlsx" download>
              <Download size={14} aria-hidden="true" /> Weighted Excel
            </a>
          </div>
        </div>
      </section>

      {issues.length > 0 && (
        <div className={s.warning} role="status">
          <strong>Some saved research could not be loaded.</strong>
          <p>
            Counts below cover readable data. Existing saved work is preserved;
            the library shows storage details and backup options.
          </p>
          <button onClick={() => onNavigate("library")}>
            Open saved research
          </button>
          <details>
            <summary>Read storage details</summary>
            <ul>
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className={s.stats} aria-label="Saved research overview">
        <button onClick={() => onNavigate("portfolios")} disabled={!ready}>
          <Layers3 size={19} aria-hidden="true" />
          <strong>
            {ready && portfolioReadable ? portfolios.length : "—"}
          </strong>
          <span>Saved portfolios</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
        <button onClick={() => onNavigate("library")} disabled={!ready}>
          <Bookmark size={19} aria-hidden="true" />
          <strong>{ready ? evidenceCount : "—"}</strong>
          <span>Indexed evidence items</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
        <button onClick={() => onNavigate("inbox")} disabled={!ready}>
          <CheckCheck size={19} aria-hidden="true" />
          <strong>{ready ? queuedCount : "—"}</strong>
          <span>Saved pending reviews</span>
          <ArrowUpRight size={16} aria-hidden="true" />
        </button>
      </div>

      <section className={s.searchPanel} aria-labelledby="hub-search-title">
        <div>
          <h3 id="hub-search-title">Find anything you saved</h3>
          <p>
            Search portfolios, companies, notes, and source evidence together.
          </p>
        </div>
        <label className={s.searchInput}>
          <Search size={20} aria-hidden="true" />
          <span className={s.srOnly}>Search all saved research</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchLimit(12);
            }}
            placeholder="Try a ticker, portfolio name, or research question"
            maxLength={300}
            autoComplete="off"
            disabled={!ready}
          />
        </label>
        <div className={s.filterBar}>
          <label>
            Research type
            <select
              value={searchKind}
              onChange={(event) => {
                setSearchKind(event.target.value);
                setSearchLimit(12);
              }}
            >
              {[
                "all",
                "Portfolio",
                "Watchlist",
                "Pending review",
                "Evidence",
                "Note",
                "Saved research",
              ].map((kind) => (
                <option key={kind} value={kind}>
                  {kind === "all" ? "All saved research" : kind}
                </option>
              ))}
            </select>
          </label>
          <label>
            Order
            <select
              value={searchSort}
              onChange={(event) => {
                setSearchSort(event.target.value);
                setSearchLimit(12);
              }}
            >
              <option value="relevance">Best match</option>
              <option value="recent">Most recent</option>
            </select>
          </label>
        </div>
        {query.trim() && (
          <div>
            <p role="status" className={s.resultCount}>
              {search.total
                ? `${search.total} ${search.total === 1 ? "match" : "matches"}${search.total > search.results.length ? ` · showing the first ${search.results.length}` : ""}`
                : "No saved research matches. Try a shorter name, ticker, or topic."}
            </p>
            <ul className={s.searchResults}>
              {search.results.map((item: any) => (
                <li key={item.id}>
                  <div>
                    <span className={s.resultKind}>
                      {item.kind} · {item.source}
                    </span>
                    {item.portfolioId ? (
                      <button
                        className={s.resultTitle}
                        onClick={() =>
                          onNavigate("portfolios", {
                            portfolioId: item.portfolioId,
                          })
                        }
                      >
                        {item.title}
                        <ArrowRight size={15} />
                      </button>
                    ) : (
                      <Link
                        className={s.resultTitle}
                        href={item.href}
                        prefetch={false}
                      >
                        {item.ticker && `${item.ticker} · `}
                        {item.title}
                        <ArrowUpRight size={15} />
                      </Link>
                    )}
                    <p>{item.description}</p>
                  </div>
                  {item.date && (
                    <time dateTime={item.date}>{day(item.date)}</time>
                  )}
                </li>
              ))}
            </ul>
            {search.total > search.results.length && (
              <button
                className={s.textButton}
                onClick={() =>
                  searchLimit < 50
                    ? setSearchLimit((value) => Math.min(50, value + 12))
                    : onNavigate("library")
                }
              >
                {searchLimit < 50
                  ? "Show more matches"
                  : "Open the full library"}{" "}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        )}
        <small className={s.localNote}>
          Search stays in this browser. Private notes are never sent to a search
          service.
        </small>
      </section>

      {!ready && <p role="status">Opening your saved research…</p>}
      {ready && portfolios.length > 0 && (
        <section aria-labelledby="hub-portfolios-title">
          <div className={s.sectionHeading}>
            <div>
              <p className={s.eyebrow}>Continue a research thread</p>
              <h3 id="hub-portfolios-title">Your portfolios & company lists</h3>
            </div>
            <button
              className={s.textButton}
              disabled={!canCreate}
              onClick={() => onNavigate("portfolios", { action: "new" })}
            >
              <Plus size={16} /> New portfolio
            </button>
          </div>
          <div className={s.filterBar}>
            <label>
              Find a portfolio
              <input
                type="search"
                value={portfolioQuery}
                onChange={(event) => setPortfolioQuery(event.target.value)}
                maxLength={160}
                placeholder="Portfolio name"
              />
            </label>
            <label>
              Research status
              <select
                value={portfolioStatus}
                onChange={(event) => setPortfolioStatus(event.target.value)}
              >
                <option value="all">All portfolios</option>
                <option value="unresearched">No snapshot</option>
                <option value="attention">Needs attention</option>
                <option value="captured">Captured, no retrieval gaps</option>
              </select>
            </label>
            <label>
              Sort
              <select
                value={portfolioSort}
                onChange={(event) => setPortfolioSort(event.target.value)}
              >
                <option value="recent">Recently updated</option>
                <option value="name">Name</option>
                <option value="coverage">Lowest coverage first</option>
              </select>
            </label>
          </div>
          <p className={s.resultCount} role="status">
            {filteredPortfolios.length} of {portfolios.length} portfolios match.
          </p>
          <div className={s.portfolioGrid}>
            {(showAll
              ? filteredPortfolios
              : filteredPortfolios.slice(0, 6)
            ).map((portfolio: any) => (
              <article className={s.portfolioCard} key={portfolio.id}>
                <div className={s.cardMeta}>
                  <span>
                    {portfolio.basis} ·{" "}
                    {portfolio.weighted ? "Weighted portfolio" : "Company list"}
                  </span>
                  {portfolio.id === saved.activeId && (
                    <span className={s.activeBadge}>Last active</span>
                  )}
                </div>
                <h4>{portfolio.name}</h4>
                <p>
                  {portfolio.rowCount} included positions ·{" "}
                  {portfolio.issuerCount} identified holdings
                </p>
                <div className={s.coverage}>
                  <div>
                    <span>Financial evidence</span>
                    <strong>
                      {!portfolio.hasSnapshot
                        ? "Not researched"
                        : portfolio.totalCompanies
                          ? `${portfolio.availableCompanies} / ${portfolio.totalCompanies} companies`
                          : "No operating companies"}
                    </strong>
                  </div>
                  {portfolio.coveragePct !== null && (
                    <progress
                      value={portfolio.coveragePct}
                      max={100}
                      aria-label={`${portfolio.name}: financial evidence for ${portfolio.availableCompanies} of ${portfolio.totalCompanies} resolved operating companies`}
                    />
                  )}
                  <small>
                    {portfolio.unresolved > 0 &&
                      `${portfolio.unresolved} unresolved positions · `}
                    {portfolio.fundCount > 0 &&
                      `${portfolio.fundCount} funds · `}
                    Resolved operating companies counted once.
                  </small>
                </div>
                <div className={s.cardFooter}>
                  <div>
                    <span
                      className={
                        portfolio.incomplete || portfolio.unresolved
                          ? s.attention
                          : s.cardStatus
                      }
                    >
                      {portfolio.status}
                    </span>
                    <small>
                      {portfolio.capturedAt
                        ? `Captured ${day(portfolio.capturedAt)}`
                        : "No research snapshot saved"}
                    </small>
                  </div>
                  <button
                    className={s.openButton}
                    aria-label={`Open ${portfolio.name}`}
                    onClick={() =>
                      onNavigate("portfolios", { portfolioId: portfolio.id })
                    }
                  >
                    Open <ArrowRight size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {filteredPortfolios.length > 6 && (
            <button className={s.showAll} onClick={() => setShowAll(!showAll)}>
              {showAll
                ? "Show recent portfolios"
                : `Show all ${filteredPortfolios.length} portfolios`}
            </button>
          )}
          <p className={s.coverageNote}>
            Coverage means at least one supported financial measure is
            available. It does not measure investment quality or confirm that
            every metric is complete.
          </p>
        </section>
      )}

      {ready && nextSteps.length > 0 && (
        <section aria-labelledby="hub-next-title">
          <div className={s.sectionHeading}>
            <div>
              <p className={s.eyebrow}>Keep the work moving</p>
              <h3 id="hub-next-title">Useful next steps</h3>
            </div>
            <button
              className={s.textButton}
              onClick={() => onNavigate("inbox")}
            >
              Research inbox <ArrowRight size={15} />
            </button>
          </div>
          <div className={s.nextGrid}>
            {nextSteps.slice(0, 3).map((step, index) => (
              <article className={s.nextCard} key={step.title}>
                <span className={s.stepNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h4>{step.title}</h4>
                <p>{step.detail}</p>
                <button
                  className={s.textButton}
                  onClick={() => onNavigate(step.view, step.options)}
                >
                  {step.action}
                  <ArrowRight size={15} />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className={s.startPanel} aria-labelledby="hub-start-title">
        <div className={s.sectionHeading}>
          <div>
            <h3 id="hub-start-title">
              {resume ? "Start another question" : "Choose how to begin"}
            </h3>
            <p>
              Use what you have. Your original inputs stay available for review.
            </p>
          </div>
          <Link href="/workspace/portfolio-guide" className={s.guideLink}>
            Templates & guide <ArrowUpRight size={15} />
          </Link>
        </div>
        <div className={s.shortcuts}>
          <button
            disabled={!canCreate}
            onClick={() => onNavigate("portfolios", { action: "new" })}
          >
            <FileText size={20} aria-hidden="true" />
            <strong>Upload a portfolio</strong>
            <span>CSV, Excel, or JSON with column review.</span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <button
            disabled={!canCreate}
            onClick={() => onNavigate("portfolios", { action: "paste" })}
          >
            <ClipboardList size={20} aria-hidden="true" />
            <strong>Paste tickers</strong>
            <span>Build a research list without a spreadsheet.</span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <button
            disabled={!canCreate || !watchlist.length}
            onClick={() => onNavigate("portfolios", { action: "watchlist" })}
          >
            <Bookmark size={20} aria-hidden="true" />
            <strong>Use your watchlist</strong>
            <span>
              {watchlist.length
                ? `${watchlist.length} saved entities ready to review.`
                : "Save a company or fund to your watchlist first."}
            </span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
        {ready && portfolios.length >= 20 && (
          <p>
            All 20 portfolio slots are in use. Open a saved portfolio to edit
            its rows, or manage your portfolios before starting another.
          </p>
        )}
        {!watchlist.length && ready && (
          <button
            className={s.textButton}
            onClick={() => onNavigate("watchlist")}
          >
            Add a company to your watchlist <ArrowRight size={15} />
          </button>
        )}
      </section>
    </section>
  );
}
