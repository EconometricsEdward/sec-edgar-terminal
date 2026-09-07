"use client";
import { useMemo, useState } from "react";
import { CheckCheck, Inbox, RefreshCw, Trash2 } from "lucide-react";
import {
  buildDisclosureInbox,
  disclosureInboxCoverage,
  filterDisclosureInbox,
  reviewDisclosureInbox,
} from "../../utils/disclosureInbox.js";
import type {
  DisclosureNotebook,
  Filing,
  SavedSearch,
  SearchSettings,
} from "./disclosureTypes";
import s from "./disclosures.module.css";
import styles from "./DisclosureInbox.module.css";

const dateTime = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Never";
};

export function DisclosureInbox({
  notebook,
  change,
  check,
  open,
  load,
  checking,
  ready = true,
}: {
  notebook: DisclosureNotebook;
  change: (
    update: (current: DisclosureNotebook) => DisclosureNotebook,
  ) => boolean;
  check: (saved: SavedSearch) => void;
  open: (filing: Filing, settings: SearchSettings) => void;
  load: (settings: SearchSettings) => void;
  checking: string;
  ready?: boolean;
}) {
  const [filters, setFilters] = useState({
    company: "",
    search: "",
    form: "",
    status: "unreviewed",
    text: "",
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [queryChoices, setQueryChoices] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(30);
  const [message, setMessage] = useState("");
  const rows = useMemo(
    () => buildDisclosureInbox(notebook.searches),
    [notebook.searches],
  );
  const filtered = useMemo(
    () => filterDisclosureInbox(rows, filters),
    [rows, filters],
  );
  const visible = filtered.slice(0, limit);
  const selectedRows = filtered.filter((row) => selected.includes(row.id));
  const selectedMemberships = selectedRows.flatMap((row) => row.memberships);
  const coverage = disclosureInboxCoverage(notebook.searches);
  const incomplete = coverage.filter(
    (c) => c.failed || c.unavailable || c.companyErrors || c.limited,
  );
  const unreviewed = rows.filter((row) =>
    row.memberships.some((m) => !m.reviewed),
  ).length;
  const companies = [
    ...new Set(
      rows.flatMap((row) => row.memberships.map((m) => m.filing.ticker)),
    ),
  ].sort() as string[];
  const forms = [
    ...new Set(rows.map((row) => row.filing.form)),
  ].sort() as string[];
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setSelected([]);
    setLimit(30);
    setMessage("");
  };
  const patch = (id: string, values: Partial<SavedSearch>) =>
    change((current) => ({
      ...current,
      searches: current.searches.map((item) =>
        item.id === id ? { ...item, ...values } : item,
      ),
    }));
  const mark = (
    targets: { searchId: string; itemId: string }[],
    reviewed: boolean,
  ) => {
    const ok = change((current) =>
      reviewDisclosureInbox(current, targets, reviewed),
    );
    if (ok) {
      setMessage(
        `${targets.length} search membership${targets.length === 1 ? "" : "s"} marked ${reviewed ? "reviewed" : "unreviewed"}.`,
      );
      setSelected([]);
    }
  };
  return (
    <section className={s.panel} aria-labelledby="disclosure-inbox-title">
      <div className={s.panelHeading}>
        <div>
          <span className={s.eyebrow}>Your disclosure monitoring inbox</span>
          <h2 id="disclosure-inbox-title">
            Review each filing once. Keep every research angle.
          </h2>
        </div>
        <Inbox size={26} aria-hidden="true" />
      </div>
      <p className={s.muted}>
        Matching filings are grouped across saved searches. Choose the query you
        want to read; review status stays separate for each search.
      </p>
      <div className={styles.stats}>
        <div>
          <strong>{unreviewed}</strong>
          <span>Filings needing review</span>
        </div>
        <div>
          <strong>{rows.length}</strong>
          <span>Unique matched filings</span>
        </div>
        <div>
          <strong>{notebook.searches.length}</strong>
          <span>Saved searches</span>
        </div>
        <div>
          <strong>{incomplete.length}</strong>
          <span>Latest checks with coverage limits</span>
        </div>
      </div>
      <details className={styles.manage} open={!notebook.searches.length}>
        <summary>
          Manage saved searches and check coverage ({notebook.searches.length})
        </summary>
        <p className={s.muted}>
          Stored in this browser. Opt-in checks rerun your query when this page
          is open and every 15 minutes while visible. No external notifications
          are sent.
        </p>
        {!notebook.searches.length && (
          <div className={s.empty}>
            Run a search, name it, and select “Save search” to establish a
            review baseline.
          </div>
        )}
        {notebook.searches.map((saved) => {
          const checked = coverage.find((c) => c.searchId === saved.id);
          return (
            <article className={styles.saved} key={saved.id}>
              <div className={s.panelHeading}>
                <div>
                  <h3>{saved.name}</h3>
                  <code>{saved.settings.query}</code>
                  <p className={s.muted}>
                    {saved.settings.tickers || "SEC index candidate sample"} ·{" "}
                    {saved.settings.forms} · {saved.settings.section} ·{" "}
                    {saved.settings.scope}
                    <br />
                    Last checked: {dateTime(saved.lastChecked)}
                  </p>
                </div>
                <div className={s.actions}>
                  <button
                    disabled={!ready || Boolean(checking)}
                    onClick={() => check(saved)}
                  >
                    <RefreshCw size={14} />
                    {checking === saved.id ? "Checking…" : "Check now"}
                  </button>
                  <button onClick={() => load({ ...saved.settings })}>
                    Load search
                  </button>
                  <button
                    aria-label={`Delete saved search ${saved.name}`}
                    disabled={!ready}
                    onClick={() =>
                      change((current) => ({
                        ...current,
                        searches: current.searches.filter(
                          (x) => x.id !== saved.id,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className={s.filterRow}>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={Boolean(saved.autoCheck)}
                    disabled={!ready}
                    onChange={(e) =>
                      patch(saved.id, { autoCheck: e.target.checked })
                    }
                  />
                  Check automatically while Disclosures is open
                </label>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    checked={Boolean(saved.followLatest)}
                    disabled={!ready}
                    onChange={(e) =>
                      patch(saved.id, { followLatest: e.target.checked })
                    }
                  />
                  Extend the filing end date to today on each check
                </label>
              </div>
              {checked?.hasCheck ? (
                <p className={styles.coverage}>
                  Latest check: {checked.reviewed} documents successfully
                  searched · {checked.failed} fetch failures ·{" "}
                  {checked.unavailable} unavailable sections ·{" "}
                  {checked.companyErrors} company errors
                  {checked.limited ? " · bounded history/depth" : ""}.
                  {!checked.reviewed
                    ? " No documents were successfully searched; this is not a no-match result."
                    : " Previously seen matches do not re-enter the inbox."}
                </p>
              ) : (
                <p className={s.muted}>
                  This saved search has not been checked yet.
                </p>
              )}
              {!!saved.lastCoverage?.length && (
                <details className={s.method}>
                  <summary>Coverage by company</summary>
                  {saved.lastCoverage.map((c, i) => (
                    <p key={`${c.ticker}:${i}`}>
                      {c.ticker}: {c.reviewed} successfully searched ·{" "}
                      {c.failed} fetch failures · {c.sectionUnavailable}{" "}
                      sections unavailable
                      {c.limited ? " · bounded history/depth" : ""}
                      {c.error ? ` · ${c.error}` : ""}
                    </p>
                  ))}
                </details>
              )}
            </article>
          );
        })}
      </details>
      <div className={styles.filters}>
        <label>
          Find an inbox filing
          <input
            type="search"
            value={filters.text}
            placeholder="Company, accession, query…"
            onChange={(e) => setFilter("text", e.target.value)}
          />
        </label>
        <label>
          Company
          <select
            value={filters.company}
            onChange={(e) => setFilter("company", e.target.value)}
          >
            <option value="">All companies</option>
            {companies.map((company) => (
              <option key={company}>{company}</option>
            ))}
          </select>
        </label>
        <label>
          Saved search
          <select
            value={filters.search}
            onChange={(e) => setFilter("search", e.target.value)}
          >
            <option value="">All saved searches</option>
            {notebook.searches.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {saved.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Filing form
          <select
            value={filters.form}
            onChange={(e) => setFilter("form", e.target.value)}
          >
            <option value="">All forms</option>
            {forms.map((form) => (
              <option key={form}>{form}</option>
            ))}
          </select>
        </label>
        <label>
          Review status
          <select
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value)}
          >
            <option value="unreviewed">Needs review</option>
            <option value="all">All statuses</option>
            <option value="partial">Partly reviewed</option>
            <option value="reviewed">Fully reviewed</option>
          </select>
        </label>
      </div>
      <div className={styles.bulk}>
        <label className={s.check}>
          <input
            type="checkbox"
            aria-label="Select shown inbox filings"
            disabled={!visible.length}
            checked={
              !!visible.length &&
              visible.every((row) => selected.includes(row.id))
            }
            onChange={(e) =>
              setSelected((current) =>
                e.target.checked
                  ? [...new Set([...current, ...visible.map((row) => row.id)])]
                  : current.filter(
                      (id) => !visible.some((row) => row.id === id),
                    ),
              )
            }
          />
          Select shown
        </label>
        <span>
          {selectedRows.length} filings selected · {selectedMemberships.length}{" "}
          search memberships
        </span>
        <button
          disabled={!ready || !selectedMemberships.length}
          onClick={() => mark(selectedMemberships, true)}
        >
          <CheckCheck size={14} />
          Mark selected reviewed
        </button>
        <button
          disabled={!ready || !selectedMemberships.length}
          onClick={() => mark(selectedMemberships, false)}
        >
          Mark selected unreviewed
        </button>
      </div>
      <p className={styles.selectionHelp}>
        Bulk actions apply to selected filings in the current saved-search
        filter. A filing appearing in several searches has a separate review
        state for each query.
      </p>
      {message && (
        <p role="status" className={styles.feedback}>
          {message}
        </p>
      )}
      {!filtered.length && (
        <div className={s.empty}>
          <h3>No filings in this view</h3>
          <p>
            {rows.length
              ? "Change the filters or choose All statuses to see reviewed filings."
              : "New matches will appear after a saved-search check finds filings outside its existing baseline."}
            {incomplete.length
              ? " Some latest checks have incomplete coverage; open Manage saved searches for failed or unsearched documents."
              : " An empty inbox does not establish that no relevant disclosures exist."}
          </p>
        </div>
      )}
      <div className={styles.results}>
        {visible.map((row) => {
          const chosen =
            row.memberships.find((m) => m.searchId === queryChoices[row.id]) ||
            (row.memberships.length === 1 ? row.memberships[0] : null);
          return (
            <article key={row.id} className={styles.filing}>
              <div className={styles.filingHeading}>
                <label className={s.check}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.filing.ticker} ${row.filing.form} ${row.filing.filingDate}`}
                    checked={selected.includes(row.id)}
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked
                          ? [...new Set([...current, row.id])]
                          : current.filter((id) => id !== row.id),
                      )
                    }
                  />
                  <strong>
                    {row.filing.ticker} · {row.filing.form}
                  </strong>
                </label>
                <span className={styles.badge}>
                  {row.reviewState === "reviewed"
                    ? "Fully reviewed"
                    : row.reviewState === "partial"
                      ? "Partly reviewed"
                      : "Needs review"}{" "}
                  · {row.memberships.length}{" "}
                  {row.memberships.length === 1 ? "query" : "queries"}
                </span>
              </div>
              <p className={s.muted}>
                Filed {row.filing.filingDate} · Reporting period{" "}
                {row.filing.reportDate || "not supplied"}
                <br />
                Accession {row.filing.accession} · Discovered{" "}
                {dateTime(row.latestDiscovery)}
              </p>
              <div className={styles.readRow}>
                <label>
                  Read with this matching search
                  <select
                    aria-label={`Matching search for ${row.filing.ticker} ${row.filing.accession}`}
                    value={chosen?.searchId || ""}
                    onChange={(e) =>
                      setQueryChoices((current) => ({
                        ...current,
                        [row.id]: e.target.value,
                      }))
                    }
                  >
                    <option value="" disabled>
                      Choose a research query
                    </option>
                    {row.memberships.map((m) => (
                      <option value={m.searchId} key={m.searchId}>
                        {m.searchName} ·{" "}
                        {m.reviewed ? "reviewed" : "unreviewed"}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={!chosen}
                  onClick={() =>
                    chosen && open(chosen.filing, { ...chosen.settings })
                  }
                >
                  Read selected evidence
                </button>
                <button
                  disabled={!ready || !chosen}
                  onClick={() => chosen && mark([chosen], !chosen.reviewed)}
                >
                  {chosen?.reviewed
                    ? "Mark this query unreviewed"
                    : "Mark this query reviewed"}
                </button>
              </div>
              {chosen ? (
                <div className={styles.query}>
                  <code>{chosen.settings.query}</code>
                  <p>
                    {chosen.settings.section} · {chosen.settings.scope} ·{" "}
                    {chosen.settings.start} to {chosen.settings.end}
                    <br />
                    {chosen.reason} ·{" "}
                    {chosen.capturedSettings
                      ? "Search settings preserved when this match was discovered."
                      : "Original search window not recorded. The saved search settings will be used."}
                  </p>
                </div>
              ) : (
                <p className={styles.selectionHelp}>
                  Choose a query to open the corresponding evidence. Reading a
                  filing does not automatically mark its other research topics
                  reviewed.
                </p>
              )}
            </article>
          );
        })}
      </div>
      {filtered.length > visible.length && (
        <button className={styles.more} onClick={() => setLimit((n) => n + 30)}>
          Show 30 more filings ({filtered.length - visible.length} remaining)
        </button>
      )}
    </section>
  );
}
