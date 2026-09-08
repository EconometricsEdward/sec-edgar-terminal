"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Inbox,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  PORTFOLIOS_KEY,
  readPortfolios,
} from "../../utils/portfolioStorage.js";
import { readResearchVault } from "../../utils/researchVault.js";
import {
  deriveResearchInbox,
  readResearchInbox,
  RESEARCH_INBOX_KEY,
  updateResearchInbox,
} from "../../utils/researchInbox.js";
import styles from "./ResearchInbox.module.css";

const kindLabel: Record<string, string> = {
  identity: "Identity",
  coverage: "Coverage",
  freshness: "Freshness",
  filing: "Recent filings",
  queue: "Saved filing queue",
  metric: "Reported results",
  watchlist: "Watchlist review",
};
const displayDate = (value: string) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
      })
    : "";

export default function ResearchInbox({
  watchlist,
  onNavigate,
  onCreateBrief,
}: {
  watchlist: any[];
  onNavigate: (
    view: string,
    options?: { portfolioId?: string; rowId?: string },
  ) => void;
  onCreateBrief: (draft: any) => void;
}) {
  const [portfolios, setPortfolios] = useState<any[]>([]);
  const [vault, setVault] = useState<any>({ entries: [] });
  const [states, setStates] = useState<any>(() => readResearchInbox(null));
  const [ready, setReady] = useState(false);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [decisionsAvailable, setDecisionsAvailable] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [status, setStatus] = useState("open");
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [kind, setKind] = useState("");
  const [groupBy, setGroupBy] = useState("priority");
  const [limit, setLimit] = useState(40);
  const listHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    const read = () => {
      const failures: string[] = [];
      try {
        setPortfolios(
          readPortfolios(localStorage.getItem(PORTFOLIOS_KEY)).portfolios,
        );
      } catch (problem) {
        setPortfolios([]);
        failures.push(
          problem instanceof Error
            ? problem.message
            : "Saved portfolios could not be read.",
        );
      }
      try {
        const index = readResearchVault(localStorage);
        setVault(index);
        failures.push(
          ...index.issues.map(
            (issue: any) => `${issue.label}: ${issue.message}`,
          ),
        );
      } catch {
        setVault({ entries: [] });
        failures.push("The saved filing queue could not be read.");
      }
      try {
        setStates(readResearchInbox(localStorage.getItem(RESEARCH_INBOX_KEY)));
        setDecisionsAvailable(true);
      } catch (problem) {
        setDecisionsAvailable(false);
        failures.push(
          problem instanceof Error
            ? problem.message
            : "Saved inbox decisions could not be read.",
        );
      }
      setReadErrors([...new Set(failures)]);
      setNow(Date.now());
      setReady(true);
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("research-storage", read);
    window.addEventListener("focus", read);
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("research-storage", read);
      window.removeEventListener("focus", read);
      window.clearInterval(timer);
    };
  }, []);
  const derived = useMemo(
    () => deriveResearchInbox({ portfolios, watchlist, vault, states, now }),
    [portfolios, watchlist, vault, states, now],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return derived.items.filter(
      (item: any) =>
        (status === "all" || item.status === status) &&
        (!company || item.companyKey === company) &&
        (!kind || item.kind === kind) &&
        (!needle ||
          [
            item.title,
            item.reason,
            item.ticker,
            item.companyName,
            item.portfolioName,
            item.source,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [derived.items, query, company, kind, status]);
  const groups = useMemo(() => {
    const companyLabels = new Map(
      derived.companies.map((entry: any) => [entry.key, entry.label]),
    );
    const ordered =
      groupBy === "company"
        ? [...filtered].sort(
            (a: any, b: any) =>
              a.companyName.localeCompare(b.companyName) ||
              a.priorityOrder - b.priorityOrder,
          )
        : filtered;
    const output = new Map<string, any[]>();
    for (const item of ordered.slice(0, limit)) {
      const name =
        groupBy === "company"
          ? companyLabels.get(item.companyKey) || item.companyName
          : item.priorityLabel;
      output.set(name, [...(output.get(name) || []), item]);
    }
    return [...output.entries()];
  }, [filtered, groupBy, limit, derived.companies]);
  function changeFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setLimit(40);
  }
  function decide(item: any, nextStatus: "open" | "reviewed" | "snoozed") {
    setError("");
    try {
      const next = updateResearchInbox(localStorage, {
        id: item.id,
        status: nextStatus,
        expectedUpdatedAt: item.stateUpdatedAt,
      });
      setStates(next);
      setMessage(
        nextStatus === "reviewed"
          ? `${item.ticker || item.companyName}: marked reviewed in this inbox.`
          : nextStatus === "snoozed"
            ? `${item.ticker || item.companyName}: snoozed for seven days.`
            : `${item.ticker || item.companyName}: reopened in this inbox.`,
      );
      window.dispatchEvent(new Event("research-storage"));
      if (status !== "all" && status !== nextStatus)
        listHeading.current?.focus();
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Your inbox decision could not be saved.",
      );
    }
  }
  function draftBrief(item: any) {
    onCreateBrief({
      title: `${item.ticker || item.companyName}: ${item.title}`,
      ticker: item.ticker,
      cik: item.cik,
      portfolioId: item.portfolioId,
      question: `${item.reason}\n\nWhat does this evidence change, and what would contradict that conclusion?`,
      sources: item.sourceUrl
        ? [
            {
              label: `${item.ticker || item.companyName} · ${item.title}`,
              url: item.sourceUrl,
              annotation: "context",
              origin: item.source,
              ...(item.capturedAt ? { capturedAt: item.capturedAt } : {}),
            },
          ]
        : [],
    });
  }
  const problems = [...new Set([...readErrors, ...derived.warnings])];
  return (
    <section className={styles.root} aria-labelledby="inbox-title">
      <div className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>YOUR NEXT RESEARCH DECISION</p>
          <h2 id="inbox-title">Make the next read count.</h2>
          <p>
            One place for recent filings, evidence gaps, and the companies you
            want to revisit. Every item explains why it is here.
          </p>
        </div>
        <div className={styles.heroCount}>
          <Inbox size={24} aria-hidden="true" />
          <strong>{ready ? derived.counts.open : "—"}</strong>
          <span>open research items</span>
        </div>
      </div>
      <div className={styles.guide}>
        <span>
          <strong>Read</strong> the evidence
        </span>
        <span>
          <strong>Decide</strong> what changes
        </span>
        <span>
          <strong>Record</strong> a research brief
        </span>
      </div>
      <p className={styles.explanation}>
        Built from research already saved in this browser. Conditions are
        grouped by the action they need; they are not investment ratings.
        Refreshing SEC data never marks an item reviewed.
      </p>
      {problems.length > 0 && (
        <div className={styles.alert} role="alert">
          <strong>Some saved research is unavailable.</strong>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => onNavigate("library")}
          >
            Open saved research and backups{" "}
            <ArrowUpRight size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {error && (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      )}
      <p className={styles.live} role="status" aria-live="polite">
        {message}
      </p>
      <div className={styles.tabs} role="group" aria-label="Inbox status">
        {[
          ["open", "Open", derived.counts.open],
          ["snoozed", "Snoozed", derived.counts.snoozed],
          ["reviewed", "Reviewed", derived.counts.reviewed],
          ["all", "All", derived.counts.total],
        ].map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            className={status === value ? styles.activeTab : ""}
            onClick={() => changeFilter(setStatus, String(value))}
          >
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      <div className={styles.filters}>
        <label className={styles.searchLabel}>
          Search the inbox
          <div className={styles.search}>
            <Search size={18} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => changeFilter(setQuery, event.target.value)}
              placeholder="Company, filing, or condition"
              type="search"
            />
          </div>
        </label>
        <label>
          Company
          <select
            value={company}
            onChange={(event) => changeFilter(setCompany, event.target.value)}
          >
            <option value="">All companies</option>
            {derived.companies.map((entry: any) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Item type
          <select
            value={kind}
            onChange={(event) => changeFilter(setKind, event.target.value)}
          >
            <option value="">All item types</option>
            {derived.kinds.map((entry: string) => (
              <option key={entry} value={entry}>
                {kindLabel[entry]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Group by
          <select
            value={groupBy}
            onChange={(event) => changeFilter(setGroupBy, event.target.value)}
          >
            <option value="priority">Research action</option>
            <option value="company">Company</option>
          </select>
        </label>
      </div>
      <div className={styles.resultHeading}>
        <h3 ref={listHeading} tabIndex={-1}>
          {!ready
            ? "Reading your saved research…"
            : `${filtered.length} ${filtered.length === 1 ? "item" : "items"}${status === "all" ? " across all statuses" : ` ${status}`}`}
        </h3>
        {(query || company || kind) && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              setQuery("");
              setCompany("");
              setKind("");
              setLimit(40);
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {ready && !filtered.length && (
        <div className={styles.empty}>
          <Check size={32} aria-hidden="true" />
          <h3>
            {derived.counts.total === 0
              ? "Your research inbox starts with your companies."
              : query || company || kind
                ? "No items match these filters."
                : status === "open"
                  ? "Your current inbox is clear."
                  : `No ${status} items right now.`}
          </h3>
          <p>
            {derived.counts.total === 0
              ? "Create a portfolio and run SEC research, add a company to your watchlist, or queue a filing to build a useful reading list."
              : "Items appear only while their research condition is present. New filing accessions and changed evidence get their own review decisions."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => onNavigate("portfolios")}
            >
              Open portfolios <ArrowUpRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => onNavigate("watchlist")}
            >
              Open watchlist
            </button>
          </div>
        </div>
      )}
      {groups.map(([name, items]) => (
        <section className={styles.group} key={name} aria-label={name}>
          <h3 className={styles.groupTitle}>
            {name}
            <span>{items.length}</span>
          </h3>
          <div className={styles.cards}>
            {items.map((item: any) => (
              <article className={styles.card} key={item.id}>
                <div className={styles.cardTop}>
                  <span className={styles.tag}>{kindLabel[item.kind]}</span>
                  <span
                    className={`${styles.state} ${item.status === "reviewed" ? styles.reviewed : ""}`}
                  >
                    {item.status === "snoozed"
                      ? `Snoozed until ${displayDate(item.snoozedUntil)}`
                      : item.status === "reviewed"
                        ? "Reviewed"
                        : "Open"}
                  </span>
                </div>
                <div className={styles.company}>
                  {item.ticker && <strong>{item.ticker}</strong>}
                  <span>{item.companyName}</span>
                </div>
                <h4>{item.title}</h4>
                <p className={styles.reason}>{item.reason}</p>
                <p className={styles.provenance}>
                  {item.source}
                  {item.portfolioName ? ` · ${item.portfolioName}` : ""}
                  {item.evidenceDate
                    ? ` · ${displayDate(item.evidenceDate)}`
                    : ""}
                </p>
                <div className={styles.evidenceActions}>
                  {item.sourceUrl && (
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Read SEC source{" "}
                      <ArrowUpRight size={15} aria-hidden="true" />
                      <span className={styles.srOnly}>
                        {" "}
                        (opens in a new tab)
                      </span>
                    </a>
                  )}
                  {item.portfolioId && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() =>
                        onNavigate("portfolios", {
                          portfolioId: item.portfolioId,
                          rowId: item.rowId,
                        })
                      }
                    >
                      Open portfolio{" "}
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </button>
                  )}
                  {item.companyUrl && (
                    <Link href={item.companyUrl}>
                      {item.kind === "queue"
                        ? "Open saved filing"
                        : item.instrumentKind === "fund"
                          ? "Open fund"
                          : "Open company"}
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </Link>
                  )}
                </div>
                <div className={styles.cardBottom}>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => draftBrief(item)}
                  >
                    Draft a brief
                  </button>
                  <div className={styles.decisions}>
                    {item.status !== "reviewed" && (
                      <button
                        type="button"
                        className={styles.primary}
                        disabled={!decisionsAvailable}
                        onClick={() => decide(item, "reviewed")}
                      >
                        <Check size={15} aria-hidden="true" />
                        Mark reviewed
                        <span className={styles.srOnly}>
                          : {item.companyName}, {item.title}
                        </span>
                      </button>
                    )}
                    {item.status === "open" ? (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={!decisionsAvailable}
                        onClick={() => decide(item, "snoozed")}
                      >
                        <Clock3 size={15} aria-hidden="true" />
                        Snooze 7 days
                        <span className={styles.srOnly}>
                          : {item.companyName}, {item.title}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={!decisionsAvailable}
                        onClick={() => decide(item, "open")}
                      >
                        <RotateCcw size={15} aria-hidden="true" />
                        Reopen
                        <span className={styles.srOnly}>
                          : {item.companyName}, {item.title}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
      {filtered.length > limit && (
        <button
          type="button"
          className={styles.loadMore}
          onClick={() => setLimit((value) => value + 40)}
        >
          Show {Math.min(40, filtered.length - limit)} more items (
          {filtered.length - limit} remaining)
        </button>
      )}
      <details className={styles.methodology}>
        <summary>How this inbox works</summary>
        <ul>
          <li>
            Recent filings cover the last 30 days of the filings in saved
            portfolio snapshots. A new accession always creates a new item.
          </li>
          <li>
            Missing financial coverage is highlighted for positions with a known
            allocation of at least 10%. Freshness uses reporting periods older
            than 550 days for annual research or 200 days for TTM research, plus
            explicitly stale cached results.
          </li>
          <li>
            Reported-result prompts flag negative net income, reported equity,
            or operating cash flow. They invite investigation and do not predict
            performance.
          </li>
          <li>
            Watchlist reminders appear before the first company review or 90
            days after a saved review. Your existing company review dates and
            filing queue remain unchanged by inbox actions.
          </li>
          <li>
            Review decisions apply to the exact evidence or condition shown.
            Material changes create a new open item; snoozes expire after seven
            days. Conditions that disappear from saved research also leave this
            inbox.
          </li>
          <li>
            Only item identifiers, review status, and dates are saved for the
            inbox. These local decisions are included in Research Hub backups.
          </li>
        </ul>
      </details>
    </section>
  );
}
