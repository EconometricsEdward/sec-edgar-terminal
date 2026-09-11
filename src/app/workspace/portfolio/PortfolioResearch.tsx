"use client";
import {
  enrichPortfolioReport,
  portfolioReportHtml,
} from "../../../utils/portfolioReport.js";

import Link from "next/link";
import {
  portfolioAvailableMetrics,
  portfolioMetricState,
} from "../../../utils/portfolioDeepResearch.js";
import { PORTFOLIO_METRIC_CATALOG } from "../../../utils/portfolioMetricCatalog.js";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Copy,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useWorkspace } from "../../../components/research/WorkspaceProvider";
import {
  readPortfolios,
  createPortfolio,
  writePortfolio,
  PORTFOLIOS_KEY,
} from "../../../utils/portfolioStorage.js";
import {
  allocationSummary,
  companyAvailable,
} from "../../../utils/portfolioModel.js";
import {
  portfolioIssuerRequests,
  researchPortfolioRows,
  isCompletePortfolioCheck,
} from "../../../utils/portfolioClient.js";
import { portfolioReviewPriorities } from "../../../utils/portfolioInsights.js";
import {
  buildPortfolioResearchPackage,
  portfolioCsv,
  portfolioAnalyticsCsv,
  portfolioMarkdown,
  portfolioXlsx,
  researchContext,
} from "../../../utils/portfolioExports.js";
import { MAX_COMPARE_COMPANIES } from "../../../utils/compareLimits.js";
import { downloadText } from "../../../utils/download.js";
import s from "./PortfolioResearch.module.css";
import { rowMatchesPortfolioView } from "../../../utils/portfolioViews.js";
import { advancePortfolioBaseline } from "../../../utils/portfolioChanges.js";
import {
  PORTFOLIO_TABS,
  ANALYTICS_AREAS,
} from "../../../utils/researchHubNavigation.js";

const PortfolioResearchDesk = dynamic(() => import("./PortfolioResearchDesk"));

const PortfolioImport = dynamic(() => import("./PortfolioImport"), {
  loading: () => <p role="status">Opening import and review…</p>,
});
const PortfolioViews = dynamic(() => import("./PortfolioViews"));
const CompanyFocus = dynamic(() => import("./CompanyFocus"));
const PortfolioChanges = dynamic(() => import("./PortfolioChanges"));
const PortfolioAnalytics = dynamic(() => import("./PortfolioAnalytics"), {
  loading: () => <p role="status">Opening portfolio analytics…</p>,
});
const METRICS: [string, string][] = PORTFOLIO_METRIC_CATALOG.map((d) => [
  d.key,
  d.label,
]);
const DEFAULT_COLUMNS = [
  "revenue",
  "netIncome",
  "operatingCashFlow",
  "freeCashFlow",
  "cash",
  "debt",
];
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const pct = (value: unknown) =>
  number(value)
    ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
    : "Unavailable";
const date = (value: string | null | undefined) =>
  value ? value.slice(0, 10) : "Unavailable";
