"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { mapDisclosureWork, mergeDisclosureSearchFilings } from "../../utils/disclosureSearchFlow.js";
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
const DisclosureReader = dynamic(() => import("./DisclosureReader"));
import DisclosureResults from "./DisclosureResults";
import DisclosureCoverageDesk from "./DisclosureCoverageDesk";
const DisclosureInbox = dynamic(() => import("./DisclosureInbox").then((module) => module.DisclosureInbox));
import { parseDisclosureReaderState } from "../../utils/disclosureReaderState.js";
import {
  DISCLOSURE_SESSION_KEY,
  disclosureSearchIdentity,
  upsertDisclosureCompany,
  replaceDisclosureFiling,
  makeDisclosureSession,
  readDisclosureSession,
} from "../../utils/disclosureCoverage.js";
const DisclosureMatrix = dynamic(() => import("./DisclosureComparisons").then((module) => module.DisclosureMatrix));
const DisclosureTrends = dynamic(() => import("./DisclosureComparisons").then((module) => module.DisclosureTrends));
const DisclosureCollections = dynamic(() => import("./DisclosureLibrary").then((module) => module.DisclosureCollections));
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
  if (!response.ok) {
    const message = data.error || `Request failed (${response.status}).`;
    throw new Error(/shared SEC request coordination|data gateway|OIDC/i.test(message)
      ? "SEC search is temporarily unavailable. Please try again shortly."
      : message);
  }
  return data;
}
async function indexSearch(settings: SearchSettings, signal: AbortSignal, from = 0) {
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
    limit: "20",
    from: String(from),
    scope: settings.scope,
  });
  return jsonResponse(
    await fetch(`/api/edgar-index-search?${params}`, { signal }),
  );
}
function indexFiling(hit: any): Filing {
  return {
    ticker: hit.requestedTicker || hit.tickers?.[0] || hit.cik,
    cik: hit.cik,
    companyName: hit.companyName,
    accession: hit.accession,
    form: hit.form,
    filingDate: hit.filingDate,
    reportDate: hit.periodEnding,
    primaryDoc: hit.documentName,
    documentUrl: hit.documentUrl,
    status: "index-candidate",
    indexRank: hit.secRank ?? hit.rank,
    indexScore: hit.score,
  };
}
async function verifyFiling(
  filing: Filing,
  settings: SearchSettings,
  signal: AbortSignal,
) {
  const params = queryParams(settings);
  params.set("action", "document");
  params.set("ticker", filing.cik || filing.ticker);
  params.set("accession", filing.accession);
  params.set("document", filing.primaryDoc);
  const data = await jsonResponse(
    await fetch(`/api/disclosure-research?${params}`, { signal }),
  );
  return {
    ...filing,
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
    mode: "index",
    searchStyle: "smart",
    start: `${new Date().getUTCFullYear() - 1}-01-01`,
    end: new Date().toISOString().slice(0, 10),
    forms: "10-K,10-Q,8-K",
    section: "all",
    scope: "paragraph",
    depth: 4,
    amendments: false,
    comparison: "none",
    ...initial,
    query: initial.searchStyle === "exact" ? legacyDisclosureQuery(initial.query || "") : initial.query || "",
  }));
  const [active, setActive] = useState<SearchSettings | null>(null);
  const [companies, setCompanies] = useState<CompanyScan[]>([]);
  const [index, setIndex] = useState<any>(null);
  const [verified, setVerified] = useState<Filing[]>([]);
  const [prepared, setPrepared] = useState<Filing[]>([]);
  const [preparedCoverage, setPreparedCoverage] = useState<any>(null);
  const [preparedPage, setPreparedPage] = useState<any>(null);
  const [interpretation, setInterpretation] = useState<any>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [searchTiming, setSearchTiming] = useState<{ firstResult?: number; firstPassage?: number }>({});
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
  const enrichCandidates = async (candidates: Filing[], next: SearchSettings, signal: AbortSignal, startedAt?: number) => {
    let completed = 0;
    await mapDisclosureWork(candidates, async (filing: Filing) => {
      try {
        const result = await verifyFiling(filing, next, signal);
        if (signal.aborted) return;
        setVerified((items) => mergeDisclosureSearchFilings(items, [result]));
        if (result.matched && startedAt)
          setSearchTiming((timing) => ({ ...timing, firstPassage: timing.firstPassage ?? Date.now() - startedAt }));
      } catch (error) {
        if (signal.aborted) return;
        setVerified((items) => mergeDisclosureSearchFilings(items, [{ ...filing, status: "fetch-failed", reason: error.message }]));
      } finally {
        completed++;
        if (!signal.aborted) setProgress(`Checking source passages · ${completed} of ${candidates.length} documents. Results are ready to read.`);
      }
    }, { concurrency: 2, signal });
  };
  const run = async (
    requestedSettings: SearchSettings,
    options: { resume?: boolean; targets?: string[]; after?: string; view?: string } = {},
  ) => {
    if (running.current) return;
    running.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    // Show the requested question immediately. A later response must not overwrite
    // a new draft the user has typed while this search was running.
    setSettings({ ...requestedSettings, comparison: requestedSettings.comparison || "none", searchStyle: requestedSettings.searchStyle || "exact" });
    setBusy(true);
    setError("");
    setNotice("");
    let next: SearchSettings = { ...requestedSettings, comparison: requestedSettings.comparison || "none" };
    let currentInterpretation: any = null;
    let committed = false;
    const continuing = Boolean(options.resume && active && disclosureSearchIdentity(next) === disclosureSearchIdentity(active));
    const commitSearch = () => {
      if (committed || controller.signal.aborted) return;
      committed = true;
      setActive(next);
      activeRef.current = next;
      // Inferred filters belong to this result set; editable settings retain
      // only the explicit controls from the requested question.
      setInterpretation(currentInterpretation);
      setRestoredAt("");
      if (!continuing) {
        setCompanies([]);
        companiesRef.current = [];
        setAliases({});
        setIndex(null);
        setVerified([]);
        setPrepared([]);
        setPreparedCoverage(null);
        setPreparedPage(null);
        setReader(null);
        setTab(options.view || "evidence");
        setSearchTiming(next.mode === "index" ? { firstResult: Date.now() - startedAt } : {});
      }
      const params = queryParams(next);
      params.set("tickers", next.tickers);
      params.set("mode", next.mode);
      params.set("style", "exact");
      window.history.replaceState(null, "", `/disclosures?${params}`);
    };
    try {
      if (!continuing && requestedSettings.searchStyle === "smart") {
        setInterpreting(true);
        setProgress("Understanding your company, topic, and filing filters…");
        const params = queryParams(requestedSettings);
        params.set("tickers", requestedSettings.tickers);
        params.set("style", "smart");
        currentInterpretation = await jsonResponse(await fetch(`/api/disclosure-search/interpret?${params}`, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        next = { ...next, ...currentInterpretation.settings, mode: requestedSettings.mode === "companies" ? "companies" : "index", searchStyle: "exact" };
        setInterpreting(false);
      }
      parseDisclosureQuery(next.query);
      let inputs = companyInputs(next.tickers);
      if (next.mode === "companies" && (!inputs.length || inputs.length > 40 || inputs.some((t) => t.length > 100)))
        throw new Error("Choose 1–40 companies for a company sample, or switch to Search all filings.");
      if (next.mode === "index" && inputs.length > 5)
        throw new Error("Use up to five companies in a broad search. Company sample supports larger groups.");
      if (continuing) inputs = options.targets || inputs.filter((ticker) => {
        const company = companiesRef.current.find((c) => c.ticker === (aliases[ticker] || ticker));
        return !company || Boolean(company.error);
      });
      if (next.mode === "index") {
        setProgress(active ? "Finding ranked results. Your previous search stays visible until the new results arrive…" : "Finding relevant SEC filings and prepared passages…");
        let preparedResults: Filing[] = [];
        const preparedParams = queryParams(next);
        preparedParams.set("tickers", next.tickers);
        const preparedRequest = fetch(`/api/disclosure-search/passages?${preparedParams}`, { signal: controller.signal }).then(jsonResponse);
        const preparedTask = preparedRequest.then((data) => {
          if (controller.signal.aborted) return;
          preparedResults = data.results || [];
          if (preparedResults.length) commitSearch();
          if (committed) {
            setPrepared(preparedResults);
            setPreparedCoverage(data.coverage);
            setPreparedPage({ hasMore: data.hasMore, nextOffset: data.nextOffset });
            if (preparedResults.length) setSearchTiming((timing) => ({ ...timing, firstPassage: timing.firstPassage ?? Date.now() - startedAt }));
          }
          return data;
        }).catch(() => null);
        try {
          const data = await indexSearch(next, controller.signal);
          if (controller.signal.aborted) return;
          commitSearch();
          setIndex(data);
          if (next.comparison !== "none") await preparedTask;
          const preparedIds = new Set(preparedResults.map(filingEvidenceId));
          const candidates = mergeDisclosureSearchFilings((data.results || []).map(indexFiling), next.comparison !== "none" ? preparedResults : [])
            .filter((f: Filing) => next.comparison !== "none" || !preparedIds.has(filingEvidenceId(f))).slice(0, 4);
          const [, preparedData] = await Promise.all([enrichCandidates(candidates, next, controller.signal, startedAt), preparedTask]);
          if (controller.signal.aborted) return;
          if (preparedData) { setPrepared(preparedData.results || []); setPreparedCoverage(preparedData.coverage); setPreparedPage({ hasMore: preparedData.hasMore, nextOffset: preparedData.nextOffset }); }
        } catch (error) {
          await preparedTask;
          if (!controller.signal.aborted) {
            if (preparedResults.length) setNotice("Prepared passages are available. SEC discovery is temporarily unavailable; the coverage panel shows the indexed scope.");
            else throw error;
          }
        }
      } else {
        commitSearch();
        let completed = 0;
        await mapDisclosureWork(inputs, async (ticker: string) => {
          try {
            const params = queryParams(next);
            params.set("ticker", ticker);
            if (options.after) params.set("after", options.after);
            const result = await jsonResponse(await fetch(`/api/disclosure-research?${params}`, { signal: controller.signal }));
            if (controller.signal.aborted) return;
            setSearchTiming((timing) => ({ ...timing, firstResult: timing.firstResult ?? Date.now() - startedAt, ...((result.filings || []).some((filing: Filing) => filing.matched) ? { firstPassage: timing.firstPassage ?? Date.now() - startedAt } : {}) }));
            const merged = upsertDisclosureCompany(companiesRef.current, result);
            companiesRef.current = merged;
            setCompanies(merged);
            const canonical = merged.find((c) => c.cik === result.cik)?.ticker || result.ticker;
            setAliases((values) => ({ ...values, [ticker]: canonical }));
          } catch (error) {
            if (controller.signal.aborted) return;
            if (options.after) setError(`Older filings for ${ticker} could not be reviewed: ${error.message}. Earlier results remain available.`);
            else {
              const updated = upsertDisclosureCompany(companiesRef.current, { ticker: (continuing && aliases[ticker]) || ticker, error: error.message, filings: [] });
              companiesRef.current = updated;
              setCompanies(updated);
            }
          } finally {
            completed++;
            if (!controller.signal.aborted) setProgress(`${completed} of ${inputs.length} companies reviewed · results appear as they finish.`);
          }
        }, { concurrency: 2, signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error.message);
    } finally {
      running.current = false;
      setBusy(false);
      setInterpreting(false);
      setProgress(controller.signal.aborted ? "Search stopped. Results already received remain available." : committed ? "Results ready. Open a passage, refine your search, or load more filings." : "");
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
  const initialSearchStarted = useRef(false);
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  useEffect(() => {
    if (!sessionReady || initialSearchStarted.current) return;
    initialSearchStarted.current = true;
    if (initial.query && !activeRef.current && !parseDisclosureReaderState(new URLSearchParams(window.location.search)))
      void runRef.current(settings);
  }, [sessionReady, initial.query, settings]);
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
  const allResults: Filing[] = useMemo(() => active?.mode === "index"
    ? mergeDisclosureSearchFilings((index?.results || []).map(indexFiling), prepared, verified)
    : filings, [active?.mode, index, prepared, verified, filings]);
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
    const candidates = allResults.filter((f) => f.status === "index-candidate" || f.status === "fetch-failed" || active.comparison !== "none" && f.status === "indexed-match").slice(0, 8);
    try { await enrichCandidates(candidates, active, controller.signal); }
    finally {
      setBusy(false);
      running.current = false;
      setProgress(controller.signal.aborted ? "Verification stopped; completed passages retained." : "Source checks finished. Open any result to read the full evidence.");
    }
  };
  const loadMoreIndex = async () => {
    if (!active || running.current || index?.nextFrom == null) return;
    running.current = true;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress("Finding the next page of filings…");
    try {
      const data = await indexSearch(active, controller.signal, index.nextFrom);
      if (controller.signal.aborted) return;
      setIndex((previous) => ({ ...data, results: [...(previous?.results || []), ...(data.results || [])] }));
      const existingIds = new Set(allResults.map(filingEvidenceId));
      await enrichCandidates((data.results || []).map(indexFiling).filter((f: Filing) => !existingIds.has(filingEvidenceId(f))).slice(0, 4), active, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setError(`Could not load more filings: ${error.message}. Your current results remain available.`);
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(controller.signal.aborted ? "Stopped. Earlier results retained." : "More filings are ready to read.");
    }
  };
  const loadMorePrepared = async () => {
    if (!active || running.current || !preparedPage?.hasMore) return;
    running.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress("Searching additional prepared passages…");
    try {
      const params = queryParams(active);
      params.set("tickers", active.tickers);
      params.set("offset", String(preparedPage.nextOffset));
      const data = await jsonResponse(await fetch(`/api/disclosure-search/passages?${params}`, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      setPrepared((items) => mergeDisclosureSearchFilings(items, data.results || []));
      setPreparedCoverage(data.coverage);
      setPreparedPage({ hasMore: data.hasMore, nextOffset: data.nextOffset });
    } catch (error) {
      if (!controller.signal.aborted) setError(`Additional passages could not be loaded: ${error.message}. Current results remain available.`);
    } finally {
      running.current = false;
      setBusy(false);
      setProgress(controller.signal.aborted ? "Stopped. Earlier results retained." : "Prepared passage search finished.");
    }
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
        <h1>Search the disclosures.</h1>
          <p>
            Find what companies say. Read the evidence behind it.
          </p>
        </div>
        <span className={s.sourceBadge}>
          <span /> SEC originals linked
        </span>
      </header>
      <DisclosureQueryBar
        settings={settings}
        setSettings={(next) => { setSettings(next); setInterpretation(null); }}
        onSearch={run}
        busy={busy || Boolean(checking)}
        interpreting={interpreting}
        interpretation={interpretation}
        onApplySuggestion={(query) => { setSettings({ ...settings, query }); setInterpretation(null); }}
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
                    "Matching filing candidates in the SEC index",
                  ],
                  [
                    allResults.filter((f) => f.matched).length,
                    "Filings with passages",
                    "Original excerpts matching your search",
                  ],
                  [
                    allResults.length,
                    "Filings loaded",
                    index?.hasMore ? "More filings available below" : "See search coverage for scope",
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
              <code>{interpretation?.originalQuery || active.query}</code>
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
                    params.set("style", "exact");
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
              <summary>Search coverage & source checks</summary>
              <p>
                {index?.results?.length || 0} SEC candidates loaded. {verified.filter((f) => f.status === "reviewed").length} documents fully checked.
                Candidate listings require passage verification; search results do not measure how common a disclosure is across all companies.
              </p>
              {index?.query?.notes?.map((note: string) => <p key={note}>{note}</p>)}
              {preparedCoverage && <p>{preparedCoverage.available === false ? "Prepared passages are unavailable for this search. SEC discovery and full filing review remain available." : `Prepared passage coverage: ${preparedCoverage.documentCount ?? preparedCoverage.documents ?? "recent indexed"} documents. ${preparedCoverage.note || "This is a bounded selection, not the complete EDGAR archive."}`}</p>}
              {searchTiming.firstResult != null && <p>First results in {(searchTiming.firstResult / 1000).toFixed(1)} seconds{searchTiming.firstPassage != null ? ` · first matching passage in ${(searchTiming.firstPassage / 1000).toFixed(1)} seconds` : ""}. Times include this browser’s requests.</p>}
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
                <span className={s.eyebrow}>Start exploring</span>
                <h2>What are you researching?</h2>
                <p>Search a company, a disclosure topic, or a question. Add dates and filing types naturally.</p>
                <div className={s.welcomeSteps}>
                  {[
                    ["Company risks", "Microsoft cybersecurity risks"],
                    ["Across companies", "Companies mentioning debt covenant breaches"],
                    ["A specific period", "Apple supply chain risks in filings from 2025"],
                  ].map(([label, query]) => <button key={query} onClick={() => run({ ...settings, query, tickers: "", mode: "index", searchStyle: "smart" })}>
                    <strong>{label}</strong><span>{query}</span><ArrowUpRight size={15} />
                  </button>)}
                </div>
              </div>
            ) : (
              <>
              {tab === "changes" && active.comparison === "none" && <div className={s.notice}>
                <span>Compare wording with earlier reports to see additions and revisions.</span>
                <button disabled={busy} onClick={() => run({ ...active, comparison: "annual-season", searchStyle: "exact" }, { view: "changes" })}>Compare earlier wording</button>
              </div>}
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
              {active.mode === "index" && index?.hasMore && <button className={s.loadMore} disabled={busy} onClick={loadMoreIndex}>
                {busy ? "Loading…" : "Load more SEC filings"}
              </button>}
              {active.mode === "index" && preparedPage?.hasMore && <button className={s.loadMore} disabled={busy} onClick={loadMorePrepared}>Search more prepared passages</button>}
              {!busy && !allResults.some((filing) => filing.matched || filing.status === "index-candidate") && <div className={s.coverage}>
                <strong>Adjust this search</strong>
                <p>Try a related term, widen the filing dates, or allow words to appear across the document.</p>
                <div className={s.actions}>
                  {interpretation?.suggestions?.filter((item: any) => item.kind === "spelling").slice(0, 2).map((item: any) => <button key={item.query} onClick={() => run({ ...settings, query: item.query, searchStyle: "smart" })}>{item.label}</button>)}
                  {active.scope === "paragraph" && <button onClick={() => run({ ...active, scope: "document", searchStyle: "exact" })}>Search across the document</button>}
                  <button onClick={() => run({ ...active, start: `${new Date().getUTCFullYear() - 5}-01-01`, searchStyle: "exact" })}>Search the past five years</button>
                </div>
              </div>}
              </>
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
