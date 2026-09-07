"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileSearch,
  BookmarkPlus,
  Link as LinkIcon,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
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
import DisclosureReader from "./DisclosureReader";
import DisclosureResults from "./DisclosureResults";
import DisclosureCoverageDesk from "./DisclosureCoverageDesk";
import { DisclosureInbox } from "./DisclosureInbox";
import { parseDisclosureReaderState } from "../../utils/disclosureReaderState.js";
import {
  DISCLOSURE_SESSION_KEY,
  disclosureSearchIdentity,
  upsertDisclosureCompany,
  replaceDisclosureFiling,
  makeDisclosureSession,
  readDisclosureSession,
} from "../../utils/disclosureCoverage.js";
import { DisclosureMatrix, DisclosureTrends } from "./DisclosureComparisons";
import { DisclosureCollections } from "./DisclosureLibrary";
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
    previews: data.previews || data.matches.slice(0, 3),
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
    comparison: "annual-season",
    ...initial,
    query: legacyDisclosureQuery(initial.query || "liquidity"),
  }));
  const [active, setActive] = useState<SearchSettings | null>(null);
  const [companies, setCompanies] = useState<CompanyScan[]>([]);
  const [index, setIndex] = useState<any>(null);
  const [verified, setVerified] = useState<Filing[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("evidence");
  const [reader, setReader] = useState<{
    filing: Filing;
    settings: SearchSettings;
    initialState?: any;
  } | null>(null);
  const [readerChoices, setReaderChoices] = useState<Filing[]>([]);
  const [notebook, setNotebook] = useState<DisclosureNotebook>(
    emptyDisclosureNotebook,
  );
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [collectionsOpened, setCollectionsOpened] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [checking, setChecking] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const page = pageRef.current;
    const header = document.querySelector("body > div > header");
    const controls = page?.querySelector("form");
    if (!page || !header || !controls) return;
    const measure = () => {
      page.style.setProperty(
        "--disc-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
      page.style.setProperty(
        "--disc-controls-height",
        `${controls.getBoundingClientRect().height}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(controls);
    measure();
    return () => observer.disconnect();
  }, []);
  const companiesRef = useRef<CompanyScan[]>([]);
  const activeRef = useRef<SearchSettings | null>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [restoredAt, setRestoredAt] = useState("");
  useEffect(() => {
    companiesRef.current = companies;
  }, [companies]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const recordVerified = useCallback(
    (filing: Filing, readSettings?: SearchSettings) => {
      if (
        !activeRef.current ||
        !readSettings ||
        disclosureSearchIdentity(readSettings) !==
          disclosureSearchIdentity(activeRef.current)
      )
        return;
      const compact = {
        ...filing,
        previews: filing.previews || filing.matches?.slice(0, 3),
        matches: undefined,
      };
      if (activeRef.current.mode === "index")
        setVerified((items) => [
          ...items.filter(
            (f) => filingEvidenceId(f) !== filingEvidenceId(filing),
          ),
          compact,
        ]);
      else {
        const next = replaceDisclosureFiling(companiesRef.current, compact);
        companiesRef.current = next;
        setCompanies(next);
      }
    },
    [],
  );
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const pointer = parseDisclosureReaderState(params);
      if (pointer) {
        setReader({
          filing: pointer.filing,
          settings: {
            ...settings,
            tickers: settings.tickers || pointer.filing.ticker,
          },
          initialState: pointer,
        });
        setNotice(
          "Linked passage opened with its original search settings. A new company-wide scan has not been run.",
        );
      } else {
        const snapshot = readDisclosureSession(
          sessionStorage.getItem(DISCLOSURE_SESSION_KEY),
        );
        const explicit = [
          "query",
          "keywords",
          "tickers",
          "ticker",
          "focus",
          "company",
          "cik",
          "mode",
          "start",
          "end",
          "forms",
          "section",
          "scope",
          "depth",
          "amendments",
          "comparison",
        ].some((k) => params.has(k));
        if (
          snapshot &&
          (!explicit ||
            disclosureSearchIdentity(snapshot.settings) ===
              disclosureSearchIdentity(settings))
        ) {
          setSettings(snapshot.settings);
          setActive(snapshot.settings);
          activeRef.current = snapshot.settings;
          setCompanies(snapshot.companies);
          companiesRef.current = snapshot.companies;
          setAliases(snapshot.aliases);
          setRestoredAt(snapshot.savedAt);
        }
      }
    } catch (error) {
      setNotice(
        `The previous result session could not be restored: ${error.message}. Run a new search; saved collections remain separate.`,
      );
    }
    setSessionReady(true);
    // Initial URL or tab session is restored once. Subsequent edits are draft search controls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!sessionReady || active?.mode !== "companies") return;
    const persist = () => {
      try {
        const serialized = makeDisclosureSession(active, companies, aliases);
        if (serialized)
          sessionStorage.setItem(DISCLOSURE_SESSION_KEY, serialized);
      } catch {
        setNotice(
          "Results remain on this page, but this browser could not retain them across reload. Export the coverage ledger or save the query before leaving.",
        );
      }
    };
    const timer = setTimeout(persist, 350);
    window.addEventListener("pagehide", persist);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
    };
  }, [sessionReady, active, companies, aliases]);
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
        return false;
      }
      try {
        const next = writeDisclosureNotebook(localStorage, update);
        setNotebook(next);
        notebookRef.current = next;
        setStorageError("");
        return true;
      } catch (error) {
        setStorageError(
          `Could not save: ${error.message}. Existing saved research has been retained.`,
        );
        return false;
      }
    },
    [storageReady],
  );
  const run = async (
    requestedSettings: SearchSettings,
    options: { resume?: boolean; targets?: string[]; after?: string } = {},
  ) => {
    if (running.current) return;
    const next = {
      ...requestedSettings,
      comparison: requestedSettings.comparison || "annual-season",
    };
    const continuing = Boolean(
      options.resume &&
      active &&
      disclosureSearchIdentity(next) === disclosureSearchIdentity(active),
    );
    let inputs = companyInputs(next.tickers);
    try {
      parseDisclosureQuery(next.query);
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
      if (continuing)
        inputs =
          options.targets ||
          inputs.filter((t) => {
            const c = companiesRef.current.find(
              (c) => c.ticker === (aliases[t] || t),
            );
            return !c || Boolean(c.error);
          });
    } catch (error) {
      setError(error.message);
      return;
    }
    if (continuing && !inputs.length) {
      setNotice(
        "Every requested company has a completed scan. Open coverage actions to retry documents or review older filings.",
      );
      return;
    }
    running.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    setRestoredAt("");
    setActive(next);
    activeRef.current = next;
    setSettings(next);
    if (!continuing) {
      setCompanies([]);
      companiesRef.current = [];
      setAliases({});
      setIndex(null);
      setVerified([]);
      setReader(null);
      setTab("evidence");
    }
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
      } else
        for (let i = 0; i < inputs.length; i++) {
          if (controller.signal.aborted) break;
          setProgress(
            `${i + 1} / ${inputs.length} companies · ${inputs[i]} · ${options.after ? "reviewing older filings" : "reading filings and prior reports"}`,
          );
          try {
            const request = queryParams(next);
            request.set("ticker", inputs[i]);
            if (options.after) request.set("after", options.after);
            const result = await jsonResponse(
              await fetch(`/api/disclosure-research?${request}`, {
                signal: controller.signal,
              }),
            );
            const merged = upsertDisclosureCompany(
              companiesRef.current,
              result,
            );
            companiesRef.current = merged;
            setCompanies(merged);
            const canonical =
              merged.find((c) => c.cik === result.cik)?.ticker || result.ticker;
            setAliases((values) => ({ ...values, [inputs[i]]: canonical }));
            const first = result.filings.find((f: Filing) => f.matched);
            if (first && !continuing)
              setReader(
                (current) =>
                  current || {
                    filing: { ...first, ticker: canonical },
                    settings: next,
                  },
              );
          } catch (error) {
            if (controller.signal.aborted) break;
            if (options.after) {
              setError(
                `Older filings for ${inputs[i]} could not be reviewed: ${error.message}. Earlier results and the continuation point remain available.`,
              );
            } else {
              const updated = upsertDisclosureCompany(companiesRef.current, {
                ticker: (continuing && aliases[inputs[i]]) || inputs[i],
                error: error.message,
                filings: [],
              });
              companiesRef.current = updated;
              setCompanies(updated);
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
          ? "Stopped. Completed company results remain available. Use Resume in the coverage desk for unfinished companies."
          : "Review complete. Use the coverage desk to inspect gaps and continue into older filings.",
      );
    }
  };
  const retryDocument = async (filing: Filing) => {
    if (!active || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(
      `Retrying ${filing.ticker} · ${filing.form} · ${filing.filingDate}`,
    );
    try {
      const result = await verifyFiling(filing, active, controller.signal);
      const updated = replaceDisclosureFiling(companiesRef.current, result);
      companiesRef.current = updated;
      setCompanies(updated);
      setNotice(
        result.status === "reviewed"
          ? "Document reviewed. Coverage and query-match counts were updated; any remaining comparison gap stays visible."
          : "The document was fetched, but its requested section is still unavailable. It remains outside the reviewed denominator.",
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          `Retry failed: ${error.message}. The previous result remains available.`,
        );
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(
        controller.signal.aborted
          ? "Retry stopped; previous evidence retained."
          : "Document retry finished.",
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
        let applied = false;
        const stored = changeNotebook((current) => ({
          ...current,
          searches: current.searches.map((item) => {
            if (
              item.id !== saved.id ||
              disclosureSearchIdentity(item.settings) !==
                disclosureSearchIdentity(saved.settings)
            )
              return item;
            applied = true;
            return updateDisclosureMonitor(
              item,
              results,
              new Date().toISOString(),
              next,
            );
          }),
        }));
        if (stored)
          setNotice(
            applied
              ? `Checked “${saved.name}”. New verified matches and coverage are in the inbox.`
              : "The saved query changed or was removed during this check. Its current monitoring history was retained; run the updated query to check it.",
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
  const unread = notebook.searches.reduce(
    (n, saved) => n + saved.inbox.filter((i) => !i.reviewed).length,
    0,
  );
  const evidenceCount = notebook.collections.reduce(
    (n, c) => n + c.items.length,
    0,
  );
  const open = (
    filing: Filing,
    next: SearchSettings,
    pointer?: { index: number; side: "current" | "prior" },
  ) => {
    evidenceTrigger.current = document.activeElement as HTMLElement;
    setReader({ filing, settings: next, initialState: pointer });
  };
  const closeReader = () => {
    setReader(null);
    evidenceTrigger.current?.focus({ preventScroll: true });
  };
  const markResult = (id: string, reviewed: boolean) =>
    changeNotebook((current) => {
      const map = { ...current.reviewedFilings };
      if (reviewed) map[id] = new Date().toISOString();
      else delete map[id];
      const entries = Object.entries(map)
        .sort((a, b) => b[1].localeCompare(a[1]))
        .slice(0, 2000);
      return { ...current, reviewedFilings: Object.fromEntries(entries) };
    });
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
    const saved = changeNotebook((current) => ({
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
    if (saved) setSaveName("");
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
    <div className={s.page} ref={pageRef} data-research-view={tab}>
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
              if (id === "collections") setCollectionsOpened(true);
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
          {active.mode === "companies" ? (
            <DisclosureCoverageDesk
              settings={active}
              companies={companies}
              aliases={aliases}
              busy={busy || Boolean(checking)}
              restoredAt={restoredAt}
              onResume={() => run(active, { resume: true })}
              onRetry={(ticker) =>
                run(active, { resume: true, targets: [ticker] })
              }
              onMore={(company) =>
                run(active, {
                  resume: true,
                  targets: [company.ticker],
                  after: company.nextCursor,
                })
              }
              onRetryFiling={retryDocument}
            />
          ) : (
            <details className={s.coverage}>
              <summary>Index candidate coverage</summary>
              <p>
                {index?.returnedHits || 0} candidates returned. Full-query and
                section filters require document verification; this candidate
                sample cannot establish disclosure prevalence.
              </p>
              {verified.map((f) => (
                <p key={filingEvidenceId(f)}>
                  {f.ticker} · {f.form} · {f.filingDate}: {f.status}
                  {f.reason ? ` — ${f.reason}` : ""}
                </p>
              ))}
            </details>
          )}
        </>
      )}
      {tab === "inbox" && (
        <DisclosureInbox
          notebook={notebook}
          change={changeNotebook}
          check={checkSaved}
          checking={busy ? "active-search" : checking}
          ready={storageReady && !storageError}
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
      {collectionsOpened && (
        <div hidden={tab !== "collections"}>
          <DisclosureCollections
            notebook={notebook}
            change={changeNotebook}
            notice={setNotice}
          />
        </div>
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
              <DisclosureResults
                key={disclosureSearchIdentity(active)}
                filings={allResults}
                settings={active}
                changesOnly={tab === "changes"}
                reviewedFilings={notebook.reviewedFilings || {}}
                onReview={markResult}
                open={open}
                onVerifyCandidates={
                  active.mode === "index" ? verifyCandidates : undefined
                }
                busy={busy || Boolean(checking)}
                selectedId={reader ? filingEvidenceId(reader.filing) : ""}
              />
            )}
          </section>
          {reader && (
            <DisclosureReader
              key={`${filingEvidenceId(reader.filing)}:${disclosureSearchIdentity(reader.settings)}:${reader.initialState?.side}:${reader.initialState?.index}:${tab}`}
              filing={reader.filing}
              settings={reader.settings}
              changesOnly={tab === "changes"}
              onReviewed={recordVerified}
              initialState={reader.initialState}
              notebook={notebook}
              onCollect={collect}
              onLabel={setLabel}
              close={closeReader}
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
            key={`${filingEvidenceId(reader.filing)}:${disclosureSearchIdentity(reader.settings)}:${reader.initialState?.side}:${reader.initialState?.index}`}
            filing={reader.filing}
            settings={reader.settings}
            changesOnly={false}
            initialState={reader.initialState}
            onReviewed={recordVerified}
            notebook={notebook}
            onCollect={collect}
            onLabel={setLabel}
            close={closeReader}
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
