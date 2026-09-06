"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  History,
  LayoutList,
  ListChecks,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";
import CompanySearch from "../CompanySearch";
import { TickerContext } from "../../../contexts/TickerContext";
import { getItemsInfo } from "../../../utils/formItems.js";
import {
  FILINGS_SETTINGS,
  FILING_FAMILIES,
  readFilingsSettings,
  normalizeFilingsSettings,
  filingPath,
  filterFilings,
  mergeFilings,
  selectFilingBaseline,
} from "../../../utils/filingsResearch.js";
import {
  FILINGS_NOTEBOOK_KEY,
  emptyFilingsNotebook,
  readFilingsNotebook,
  writeFilingsNotebook,
  exportFilingsCsv,
} from "../../../utils/filingsNotebook.js";
import styles from "../filings.module.css";

const FilingReader = dynamic(() => import("./FilingReader"), {
  loading: () => (
    <p className={styles.empty} role="status">
      Opening the filing reader…
    </p>
  ),
});
const FilingsNotebook = dynamic(() => import("./FilingsNotebook"), {
  loading: () => (
    <p className={styles.empty} role="status">
      Opening your review workspace…
    </p>
  ),
});
const PAGE_SIZE = 25;
const FORM_TITLES: Record<string, string> = {
  "10-K": "Annual report",
  "10-Q": "Quarterly report",
  "8-K": "Current report",
  "6-K": "Foreign issuer report",
  "20-F": "Foreign issuer annual report",
  "40-F": "Canadian issuer annual report",
  "4": "Insider ownership change",
  "3": "Initial insider ownership",
  "5": "Annual insider ownership",
  "DEF 14A": "Definitive proxy statement",
  DEFM14A: "Merger proxy statement",
  "PRE 14A": "Preliminary proxy statement",
  "S-1": "Registration statement",
  "S-3": "Shelf registration",
  "424B2": "Prospectus supplement",
  "424B3": "Prospectus supplement",
  "424B5": "Prospectus supplement",
};
const formatDate = (value: string) => value || "Not supplied";
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function errorText(error: any) {
  return error?.name === "AbortError"
    ? "The request timed out. Please try again."
    : error?.message || "The request could not be completed.";
}