const present = (point: any) => {
  if (!number(point?.value))
    return point?.classification === "not_applicable"
      ? "Not applicable"
      : "Unavailable";
  if (point.unit === "%") return pct(point.value);
  if (point.unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(point.value);
  return `${point.value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${point.unit && point.unit !== "ratio" ? ` ${point.unit}` : ""}`;
};
const activeRows = (document: any) =>
  (document?.rows || []).filter(
    (row: any) => !row.excluded && row.duplicateChoice !== "remove",
  );
const companyLink = (row: any, company: any) =>
  row.resolution?.ticker || company?.ticker || "";
const documentKey = (document: any) =>
  document
    ? `${document.id}:${document.research.basis}:${document.updatedAt}`
    : "";
const statusLabel = (row: any, company: any) =>
  row.excluded
    ? "Excluded"
    : row.resolution?.status !== "resolved"
      ? row.resolution?.status || "Unresolved"
      : company?.refreshStatus === "not_checked"
        ? "Refresh unchecked"
        : company?.refreshStatus === "pending"
          ? "Refresh pending"
          : company?.refreshStatus === "failed"
            ? "Refresh failed"
            : company?.status || "Not retrieved";
const validSecUrl = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      ["www.sec.gov", "sec.gov", "data.sec.gov"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

export default function PortfolioResearch({
  watchlist,
  navigationRequest,
  onCreateBrief,
  active = true,
}: {
  watchlist: any[];
  navigationRequest?: any;
  onCreateBrief: (draft: any) => void;
  active?: boolean;
}) {
  const workspace = useWorkspace();
  const [store, setStore] = useState<any>({
    version: 1,
    portfolios: [],
    activeId: "",
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const editorDirtyRef = useRef(false);
  const [pendingNavigation, setPendingNavigation] = useState<any>(null);
  const pendingNavigationRef = useRef<HTMLElement | null>(null);
  const onEditorDirtyChange = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);
  const [rename, setRename] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [workingSnapshot, setWorkingSnapshot] = useState<any>(null);
  const [tab, setTab] = useState("analytics");
  const [analyticsArea, setAnalyticsArea] = useState("overview");
  const [sourceEvidence, setSourceEvidence] = useState<Record<string, any>>({});
  const [disclosureRequest, setDisclosureRequest] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [industryFilter, setIndustryFilter] = useState("");
  const [sort, setSort] = useState("name");
  const [preset, setPreset] = useState("overview");
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [importStart, setImportStart] = useState<"new" | "paste" | "watchlist">(
    "new",
  );
  const [importEpoch, setImportEpoch] = useState(0);
  const handledNavigation = useRef(0);
  const [consumedViewRequest, setConsumedViewRequest] = useState(0);
  const [direction, setDirection] = useState("asc");
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [includeAllocations, setIncludeAllocations] = useState(true);
  const [exportScope, setExportScope] = useState("all");
  const [copyFallback, setCopyFallback] = useState("");
  const [evidence, setEvidence] = useState<any>(null);
  const evidenceRef = useRef<HTMLElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const currentContext = useRef("");
  const runGeneration = useRef(0);
  const runOwner = useRef<{ key: string; token: number } | null>(null);
  const editorOwner = useRef<string | null>(null);
  const document =
    store.portfolios.find((item: any) => item.id === store.activeId) ||
    store.portfolios[0] ||
    null;

  const acceptStore = useCallback(
    (saved: any, allowDraftReplacement = false) => {
      const active =
        saved.portfolios.find((item: any) => item.id === saved.activeId) ||
        saved.portfolios[0];
      const key = documentKey(active);
      if (currentContext.current !== key) {
        if (editorDirtyRef.current && !allowDraftReplacement) {
          setMessage(
            "Saved portfolios changed in another tab. Your unsaved draft remains open. Finish reviewing it or cancel to load the latest saved version.",
          );
          return;
        }
        if (editorOwner.current !== null) {
          setMessage(
            "The saved portfolio changed while the editor was open. Reopen Edit rows to review the current version before saving.",
          );
          editorOwner.current = null;
        }
        setEditor(null);
        if (runOwner.current && runOwner.current.key !== key) {
          controller.current?.abort();
          runGeneration.current += 1;
          runOwner.current = null;
          setBusy(false);
          setMessage(
            "The saved portfolio changed. Research stopped to protect the newer version; run research again when ready.",
          );
        }
        currentContext.current = key;
        setWorkingSnapshot((current: any) =>
          current?.ownerKey === key ? current : null,
        );
        setEvidence(null);
        setCopyFallback("");
        setSelected([]);
        setFocusedRowId(null);
      }
      setStore(saved);
    },
    [],
  );

  useEffect(() => {
    let restoreRequested = true;
    const read = () => {
      try {
        const saved = readPortfolios(localStorage.getItem(PORTFOLIOS_KEY));
        const requested = new URLSearchParams(window.location.search).get(
          "portfolio",
        );
        if (
          restoreRequested &&
          requested &&
          saved.portfolios.some((item: any) => item.id === requested)
        )
          saved.activeId = requested;
        restoreRequested = false;
        acceptStore(saved);
        setError("");
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Saved portfolios could not be read. Existing data is preserved.",
        );
      }
      setReady(true);
    };
    read();
    const sync = (event: StorageEvent) => {
      if (!event.key || event.key === PORTFOLIOS_KEY) read();
    };
    window.addEventListener("storage", sync);
    window.addEventListener("research-storage", read);
    return () => {
      controller.current?.abort();
      runGeneration.current += 1;
      runOwner.current = null;
      window.removeEventListener("storage", sync);
      window.removeEventListener("research-storage", read);
    };
  }, [acceptStore]);
  useEffect(() => {
    if (evidence) evidenceRef.current?.focus();
  }, [evidence]);
  useEffect(() => {
    if (!active) setFocusedRowId(null);
  }, [active]);
  useEffect(() => {
    if (active && pendingNavigation) pendingNavigationRef.current?.focus();
  }, [active, pendingNavigation]);

  function persist(operation: any, notice = "") {
    try {
      const next = writePortfolio(localStorage, operation);
      acceptStore(next, true);
      setError("");
      if (notice) setMessage(notice);
      window.dispatchEvent(new Event("research-storage"));
      return next;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Your changes could not be saved. Keep this page open and export the research.",
      );
      return null;
    }
  }
  function commitRows(rows: any[], name: string, settings: any = {}) {
    try {
      if (editor === "edit" && editorOwner.current !== documentKey(document))
        throw new Error(
          "This portfolio changed while you were editing. Reopen Edit rows and review the current version.",
        );
      const next =
        editor === "edit" && document
          ? persist(
              {
                mode: "update",
                id: document.id,
                expectedUpdatedAt: document.updatedAt,
                patch: {
                  rows,
                  name,
                  ...settings,
                  snapshot: null,
                  lastCheckedAt: null,
                  previousCheckedAt: null,
                  comparisonBaseline: null,
                },
              },
              "Rows saved. Review the analysis settings, then run research.",
            )
          : persist(
              {
                mode: "create",
                portfolio: createPortfolio({ name, rows, ...settings }),
              },
              "Research rows saved with the analysis settings you reviewed.",
            );
      if (next) {
        onEditorDirtyChange(false);
        if (pendingNavigation) {
          setConsumedViewRequest(pendingNavigation.nonce || 0);
          restoreDraftUrl(next.activeId);
        }
        setPendingNavigation(null);
        setEditor(null);
        setSelected([]);
        setWorkingSnapshot(null);
        setTab("research");
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The portfolio could not be saved. Review the rows and try again.",
      );
    }
  }
  function openEditor(mode: "new" | "edit") {
    if (editorDirtyRef.current) return;
    onEditorDirtyChange(false);
    editorOwner.current = documentKey(document);
    if (mode === "new") {
      setImportStart("new");
      setImportEpoch((value) => value + 1);
    }
    setEditor(mode);
  }
  function selectPortfolio(id: string) {
    if (id === document?.id) return;
    if (editorDirtyRef.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "portfolios");
    url.searchParams.set("portfolio", id);
    url.searchParams.delete("row");
    window.history.replaceState(null, "", url);
    if (!persist({ mode: "activate", id })) return;
    setSelected([]);
    setWorkingSnapshot(null);
    setEvidence(null);
    setEditor(null);
    setRename("");
    setConfirmDelete(false);
    setMessage("");
  }
  function restoreDraftUrl(portfolioId = document?.id) {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "portfolios");
    if (portfolioId) url.searchParams.set("portfolio", portfolioId);
    else url.searchParams.delete("portfolio");
    for (const key of ["action", "row", "portfolioView"])
      url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url);
  }
  function cancelEditor() {
    editorOwner.current = null;
    onEditorDirtyChange(false);
    setEditor(null);
    try {
      acceptStore(readPortfolios(localStorage.getItem(PORTFOLIOS_KEY)), true);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Saved portfolios could not be read.",
      );
    }
  }
  function applyNavigation(request: any) {
    if (request.action === "cancel-editor") {
      cancelEditor();
      restoreDraftUrl();
      return;
    }
    if (request.portfolioId) {
      if (
        !store.portfolios.some((entry: any) => entry.id === request.portfolioId)
      ) {
        setError(
          "That portfolio is not saved in this browser. Choose another portfolio or import your file.",
        );
        restoreDraftUrl();
        return;
      }
      // Opening the active portfolio must not reset its current import draft.
      if (request.portfolioId !== document?.id)
        selectPortfolio(request.portfolioId);
      setTab(
        request.rowId || request.portfolioViewId ? "research" : "analytics",
      );
      if (request.rowId) setFocusedRowId(request.rowId);
    }
    setAnalyticsArea(
      ANALYTICS_AREAS.includes(request.analyticsArea)
        ? request.analyticsArea
        : "overview",
    );
    if (PORTFOLIO_TABS.includes(request.portfolioTab))
      setTab(request.portfolioTab);
    if (request.portfolioViewId) setTab("research");
    if (["new", "paste", "watchlist"].includes(request.action)) {
      editorOwner.current = documentKey(document);
      setImportStart(request.action);
      setImportEpoch((value) => value + 1);
      setEditor("new");
    }
  }
  useEffect(() => {
    if (
      !ready ||
      !navigationRequest ||
      handledNavigation.current === navigationRequest.nonce
    )
      return;
    handledNavigation.current = navigationRequest.nonce;
    const replacesDraft =
      (navigationRequest.portfolioId &&
        navigationRequest.portfolioId !== document?.id) ||
      ["new", "paste", "watchlist"].includes(navigationRequest.action);
    if (editorDirtyRef.current && replacesDraft) {
      setPendingNavigation(navigationRequest);
      return;
    }
    applyNavigation(navigationRequest);
    // Requests are processed once after saved documents finish loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationRequest, ready, store.portfolios]);
  const captured =
    workingSnapshot?.ownerKey === documentKey(document)
      ? workingSnapshot.snapshot
      : document?.snapshot;
  function changePortfolioTab(value: string) {
    if (!PORTFOLIO_TABS.includes(value)) return;
    setTab(value);
    const url = new URL(window.location.href);
    url.searchParams.set("portfolioTab", value);
    url.searchParams.delete("row");
    url.searchParams.delete("portfolioView");
    window.history.replaceState(window.history.state, "", url);
  }
  const companies = useMemo(() => captured?.companies || [], [captured]);
  const companiesByCik = useMemo(
    () =>
      Object.fromEntries(
        companies.map((company: any) => [company.cik, company]),
      ),
    [companies],
  );
  const summary: any = useMemo(
    () =>
      allocationSummary(
        document?.rows || [],
        document?.allocation || {},
        companiesByCik,
      ),
    [document, companiesByCik],
  );
  const rows = useMemo(() => document?.rows || [], [document]);
  const focusedRow = rows.find((row: any) => row.id === focusedRowId);
  const focusedCompany = focusedRow
    ? companiesByCik[focusedRow.resolution?.cik]
    : null;

  const included = activeRows(document);
  const filteredRows = useMemo(
    () =>
      rows.filter((row: any) => {
        const company = companiesByCik[row.resolution?.cik];
        const state = statusLabel(row, company).toLowerCase();
        const text =
          `${row.input.ticker} ${row.input.company_name} ${row.resolution?.name} ${row.resolution?.cik} ${company?.industry || ""}`.toLowerCase();
        return (
          rowMatchesPortfolioView(row, company, preset) &&
          (!query.trim() || text.includes(query.toLowerCase().trim())) &&
          (filter === "all" ||
            (filter === "needs-review"
              ? !["ready", "partial"].includes(state)
              : filter === "failed"
                ? state === "failed" || state === "refresh failed"
                : state === filter)) &&
          (!industryFilter ||
            (company?.sicDescription || company?.industry || "Unclassified") ===
              industryFilter)
        );
      }),
    [rows, companiesByCik, preset, query, filter, industryFilter],
  );
  const availableMetrics = useMemo(
    () =>
      portfolioAvailableMetrics([
        ...new Set(
          filteredRows.map((row: any) => companiesByCik[row.resolution?.cik]),
        ),
      ]),
    [filteredRows, companiesByCik],
  );
  const availableColumns = columns.filter((key) =>
    availableMetrics.some((d) => d.key === key),
  );
  const effectiveSort =
    ["name", "weight"].includes(sort) ||
    availableMetrics.some((d) => d.key === sort)
      ? sort
      : "name";
  const visibleRows = useMemo(() => {
    return [...filteredRows].sort((left: any, right: any) => {
      const a = companiesByCik[left.resolution?.cik],
        b = companiesByCik[right.resolution?.cik];
      if (effectiveSort === "name")
        return (
          String(
            a?.name || left.resolution?.name || left.input.ticker,
          ).localeCompare(
            String(b?.name || right.resolution?.name || right.input.ticker),
          ) * (direction === "asc" ? 1 : -1)
        );
      const av =
        effectiveSort === "weight"
          ? summary.allocations.find((entry: any) => entry.rowId === left.id)
              ?.weightPct
          : a?.metrics?.[effectiveSort]?.value;
      const bv =
        effectiveSort === "weight"
          ? summary.allocations.find((entry: any) => entry.rowId === right.id)
              ?.weightPct
          : b?.metrics?.[effectiveSort]?.value;
      if (!number(av)) return number(bv) ? 1 : 0;
      if (!number(bv)) return -1;
      return (av - bv) * (direction === "asc" ? 1 : -1);
    });
  }, [filteredRows, companiesByCik, effectiveSort, direction, summary]);
  const viewSettings = useMemo(
    () => ({ query, filter, industryFilter, sort, direction, columns, preset }),
    [query, filter, industryFilter, sort, direction, columns, preset],
  );
  function applyView(value: any) {
    setQuery(value.query);
    setFilter(value.filter);
    setIndustryFilter(value.industryFilter);
    setSort(value.sort);
    setDirection(value.direction);
    setColumns(value.columns);
    setPreset(value.preset);
    setSelected([]);
  }
  function draftBrief(draft: any) {
    setFocusedRowId(null);
    onCreateBrief({ ...draft, portfolioId: document?.id || "" });
  }
  const priorities = useMemo(
    () => portfolioReviewPriorities(rows, companies, summary),
    [rows, companies, summary],
  );

  const comparisonIssuers = new Map<string, string>();
  for (const row of rows) {
    const symbol = companyLink(row, companiesByCik[row.resolution?.cik]);
    if (
      selected.includes(row.id) &&
      !row.excluded &&
      row.resolution?.kind === "company" &&
      row.resolution?.status === "resolved" &&
      symbol &&
      !comparisonIssuers.has(row.resolution.cik)
    )
      comparisonIssuers.set(row.resolution.cik, symbol);
  }
  const comparisonTickers = [...comparisonIssuers.values()];
  const selectedIds =
    exportScope === "selected"
      ? selected
      : exportScope === "visible"
        ? visibleRows.map((row: any) => row.id)
        : undefined;

  async function run(onlyFailed = false) {
    if (!document || busy) return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const id = document.id;
    const basis = document.research.basis;
    const previousCheck = document.lastCheckedAt;
    const revision = document.updatedAt;
    const ownerKey = documentKey(document);
    const token = ++runGeneration.current;
    runOwner.current = { key: ownerKey, token };
    const isCurrent = () =>
      runGeneration.current === token && currentContext.current === ownerKey;
    setBusy(true);
    setError("");
    setMessage("Retrieving public company evidence in batches of five…");
    try {
      const result = await researchPortfolioRows(rows, {
        basis,
        previousCompanies: companies,
        onlyFailed,
        signal: next.signal,
        onProgress: (state: any) => {
          if (next.signal.aborted || !isCurrent()) return;
          const snapshot = {
            schema_version: "edgar.portfolio.v1",
            generated_at: new Date().toISOString(),
            basis,
            companies: state.companies,
          };
          setWorkingSnapshot({ ownerKey, snapshot });
          setProgress({ completed: state.completed, total: state.total });
        },
      });
      if (!isCurrent()) return;
      const snapshot = {
        schema_version: result.schema_version,
        generated_at: result.generated_at,
        basis,
        companies: result.companies,
      };
      setWorkingSnapshot({ ownerKey, snapshot });
      const completeCheck = isCompletePortfolioCheck(result, onlyFailed);
      let comparisonBaseline = document.comparisonBaseline || null;
      let comparisonWarning = "";
      try {
        comparisonBaseline = advancePortfolioBaseline(
          document,
          snapshot,
          completeCheck,
        );
      } catch {
        comparisonWarning =
          " The comparison capture could not fit its storage limit; the current research is still available.";
      }
      runOwner.current = null;
      persist(
        {
          mode: "update",
          id,
          expectedUpdatedAt: revision,
          patch: {
            snapshot,
            comparisonBaseline,
            ...(completeCheck
              ? {
                  previousCheckedAt: previousCheck,
                  lastCheckedAt: result.generated_at,
                }
              : {}),
          },
        },
        result.cancelled
          ? "Research stopped. Completed evidence is retained; remaining companies are unchecked."
          : `Research finished: ${result.companies.filter(companyAvailable).length} companies with financial evidence; ${result.companies.filter((entry: any) => entry.status === "failed" || entry.refreshStatus === "failed").length} retrieval failures. ${completeCheck ? "Full-check baseline updated. Open What changed to review differences." : "The full-check baseline is unchanged; review incomplete or stale results."}${comparisonWarning}`,
      );
    } catch (failure) {
      if (!isCurrent()) return;
      setError(
        failure instanceof Error
          ? failure.message
          : "Research could not be completed. Your saved rows are preserved.",
      );
    } finally {
      if (runGeneration.current === token) {
        runOwner.current = null;
        setBusy(false);
      }
    }
  }
  function changeBasis(basis: string) {
    if (
      persist(
        {
          mode: "update",
          id: document.id,
          expectedUpdatedAt: document.updatedAt,
          patch: {
            research: { basis },
            snapshot: null,
            lastCheckedAt: null,
            previousCheckedAt: null,
            comparisonBaseline: null,
          },
        },
        "Reporting basis changed. Run research to capture compatible evidence.",
      )
    ) {
      setWorkingSnapshot(null);
      setEvidence(null);
    }
  }
  const captureSourceEvidence = useCallback(
    (value: any) => {
      if (document?.id)
        setSourceEvidence((previous) => ({
          ...previous,
          [document.id]: value,
        }));
    },
    [document?.id],
  );
  function openPortfolioDisclosures(query: string, ciks: string[]) {
    setDisclosureRequest({
      query,
      ciks,
      portfolioId: document?.id,
    });
    changePortfolioTab("disclosures");
  }

  async function exportResearch(format: string) {
    if (!document) return;
    try {
      const snapshotDocument = {
        ...document,
        snapshot: captured || {
          schema_version: "edgar.portfolio.v1",
          generated_at: new Date().toISOString(),
          basis: document.research.basis,
          companies: [],
        },
      };
      const pack = enrichPortfolioReport(
        buildPortfolioResearchPackage(snapshotDocument, {
          includeNotes,
          includeAllocations,
          selectedRowIds: selectedIds,
          columns: availableColumns,
        }),
        sourceEvidence[document.id],
      );
      const filename = `${document.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 65) || "portfolio"}-research`;
      if (format === "copy") {
        const text = researchContext(pack);
        try {
          await navigator.clipboard.writeText(text);
          setMessage(
            "Research context copied. This is a captured snapshot, with your chosen privacy settings.",
          );
        } catch {
          setCopyFallback(text);
          setMessage("Select and copy the research context below.");
        }
        return;
      }
      if (format === "xlsx") {
        const bytes = await portfolioXlsx(pack);
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        );
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = `${filename}.xlsx`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (format === "csv")
        downloadText(
          `${filename}.csv`,
          portfolioCsv(pack, availableColumns),
          "text/csv;charset=utf-8",
        );
      else if (format === "analytics")
        downloadText(
          `${filename}-analytics.csv`,
          portfolioAnalyticsCsv(pack),
          "text/csv;charset=utf-8",
        );
      else if (format === "html")
        downloadText(
          `${filename}.html`,
          portfolioReportHtml(pack),
          "text/html;charset=utf-8",
        );
      else if (format === "json")
        downloadText(
          `${filename}.json`,
          JSON.stringify(pack, null, 2),
          "application/json",
        );
      else
        downloadText(
          `${filename}.md`,
          portfolioMarkdown(pack),
          "text/markdown;charset=utf-8",
        );
      setMessage(
        `${format.toUpperCase()} research snapshot downloaded. ${includeNotes ? "Private notes are included." : "Private notes are excluded."}`,
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The export could not be generated.",
      );
    }
  }
  function saveFiling(filing: any) {
    if (!validSecUrl(filing.documentUrl)) return;
    const key = filing.ticker || filing.cik;
    const saved = workspace.update((current) => {
      const existing = current.companies[key] || {
        ticker: key,
        name: filing.companyName,
        cik: filing.cik,
      };
      if (
        (existing.evidence || []).some(
          (entry: any) => entry.url === filing.documentUrl,
        )
      )
        return current;
      if ((existing.evidence || []).length >= 1000)
        throw new Error("This company already has 1,000 saved evidence items.");
      return {
        ...current,
        companies: {
          ...current.companies,
          [key]: {
            ...existing,
            evidence: [
              ...(existing.evidence || []),
              {
                label: `${filing.companyName} · ${filing.form} · ${filing.filingDate}`,
                text: `Portfolio research filing. Report date: ${filing.reportDate || "unavailable"}. ${filing.description || ""}`,
                url: filing.documentUrl,
                collectedAt: new Date().toISOString(),
              },
            ],
          },
        },
      };
    });
    if (saved) {
      setMessage(
        "Filing saved in the existing research library. Your watchlist is unchanged.",
      );
      window.dispatchEvent(new Event("research-storage"));
    }
  }

  if (!ready)
    return <p role="status">Opening your browser-local portfolios…</p>;
  return (
    <section className={s.root} aria-labelledby="portfolio-title">
      <header className={s.intro}>
        <div>
          <p className={s.eyebrow}>Portfolio Research</p>
          <h2 id="portfolio-title">One list. A connected research view.</h2>
          <p>
            Upload or paste up to 100 companies. Review their identities,
            retrieve SEC evidence, and export a research package. Tickers alone
            are enough.
          </p>
        </div>
        <Link className={s.secondary} href="/workspace/portfolio-guide">
          Templates & AI / API guide <ArrowUpRight size={16} />
        </Link>
      </header>
      {error && (
        <div className={s.error} role="alert">
          {error}
        </div>
      )}
      {workspace.error && (
        <p className={s.error} role="alert">
          {workspace.error}
        </p>
      )}
      <div className={s.status} role="status" aria-live="polite">
        {message}
      </div>
      {pendingNavigation && (
        <section
          ref={pendingNavigationRef}
          tabIndex={-1}
          className={s.evidence}
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="portfolio-draft-choice-title"
          aria-describedby="portfolio-draft-choice-description"
        >
          <h3 id="portfolio-draft-choice-title">
            Keep your unsaved import draft?
          </h3>
          <p id="portfolio-draft-choice-description">
            You have unsaved rows or import settings. Continuing will replace
            this draft.
          </p>
          <div className={s.selectionBar}>
            <button
              className={s.primary}
              onClick={() => {
                setConsumedViewRequest(pendingNavigation.nonce || 0);
                setPendingNavigation(null);
                restoreDraftUrl();
                setMessage("Your unsaved draft is still open.");
              }}
            >
              Keep draft
            </button>
            <button
              className={s.secondary}
              onClick={() => {
                const request = pendingNavigation;
                onEditorDirtyChange(false);
                setPendingNavigation(null);
                applyNavigation(request);
              }}
            >
              Discard draft and continue
            </button>
          </div>
        </section>
      )}
      {store.portfolios.length > 0 && (
        <div className={s.savedBar}>
          <label>
            Saved portfolios & universes
            <select
              value={document?.id || ""}
              disabled={busy || editorDirty}
              onChange={(event) => selectPortfolio(event.target.value)}
            >
              {store.portfolios.map((item: any) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.rows.length} rows
                </option>
              ))}
            </select>
          </label>
          <button
            className={s.primary}
            disabled={busy || editorDirty || store.portfolios.length >= 20}
            onClick={() => openEditor("new")}
          >
            <Plus size={16} /> New
          </button>
          <button
            className={s.secondary}
            disabled={busy || editorDirty}
            onClick={() => openEditor("edit")}
          >
            Edit rows
          </button>
          <details className={s.manage}>
            <summary>Manage</summary>
            <div className={s.manageBody}>
              <label>
                Rename
                <input
                  value={rename}
                  placeholder={document?.name}
                  onChange={(event) => setRename(event.target.value)}
                  maxLength={200}
                />
              </label>
              <button
                className={s.secondary}
                disabled={busy || editorDirty || !rename.trim()}
                onClick={() => {
                  if (
                    persist(
                      { mode: "rename", id: document.id, name: rename },
                      "Portfolio renamed.",
                    )
                  )
                    setRename("");
                }}
              >
                Save name
              </button>
              <button
                className={s.secondary}
                disabled={busy || editorDirty || store.portfolios.length >= 20}
                onClick={() => {
                  const next = persist(
                    { mode: "duplicate", id: document.id },
                    "An independent copy was saved.",
                  );
                  if (next) {
                    setSelected([]);
                    setWorkingSnapshot(null);
                  }
                }}
              >
                Duplicate
              </button>
              <button
                className={s.secondary}
                disabled={busy || editorDirty}
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
              {confirmDelete && (
                <div>
                  <p>
                    Delete “{document.name}” from this browser? Watchlists and
                    saved evidence are retained.
                  </p>
                  <button
                    className={s.danger}
                    disabled={editorDirty}
                    onClick={() => {
                      if (
                        persist(
                          { mode: "delete", id: document.id },
                          "Portfolio deleted.",
                        )
                      ) {
                        setConfirmDelete(false);
                        setWorkingSnapshot(null);
                        setSelected([]);
                      }
                    }}
                  >
                    Delete this portfolio
                  </button>{" "}
                  <button
                    className={s.secondary}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep it
                  </button>
                </div>
              )}
            </div>
          </details>
        </div>
      )}
      {editor || !document ? (
        <PortfolioImport
          key={`${editor || "first"}:${importEpoch}:${editor === "edit" ? document?.id : "new"}`}
          initialAction={editor === "edit" ? "new" : importStart}
          initialRows={editor === "edit" ? document?.rows : undefined}
          initialName={editor === "edit" ? document?.name : undefined}
          watchlist={watchlist}
          onDirtyChange={onEditorDirtyChange}
          onCommit={commitRows}
          onCancel={
            document
              ? () => {
                  if (editorDirtyRef.current)
                    setPendingNavigation({ action: "cancel-editor" });
                  else cancelEditor();
                }
              : undefined
          }
        />
      ) : (
        <>
          <div className={s.researchControls}>
            <div>
              <p className={s.eyebrow}>{summary.label}</p>
              <h3>{document.name}</h3>
              <p>
                {included.length} included rows · {summary.issuers.length}{" "}
                identified holdings · {summary.coverage.unresolvedPositions}{" "}
                unresolved rows. Original inputs remain saved.
              </p>
            </div>
            <label>
              Reporting basis
              <select
                value={document.research.basis}
                disabled={busy}
                onChange={(event) => changeBasis(event.target.value)}
              >
                <option value="annual">Latest annual</option>
                <option value="ttm">Supported trailing twelve months</option>
              </select>
            </label>
            {busy ? (
              <button
                className={s.secondary}
                onClick={() => {
                  controller.current?.abort();
                  setMessage(
                    "Stopping after the current request; completed evidence will remain.",
                  );
                }}
              >
                Stop research
              </button>
            ) : (
              <button
                className={s.primary}
                disabled={!portfolioIssuerRequests(rows).length}
                onClick={() => run()}
              >
                <RefreshCw size={16} />{" "}
                {captured ? "Refresh research & filings" : "Run research"}
              </button>
            )}
          </div>
          {busy && (
            <div className={s.progress}>
              <progress
                value={progress.completed}
                max={Math.max(1, progress.total)}
                aria-label="Company research progress"
              />
              <p>
                {progress.completed} of {progress.total} companies processed.
                Five companies per request; successful results appear as batches
                complete.
              </p>
            </div>
          )}
          <details className={s.settings}>
            <summary>
              Allocation settings ·{" "}
              {summary.mode === "universe"
                ? "No weights assumed"
                : summary.label}
            </summary>
            <div className={s.settingsBody}>
              <label>
                Analysis mode and weighting basis
                <select
                  value={document.allocation.basis}
                  disabled={busy}
                  onChange={(event) =>
                    persist(
                      {
                        mode: "update",
                        id: document.id,
                        patch: {
                          allocation: {
                            basis: event.target.value,
                            normalize: false,
                          },
                        },
                      },
                      "Allocation basis updated. Original inputs are preserved.",
                    )
                  }
                >
                  <option value="none">
                    Research universe — company counts only
                  </option>
                  <option value="weights">
                    Weighted portfolio — supplied weight_pct
                  </option>
                  <option value="market_value">
                    Weighted portfolio — comparable market_value
                  </option>
                  <option value="equal">
                    Model as equal-weighted — explicit assumption
                  </option>
                </select>
              </label>
              {document.allocation.basis === "weights" && (
                <div>
                  <p>
                    Original supplied weights:{" "}
                    <strong>{pct(summary.originalWeightTotal)}</strong>.
                    Normalization changes the model, never the imported weights.
                  </p>
                  <button
                    className={s.secondary}
                    disabled={
                      busy ||
                      !number(summary.originalWeightTotal) ||
                      summary.originalWeightTotal <= 0
                    }
                    onClick={() =>
                      persist({
                        mode: "update",
                        id: document.id,
                        patch: {
                          allocation: {
                            ...document.allocation,
                            normalize: !document.allocation.normalize,
                          },
                        },
                      })
                    }
                  >
                    {document.allocation.normalize
                      ? "Use original weights"
                      : "Explicitly normalize to 100%"}
                  </button>
                </div>
              )}
              <p>
                Position values require one stated currency and compatible
                dates. Shares remain metadata; no price or weight is inferred.
                Negative allocations are unsupported. An unspecified balance is
                not automatically cash.
              </p>
            </div>
          </details>
          {(summary.warnings.length > 0 ||
            summary.issues.length > 0 ||
            summary.assumptions?.length > 0) && (
            <div className={s.notice}>
              {(summary.assumptions || []).map((text: string) => (
                <p key={text}>
                  <strong>{text}</strong>
                </p>
              ))}
              {summary.warnings.map((text: string) => (
                <p key={text}>{text}</p>
              ))}
              {summary.issues.length > 0 && (
                <p>
                  {summary.issues.length} row validation issues affect
                  allocation calculations.{" "}
                  <button onClick={() => openEditor("edit")}>
                    Review and correct rows
                  </button>
                  .
                </p>
              )}
            </div>
          )}
          <div className={s.stats}>
            <div>
              <span>Financial evidence</span>
              <strong>
                {summary.coverage.availableCompanies} /{" "}
                {summary.coverage.totalCompanies}
              </strong>
              <small>
                Resolved operating companies;{" "}
                {summary.coverage.unresolvedPositions} unresolved rows shown
                separately
              </small>
            </div>
            <div>
              <span>
                {summary.mode === "universe"
                  ? "Research mode"
                  : "Weight with financial evidence"}
              </span>
              <strong>
                {summary.mode === "universe"
                  ? "Company list"
                  : pct(summary.coverage.availableWeight)}
              </strong>
              <small>
                {summary.mode === "universe"
                  ? "No claim about your economic exposure"
                  : `Of ${pct(summary.allocatedWeight)} known modeled allocation; missing coverage is not reweighted`}
              </small>
            </div>
            <div>
              <span>Captured evidence</span>
              <strong className={s.dateMetric}>
                {date(captured?.generated_at)}
              </strong>
              <small>
                SEC public facts;{" "}
                {document.research.basis === "annual" ? "annual" : "TTM"}{" "}
                periods can differ by company
              </small>
            </div>
          </div>
          <nav className={s.tabs} aria-label="Portfolio research views">
            {[
              ["analytics", "Portfolio analytics"],
              ["research", "Company research"],
              ["changes", "What changed"],
              ["allocation", "Allocation & coverage"],
              ["filings", "Filing library"],
              ["disclosures", "Portfolio disclosures"],
              ["ownership", "Fund ownership"],
              ["exports", "Export & AI context"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={tab === value}
                onClick={() => changePortfolioTab(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div hidden={tab !== "analytics"}>
            <PortfolioAnalytics
              key={document.id}
              rows={rows}
              onDisclosure={openPortfolioDisclosures}
              analyticsArea={analyticsArea}
              onAreaChange={(area: string) => {
                if (!ANALYTICS_AREAS.includes(area)) return;
                setAnalyticsArea(area);
                const url = new URL(window.location.href);
                url.searchParams.set("portfolio", document.id);
                url.searchParams.set("analyticsArea", area);
                url.searchParams.set("portfolioTab", "analytics");
                window.history.pushState(null, "", url.pathname + url.search);
              }}
              settings={document.allocation}
              companies={companies}
              capturedAt={captured?.generated_at || null}
              onInspectCompany={setFocusedRowId}
              onReviewRows={() => openEditor("edit")}
              onRefresh={() => run(false)}
              refreshing={busy}
            />
            <div className={s.exportButtons}>
              <button
                className={s.secondary}
                onClick={() => changePortfolioTab("exports")}
              >
                <ArrowDownToLine size={16} /> Export analytics & evidence
              </button>
              <Link href="/workspace/portfolio-guide#analytics">
                How these analytics work ↗
              </Link>
            </div>
          </div>
          {tab === "research" && (
            <>
              <PortfolioViews
                value={viewSettings}
                onChange={applyView}
                portfolioId={document.id}
                requestedViewId={
                  consumedViewRequest === navigationRequest?.nonce
                    ? ""
                    : navigationRequest?.portfolioViewId || ""
                }
                requestNonce={navigationRequest?.nonce || 0}
                onRequestHandled={() =>
                  setConsumedViewRequest(navigationRequest?.nonce || 0)
                }
              />
              <div className={s.tableToolbar}>
                <label className={s.search}>
                  Search companies
                  <span>
                    <Search size={17} />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Ticker, company or CIK"
                    />
                  </span>
                </label>
                <label>
                  Coverage
                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">All rows</option>
                    <option value="ready">Ready</option>
                    <option value="partial">Partial evidence</option>
                    <option value="failed">Retrieval failed</option>
                    <option value="needs-review">
                      Needs review / not retrieved
                    </option>
                    <option value="unsupported">Unsupported</option>
                    <option value="excluded">Excluded</option>
                  </select>
                </label>
                <label>
                  SEC industry
                  <select
                    value={industryFilter}
                    onChange={(event) => setIndustryFilter(event.target.value)}
                  >
                    <option value="">All SEC industries</option>
                    {[
                      ...new Set<string>(
                        companies.map(
                          (company: any) =>
                            company.sicDescription ||
                            company.industry ||
                            "Unclassified",
                        ),
                      ),
                    ]
                      .sort()
                      .map((industry) => (
                        <option key={industry}>{industry}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Sort by
                  <select
                    value={effectiveSort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="name">Company name</option>
                    {summary.mode !== "universe" && (
                      <option value="weight">Modeled weight</option>
                    )}
                    {availableMetrics.map(({ key, label }) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className={s.secondary}
                  onClick={() =>
                    setDirection(direction === "asc" ? "desc" : "asc")
                  }
                >
                  {direction === "asc" ? "Ascending ↑" : "Descending ↓"}
                </button>
              </div>
              <details className={s.settings}>
                <summary>
                  Choose financial columns · {availableColumns.length} visible
                </summary>
                <div className={s.columnChoices}>
                  {availableMetrics.map(({ key, label }) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={columns.includes(key)}
                        onChange={() =>
                          setColumns((current) =>
                            current.includes(key)
                              ? current.filter((column) => column !== key)
                              : [...current, key],
                          )
                        }
                      />{" "}
                      {label}
                    </label>
                  ))}
                </div>
              </details>
              <div className={s.selectionBar}>
                <span>
                  {visibleRows.length} rows shown · {selected.length} selected
                </span>
                <button
                  onClick={() =>
                    setSelected(visibleRows.map((row: any) => row.id))
                  }
                >
                  Select shown
                </button>
                <button onClick={() => setSelected([])}>Clear selection</button>
                {comparisonTickers.length >= 2 &&
                comparisonTickers.length <= MAX_COMPARE_COMPANIES ? (
                  <Link
                    href={`/compare/${comparisonTickers.join(",")}`}
                    prefetch={false}
                  >
                    Compare {comparisonTickers.length} tickers{" "}
                    <ArrowUpRight size={14} />
                  </Link>
                ) : (
                  <span>
                    Choose 2–{MAX_COMPARE_COMPANIES} supported company tickers
                    for Compare.
                  </span>
                )}
                {companies.some(
                  (company: any) =>
                    company.status === "failed" ||
                    ["failed", "not_checked", "pending", "stale"].includes(
                      company.refreshStatus,
                    ),
                ) && (
                  <button disabled={busy} onClick={() => run(true)}>
                    Retry failed / unchecked companies
                  </button>
                )}
              </div>
              <div
                className={s.tableWrap}
                tabIndex={0}
                role="region"
                aria-label="Portfolio company research table"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Select</th>
                      <th scope="col">Company / security</th>
                      <th scope="col">Status & reporting period</th>
                      {summary.mode !== "universe" && (
                        <th scope="col">Modeled weight</th>
                      )}
                      <th scope="col">Latest annual / interim filing</th>
                      {availableColumns.map((key) => (
                        <th scope="col" key={key}>
                          {METRICS.find(([id]) => id === key)?.[1] || key}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row: any) => {
                      const company = companiesByCik[row.resolution?.cik];
                      const symbol = companyLink(row, company);
                      const fund =
                        company?.kind === "fund" ||
                        row.resolution?.kind === "fund";
                      const annual =
                        company?.latestAnnualFiling ||
                        company?.filings?.find((filing: any) =>
                          /^(10-K|20-F|40-F)/.test(filing.form),
                        );
                      const interim =
                        company?.latestInterimFiling ||
                        company?.filings?.find((filing: any) =>
                          /^(10-Q|6-K)/.test(filing.form),
                        );
                      return (
                        <tr
                          key={row.id}
                          className={row.excluded ? s.excluded : undefined}
                        >
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.resolution?.name || row.input.ticker || row.id}`}
                              checked={selected.includes(row.id)}
                              onChange={() =>
                                setSelected((current) =>
                                  current.includes(row.id)
                                    ? current.filter((id) => id !== row.id)
                                    : [...current, row.id],
                                )
                              }
                            />
                          </td>
                          <th scope="row">
                            <strong>
                              {row.resolution?.ticker ||
                                row.input.ticker ||
                                "CIK-only holding"}
                            </strong>
                            <button
                              className={s.focusButton}
                              onClick={() => setFocusedRowId(row.id)}
                            >
                              Open company focus
                            </button>
                            <span>
                              {company?.name ||
                                row.resolution?.name ||
                                row.input.company_name ||
                                "Unidentified"}
                            </span>
                            <small>
                              CIK {row.resolution?.cik || "unresolved"} ·{" "}
                              {company?.kind ||
                                row.resolution?.kind ||
                                "unknown"}
                            </small>
                            {company && (
                              <small>
                                {company.sic ? `SEC SIC ${company.sic}: ` : ""}
                                {company.sicDescription || company.industry}
                              </small>
                            )}
                            <div className={s.drill}>
                              {["resolved", "unsupported"].includes(
                                row.resolution?.status,
                              ) &&
                                (fund ? (
                                  <Link
                                    href={
                                      company?.fundUrl ||
                                      (symbol
                                        ? `/fund?tickers=${encodeURIComponent(symbol)}`
                                        : "/fund")
                                    }
                                    prefetch={false}
                                  >
                                    Fund research
                                  </Link>
                                ) : (
                                  <>
                                    {symbol && (
                                      <>
                                        <Link
                                          href={`/analysis/${encodeURIComponent(symbol)}`}
                                          prefetch={false}
                                        >
                                          Analysis
                                        </Link>
                                        <Link
                                          href={`/risk?ticker=${encodeURIComponent(symbol)}`}
                                          prefetch={false}
                                        >
                                          Risk
                                        </Link>
                                      </>
                                    )}
                                    <Link
                                      href={`/disclosures?tickers=${encodeURIComponent(symbol || row.resolution.cik)}&mode=companies`}
                                      prefetch={false}
                                    >
                                      Disclosures
                                    </Link>
                                    {!symbol && (
                                      <small>
                                        Confirm a ticker in Edit rows to open
                                        Analysis and Risk.
                                      </small>
                                    )}
                                  </>
                                ))}
                            </div>
                          </th>
                          <td>
                            <span className={s.badge}>
                              {statusLabel(row, company)}
                            </span>
                            <span>
                              {company?.period
                                ? `${company.period.kind} · ${company.period.start || "instant"} → ${company.period.end}`
                                : "Reporting period unavailable"}
                            </span>
                            {company && (
                              <small>
                                {company.cache?.status || "fresh"} · retrieved{" "}
                                {date(company.retrievedAt)}
                              </small>
                            )}
                            {company?.refreshStatus &&
                              company.refreshStatus !== "checked" && (
                                <small>
                                  Latest refresh:{" "}
                                  {company.refreshStatus.replaceAll("_", " ")}.
                                  Earlier evidence keeps its original retrieval
                                  date.
                                </small>
                              )}
                            {company?.warnings?.length > 0 && (
                              <details>
                                <summary>Coverage details</summary>
                                {company.warnings.map((text: string) => (
                                  <p key={text}>{text}</p>
                                ))}
                              </details>
                            )}
                          </td>
                          {summary.mode !== "universe" && (
                            <td>
                              {pct(
                                summary.allocations.find(
                                  (entry: any) => entry.rowId === row.id,
                                )?.weightPct,
                              )}
                            </td>
                          )}
                          <td>
                            {[
                              ["Annual", annual],
                              ["Interim", interim],
                            ].map(([label, filing]: any[]) => (
                              <span key={label}>
                                {label}:{" "}
                                {filing && validSecUrl(filing.documentUrl) ? (
                                  <a
                                    href={filing.documentUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {filing.filingDate} · {filing.form}
                                  </a>
                                ) : (
                                  "Unavailable"
                                )}
                              </span>
                            ))}
                          </td>
                          {availableColumns.map((key) => {
                            const point = company?.metrics?.[key];
                            if (
                              portfolioMetricState(
                                company,
                                PORTFOLIO_METRIC_CATALOG.find(
                                  (d) => d.key === key,
                                ),
                              ) !== "available"
                            )
                              return (
                                <td key={key}>
                                  <span aria-label="No comparable value">
                                    —
                                  </span>
                                </td>
                              );
                            return (
                              <td key={key}>
                                <button
                                  className={s.metric}
                                  disabled={!company}
                                  onClick={() =>
                                    setEvidence({ company, key, point })
                                  }
                                >
                                  {present(point)}
                                </button>
                                {point && (
                                  <small>
                                    {point.classification === "calculated"
                                      ? "Calculated"
                                      : point.classification ===
                                          "not_applicable"
                                        ? "Not applicable"
                                        : point.value === null
                                          ? "Missing evidence"
                                          : "Reported"}
                                  </small>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!visibleRows.length && (
                  <p className={s.empty}>No rows match these filters.</p>
                )}
              </div>
              <p className={s.caption}>
                Values describe whole companies, not the portion economically
                owned by this portfolio. Financial figures use supported USD
                contexts. Click a value to inspect its period, formula, inputs,
                and SEC sources. Share classes retain separate positions and
                reuse one company retrieval.
              </p>
              {evidence && (
                <section
                  ref={evidenceRef}
                  tabIndex={-1}
                  className={s.evidence}
                  aria-labelledby="portfolio-evidence-title"
                >
                  <div className={s.sectionHeading}>
                    <h4 id="portfolio-evidence-title">
                      {evidence.company.name} ·{" "}
                      {METRICS.find(([key]) => key === evidence.key)?.[1] ||
                        evidence.key}
                    </h4>
                    <button
                      className={s.secondary}
                      onClick={() =>
                        draftBrief({
                          title: `${evidence.company.name} · ${evidence.point?.label || evidence.key}`,
                          question: `What does the reported ${evidence.point?.label || evidence.key} evidence tell us, and what remains uncertain?`,
                          ticker: evidence.company.ticker || "",
                          cik: evidence.company.cik,
                          sources: (evidence.point?.sources || [])
                            .filter((source: any) =>
                              validSecUrl(source.documentUrl || source.url),
                            )
                            .map((source: any) => ({
                              url: source.documentUrl || source.url,
                              label: `${source.form || "SEC filing"} · ${source.filed || source.end || "source evidence"}`,
                              annotation: "context",
                              origin: "Portfolio metric evidence",
                              capturedAt:
                                source.observedAt ||
                                evidence.company.retrievedAt,
                            })),
                        })
                      }
                    >
                      Draft a research brief
                    </button>
                    <button
                      className={s.secondary}
                      onClick={() => setEvidence(null)}
                    >
                      Close evidence
                    </button>
                  </div>
                  <p>
                    <strong>{present(evidence.point)}</strong> ·{" "}
                    {evidence.point?.classification || "Unavailable"} ·{" "}
                    {evidence.point?.unit || "Unit unavailable"}
                  </p>
                  <p>
                    Period: {evidence.point?.period?.start || "instant"} to{" "}
                    {evidence.point?.period?.end || "unavailable"}.
                  </p>
                  {evidence.point?.formula && (
                    <p>Formula: {evidence.point.formula}</p>
                  )}
                  {evidence.point?.reason && <p>{evidence.point.reason}</p>}
                  {evidence.point?.note && <p>{evidence.point.note}</p>}
                  <ul>
                    {(evidence.point?.sources || []).map(
                      (source: any, index: number) => (
                        <li key={index}>
                          <strong>
                            {source.tag || source.label || "Reported input"}
                          </strong>
                          :{" "}
                          {number(source.value)
                            ? source.value.toLocaleString("en-US", {
                                maximumFractionDigits: 5,
                              })
                            : "Unavailable"}{" "}
                          {source.unit}. {source.start || "instant"} →{" "}
                          {source.end}; filed {source.filed}; accession{" "}
                          {source.accession}.{" "}
                          {validSecUrl(source.documentUrl) && (
                            <a
                              href={source.documentUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              SEC source ↗
                            </a>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                  {(evidence.point?.calculations || []).map(
                    (calculation: any, index: number) => (
                      <p key={index}>
                        {calculation.formula} · {calculation.start} →{" "}
                        {calculation.end} ·{" "}
                        {number(calculation.value)
                          ? calculation.value
                          : "Unavailable"}{" "}
                        {calculation.unit}
                      </p>
                    ),
                  )}
                  {!evidence.point?.sources?.length && (
                    <p>
                      No supporting compatible fact is available for this
                      metric.
                    </p>
                  )}
                </section>
              )}
              <ReviewPriorities
                priorities={priorities}
                onReview={() => openEditor("edit")}
              />
            </>
          )}
          {tab === "allocation" && (
            <AllocationView summary={summary} columns={availableColumns} />
          )}
          {tab === "changes" && (
            <PortfolioChanges
              baseline={document.comparisonBaseline || null}
              snapshot={captured}
              rows={rows}
              onInspectCompany={setFocusedRowId}
              onCreateBrief={draftBrief}
              onRefresh={() => run(false)}
              refreshing={busy}
            />
          )}
          <PortfolioResearchDesk
            key={document.id}
            rows={rows}
            companies={companies}
            activeTab={tab}
            request={
              disclosureRequest?.portfolioId === document.id
                ? disclosureRequest
                : null
            }
            initialEvidence={sourceEvidence[document.id]}
            onEvidence={captureSourceEvidence}
            onSaveFiling={saveFiling}
          />
          {tab === "exports" && (
            <section className={s.panel}>
              <h3>A portable research snapshot</h3>
              <p>
                Download verified facts, identifiers, reporting periods,
                calculation inputs, SEC sources, allocation assumptions,
                exclusions, and coverage. These files do not update themselves.
              </p>
              <div className={s.exportOptions}>
                <label>
                  Rows to include
                  <select
                    value={exportScope}
                    onChange={(event) => setExportScope(event.target.value)}
                  >
                    <option value="all">All portfolio rows</option>
                    <option value="visible">
                      Rows matching the company-table filters (
                      {visibleRows.length})
                    </option>
                    <option value="selected">
                      Selected rows ({selected.length})
                    </option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeAllocations}
                    onChange={(event) =>
                      setIncludeAllocations(event.target.checked)
                    }
                  />{" "}
                  Include supplied allocations, values and quantities
                  (sensitive)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={includeNotes}
                    onChange={(event) => setIncludeNotes(event.target.checked)}
                  />{" "}
                  Include private notes (off by default)
                </label>
              </div>
              <p className={s.notice}>
                {includeAllocations
                  ? "This package includes your supplied allocation information. Share it only with a recipient or AI service you trust."
                  : "Allocation details and quantities are excluded. The package is presented as company research."}{" "}
                {includeNotes
                  ? "Your private notes will also be included."
                  : "Private notes remain excluded."}
              </p>
              <div className={s.exportButtons}>
                {[
                  ["html", "Download complete portfolio report"],
                  ["csv", "Company table CSV"],
                  ["analytics", "Analytics summary CSV"],
                  ["xlsx", "Research workbook XLSX"],
                  ["json", "Structured JSON"],
                  ["md", "Research brief Markdown"],
                  ["copy", "Copy research context"],
                ].map(([format, label]) => (
                  <button
                    key={format}
                    className={format === "copy" ? s.primary : s.secondary}
                    disabled={
                      selectedIds?.length === 0 ||
                      (format === "analytics" && exportScope !== "all")
                    }
                    onClick={() => exportResearch(format)}
                  >
                    {format === "copy" ? (
                      <Copy size={16} />
                    ) : (
                      <ArrowDownToLine size={16} />
                    )}
                    {label}
                  </button>
                ))}
              </div>
              <p>
                The complete report includes every captured metric, connected
                findings, filings, disclosure searches and fund ownership
                results from this session. Open the HTML file to print or save
                as PDF. JSON includes the same research for AI assistants. CSV
                follows your chosen financial columns and includes source
                context. XLSX separates holdings, company research, portfolio
                summary, analytics, metric observations, sources, and coverage.
                Full-portfolio exports include concentration and financial
                distributions. Select all portfolio rows for the analytics CSV.
                Selected subsets retain their original portfolio denominator.
              </p>
              {copyFallback && (
                <label className={s.copyArea}>
                  Research context
                  <textarea
                    value={copyFallback}
                    readOnly
                    rows={12}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
              )}
              <Link href="/workspace/portfolio-guide">
                Read the versioned input format and batch API documentation ↗
              </Link>
            </section>
          )}
        </>
      )}
      {focusedRow && !editor && (
        <CompanyFocus
          row={focusedRow}
          company={focusedCompany}
          relatedRows={rows.filter((row: any) =>
            focusedRow.resolution?.cik
              ? row.resolution?.cik === focusedRow.resolution.cik
              : row.id === focusedRow.id,
          )}
          allocations={summary.allocations}
          onClose={() => setFocusedRowId(null)}
          onInspectMetric={(key: string, point: any) => {
            setFocusedRowId(null);
            changePortfolioTab("research");
            setEvidence({ company: focusedCompany, key, point });
          }}
          onCreateBrief={draftBrief}
          onSaveFiling={(filing: any) =>
            saveFiling({
              ...filing,
              cik: focusedRow.resolution?.cik,
              ticker:
                focusedRow.resolution?.ticker || focusedCompany?.ticker || "",
              companyName: focusedCompany?.name || focusedRow.resolution?.name,
            })
          }
        />
      )}
      <p className={s.privacy}>
        Saved only in this browser, with up to 20 portfolios and a 4 MiB
        portfolio-storage budget. Uploaded files are parsed locally. Company
        retrieval sends public identifiers; notes and allocation amounts stay
        here. Clearing browser data removes saved work. Full Research Hub
        backups include private notes and allocations—store them securely.
      </p>
    </section>
  );
}

function ReviewPriorities({
  priorities,
  onReview,
}: {
  priorities: any[];
  onReview: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  return (
    <section className={s.panel}>
      <h3>Review priorities</h3>
      <p>
        Transparent checks for missing evidence, unresolved identities, recent
        filings, stale reporting, and negative reported financial measures.
        These are review prompts, not ratings or trade recommendations.
      </p>
      {priorities.length ? (
        <>
          <ul className={s.priorities}>
            {(showAll ? priorities : priorities.slice(0, 12)).map((item) => (
              <li key={item.key}>
                <strong>{item.label}</strong>
                <span>{item.reason}</span>
                {item.kind === "identity" ? (
                  <button onClick={onReview}>Review row</button>
                ) : item.url && validSecUrl(item.url) ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    Verify SEC evidence ↗
                  </a>
                ) : (
                  <small>
                    Run or retry research to obtain supporting evidence.
                  </small>
                )}
              </li>
            ))}
          </ul>
          {priorities.length > 12 && (
            <button
              className={s.secondary}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "Show fewer" : `Show all ${priorities.length} prompts`}
            </button>
          )}
        </>
      ) : (
        <p>
          No supported review condition was triggered. Missing or unresearched
          data cannot establish that a company is low risk.
        </p>
      )}
    </section>
  );
}

function AllocationView({
  summary,
  columns,
}: {
  summary: any;
  columns: string[];
}) {
  const weighted = summary.mode !== "universe";
  return (
    <section className={s.panel}>
      <h3>
        {weighted
          ? "Allocation, concentration & evidence"
          : "Research-universe composition & evidence"}
      </h3>
      <p>
        {weighted
          ? "Percentages use the selected allocation basis. Missing weights and missing evidence stay visible."
          : "Distributions count identified holdings. They do not measure capital invested or portfolio exposure."}
      </p>
      {weighted && (
        <div className={s.stats}>
          <div>
            <span>Known modeled allocation</span>
            <strong>{pct(summary.allocatedWeight)}</strong>
          </div>
          <div>
            <span>Top-five holding concentration</span>
            <strong>{pct(summary.topFiveWeightPct)}</strong>
            <small>
              {summary.allocations.length < 5
                ? `Across all ${summary.allocations.length} included positions`
                : "Largest five known position weights"}
            </small>
          </div>
          <div>
            <span>Weight with financial evidence</span>
            <strong>{pct(summary.coverage.availableWeight)}</strong>
            <small>Not normalized to the covered subset</small>
          </div>
        </div>
      )}
      <div className={s.split}>
        <div>
          <h4>
            {weighted ? "Holding allocation" : "Included research identities"}
          </h4>
          {weighted && (
            <div
              className={s.chart}
              role="img"
              aria-label="Holding weights, with exact values in the accompanying table"
            >
              {summary.allocations
                .filter((entry: any) => number(entry.weightPct))
                .slice()
                .sort((a: any, b: any) => b.weightPct - a.weightPct)
                .slice(0, 10)
                .map((entry: any) => (
                  <div key={entry.rowId}>
                    <span>{entry.ticker || entry.name}</span>
                    <div>
                      <i
                        style={{
                          width: `${Math.max(0, Math.min(100, entry.weightPct))}%`,
                        }}
                      />
                    </div>
                    <strong>{pct(entry.weightPct)}</strong>
                  </div>
                ))}
              <small>
                Top 10 known weights shown; all positions appear below.
              </small>
            </div>
          )}
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="All holding allocations"
          >
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>{weighted ? "Modeled weight" : "Classification"}</th>
                  <th>Original supplied weight</th>
                </tr>
              </thead>
              <tbody>
                {summary.allocations.map((entry: any) => (
                  <tr key={entry.rowId}>
                    <th scope="row">{entry.ticker || entry.name}</th>
                    <td>{weighted ? pct(entry.weightPct) : entry.kind}</td>
                    <td>
                      {number(entry.originalWeightPct)
                        ? pct(entry.originalWeightPct)
                        : "Not supplied"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h4>SEC industry distribution</h4>
          <p>
            SEC SIC descriptions or the application’s SEC SIC groups; this is
            not GICS. Unresolved rows are shown separately.
          </p>
          <div
            className={s.chart}
            role="img"
            aria-label={
              weighted ? "SEC industry weights" : "SEC industry holding counts"
            }
          >
            {summary.distribution
              .slice()
              .sort((a: any, b: any) =>
                weighted
                  ? (b.weightPct || 0) - (a.weightPct || 0)
                  : b.count - a.count,
              )
              .slice(0, 10)
              .map((entry: any) => (
                <div key={entry.label}>
                  <span>{entry.label}</span>
                  <div>
                    <i
                      style={{
                        width: `${weighted ? Math.max(0, Math.min(100, entry.weightPct || 0)) : Math.max(0, (entry.count / Math.max(1, summary.issuers.length + summary.coverage.unresolvedPositions)) * 100)}%`,
                      }}
                    />
                  </div>
                  <strong>
                    {weighted ? pct(entry.weightPct) : entry.count}
                  </strong>
                </div>
              ))}
          </div>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="All SEC industry distribution values"
          >
            <table>
              <thead>
                <tr>
                  <th>Classification</th>
                  <th>Holding / unresolved row count</th>
                  {weighted && <th>Known weight</th>}
                </tr>
              </thead>
              <tbody>
                {summary.distribution.map((entry: any) => (
                  <tr key={entry.label}>
                    <th scope="row">{entry.label}</th>
                    <td>{entry.count}</td>
                    {weighted && <td>{pct(entry.weightPct)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {weighted && (
        <>
          <h4>Holding concentration across share classes</h4>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Holding concentration"
          >
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Securities</th>
                  <th>Known combined weight</th>
                  <th>Weight completeness</th>
                </tr>
              </thead>
              <tbody>
                {summary.issuers.map((issuer: any) => (
                  <tr key={issuer.cik}>
                    <th scope="row">
                      {issuer.name} · CIK {issuer.cik}
                    </th>
                    <td>{issuer.tickers.join(", ") || "CIK-only identity"}</td>
                    <td>{pct(issuer.weightPct)}</td>
                    <td>
                      {issuer.weightComplete
                        ? "Complete for included positions"
                        : `${issuer.missingWeightCount} weights missing`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>Evidence coverage by selected financial metric</h4>
      <div
        className={s.tableWrap}
        tabIndex={0}
        role="region"
        aria-label="Financial metric coverage"
      >
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Companies with evidence</th>
              {weighted && <th>Known portfolio weight covered</th>}
            </tr>
          </thead>
          <tbody>
            {columns.map((key) => {
              const coverage = summary.fieldCoverage?.[key];
              return (
                <tr key={key}>
                  <th scope="row">
                    {METRICS.find(([id]) => id === key)?.[1] || key}
                  </th>
                  <td>
                    {coverage?.availableCompanies || 0} /{" "}
                    {coverage?.totalCompanies ??
                      summary.coverage.totalCompanies}
                  </td>
                  {weighted && <td>{pct(coverage?.availableWeight)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p>
        No portfolio returns, volatility, beta, Sharpe ratio, drawdown, or value
        at risk are inferred from these holdings.
      </p>
    </section>
  );
}
