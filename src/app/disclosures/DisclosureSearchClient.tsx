"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileSearch,
  BookmarkPlus,
  Link as LinkIcon,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  RefreshCw,
} from "lucide-react";
import {
  legacyDisclosureQuery,
  parseDisclosureQuery,
} from "../../utils/disclosureQuery.js";
import {
  emptyDisclosureNotebook,
  readDisclosureNotebook,
  writeDisclosureNotebook,
  DISCLOSURE_NOTEBOOK_KEY,
  filingEvidenceId,
  collectDisclosureEvidence,
  updateDisclosureMonitor,
  passageEvidenceId,
} from "../../utils/disclosureNotebook.js";
import DisclosureQueryBar from "./DisclosureQueryBar";
import DisclosureReader, { Highlight } from "./DisclosureReader";
import { DisclosureMatrix, DisclosureTrends } from "./DisclosureComparisons";
import { DisclosureCollections, DisclosureInbox } from "./DisclosureLibrary";
import {
  companyInputs,
  queryParams,
  type CompanyScan,
  type DisclosureNotebook,
  type Filing,
  type Passage,
  type SavedSearch,
  type SearchSettings,
} from "./disclosureTypes";
import s from "./disclosures.module.css";

async function jsonResponse(response: Response) {
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function indexSearch(settings: SearchSettings, signal: AbortSignal) {
  const forms = settings.amendments
    ? settings.forms
        .split(",")
        .flatMap((f) => [f, `${f}/A`])
        .join(",")
    : settings.forms;
  const params = new URLSearchParams({
    expression: settings.query,
    focus: settings.tickers,
    forms,
    startdt: settings.start,
    enddt: settings.end,
    limit: "50",
  });
  return jsonResponse(
    await fetch(`/api/edgar-index-search?${params}`, { signal }),
  );
}
function indexFiling(hit: any): Filing {
  return {
    ticker: hit.requestedTicker || hit.cik,
    cik: hit.cik,
    companyName: hit.companyName,
    accession: hit.accession,
    form: hit.form,
    filingDate: hit.filingDate,
    reportDate: hit.periodEnding,
    primaryDoc: hit.documentName,
    documentUrl: hit.documentUrl,
    status: "index-candidate",
  };
}
async function verifyFiling(
  filing: Filing,
  settings: SearchSettings,
  signal: AbortSignal,
) {
  const params = queryParams(settings);
  params.set("action", "document");
  params.set("ticker", filing.ticker || filing.cik);
  params.set("accession", filing.accession);
  params.set("document", filing.primaryDoc);
  const data = await jsonResponse(
    await fetch(`/api/disclosure-research?${params}`, { signal }),
  );
  return {
    ...data,
    previews: data.matches.slice(0, 3),
    matches: undefined,
  } as Filing;
}

export default function DisclosureSearchClient({
  initial = {},
}: {
  initial?: Partial<SearchSettings>;
}) {
  const [settings, setSettings] = useState<SearchSettings>(() => ({
    tickers: "",
    mode: "companies",
    start: `${new Date().getUTCFullYear() - 5}-01-01`,
    end: new Date().toISOString().slice(0, 10),
    forms: "10-K",
    section: "all",
    scope: "paragraph",
    depth: 6,
    amendments: false,
    ...initial,
    query: legacyDisclosureQuery(initial.query || "liquidity"),
  }));
  const [active, setActive] = useState<SearchSettings | null>(null);
  const [companies, setCompanies] = useState<CompanyScan[]>([]);
  const [index, setIndex] = useState<any>(null);
  const [verified, setVerified] = useState<Filing[]>([]);
  const recordVerified = useCallback((filing: Filing) => {
    setVerified((items) => [
      ...items.filter((f) => filingEvidenceId(f) !== filingEvidenceId(filing)),
      { ...filing, previews: filing.matches?.slice(0, 3), matches: undefined },
    ]);
  }, []);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("evidence");
  const [sort, setSort] = useState("relevance");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [visibleCount, setVisibleCount] = useState(24);
  const [language, setLanguage] = useState("all");
  const [reader, setReader] = useState<{
    filing: Filing;
    settings: SearchSettings;
  } | null>(null);
  const [readerChoices, setReaderChoices] = useState<Filing[]>([]);
  const [notebook, setNotebook] = useState<DisclosureNotebook>(
    emptyDisclosureNotebook,
  );
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [saveName, setSaveName] = useState("");
  const [checking, setChecking] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const running = useRef(false);
  const notebookRef = useRef(notebook);
  useEffect(() => {
    notebookRef.current = notebook;
  }, [notebook]);
  useEffect(() => {
    const load = () => {
      try {
        setNotebook(
          readDisclosureNotebook(localStorage.getItem(DISCLOSURE_NOTEBOOK_KEY)),
        );
        setStorageReady(true);
        setStorageError("");
      } catch (error) {
        setStorageError(error.message);
      }
    };
    load();
    const changed = (event: StorageEvent) => {
      if (event.key === DISCLOSURE_NOTEBOOK_KEY) load();
    };
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("storage", changed);
      abortRef.current?.abort();
    };
  }, []);
  const changeNotebook = useCallback(
    (update: (current: DisclosureNotebook) => DisclosureNotebook) => {
      if (!storageReady) {
        setStorageError(
          "Browser storage is unavailable. Your changes were not saved.",
        );
        return;
      }
      try {
        const next = writeDisclosureNotebook(localStorage, update);
        setNotebook(next);
        notebookRef.current = next;
        setStorageError("");
      } catch (error) {
        setStorageError(
          `Could not save: ${error.message}. Existing saved research has been retained.`,
        );
      }
    },
    [storageReady],
  );
  const run = async (next: SearchSettings) => {
    if (running.current) return;
    try {
      parseDisclosureQuery(next.query);
      const inputs = companyInputs(next.tickers);
      if (
        next.mode === "companies" &&
        (!inputs.length ||
          inputs.length > 40 ||
          inputs.some((t) => !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(t)))
      )
        throw new Error(
          "Enter 1–40 tickers or CIKs, separated by commas. Use index discovery for exact company names.",
        );
      if (next.mode === "index" && inputs.length > 5)
        throw new Error("Focus the index on at most five companies.");
    } catch (error) {
      setError(error.message);
      return;
    }
    running.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    setActive({ ...next });
    setSettings({ ...next });
    setCompanies([]);
    setAliases({});
    setIndex(null);
    setVerified([]);
    setReader(null);
    setTab("evidence");
    setCompanyFilter("all");
    setVisibleCount(24);
    const params = queryParams(next);
    params.set("tickers", next.tickers);
    params.set("mode", next.mode);
    window.history.replaceState(null, "", `/disclosures?${params}`);
    try {
      if (next.mode === "index") {
        setProgress(
          "Searching the SEC index with resolved company identities…",
        );
        setIndex(await indexSearch(next, controller.signal));
      } else {
        const inputs = companyInputs(next.tickers);
        const completed: CompanyScan[] = [];
        const seenCiks = new Set();
        for (let i = 0; i < inputs.length; i++) {
          if (controller.signal.aborted) break;
          setProgress(
            `${i + 1} / ${inputs.length} companies · ${inputs[i]} · reading filings and prior reports`,
          );
          try {
            const params = queryParams(next);
            params.set("ticker", inputs[i]);
            const result = await jsonResponse(
              await fetch(`/api/disclosure-research?${params}`, {
                signal: controller.signal,
              }),
            );
            const canonical =
              completed.find((c) => c.cik === result.cik)?.ticker ||
              result.ticker;
            setAliases((values) => ({ ...values, [inputs[i]]: canonical }));
            if (!seenCiks.has(result.cik)) {
              seenCiks.add(result.cik);
              completed.push(result);
            } else
              setNotice(
                "Aliases resolving to the same CIK are counted as one company.",
              );
            setCompanies([...completed]);
            const first = result.filings.find((f: Filing) => f.matched);
            if (first)
              setReader(
                (current) => current || { filing: first, settings: next },
              );
          } catch (error) {
            if (controller.signal.aborted) break;
            completed.push({
              ticker: inputs[i],
              error: error.message,
              filings: [],
            });
            setCompanies([...completed]);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error.message);
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(
        controller.signal.aborted
          ? "Stopped. Completed company results remain available; the rest were not reviewed."
          : "Search complete. Review the coverage ledger for gaps and limits.",
      );
    }
  };
  const checkSaved = useCallback(
    async (saved: SavedSearch) => {
      if (running.current) return;
      running.current = true;
      setChecking(saved.id);
      setError("");
      const controller = new AbortController();
      abortRef.current = controller;
      const next = {
        ...saved.settings,
        end: saved.followLatest
          ? new Date().toISOString().slice(0, 10)
          : saved.settings.end,
      };
      const results: CompanyScan[] = [];
      try {
        if (next.mode === "index") {
          const data = await indexSearch(next, controller.signal);
          const filings: Filing[] = [];
          for (const hit of data.results.slice(0, 12)) {
            const filing = indexFiling(hit);
            try {
              filings.push(await verifyFiling(filing, next, controller.signal));
            } catch (error) {
              if (controller.signal.aborted) throw error;
              filings.push({
                ...filing,
                status: "fetch-failed",
                reason: error.message,
              });
            }
          }
          results.push({
            ticker: "Index candidate sample",
            filings,
            reviewed: filings.filter((f) => f.status === "reviewed").length,
            fetchFailed: filings.filter((f) => f.status === "fetch-failed")
              .length,
            sectionUnavailable: filings.filter(
              (f) => f.status === "section-unavailable",
            ).length,
            limited: data.totalHits > 12,
          });
        } else {
          const seenCiks = new Set();
          for (const ticker of companyInputs(next.tickers)) {
            try {
              const params = queryParams(next);
              params.set("ticker", ticker);
              const result = await jsonResponse(
                await fetch(`/api/disclosure-research?${params}`, {
                  signal: controller.signal,
                }),
              );
              if (!seenCiks.has(result.cik)) {
                seenCiks.add(result.cik);
                results.push(result);
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              results.push({ ticker, filings: [], error: error.message });
            }
          }
        }
        changeNotebook((current) => ({
          ...current,
          searches: current.searches.map((item) =>
            item.id === saved.id
              ? updateDisclosureMonitor(item, results)
              : item,
          ),
        }));
        setNotice(
          `Checked “${saved.name}”. New verified matches and coverage are in the inbox.`,
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            `Monitoring check failed: ${error.message}. The previous baseline is retained.`,
          );
      } finally {
        setChecking("");
        running.current = false;
      }
    },
    [changeNotebook],
  );
  useEffect(() => {
    if (!storageReady) return;
    const check = async () => {
      if (document.visibilityState !== "visible" || running.current) return;
      for (const saved of notebookRef.current.searches) {
        if (
          saved.autoCheck &&
          Date.now() - Date.parse(saved.lastChecked || saved.createdAt) >
            15 * 60000
        )
          await checkSaved(saved);
      }
    };
    void check();
    const timer = setInterval(check, 60000);
    return () => clearInterval(timer);
  }, [storageReady, checkSaved]);
  const requested = useMemo(() => {
    return active
      ? [...new Set(companyInputs(active.tickers).map((t) => aliases[t] || t))]
      : [];
  }, [active, aliases]);
  const filings = companies.flatMap((c) => c.filings);
  const reviewed = filings.filter((f) => f.status === "reviewed");
  const matching = reviewed.filter((f) => f.matched);
  const allResults: Filing[] =
    active?.mode === "index"
      ? (index?.results || []).map(
          (hit: any) =>
            verified.find(
              (f) => filingEvidenceId(f) === filingEvidenceId(indexFiling(hit)),
            ) || indexFiling(hit),
        )
      : filings;
  const terms = useMemo(() => {
    try {
      return parseDisclosureQuery(active?.query || "liquidity").positive;
    } catch {
      return [];
    }
  }, [active?.query]);
  const results = allResults.filter(
    (f) =>
      (f.matched ||
        f.status === "index-candidate" ||
        (tab === "changes" &&
          (f.removedCount || 0) + (f.revisions || 0) > 0)) &&
      (companyFilter === "all" || f.ticker === companyFilter) &&
      (language === "all" || (f.signals?.languages[language] || 0) > 0) &&
      (tab !== "changes" ||
        (f.additions || 0) + (f.revisions || 0) + (f.removedCount || 0) > 0),
  );
  results.sort((a, b) => {
    const ap = a.previews || [];
    const bp = b.previews || [];
    if (sort === "date") return b.filingDate.localeCompare(a.filingDate);
    if (sort === "added")
      return (
        (b.additions || 0) - (a.additions || 0) ||
        (b.revisions || 0) - (a.revisions || 0)
      );
    if (sort === "proximity")
      return (
        (a.signals?.closestTerms ?? Infinity) -
        (b.signals?.closestTerms ?? Infinity)
      );
    if (sort === "specificity")
      return (b.signals?.concrete || 0) - (a.signals?.concrete || 0);
    if (sort === "section")
      return (b.signals?.recognized || 0) - (a.signals?.recognized || 0);
    return (
      Math.max(0, ...bp.map((p) => p.relevance)) -
        Math.max(0, ...ap.map((p) => p.relevance)) ||
      b.filingDate.localeCompare(a.filingDate)
    );
  });
  const unread = notebook.searches.reduce(
    (n, saved) => n + saved.inbox.filter((i) => !i.reviewed).length,
    0,
  );
  const evidenceCount = notebook.collections.reduce(
    (n, c) => n + c.items.length,
    0,
  );
  const open = (filing: Filing, next: SearchSettings) =>
    setReader({ filing, settings: next });
  const collect = (
    filing: Filing,
    passage: Passage,
    next: SearchSettings,
    collection: string,
  ) => {
    const item = collectDisclosureEvidence(filing, passage, next);
    item.labelReviewed = Boolean(
      notebook.labels[passageEvidenceId(filing, passage)]?.reviewed,
    );
    changeNotebook((current) => ({
      ...current,
      collections: current.collections.map((c) =>
        c.id === collection && !c.items.some((e) => e.id === item.id)
          ? { ...c, items: [...c.items, item] }
          : c,
      ),
    }));
  };
  const save = () => {
    if (!active || !saveName.trim()) return;
    const seen = (active.mode === "index" ? verified : reviewed)
      .filter((f) => f.status === "reviewed")
      .map(filingEvidenceId);
    const now = new Date().toISOString();
    changeNotebook((current) => ({
      ...current,
      searches: [
        ...current.searches,
        {
          id: crypto.randomUUID(),
          name: saveName.trim(),
          settings: { ...active },
          seen,
          createdAt: now,
          lastChecked: now,
          inbox: [],
          autoCheck: false,
          followLatest: active.end === now.slice(0, 10),
        },
      ],
    }));
    setSaveName("");
  };
  const verifyCandidates = async () => {
    if (!active || running.current) return;
    running.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const candidates = allResults
      .filter(
        (f) => f.status === "index-candidate" || f.status === "fetch-failed",
      )
      .slice(0, 12);
    for (let i = 0; i < candidates.length; i++) {
      const filing = candidates[i];
      if (controller.signal.aborted) break;
      setProgress(
        `Verifying candidate ${i + 1}/${candidates.length} · ${filing.ticker}`,
      );
      try {
        const result = await verifyFiling(filing, active, controller.signal);
        setVerified((items) => [
          ...items.filter(
            (f) => filingEvidenceId(f) !== filingEvidenceId(result),
          ),
          result,
        ]);
      } catch (error) {
        if (controller.signal.aborted) break;
        setVerified((items) => [
          ...items.filter(
            (f) => filingEvidenceId(f) !== filingEvidenceId(filing),
          ),
          { ...filing, status: "fetch-failed", reason: error.message },
        ]);
      }
    }
    setBusy(false);
    running.current = false;
    setProgress(
      controller.signal.aborted
        ? "Verification stopped; completed reviews retained."
        : "Candidate verification complete. Coverage is limited to the selected index sample.",
    );
  };
  const setLabel = (id: string, label: string) =>
    changeNotebook((current) => ({
      ...current,
      labels: { ...current.labels, [id]: { label, reviewed: true } },
      collections: current.collections.map((c) => ({
        ...c,
        items: c.items.map((item) =>
          item.id === id
            ? { ...item, languageLabel: label, labelReviewed: true }
            : item,
        ),
      })),
    }));
  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>
            <FileSearch size={15} /> SEC disclosure research
          </span>
          <h1>
            Find the language.
            <br className={s.mobileBreak} /> Follow the evidence.
          </h1>
          <p>
            Search, compare, and collect the passages behind your company
            research.
          </p>
        </div>
        <span className={s.sourceBadge}>
          <span /> SEC originals linked
        </span>
      </header>
      <DisclosureQueryBar
        settings={settings}
        setSettings={setSettings}
        onSearch={run}
        busy={busy || Boolean(checking)}
        stop={() => abortRef.current?.abort()}
      />
      {(error || storageError) && (
        <div role="alert" className={s.error}>
          <AlertCircle size={17} /> {error} {storageError}
        </div>
      )}
      {notice && (
        <div role="status" className={s.notice}>
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}
      {progress && (
        <p role="status" className={s.progress}>
          {busy && <span className={s.pulse} />}
          {progress}
        </p>
      )}
      <nav className={s.tabs} aria-label="Disclosure research views">
        {[
          ["evidence", "Evidence"],
          ["changes", "Changes"],
          ["matrix", "Topic matrix"],
          ["trends", "Trends"],
          ["inbox", `Inbox${unread ? ` · ${unread}` : ""}`],
          [
            "collections",
            `Collections${evidenceCount ? ` · ${evidenceCount}` : ""}`,
          ],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              setTab(id);
              setReader(null);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {active && !["inbox", "collections"].includes(tab) && (
        <>
          <div className={s.summaryCards}>
            {(active.mode === "companies"
              ? [
                  [
                    reviewed.length,
                    "Documents reviewed",
                    `${filings.length} selected · ${requested.length} companies`,
                  ],
                  [
                    matching.length,
                    "Filings with matches",
                    "Full query verified in selected scope",
                  ],
                  [
                    filings.filter((f) => f.status !== "reviewed").length +
                      companies.filter(
                        (c) => c.error || c.limited || c.historyLimited,
                      ).length +
                      Math.max(0, requested.length - companies.length),
                    "Coverage gaps",
                    "Source gaps, pending issuers & bounded histories",
                  ],
                ]
              : [
                  [
                    index?.totalHits ?? "—",
                    "SEC index candidates",
                    "Positive-term discovery, not full-query verification",
                  ],
                  [
                    verified.filter((f) => f.status === "reviewed").length,
                    "Documents verified",
                    `${verified.filter((f) => f.matched).length} satisfy your full query`,
                  ],
                  [
                    verified.filter((f) => f.status !== "reviewed").length,
                    "Coverage gaps",
                    "Matrix & trends require an unfiltered company sample",
                  ],
                ]
            ).map(([value, label, detail]) => (
              <div key={String(label)}>
                <strong>
                  {typeof value === "number" ? value.toLocaleString() : value}
                  {label === "SEC index candidates" &&
                  index?.totalRelation === "gte"
                    ? "+"
                    : ""}
                </strong>
                <span>{label}</span>
                <small>{detail}</small>
              </div>
            ))}
          </div>
          <div className={s.researchActions}>
            <div className={s.currentQuery}>
              <span className={s.eyebrow}>Current result set</span>
              <code>{active.query}</code>
              <small>
                {active.forms} · {active.start} to {active.end} ·{" "}
                {active.section} · {active.scope}
              </small>
            </div>
            <div className={s.actions}>
              <input
                aria-label="Saved search name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Name this research…"
                maxLength={100}
              />
              <button
                disabled={busy || !saveName.trim() || !storageReady}
                onClick={save}
              >
                <BookmarkPlus size={15} /> Save search
              </button>
              <button
                aria-label="Copy complete search link"
                onClick={async () => {
                  try {
                    const params = queryParams(active);
                    params.set("tickers", active.tickers);
                    params.set("mode", active.mode);
                    await navigator.clipboard.writeText(
                      `${location.origin}/disclosures?${params}`,
                    );
                    setNotice("Complete search link copied.");
                  } catch {
                    setError(
                      "The browser could not copy the link. Use the address bar to share this search.",
                    );
                  }
                }}
              >
                <LinkIcon size={15} /> Share
              </button>
            </div>
          </div>
          <details className={s.coverage}>
            <summary>Coverage ledger · what was actually reviewed</summary>
            {active.mode === "index" ? (
              <>
                <p>
                  {index?.focus?.constrainedAtSource
                    ? `Company identity resolved before search: ${index.focus.resolved.map((f: any) => `${f.requested} → CIK ${f.cik}`).join("; ")}.`
                    : "SEC-wide index discovery."}{" "}
                  {index?.returnedHits || 0} candidate documents returned.
                  Query, section, and paragraph filters require text
                  verification.
                </p>
                {verified.map((f) => (
                  <p key={filingEvidenceId(f)}>
                    {f.ticker} · {f.form} · {f.filingDate}: {f.status}
                    {f.reason ? ` — ${f.reason}` : ""}
                    {f.status === "reviewed"
                      ? f.matched
                        ? " · query matched"
                        : " · no full-query match"
                      : ""}
                  </p>
                ))}
              </>
            ) : (
              companies.map((company) => (
                <div key={company.ticker}>
                  <strong>
                    {company.ticker} ·{" "}
                    {company.companyName || "Identity / history unavailable"}
                  </strong>
                  <p>
                    {company.error ||
                      `${company.reviewed} reviewed / ${company.selected} selected from ${company.eligible} eligible filings in inspected history. ${company.fetchFailed} fetch failures; ${company.sectionUnavailable} sections unavailable.`}
                  </p>
                  {(company.limited || company.historyLimited) && (
                    <p className={s.warning}>
                      Bounded coverage:{" "}
                      {company.limited ? "filing-depth limit reached. " : ""}
                      {company.historyLimited
                        ? "Not all eligible historical submissions were retrieved. "
                        : ""}
                      Increase depth or narrow the date window.
                    </p>
                  )}
                  <p>
                    First observed within this search:{" "}
                    {company.firstObserved || "No verified match"}. Checked:{" "}
                    {company.checkedAt
                      ? new Date(company.checkedAt).toLocaleString()
                      : "unavailable"}
                    .
                  </p>
                  {company.filings
                    .filter((f) => f.status !== "reviewed" || f.comparisonError)
                    .map((f) => (
                      <p key={f.accession}>
                        {f.form} · {f.filingDate}:{" "}
                        {f.reason || f.comparisonError}{" "}
                        <button onClick={() => open(f, active)}>
                          Retry / read source
                        </button>
                      </p>
                    ))}
                </div>
              ))
            )}
          </details>
        </>
      )}
      {tab === "inbox" && (
        <DisclosureInbox
          notebook={notebook}
          change={changeNotebook}
          check={checkSaved}
          checking={busy ? "active-search" : checking}
          open={open}
          load={(next) => {
            setSettings(next);
            setTab("evidence");
            setReader(null);
            setNotice(
              "Saved settings loaded. Select Search filings to run them.",
            );
          }}
        />
      )}
      {tab === "collections" && (
        <DisclosureCollections
          notebook={notebook}
          change={changeNotebook}
          notice={setNotice}
        />
      )}
      {["matrix", "trends"].includes(tab) &&
        (!active || active.mode === "index" ? (
          <div className={s.empty}>
            <h2>Build a company sample first</h2>
            <p>
              Index candidates are selected because they contain search terms.
              That sample cannot establish company prevalence or reliable
              no-match cells. Run Company evidence with your issuer group to
              populate this view.
            </p>
          </div>
        ) : tab === "matrix" ? (
          <DisclosureMatrix
            companies={companies}
            requested={requested}
            inspect={(ticker, query, accessions) => {
              const company = companies.find((c) => c.ticker === ticker);
              const choices = (company?.filings || []).filter((f) =>
                accessions.length
                  ? accessions.includes(f.accession)
                  : f.status === "reviewed",
              );
              setReaderChoices(choices);
              if (choices[0])
                open(choices[0], { ...active, query, scope: "paragraph" });
            }}
          />
        ) : (
          <DisclosureTrends companies={companies} requested={requested} />
        ))}
      {["evidence", "changes"].includes(tab) && (
        <div className={s.workspace} data-reader={Boolean(reader)}>
          <section
            className={s.resultsPanel}
            aria-label="Disclosure search results"
          >
            {!active ? (
              <div className={s.welcome}>
                <span className={s.eyebrow}>
                  A research desk, built around sources
                </span>
                <h2>
                  Start with a question.
                  <br />
                  Leave with the evidence.
                </h2>
                <p>
                  Enter your companies and the language you want to investigate.
                  Review exact passages, changes across reports, and a
                  company-by-topic comparison.
                </p>
                <div className={s.welcomeSteps}>
                  <div>
                    <b>01</b>
                    <strong>Find</strong>
                    <span>Precise queries and clear coverage</span>
                  </div>
                  <div>
                    <b>02</b>
                    <strong>Compare</strong>
                    <span>Prior wording and consistent samples</span>
                  </div>
                  <div>
                    <b>03</b>
                    <strong>Collect</strong>
                    <span>Source-backed notes and research briefs</span>
                  </div>
                </div>
                <button
                  className={s.primary}
                  onClick={() =>
                    run({
                      ...settings,
                      tickers: "JPM",
                      query: "liquidity",
                      forms: "10-K",
                      mode: "companies",
                    })
                  }
                >
                  Explore JPM liquidity <ArrowUpRight size={15} />
                </button>
              </div>
            ) : (
              <>
                <div className={s.panelHeading}>
                  <div>
                    <span className={s.eyebrow}>
                      {tab === "changes"
                        ? "Added, revised & removed passages"
                        : "Research results"}
                    </span>
                    <h2>
                      {results.length}{" "}
                      {active.mode === "index"
                        ? "candidate / verified documents"
                        : "matching filings"}
                    </h2>
                  </div>
                  {active.mode === "index" && (
                    <button disabled={busy} onClick={verifyCandidates}>
                      <RefreshCw size={14} /> Verify next 12
                    </button>
                  )}
                </div>
                <div className={s.resultFilters}>
                  <label>
                    Sort by
                    <select
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="relevance">Evidence relevance</option>
                      <option value="date">Newest filing</option>
                      <option value="added">Newly added language</option>
                      <option value="section">Recognized section</option>
                      <option value="proximity">Term proximity</option>
                      <option value="specificity">Amounts & dates</option>
                    </select>
                  </label>
                  <label>
                    Company
                    <select
                      value={companyFilter}
                      onChange={(e) => setCompanyFilter(e.target.value)}
                    >
                      <option value="all">All companies</option>
                      {[...new Set(allResults.map((f) => f.ticker))].map(
                        (t) => (
                          <option key={t}>{t}</option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    Automated wording
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                    >
                      <option value="all">All wording</option>
                      {[
                        "Reported-event wording",
                        "Hypothetical wording",
                        "Mixed language",
                        "Unclassified wording",
                      ].map((label) => (
                        <option key={label}>{label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className={s.muted}>
                  Ranking reflects term proximity, recognized sections, and
                  concrete amounts or dates. Language labels describe wording
                  and require review. Neither is a risk score.
                </p>
                {tab === "changes" && (
                  <p className={s.muted}>
                    Repeated wording is suppressed. Comparisons use the same
                    reporting season; amendments compare to their original
                    period. See the reader for baseline and extraction gaps.
                  </p>
                )}
                {!results.length && (
                  <div className={s.empty}>
                    {busy
                      ? "Completed reviews will appear here as each company finishes."
                      : tab === "changes"
                        ? "No added, revised, or removed matching passages in comparable sections. Check the coverage ledger for unavailable baselines."
                        : "No verified matches in the selected filters. Check coverage before interpreting this as an absence of disclosure."}
                  </div>
                )}
                {results.slice(0, visibleCount).map((filing) => (
                  <article
                    className={s.resultCard}
                    data-selected={Boolean(
                      reader &&
                        filingEvidenceId(reader.filing) ===
                          filingEvidenceId(filing),
                    )}
                    key={filingEvidenceId(filing)}
                  >
                    <button
                      className={s.resultOpen}
                      onClick={() => open(filing, active)}
                    >
                      <div className={s.row}>
                        <strong>
                          {filing.ticker} <span>{filing.form}</span>
                        </strong>
                        <span className={s.muted}>{filing.filingDate}</span>
                      </div>
                      <p className={s.companyName}>{filing.companyName}</p>
                      <div className={s.resultMeta}>
                        {active.mode === "index" && (
                          <span>{filing.primaryDoc}</span>
                        )}
                        <span>
                          {filing.status === "index-candidate"
                            ? "Index candidate · unverified"
                            : `${filing.matchCount || 0} matching passages`}
                        </span>
                        {(filing.additions || 0) > 0 && (
                          <span>{filing.additions} added</span>
                        )}
                        {(filing.revisions || 0) > 0 && (
                          <span>{filing.revisions} revised</span>
                        )}
                        {(filing.removedCount || 0) > 0 && (
                          <span>{filing.removedCount} removed</span>
                        )}
                      </div>
                      {filing.previews?.[0] && (
                        <p className={s.preview}>
                          <Highlight
                            text={
                              filing.previews[0].text ||
                              filing.previews[0].priorText ||
                              ""
                            }
                            terms={terms}
                          />
                          {filing.previews[0].previewTruncated ? "…" : ""}
                        </p>
                      )}
                      <span className={s.readLink}>
                        Read passages & compare wording{" "}
                        <ArrowUpRight size={14} />
                      </span>
                    </button>
                  </article>
                ))}
                {results.length > visibleCount && (
                  <button
                    className={s.loadMore}
                    onClick={() => setVisibleCount((n) => n + 24)}
                  >
                    Show 24 more filings
                  </button>
                )}
              </>
            )}
          </section>
          {reader && (
            <DisclosureReader
              key={`${filingEvidenceId(reader.filing)}:${reader.settings.query}:${tab}`}
              filing={reader.filing}
              settings={reader.settings}
              changesOnly={tab === "changes"}
              onReviewed={active?.mode === "index" ? recordVerified : undefined}
              notebook={notebook}
              onCollect={collect}
              onLabel={setLabel}
              close={() => setReader(null)}
            />
          )}
        </div>
      )}
      {!["evidence", "changes"].includes(tab) && reader && (
        <div className={s.standaloneReader}>
          {tab === "matrix" && readerChoices.length > 1 && (
            <label>
              Supporting filings in this cell
              <select
                aria-label="Matrix supporting filing"
                value={reader.filing.accession}
                onChange={(event) => {
                  const filing = readerChoices.find(
                    (f) => f.accession === event.target.value,
                  );
                  if (filing) open(filing, reader.settings);
                }}
              >
                {readerChoices.map((filing) => (
                  <option value={filing.accession} key={filing.accession}>
                    {filing.form} · filed {filing.filingDate} · period{" "}
                    {filing.reportDate}
                  </option>
                ))}
              </select>
            </label>
          )}
          <DisclosureReader
            key={`${filingEvidenceId(reader.filing)}:${reader.settings.query}`}
            filing={reader.filing}
            settings={reader.settings}
            changesOnly={false}
            notebook={notebook}
            onCollect={collect}
            onLabel={setLabel}
            close={() => setReader(null)}
          />
        </div>
      )}
      <footer className={s.footer}>
        SEC source text · Transparent query logic · Local saved research{" "}
        <span>
          Coverage is bounded by the selected filing window, review depth, and
          source availability.
        </span>
      </footer>
    </div>
  );
}