export default function FilingsClient({ ticker }: { ticker: string }) {
  const router = useRouter();
  const context = useContext(TickerContext);
  const setTicker = context?.setTicker;
  const setCompany = context?.setCompany;
  const [settings, setSettings] = useState<any>(FILINGS_SETTINGS);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [loadedArchives, setLoadedArchives] = useState<Record<string, any>>({});
  const [archiveLoading, setArchiveLoading] = useState("");
  const [archiveErrors, setArchiveErrors] = useState<Record<string, string>>(
    {},
  );
  const [notebook, setNotebook] = useState<any>(emptyFilingsNotebook);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<any>(null);
  const [comparison, setComparison] = useState<"year" | "previous">("year");
  const [status, setStatus] = useState("");
  const [viewName, setViewName] = useState("");
  const [dateError, setDateError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const archiveAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    function readUrl() {
      setSettings(readFilingsSettings(window.location.search));
      setPage(1);
    }
    readUrl();
    setReady(true);
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, []);
  useEffect(() => {
    function read() {
      try {
        setNotebook(
          readFilingsNotebook(localStorage.getItem(FILINGS_NOTEBOOK_KEY)),
        );
        setStorageError("");
      } catch (e) {
        setStorageError(errorText(e));
      } finally {
        setStorageReady(true);
      }
    }
    function sync(e: StorageEvent) {
      if (e.key === FILINGS_NOTEBOOK_KEY || e.key === null) read();
    }
    read();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const updateNotebook = useCallback(
    (update: (current: any) => any): boolean => {
      if (!storageReady) {
        setStorageError("Your browser workspace is still loading.");
        return false;
      }
      try {
        const next = writeFilingsNotebook(localStorage, update);
        setNotebook(next);
        setStorageError("");
        return true;
      } catch (e) {
        setStorageError(errorText(e));
        return false;
      }
    },
    [storageReady],
  );
  const updateCompany = useCallback(
    (update: (current: any) => any) =>
      updateNotebook((current) => ({
        ...current,
        companies: {
          ...current.companies,
          [ticker]: update(
            current.companies[ticker] || {
              records: {},
              evidence: [],
              views: [],
            },
          ),
        },
      })),
    [ticker, updateNotebook],
  );
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    archiveAbort.current?.abort();
    setLoading(true);
    setError("");
    setArchiveLoading("");
    setArchiveErrors({});
    setLoadedArchives({});
    async function load() {
      try {
        const response = await fetch(
          `/api/filings-research?ticker=${encodeURIComponent(ticker)}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || `Request returned HTTP ${response.status}.`,
          );
        if (controller.signal.aborted || generation.current !== current) return;
        if (result.kind === "fund" && result.redirect) {
          router.replace(result.redirect);
          return;
        }
        setData(result);
        setTicker?.(ticker);
        setCompany?.({
          name: result.name,
          cik: result.cik,
          sic: result.sicDescription,
          sicNumber: result.sic,
          exchanges: result.exchange,
        });
      } catch (e) {
        if (!controller.signal.aborted) setError(errorText(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      archiveAbort.current?.abort();
    };
  }, [ticker, refresh, router, setTicker, setCompany]);
  useEffect(() => {
    if (!ready) return;
    const path = filingPath(ticker, settings);
    if (window.location.pathname + window.location.search !== path)
      window.history.replaceState(null, "", path);
  }, [ticker, settings, ready]);
  // A fixed desktop reader stays clear of both navigation bars even in short views.
  useEffect(() => {
    const root = rootRef.current;
    const controls = controlsRef.current;
    const grid = gridRef.current;
    if (!root || !controls) return;
    let frame = 0;
    const header = document.querySelector("body header");
    function measure() {
      frame = 0;
      if (!root || !controls) return;
      const headerBottom = Math.max(
        0,
        header?.getBoundingClientRect().bottom || 0,
      );
      root.style.setProperty("--filings-header", `${headerBottom + 8}px`);
      const top = Math.max(
        controls.getBoundingClientRect().bottom + 12,
        grid?.getBoundingClientRect().top || 0,
        headerBottom + 12,
      );
      root.style.setProperty("--filings-reader-top", `${top}px`);
      root.style.setProperty(
        "--filings-reader-right",
        `${Math.max(0, document.documentElement.clientWidth - root.getBoundingClientRect().right)}px`,
      );
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(controls);
    observer.observe(root);
    if (header) observer.observe(header);
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [loading, selected, settings.view]);

  const filings = useMemo(
    () =>
      mergeFilings(
        data?.filings || [],
        ...Object.values(loadedArchives).map((a: any) => a.filings || []),
      ),
    [data, loadedArchives],
  );
  const research = notebook.companies[ticker] || {
    records: {},
    evidence: [],
    views: [],
  };
  const records = research.records;
  const filtered = useMemo(
    () => filterFilings(filings, settings, records),
    [filings, settings, records],
  );
  const formOptions = useMemo(
    () => [...new Set(filings.map((f: any) => f.form))].sort() as string[],
    [filings],
  );
  const archives = data?.archives || [];
  const loadedCount = Object.keys(loadedArchives).length;
  const remaining = archives.filter((a: any) => !loadedArchives[a.name]);
  const coverage = useMemo(
    () => ({
      loadedFilings: filings.length,
      earliest: filings.at(-1)?.filingDate || "",
      latest: filings[0]?.filingDate || "",
      archivesLoaded: loadedCount,
      archivesAvailable: archives.length,
      remainingArchives: remaining.length,
      failedArchives: Object.entries(archiveErrors).map(([name, error]) => ({
        name,
        error,
      })),
      omittedArchives: data?.coverage?.omittedArchives || 0,
      omittedRecords:
        (data?.coverage?.omittedRecords || 0) +
        Object.values(loadedArchives).reduce(
          (sum: number, a: any) => sum + (a.coverage?.omittedRecords || 0),
          0,
        ),
      observedAt: data?.observedAt || "",
      note: "Counts describe loaded SEC filing records, not documents read. Recent submissions plus explicitly loaded archives; exhibits are linked through each SEC filing index.",
    }),
    [
      filings,
      loadedCount,
      archives.length,
      remaining.length,
      archiveErrors,
      loadedArchives,
      data,
    ],
  );
  const pair = useMemo(
    () =>
      selected
        ? selectFilingBaseline(
            selected,
            mergeFilings(
              filings,
              Object.values(records)
                .map((r: any) => r.filing)
                .filter(Boolean),
            ),
            { comparison },
          )
        : null,
    [selected, filings, comparison, records],
  );
  const reviewedCount = filings.filter(
    (f: any) => records[f.accession]?.reviewedAt,
  ).length;
  const queuedCount = Object.values(records).filter(
    (r: any) => r.queued,
  ).length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const monthRows = useMemo(() => {
    const months = new Map<string, number>();
    for (const filing of filtered) {
      const m = filing.filingDate.slice(0, 7);
      months.set(m, (months.get(m) || 0) + 1);
    }
    return [...months].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);
  function changeSettings(patch: any) {
    setSettings((s: any) => normalizeFilingsSettings({ ...s, ...patch }));
    setPage(1);
    setDateError("");
    setStatus("");
  }
  async function loadArchive(name: string) {
    if (archiveLoading) return;
    const controller = new AbortController();
    archiveAbort.current = controller;
    const current = generation.current;
    setArchiveLoading(name);
    setArchiveErrors((s) => {
      const n = { ...s };
      delete n[name];
      return n;
    });
    try {
      const response = await fetch(
        `/api/filings-research?ticker=${encodeURIComponent(ticker)}&archive=${encodeURIComponent(name)}`,
        { signal: controller.signal },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not load the SEC archive.");
      if (!controller.signal.aborted && current === generation.current) {
        setLoadedArchives((s) => ({ ...s, [name]: result }));
        setStatus(
          `Loaded ${result.filings.length.toLocaleString()} records from the selected SEC archive.`,
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && current === generation.current)
        setArchiveErrors((s) => ({ ...s, [name]: errorText(e) }));
    } finally {
      if (!controller.signal.aborted && current === generation.current)
        setArchiveLoading("");
    }
  }
  function filingWithIdentity(filing: any) {
    return { ...filing, ticker, cik: data?.cik || filing.cik };
  }
  function toggleQueue(filing: any) {
    const queued = !records[filing.accession]?.queued;
    const ok = updateCompany((c) => ({
      ...c,
      records: {
        ...c.records,
        [filing.accession]: {
          ...c.records[filing.accession],
          queued,
          reviewedAt: c.records[filing.accession]?.reviewedAt || "",
          notes: c.records[filing.accession]?.notes || "",
          filing: filingWithIdentity(filing),
        },
      },
    }));
    if (ok)
      setStatus(
        queued
          ? "Filing added to your review queue."
          : "Filing removed from your review queue.",
      );
  }
  function toggleReviewed(filing: any) {
    const reviewedAt = records[filing.accession]?.reviewedAt
      ? ""
      : new Date().toISOString();
    const ok = updateCompany((c) => ({
      ...c,
      records: {
        ...c.records,
        [filing.accession]: {
          ...c.records[filing.accession],
          queued: reviewedAt ? false : c.records[filing.accession]?.queued || false,
          reviewedAt,
          notes: c.records[filing.accession]?.notes || "",
          filing: filingWithIdentity(filing),
        },
      },
    }));
    if (ok)
      setStatus(
        reviewedAt
          ? "This filing accession is marked reviewed."
          : "This filing accession is marked unreviewed.",
      );
  }
  function collect(filing: any, paragraph: any) {
    const known =
      filings.find((f: any) => f.accession === filing.accession) ||
      records[filing.accession]?.filing;
    const ok = updateCompany((c) => ({
      ...c,
      evidence: c.evidence.some(
        (e: any) =>
          e.filing.accession === filing.accession &&
          e.paragraph.text === paragraph.text &&
          e.paragraph.section === paragraph.section,
      )
        ? c.evidence
        : [
            ...c.evidence,
            {
              id: crypto.randomUUID(),
              filing: filingWithIdentity({
                ...filing,
                archive: filing.archive || known?.archive || "",
              }),
              paragraph: {
                text: paragraph.text,
                index: paragraph.index,
                section: paragraph.section || "Unclassified",
                ...(paragraph.part
                  ? { part: paragraph.part, parts: paragraph.parts }
                  : {}),
                ...(paragraph.version
                  ? { version: paragraph.version, change: paragraph.change }
                  : {}),
              },
              notes: "",
              tags: [],
            },
          ],
    }));
    if (ok) setStatus("Passage saved to your review workspace.");
  }
  function saveView(e: React.FormEvent) {
    e.preventDefault();
    const name = viewName.trim();
    if (!name) {
      setStatus("Give this view a name before saving.");
      return;
    }
    const ok = updateCompany((c) => ({
      ...c,
      views: [
        ...c.views,
        {
          id: crypto.randomUUID(),
          name,
          settings: normalizeFilingsSettings(settings),
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    if (ok) {
      setViewName("");
      setStatus("Search view saved. Reopen it from your review workspace.");
    }
  }
  async function share() {
    const url = window.location.origin + filingPath(ticker, settings);
    try {
      await navigator.clipboard.writeText(url);
      setStatus(
        "Link copied with the current search and filters. Private notes are not included.",
      );
    } catch {
      setStatus(
        "Copy the current browser address to share these search settings.",
      );
    }
  }
  function alignResults(target: HTMLElement | null) {
    if (!target) return;
    const offset =
      window.innerWidth > 900
        ? controlsRef.current?.getBoundingClientRect().height || 0
        : 0;
    const header =
      document.querySelector("body header")?.getBoundingClientRect().bottom ||
      0;
    window.scrollTo({
      top: Math.max(
        0,
        window.scrollY +
          target.getBoundingClientRect().top -
          offset -
          header -
          24,
      ),
      behavior: "instant",
    });
  }
  function openFiling(filing: any) {
    setSelected(filing);
    setStatus("");
    requestAnimationFrame(() => alignResults(gridRef.current));
  }
  function changePage(next: number) {
    setPage(next);
    requestAnimationFrame(() =>
      alignResults(document.getElementById("filings-results-heading")),
    );
  }
  function applyMonth(month: string) {
    const [year, m] = month.split("-").map(Number);
    changeSettings({
      start: `${month}-01`,
      end: new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10),
      view: "list",
    });
  }

  return (
    <div ref={rootRef} className={styles.page} id="filings-workspace">
      <section className={styles.companyHeader}>
        <div>
          <p className={styles.eyebrow}>
            <Link href="/filings">EDGAR / Filings</Link>
          </p>
          <h1>
            <span>{ticker}</span> {data?.name || "Filing research workspace"}
          </h1>
          <p className={styles.muted}>
            {data
              ? `CIK ${data.cik} · ${data.exchange || "SEC registrant"}${data.sicDescription ? ` · ${data.sicDescription}` : ""}`
              : "Resolving company identity and the SEC filing index."}
          </p>
        </div>
        <CompanySearch compact />
      </section>
      {loading && (
        <div className={styles.loading} role="status">
          <RefreshCw className={styles.spin} size={23} />
          <h2>Loading the SEC filing index</h2>
          <p>
            Resolving {ticker} and retrieving recent submissions. Older archives
            can be loaded from the coverage panel.
          </p>
        </div>
      )}
      {error && (
        <section className={styles.error} role="alert">
          <h2>Filings could not be loaded</h2>
          <p>{error}</p>
          <button onClick={() => setRefresh((v) => v + 1)}>
            <RefreshCw size={15} /> Retry SEC request
          </button>
        </section>
      )}
      {data && !loading && !error && (
        <>
          <section
            className={styles.summaryStrip}
            aria-label="Loaded filing summary"
          >
            <div>
              <span>Records indexed</span>
              <strong>{filings.length.toLocaleString()}</strong>
              <small>
                {coverage.earliest} → {coverage.latest}
              </small>
            </div>
            <button
              onClick={() =>
                changeSettings({
                  family: "annual",
                  form: "all",
                  status: "all",
                  start: "",
                  end: "",
                  query: "",
                  item: "",
                  amendments: "include",
                  view: "list",
                })
              }
            >
              <span>Latest annual report</span>
              <strong>
                {filings.find((f: any) =>
                  ["10-K", "20-F", "40-F"].includes(f.form),
                )?.filingDate || "Not in loaded history"}
              </strong>
              <small>
                Show annual filings <ArrowUpRight size={12} />
              </small>
            </button>
            <button onClick={() => changeSettings({ view: "notebook" })}>
              <span>Your review queue</span>
              <strong>{queuedCount}</strong>
              <small>
                {reviewedCount.toLocaleString()} loaded accessions reviewed
              </small>
            </button>
            <div>
              <span>Archive coverage</span>
              <strong>
                {loadedCount} <small>/ {archives.length}</small>
              </strong>
              <small>
                {remaining.length
                  ? "Older SEC archives available"
                  : "All listed archives loaded"}
              </small>
            </div>
          </section>
          <div className={styles.controls} ref={controlsRef}>
            <div className={styles.controlsTop}>
              <div
                className={styles.tabs}
                role="tablist"
                aria-label="Filing workspace views"
              >
                {[
                  ["list", "Filings", LayoutList],
                  ["timeline", "Timeline", History],
                  ["notebook", "Review workspace", ListChecks],
                ].map(([view, label, Icon]: any) => (
                  <button
                    key={view}
                    role="tab"
                    aria-selected={settings.view === view}
                    onClick={() => changeSettings({ view })}
                  >
                    <Icon size={15} />
                    {label}
                    {view === "notebook" && research.evidence.length > 0 && (
                      <small>{research.evidence.length}</small>
                    )}
                  </button>
                ))}
              </div>
              <div className={styles.actions}>
                <button onClick={share} title="Copy this search view">
                  <Share2 size={15} />
                  <span>Share</span>
                </button>
                <button
                  onClick={() => setRefresh((v) => v + 1)}
                  title="Refresh recent submissions and reset loaded archives"
                >
                  <RefreshCw size={15} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
            {settings.view !== "notebook" && (
              <>
                <div className={styles.filterLine}>
                  <label className={styles.query}>
                    <Search size={17} />
                    <span className={styles.srOnly}>
                      Search filing metadata
                    </span>
                    <input
                      placeholder="Search form, description, accession, or event…"
                      value={settings.query}
                      onChange={(e) =>
                        changeSettings({ query: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Form
                    <select
                      value={settings.form}
                      onChange={(e) =>
                        changeSettings({ form: e.target.value, family: "all" })
                      }
                    >
                      <option value="all">All SEC forms</option>
                      {settings.form !== "all" &&
                        !formOptions.includes(settings.form) && (
                          <option value={settings.form}>
                            {settings.form} · not loaded
                          </option>
                        )}
                      {formOptions.map((form) => (
                        <option key={form}>{form}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Review status
                    <select
                      value={settings.status}
                      onChange={(e) =>
                        changeSettings({ status: e.target.value })
                      }
                    >
                      <option value="all">All filings</option>
                      <option value="unreviewed">Unreviewed</option>
                      <option value="queued">Queued</option>
                      <option value="reviewed">Reviewed</option>
                    </select>
                  </label>
                  <label>
                    Sort
                    <select
                      value={settings.sort}
                      onChange={(e) => changeSettings({ sort: e.target.value })}
                    >
                      <option value="newest">Newest filed</option>
                      <option value="oldest">Oldest filed</option>
                      <option value="report">Reporting date</option>
                      <option value="form">Form type</option>
                    </select>
                  </label>
                </div>
                <div
                  className={styles.familyChips}
                  aria-label="Filter filing family"
                >
                  {[
                    { id: "all", label: "All filings" },
                    ...FILING_FAMILIES,
                  ].map((family: any) => (
                    <button
                      key={family.id}
                      aria-pressed={
                        settings.family === family.id && settings.form === "all"
                      }
                      onClick={() =>
                        changeSettings({ family: family.id, form: "all" })
                      }
                    >
                      {family.label}
                    </button>
                  ))}
                  <details className={styles.advanced}>
                    <summary>
                      Dates &amp; events
                      {settings.start ||
                      settings.end ||
                      settings.item ||
                      settings.amendments !== "include"
                        ? " •"
                        : ""}
                    </summary>
                    <div className={styles.filterPopover}>
                      <form
                        key={`${settings.start}:${settings.end}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = new FormData(e.currentTarget);
                          const start = String(form.get("start") || "");
                          const end = String(form.get("end") || "");
                          if (start && end && start > end) {
                            setDateError(
                              "The start date must be on or before the end date.",
                            );
                            return;
                          }
                          changeSettings({ start, end });
                        }}
                      >
                        <p className={styles.eyebrow}>Filed date window</p>
                        <div className={styles.dateRange}>
                          <label>
                            Filed from
                            <input
                              type="date"
                              name="start"
                              defaultValue={settings.start}
                            />
                          </label>
                          <label>
                            Filed through
                            <input
                              type="date"
                              name="end"
                              defaultValue={settings.end}
                            />
                          </label>
                        </div>
                        <div className={styles.actions}>
                          <button type="submit" className={styles.primary}>
                            Apply dates
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              changeSettings({ start: "", end: "" })
                            }
                          >
                            Clear dates
                          </button>
                        </div>
                        {dateError && <p role="alert">{dateError}</p>}
                      </form>
                      <label>
                        8-K event
                        <select
                          value={settings.item}
                          onChange={(e) =>
                            changeSettings({
                              item: e.target.value,
                              form: "all",
                              family: e.target.value ? "current" : "all",
                            })
                          }
                        >
                          <option value="">Any event</option>
                          {[
                            ["1.01", "Material agreement"],
                            ["1.03", "Bankruptcy"],
                            ["1.05", "Cybersecurity incident"],
                            ["2.02", "Earnings results"],
                            ["2.03", "Financial obligation"],
                            ["2.06", "Material impairment"],
                            ["4.01", "Auditor change"],
                            ["4.02", "Non-reliance on financials"],
                            ["5.02", "Executive change"],
                            ["5.07", "Shareholder vote"],
                            ["9.01", "Financial statements / exhibits"],
                          ].map(([code, label]) => (
                            <option key={code} value={code}>
                              {code} · {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Amendments
                        <select
                          value={settings.amendments}
                          onChange={(e) =>
                            changeSettings({ amendments: e.target.value })
                          }
                        >
                          <option value="include">
                            Include originals and amendments
                          </option>
                          <option value="exclude">Original filings only</option>
                          <option value="only">Amendments only</option>
                        </select>
                      </label>
                      <p>
                        Event filters use SEC submission item codes. Older
                        records may omit this metadata.
                      </p>
                    </div>
                  </details>
                </div>
              </>
            )}
          </div>
          <div
            role="status"
            aria-live="polite"
            className={status ? styles.status : styles.srOnly}
          >
            {status}
          </div>
          {storageError && (
            <p className={styles.error} role="alert">
              Your saved workspace could not be updated: {storageError}
            </p>
          )}
          <div
            ref={gridRef}
            className={`${styles.contentGrid} ${selected ? styles.withReader : ""}`}
          >
            <div className={styles.resultsArea}>
              {settings.view === "notebook" ? (
                <FilingsNotebook
                  ticker={ticker}
                  company={data}
                  notebook={notebook}
                  onUpdate={updateNotebook}
                  onOpen={openFiling}
                  onApplyView={(s: any) => changeSettings(s)}
                  settings={settings}
                  coverage={coverage}
                />
              ) : (
                <>
                  <section className={styles.coverage}>
                    <details>
                      <summary>
                        <ShieldCheck size={16} />
                        <strong>
                          {remaining.length ||
                          coverage.omittedRecords ||
                          coverage.omittedArchives
                            ? "Partial archive coverage"
                            : "SEC index coverage"}
                        </strong>
                        <span>
                          Recent feed + {loadedCount} of {archives.length} older
                          archives
                        </span>
                      </summary>
                      <p>
                        {coverage.note}{" "}
                        {coverage.omittedRecords > 0
                          ? `${coverage.omittedRecords} malformed records were omitted.`
                          : ""}{" "}
                        {coverage.omittedArchives > 0
                          ? `${coverage.omittedArchives} invalid archive entries could not be loaded.`
                          : ""}
                      </p>
                      <p>
                        Index observed{" "}
                        {data.observedAt
                          ? new Date(data.observedAt).toLocaleString()
                          : "time unavailable"}
                        . Fetch failures stay visible and can be retried.
                      </p>
                      <div className={styles.archiveList}>
                        {archives.map((archive: any) => (
                          <div key={archive.name}>
                            <span>
                              <strong>
                                {archive.filingFrom} → {archive.filingTo}
                              </strong>
                              <small>
                                {archive.filingCount == null
                                  ? "Count unavailable"
                                  : Number(
                                      archive.filingCount,
                                    ).toLocaleString()}{" "}
                                SEC records · {archive.name}
                              </small>
                            </span>
                            {loadedArchives[archive.name] ? (
                              <span className={styles.success}>
                                <Check size={15} />
                                Loaded
                              </span>
                            ) : (
                              <button
                                disabled={!!archiveLoading}
                                onClick={() => loadArchive(archive.name)}
                              >
                                {archiveLoading === archive.name
                                  ? "Loading…"
                                  : archiveErrors[archive.name]
                                    ? "Retry archive"
                                    : "Load archive"}
                              </button>
                            )}
                            {archiveErrors[archive.name] && (
                              <p className={styles.archiveError} role="alert">
                                {archiveErrors[archive.name]}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                    {remaining.length > 0 && (
                      <button
                        disabled={!!archiveLoading}
                        onClick={() => loadArchive(remaining[0].name)}
                      >
                        <History size={15} />
                        {archiveLoading
                          ? "Loading archive…"
                          : "Load next older archive"}
                      </button>
                    )}
                  </section>
                  {(settings.start ||
                    settings.end ||
                    settings.item ||
                    settings.amendments !== "include" ||
                    settings.status !== "all") && (
                    <div className={styles.activeFilters}>
                      <span>
                        {settings.start || "Earliest loaded"} →{" "}
                        {settings.end || "Latest loaded"}
                        {settings.item ? ` · Item ${settings.item}` : ""}
                        {settings.amendments !== "include"
                          ? ` · Amendments: ${settings.amendments}`
                          : ""}
                        {settings.status !== "all"
                          ? ` · ${settings.status}`
                          : ""}
                      </span>
                      <button
                        onClick={() =>
                          changeSettings({
                            ...FILINGS_SETTINGS,
                            view: settings.view,
                          })
                        }
                      >
                        <X size={13} />
                        Reset filters
                      </button>
                    </div>
                  )}
                  <div
                    id="filings-results-heading"
                    className={styles.resultHeading}
                  >
                    <div>
                      <h2>
                        {settings.view === "timeline"
                          ? "Filing timeline"
                          : "Company filings"}{" "}
                        <span>{filtered.length.toLocaleString()}</span>
                      </h2>
                      <p>
                        {settings.query
                          ? "Search matches filing metadata. Open a filing to search its document."
                          : "Filed date and reporting period are shown separately."}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        download(
                          `${ticker}-filing-index.csv`,
                          exportFilingsCsv({
                            ticker,
                            company: data,
                            filings: filtered,
                            records,
                            settings,
                            coverage,
                          }),
                          "text/csv;charset=utf-8",
                        );
                        setStatus(
                          "CSV export prepared for the filtered filing index.",
                        );
                      }}
                    >
                      <ArrowDownToLine size={15} />
                      Export index
                    </button>
                  </div>
                  {settings.view === "timeline" && (
                    <section className={styles.timeline}>
                      <h3>Activity by filing month</h3>
                      <p>
                        Counts reflect {filtered.length.toLocaleString()}{" "}
                        matching records in loaded history. Filing activity is
                        not a risk score. Select a month to inspect its filings.
                      </p>
                      <div>
                        {monthRows.slice(0, 36).map(([month, count]) => (
                          <button
                            key={month}
                            onClick={() => applyMonth(month)}
                            aria-label={`${month}: ${count} filings. Filter to this month.`}
                          >
                            <span>{month}</span>
                            <i
                              style={{
                                width: `${Math.max(1, (count / Math.max(...monthRows.map((m) => m[1]))) * 100)}%`,
                              }}
                            />
                            <strong>{count.toLocaleString()}</strong>
                          </button>
                        ))}
                      </div>
                      {monthRows.length > 36 && (
                        <small>
                          Showing the newest 36 matching months. Use filed-date
                          filters to explore earlier periods.
                        </small>
                      )}
                    </section>
                  )}
                  {filtered.length === 0 ? (
                    <section className={styles.empty}>
                      <Search size={30} />
                      <h3>No loaded filings match these filters</h3>
                      <p>
                        {remaining.length
                          ? "Older filings may be in the unloaded SEC archives. Load history or broaden your filters."
                          : "Broaden the dates, form, event, or review filters."}
                      </p>
                      {settings.status === "queued" && queuedCount > 0 && (
                        <p>
                          Some queued records are saved from older archives.
                          Open them in your review workspace.
                        </p>
                      )}
                      <button onClick={() => changeSettings(FILINGS_SETTINGS)}>
                        Clear all filters
                      </button>
                    </section>
                  ) : (
                    <div className={styles.filingList}>
                      {visible.map((filing: any) => {
                        const record = records[filing.accession];
                        const items = getItemsInfo(filing.items || "");
                        const form = filing.form.replace("/A", "");
                        return (
                          <article
                            className={`${styles.filingRow} ${selected?.accession === filing.accession ? styles.selectedRow : ""}`}
                            key={filing.accession}
                          >
                            <div className={styles.filingIdentity}>
                              <button
                                className={`${styles.formBadge} ${styles[filing.family] || ""}`}
                                onClick={() => openFiling(filing)}
                                aria-label={`Read ${filing.form} filed ${filing.filingDate}`}
                              >
                                {filing.form}
                              </button>
                              <div>
                                <button
                                  className={styles.filingTitle}
                                  onClick={() => openFiling(filing)}
                                >
                                  {filing.primaryDescription ||
                                    FORM_TITLES[form] ||
                                    `${filing.form} filing`}
                                </button>
                                <div className={styles.filingMeta}>
                                  <span>
                                    <Clock size={12} />
                                    Filed <strong>{filing.filingDate}</strong>
                                  </span>
                                  <span>
                                    Period{" "}
                                    <strong>
                                      {formatDate(filing.reportDate)}
                                    </strong>
                                  </span>
                                  {filing.isAmendment && (
                                    <span className={styles.amendment}>
                                      Amendment
                                    </span>
                                  )}
                                  {record?.reviewedAt && (
                                    <span className={styles.success}>
                                      <CheckCheck size={13} />
                                      Reviewed
                                    </span>
                                  )}
                                </div>
                                {items.length > 0 && (
                                  <div className={styles.itemTags}>
                                    {items.map((item: any) => (
                                      <button
                                        key={item.code}
                                        onClick={() =>
                                          changeSettings({
                                            item: item.code,
                                            family: "current",
                                            form: "all",
                                          })
                                        }
                                      >
                                        {item.code}{" "}
                                        {item.code === "2.03"
                                          ? "Financial obligation"
                                          : item.label}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <small className={styles.accession}>
                                  {filing.accession}
                                  {filing.archive ? " · Archived index" : ""}
                                </small>
                              </div>
                            </div>
                            <div className={styles.rowActions}>
                              <button
                                className={styles.readButton}
                                onClick={() => openFiling(filing)}
                              >
                                <BookOpen size={15} />
                                Read
                              </button>
                              <button
                                aria-label={`${record?.queued ? "Unqueue" : "Queue"} ${filing.accession}`}
                                aria-pressed={!!record?.queued}
                                onClick={() => toggleQueue(filing)}
                                disabled={!storageReady}
                              >
                                <Bookmark size={15} />
                              </button>
                              <button
                                aria-label={`${record?.reviewedAt ? "Mark unreviewed" : "Mark reviewed"} ${filing.accession}`}
                                aria-pressed={!!record?.reviewedAt}
                                onClick={() => toggleReviewed(filing)}
                                disabled={!storageReady}
                              >
                                <Check size={15} />
                              </button>
                              <a
                                href={filing.documentUrl || filing.indexUrl}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${filing.form} filed ${filing.filingDate} on SEC.gov`}
                              >
                                <ArrowUpRight size={16} />
                              </a>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {filtered.length > PAGE_SIZE && (
                    <nav
                      className={styles.pagination}
                      aria-label="Filing result pages"
                    >
                      <span>
                        {(currentPage - 1) * PAGE_SIZE + 1}–
                        {Math.min(currentPage * PAGE_SIZE, filtered.length)} of{" "}
                        {filtered.length.toLocaleString()}
                      </span>
                      <div>
                        <button
                          disabled={currentPage === 1}
                          onClick={() => changePage(currentPage - 1)}
                        >
                          <ChevronLeft size={16} />
                          Previous
                        </button>
                        <span>
                          Page {currentPage} / {pageCount}
                        </span>
                        <button
                          disabled={currentPage === pageCount}
                          onClick={() => changePage(currentPage + 1)}
                        >
                          Next
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </nav>
                  )}
                  <form className={styles.saveView} onSubmit={saveView}>
                    <label htmlFor="filings-view-name">
                      <Bookmark size={16} />
                      Keep these search settings
                    </label>
                    <input
                      id="filings-view-name"
                      value={viewName}
                      maxLength={100}
                      onChange={(e) => setViewName(e.target.value)}
                      placeholder="e.g. Earnings and material events"
                    />
                    <button type="submit" disabled={!storageReady}>
                      Save view
                    </button>
                  </form>
                </>
              )}
            </div>
            {selected && (
              <aside
                className={styles.readerAside}
                aria-label="Selected SEC filing"
              >
                <div className={styles.readerTools}>
                  <label>
                    Comparison basis
                    <select
                      value={comparison}
                      onChange={(e) =>
                        setComparison(e.target.value as "year" | "previous")
                      }
                    >
                      <option value="year">Same reporting season</option>
                      <option value="previous">
                        Previous same-form report
                      </option>
                    </select>
                  </label>
                  <button
                    aria-label="Close selected filing"
                    onClick={() => setSelected(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <p className={styles.pairReason}>
                  {pair?.reason ||
                    "Load older history to find a comparable report."}
                </p>
                <div className={styles.readerActions}>
                  <button
                    aria-pressed={!!records[selected.accession]?.queued}
                    onClick={() => toggleQueue(selected)}
                  >
                    <Bookmark size={14} />
                    {records[selected.accession]?.queued
                      ? "Queued"
                      : "Queue filing"}
                  </button>
                  <button
                    aria-pressed={!!records[selected.accession]?.reviewedAt}
                    onClick={() => toggleReviewed(selected)}
                  >
                    <CheckCheck size={14} />
                    {records[selected.accession]?.reviewedAt
                      ? "Reviewed"
                      : "Mark reviewed"}
                  </button>
                </div>
                <FilingReader
                  key={selected.accession}
                  ticker={ticker}
                  filing={selected}
                  archive={selected.archive}
                  prior={pair?.prior}
                  priorArchive={pair?.prior?.archive}
                  onClose={() => setSelected(null)}
                  onCollect={collect}
                />
              </aside>
            )}
          </div>
          <p className={styles.bottomNote}>
            <FileText size={14} />
            Primary documents are read as extracted text. Use each filing’s SEC
            index for exhibits and the original presentation.{" "}
            <Link href={`/disclosures?tickers=${ticker}`}>
              Search disclosure topics <ArrowUpRight size={12} />
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
