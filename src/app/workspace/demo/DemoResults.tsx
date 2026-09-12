"use client";

import { resolveCompanyClassification } from "../../../utils/companyClassification.js";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import ResearchWorkspace from "../portfolio/ResearchWorkspace";
import CompanyResearchTable from "../portfolio/CompanyResearchTable";
import WorkspaceMenu from "../WorkspaceMenu";
import { allocationSummary } from "../../../utils/portfolioModel.js";
import { augmentPortfolioCompanyMetrics } from "../../../utils/financialSupplementalMetrics.js";
import { portfolioMetricState } from "../../../utils/portfolioDeepResearch.js";
import { PORTFOLIO_METRIC_CATALOG } from "../../../utils/portfolioMetricCatalog.js";
import {
  portfolioFilingFeed,
  researchPortfolioRows,
} from "../../../utils/portfolioClient.js";
import {
  PORTFOLIO_REPORTING_BASES,
  PORTFOLIO_REPORTING_OPTIONS,
  portfolioPeriodLabel,
  portfolioReportingLabel,
} from "../../../utils/portfolioReporting.js";
import { portfolioReviewPriorities } from "../../../utils/portfolioInsights.js";
import {
  PORTFOLIO_VIEW_PRESETS,
  availablePortfolioViewPresets,
  rowMatchesPortfolioView,
} from "../../../utils/portfolioViews.js";
import {
  validatePortfolioDemo,
  applyPortfolioDemoSnapshot,
  saveDemoPortfolio,
  createDemoPortfolio,
} from "../../../utils/portfolioDemo.js";
import { demoAllocationSettings } from "../../../utils/portfolioDemoAllocation.js";
import { hubDestination } from "../../../utils/researchHubNavigation.js";
import { buildPortfolioResearchPackage } from "../../../utils/portfolioExports.js";
import { portfolioReportHtml } from "../../../utils/portfolioReport.js";
import { downloadText } from "../../../utils/download.js";
import s from "./demo.module.css";

const PortfolioAnalytics = dynamic(
  () => import("../portfolio/PortfolioAnalytics"),
  {
    loading: () => <p role="status">Opening example analytics…</p>,
  },
);
const PortfolioResearchDesk = dynamic(
  () => import("../portfolio/PortfolioResearchDesk"),
);
const CompanyFocus = dynamic(() => import("../portfolio/CompanyFocus"));

const METRIC_DEFINITIONS = Object.fromEntries(
  PORTFOLIO_METRIC_CATALOG.map((definition: any) => [
    definition.key,
    definition,
  ]),
);
const METRICS: Record<string, string> = Object.fromEntries(
  PORTFOLIO_METRIC_CATALOG.map((definition: any) => [
    definition.key,
    definition.label,
  ]),
);
const day = (value?: string | null) => value?.slice(0, 10) || "Unavailable";
const pct = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
    : "—";
function present(point: any) {
  if (typeof point?.value !== "number" || !Number.isFinite(point.value))
    return point?.classification === "not_applicable"
      ? "Not applicable"
      : "Unavailable";
  if (point.unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(point.value);
  return `${point.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}${point.unit === "%" ? "%" : point.unit && point.unit !== "ratio" ? ` ${point.unit}` : ""}`;
}

export default function DemoResults() {
  const [sourceEvidence, setSourceEvidence] = useState<any>({});
  const [disclosureRequest, setDisclosureRequest] = useState<any>(null);
  const captureSources = useCallback(
    (value: any) => setSourceEvidence(value),
    [],
  );
  function openDisclosures(query: string, ciks: string[]) {
    setDisclosureRequest({ query, ciks });
    setArea("disclosures");
  }
  const [demo, setDemo] = useState<any>(null);
  const [reportingDemo, setReportingDemo] = useState<any>(null);
  const [reportingBasis, setReportingBasis] = useState("annual");
  const [reportingLoading, setReportingLoading] = useState(false);
  const [reportingProgress, setReportingProgress] = useState({
    completed: 0,
    total: 100,
  });
  const [reportingNotice, setReportingNotice] = useState("");
  const [reportingRetryBasis, setReportingRetryBasis] = useState<string | null>(
    null,
  );
  const reportingCache = useRef(new Map<string, any>());
  const reportingController = useRef<AbortController | null>(null);
  const lastReportingDemo = useRef<any>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [area, setArea] = useState("analytics");
  const [allocationBasis, setAllocationBasis] = useState("example");
  const [analyticsArea, setAnalyticsArea] = useState("overview");
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const companyTabRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [preset, setPreset] = useState("overview");
  const [limit, setLimit] = useState(20);
  const [evidence, setEvidence] = useState<any>(null);
  const evidenceRef = useRef<HTMLElement | null>(null);
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch("/portfolio/portfolio-demo-100-results.json", {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "The captured example could not be loaded. The templates are still available above.",
          );
        const raw = await response.text();
        if (raw.length > 8 * 1024 * 1024)
          throw new Error("The example is too large to open safely.");
        const next = validatePortfolioDemo(JSON.parse(raw));
        if (!controller.signal.aborted) {
          setDemo(next);
          setReportingDemo(next);
          setReportingBasis(next.snapshot.basis);
          reportingCache.current.set(next.snapshot.basis, next);
          lastReportingDemo.current = next;
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The example could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (evidence) evidenceRef.current?.focus();
  }, [evidence]);

  useEffect(() => () => reportingController.current?.abort(), []);

  async function changeReportingBasis(basis: string, retry = false) {
    if (!demo || !PORTFOLIO_REPORTING_BASES.includes(basis)) return;
    reportingController.current?.abort();
    const cached = !retry && reportingCache.current.get(basis);
    setReportingBasis(basis);
    setReportingNotice("");
    setReportingRetryBasis(null);
    setEvidence(null);
    setFocusedRowId(null);
    setDisclosureRequest(null);
    setLimit(20);
    if (cached) {
      reportingController.current = null;
      setReportingDemo(cached);
      lastReportingDemo.current = cached;
      setReportingLoading(false);
      return;
    }
    const controller = new AbortController();
    reportingController.current = controller;
    setReportingDemo(null);
    setReportingLoading(true);
    setReportingProgress({ completed: 0, total: 100 });
    const requests: any[] = [];
    const previousCapture = lastReportingDemo.current;
    const previous =
      retry &&
      reportingRetryBasis === basis &&
      previousCapture?.snapshot.basis === basis &&
      previousCapture.snapshot.companies.some(
        (company: any) =>
          company.status === "failed" ||
          ["failed", "stale", "not_checked"].includes(company.refreshStatus) ||
          ["stale", "unavailable"].includes(company.cache?.status),
      )
        ? previousCapture.snapshot.companies
        : [];
    if (retry) reportingCache.current.delete(basis);
    try {
      const result = await researchPortfolioRows(demo.rows, {
        basis,
        previousCompanies: previous,
        onlyFailed: previous.length > 0,
        signal: controller.signal,
        onProgress: ({ completed, total }: any) => {
          if (reportingController.current === controller)
            setReportingProgress({ completed, total });
        },
        fetcher: async (url: any, options: any) => {
          const request = {
            started_at: new Date().toISOString(),
            completed_at: "",
            tickers: JSON.parse(options.body).holdings.map(
              (holding: any) => holding.ticker,
            ),
          };
          requests.push(request);
          try {
            return await fetch(url, options);
          } finally {
            request.completed_at = new Date().toISOString();
          }
        },
      });
      if (reportingController.current !== controller) return;
      const usable = result.companies.some(
        (company: any) =>
          ["ready", "partial"].includes(company.status) &&
          company.cache?.status !== "unavailable",
      );
      if (result.cancelled || !usable) {
        const restored = lastReportingDemo.current;
        setReportingDemo(restored);
        setReportingBasis(restored.snapshot.basis);
        setReportingRetryBasis(basis);
        setReportingNotice(
          `${portfolioReportingLabel(basis)} retrieval ${result.cancelled ? "was cancelled" : "could not return usable evidence"}. ${portfolioReportingLabel(restored.snapshot.basis)} results remain available.`,
        );
        return;
      }
      const next = applyPortfolioDemoSnapshot(demo, {
        ...result,
        requests,
      });
      setReportingDemo(next);
      lastReportingDemo.current = next;
      const incomplete = next.snapshot.companies.filter(
        (company: any) =>
          company.status === "failed" ||
          ["failed", "stale", "not_checked"].includes(company.refreshStatus) ||
          ["stale", "unavailable"].includes(company.cache?.status),
      ).length;
      if (!incomplete) {
        reportingCache.current.set(basis, next);
        setReportingNotice(
          `${portfolioReportingLabel(basis)} evidence is ready. This capture is available for the rest of this visit.`,
        );
      } else {
        setReportingRetryBasis(basis);
        setReportingNotice(
          `${portfolioReportingLabel(basis)} results are ready; ${incomplete} ${incomplete === 1 ? "company needs" : "companies need"} another retrieval attempt. Coverage reflects the evidence returned.`,
        );
      }
    } catch (failure) {
      if (reportingController.current !== controller) return;
      const restored = lastReportingDemo.current;
      setReportingDemo(restored);
      setReportingBasis(restored.snapshot.basis);
      setReportingRetryBasis(basis);
      setReportingNotice(
        `${failure instanceof Error ? failure.message : "The requested financial evidence could not be opened."} ${portfolioReportingLabel(restored.snapshot.basis)} results remain available.`,
      );
    } finally {
      if (reportingController.current === controller) {
        reportingController.current = null;
        setReportingLoading(false);
      }
    }
  }

  const companies = useMemo(
    () =>
      (reportingDemo?.snapshot.companies || []).map(
        augmentPortfolioCompanyMetrics,
      ),
    [reportingDemo],
  );
  const rows = useMemo(() => demo?.rows || [], [demo]);
  const byCik = useMemo(
    () =>
      Object.fromEntries(
        companies.map((company: any) => [company.cik, company]),
      ),
    [companies],
  );
  const settings = useMemo(
    () =>
      demo
        ? demoAllocationSettings(demo, allocationBasis)
        : { basis: "none", normalize: false },
    [demo, allocationBasis],
  );
  const allocation = useMemo(
    () => allocationSummary(rows, settings, byCik),
    [rows, settings, byCik],
  );
  const weighted = allocation.mode === "weighted";
  const weights = useMemo(
    () =>
      new Map(
        allocation.allocations.map((row: any) => [row.rowId, row.weightPct]),
      ),
    [allocation],
  );
  const feed = useMemo(() => {
    const tickers = new Map(
      rows.map((row: any) => [
        row.resolution?.cik,
        row.resolution?.ticker || row.input.ticker,
      ]),
    );
    return portfolioFilingFeed(rows, companies).map((filing: any) => ({
      ...filing,
      ticker: filing.ticker || tickers.get(filing.cik) || "",
    }));
  }, [rows, companies]);
  const priorities = useMemo(
    () =>
      portfolioReviewPriorities(
        rows,
        companies,
        allocation,
        reportingDemo ? Date.parse(reportingDemo.captured_at) : 0,
      ),
    [rows, companies, allocation, reportingDemo],
  );
  const availableViews = useMemo(
    () => availablePortfolioViewPresets(rows, companies),
    [rows, companies],
  );
  const view =
    availableViews.find((item: any) => item.id === preset) ||
    availableViews.find((item: any) => item.id === "overview") ||
    PORTFOLIO_VIEW_PRESETS[0];
  const shown = useMemo(() => {
    const definition = METRIC_DEFINITIONS[view.sort];
    return rows
      .filter((row: any) => {
        const company = byCik[row.resolution?.cik];
        const classification = resolveCompanyClassification(company);
        const text =
          `${row.input.ticker} ${company?.name || row.resolution?.name || ""} ${classification.industry} ${classification.sector || ""}`.toLowerCase();
        return (
          text.includes(query.trim().toLowerCase()) &&
          rowMatchesPortfolioView(row, company, view.id)
        );
      })
      .sort((a: any, b: any) => {
        if (definition) {
          const left = byCik[a.resolution?.cik];
          const right = byCik[b.resolution?.cik];
          const leftAvailable =
            portfolioMetricState(left, definition) === "available";
          const rightAvailable =
            portfolioMetricState(right, definition) === "available";
          if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
          if (leftAvailable && rightAvailable) {
            const difference =
              left.metrics[definition.key].value -
              right.metrics[definition.key].value;
            if (difference)
              return view.direction === "asc" ? difference : -difference;
          }
        }
        return (
          (weighted
            ? Number(weights.get(b.id)) - Number(weights.get(a.id))
            : 0) || a.input.ticker.localeCompare(b.input.ticker)
        );
      });
  }, [rows, byCik, query, view, weights, weighted]);

  const shownColumns = view.columns.filter((key: string) =>
    shown.some(
      (row: any) =>
        portfolioMetricState(
          byCik[row.resolution?.cik],
          METRIC_DEFINITIONS[key],
        ) === "available",
    ),
  );

  function downloadReport() {
    if (!reportingDemo || reportingLoading) return;
    const bundle = buildPortfolioResearchPackage(
      createDemoPortfolio(reportingDemo, { allocationBasis }),
      { includeAllocations: true },
    );
    downloadText(
      `edgar-demo-${settings.basis}-${reportingBasis}-research.html`,
      portfolioReportHtml(bundle, sourceEvidence),
      "text/html;charset=utf-8",
    );
  }
  function openInHub() {
    if (!reportingDemo || reportingLoading || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const { portfolio } = saveDemoPortfolio(localStorage, reportingDemo, {
        allocationBasis,
      });
      // Re-enter the workspace with its saved portfolio route initialized.
      window.location.assign(
        hubDestination("portfolios", {
          portfolioId: portfolio.id,
          portfolioTab: "analytics",
          analyticsArea,
        }),
      );
    } catch (failure) {
      setSaveError(
        failure instanceof Error
          ? failure.message
          : "The example could not be saved in this browser.",
      );
      setSaving(false);
    }
  }

  return (
    <section
      id="example-results"
      className={s.results}
      aria-labelledby="demo-results-heading"
    >
      <header className={s.workspaceHeader}>
        <div>
          <h1 id="demo-results-heading">
            100-company portfolio <span className={s.demoTag}>Demo</span>
          </h1>
          <p>
            Explore a portfolio with hypothetical weights and real SEC evidence.
          </p>
        </div>
        {demo && (
          <div className={s.headerActions}>
            <WorkspaceMenu label="Download" mobileAlign="start">
              <strong>Example portfolio · fixed hypothetical weights</strong>
              <a href="/portfolio/portfolio-demo-100.csv" download>
                CSV spreadsheet ↓
              </a>
              <a href="/portfolio/portfolio-demo-100.xlsx" download>
                Excel workbook ↓
              </a>
              <a href="/portfolio/portfolio-demo-100.json" download>
                JSON portfolio ↓
              </a>
              <small>
                After CSV or Excel import, choose supplied weight percentages in
                Allocation settings. JSON keeps that setting.
              </small>
              <button
                onClick={downloadReport}
                disabled={reportingLoading || !reportingDemo}
              >
                Research report ↓
              </button>
              <small>
                The report uses your selected allocation and reporting
                perspective. Spreadsheet templates keep the original annual
                research setting.
              </small>
            </WorkspaceMenu>
            <button
              className={s.primary}
              onClick={openInHub}
              disabled={saving || reportingLoading || !reportingDemo}
            >
              {saving ? "Opening…" : "Make a copy →"}
            </button>
          </div>
        )}
      </header>
      {!demo && !error && (
        <p className={s.notice} role="status">
          Loading the 100-company example results…
        </p>
      )}
      {error && (
        <div className={s.notice} role="alert">
          <p>{error}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry example
          </button>
        </div>
      )}
      {demo && (
        <>
          <div className={s.workspaceToolbar}>
            <label className={s.allocationSelect}>
              Allocation
              <select
                value={allocationBasis}
                onChange={(event) => setAllocationBasis(event.target.value)}
              >
                <option value="example">Hypothetical weights</option>
                <option value="equal">Equal weights</option>
                <option value="none">Company counts</option>
              </select>
            </label>
            <p aria-live="polite">
              {settings.basis === "weights"
                ? "100% allocated · unequal example weights"
                : settings.basis === "equal"
                  ? "1% per company · equal-weight assumption"
                  : "Company list · no weights assumed"}
              <span>
                {reportingLoading
                  ? `Retrieving ${portfolioReportingLabel(reportingBasis).toLowerCase()} evidence…`
                  : `${portfolioReportingLabel(reportingBasis)} · SEC evidence captured ${day(reportingDemo?.captured_at)}`}
              </span>
            </p>
            {(area !== "analytics" || analyticsArea !== "metrics") && (
              <label className={s.allocationSelect}>
                Reporting perspective
                <select
                  value={reportingBasis}
                  onChange={(event) => changeReportingBasis(event.target.value)}
                >
                  {PORTFOLIO_REPORTING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <WorkspaceMenu label="About this demo">
              <strong>A starting point for your research</strong>
              <p>
                Use the overview for the big picture. Choose a research view to
                compare companies, review filings or test a scenario.
              </p>
              <p>
                {settings.basis === "equal"
                  ? "Each company receives a hypothetical 1%."
                  : demo.allocation_example.methodology}
              </p>
              <p>
                Weights affect concentration, coverage and scenarios. Financial
                ratios describe individual companies.
              </p>
              <p>
                Choose a reporting perspective to retrieve compatible SEC
                evidence. Make a copy to keep that capture and edit holdings or
                weights. {feed.length.toLocaleString("en-US")} filing references
                are included.
              </p>
              <small>
                Allocations are illustrative, not actual holdings or investment
                recommendations. Company reporting periods differ.
              </small>
              <Link href="/workspace/portfolio-guide">
                Import & format guide ↗
              </Link>
            </WorkspaceMenu>
          </div>
          {reportingLoading &&
            (area !== "analytics" || analyticsArea !== "metrics") && (
              <div className={s.reportingStatus} role="status">
                <span>
                  Retrieving{" "}
                  {portfolioReportingLabel(reportingBasis).toLowerCase()}{" "}
                  evidence · {reportingProgress.completed} of{" "}
                  {reportingProgress.total} companies
                </span>
                <progress
                  value={reportingProgress.completed}
                  max={reportingProgress.total}
                  aria-label="Reporting evidence retrieval progress"
                />
                <button onClick={() => reportingController.current?.abort()}>
                  Cancel retrieval
                </button>
              </div>
            )}
          {reportingNotice && (
            <div className={s.reportingStatus} role="status">
              <span>{reportingNotice}</span>
              {reportingRetryBasis && (
                <button
                  onClick={() =>
                    changeReportingBasis(reportingRetryBasis, true)
                  }
                >
                  Retry{" "}
                  {portfolioReportingLabel(reportingRetryBasis).toLowerCase()}
                </button>
              )}
            </div>
          )}
          {saveError && (
            <p role="alert" className={s.notice}>
              {saveError}
            </p>
          )}
          <ResearchWorkspace
            demo
            companyRef={companyTabRef}
            selected={
              area === "analytics" ? `analytics:${analyticsArea}` : area
            }
            onSelect={(value) => {
              if (value.startsWith("analytics:")) {
                setArea("analytics");
                setAnalyticsArea(value.slice(10));
              } else setArea(value);
              setLimit(20);
              setEvidence(null);
            }}
          >
            <div
              hidden={
                area !== "analytics" ||
                (reportingLoading && analyticsArea !== "metrics")
              }
            >
              <PortfolioAnalytics
                embedded
                rows={rows}
                settings={settings}
                analyticsArea={analyticsArea}
                onAreaChange={setAnalyticsArea}
                companies={companies}
                capturedAt={reportingDemo?.captured_at || null}
                reportingBasis={reportingBasis}
                onReportingBasisChange={changeReportingBasis}
                reportingLoading={reportingLoading}
                reportingProgress={reportingProgress}
                onCancelReporting={() => reportingController.current?.abort()}
                onDisclosure={openDisclosures}
                onInspectCompany={setFocusedRowId}
                onReviewRows={openInHub}
                onRefresh={() => changeReportingBasis(reportingBasis, true)}
                refreshing={reportingLoading}
                preview
              />
            </div>
            {area === "companies" && !reportingLoading && (
              <div className={s.filters}>
                <label>
                  Search{" "}
                  {area === "companies"
                    ? "companies or industries"
                    : "companies or filing forms"}
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setLimit(20);
                    }}
                    placeholder={
                      area === "companies"
                        ? "Try Apple, JPM, or semiconductors"
                        : "Try AAPL or 10-K"
                    }
                  />
                </label>
                {area === "companies" && !reportingLoading && (
                  <label>
                    Research lens
                    <select
                      value={view.id}
                      onChange={(event) => {
                        setPreset(event.target.value);
                        setLimit(20);
                        setEvidence(null);
                      }}
                    >
                      {availableViews.map((item: any) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.rowCount}{" "}
                          {item.rowCount === 1 ? "company" : "companies"}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p role="status">
                  {area === "companies"
                    ? `${shown.length} of ${rows.length} companies`
                    : `${feed.length} filing references`}{" "}
                  match
                </p>
              </div>
            )}
            {area === "companies" && !reportingLoading && (
              <>
                <p className={s.tableHelp}>
                  {view.description}{" "}
                  {METRICS[view.sort]
                    ? `Sorted by ${METRICS[view.sort].toLowerCase()}, ${view.direction === "asc" ? "lowest" : "highest"} first. `
                    : weighted
                      ? "Largest hypothetical weights first. "
                      : "Companies are ordered by ticker. "}
                  Click a financial measure to see its reporting period,
                  calculation, and SEC sources. Missing values are never treated
                  as zero.
                </p>
                <CompanyResearchTable
                  className={s.tableScroll}
                  label="100-company example results table"
                  resetKey={`${view.id}:${query}:${reportingBasis}`}
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Company</th>
                        {weighted && <th scope="col">Hypothetical weight</th>}
                        <th scope="col">Coverage & reporting period</th>
                        {shownColumns.map((key: string) => (
                          <th key={key} scope="col">
                            {METRICS[key] || key}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.slice(0, limit).map((row: any) => {
                        const company = byCik[row.resolution?.cik];
                        return (
                          <tr key={row.id}>
                            <th scope="row">
                              <strong>{row.input.ticker}</strong>
                              <span>
                                {company?.name ||
                                  row.resolution?.name ||
                                  "Identity needs review"}
                              </span>
                              <small>
                                {resolveCompanyClassification(company).sector ||
                                  resolveCompanyClassification(company)
                                    .industry ||
                                  "Industry unavailable"}
                              </small>
                            </th>
                            {weighted && (
                              <td className={s.weightCell}>
                                {pct(Number(weights.get(row.id)))}
                              </td>
                            )}
                            <td>
                              <span className={s.status}>
                                {company?.status === "ready"
                                  ? "Available"
                                  : company?.status === "partial"
                                    ? "Partial evidence"
                                    : company?.status || "Not retrieved"}
                              </span>
                              <small>
                                {portfolioPeriodLabel(company?.period)}
                              </small>
                            </td>
                            {shownColumns.map((key: string) => {
                              const point = company?.metrics?.[key];
                              if (
                                portfolioMetricState(
                                  company,
                                  METRIC_DEFINITIONS[key],
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
                                    className={s.valueButton}
                                    disabled={!company}
                                    aria-label={`${row.input.ticker}: ${METRICS[key] || key} ${present(point)}; inspect evidence`}
                                    onClick={(event) => {
                                      evidenceTrigger.current =
                                        event.currentTarget;
                                      setEvidence({
                                        company: {
                                          ...company,
                                          ticker:
                                            company.ticker ||
                                            row.resolution?.ticker ||
                                            row.input.ticker,
                                        },
                                        key,
                                        point,
                                      });
                                    }}
                                  >
                                    {present(point)}
                                  </button>
                                  <small>
                                    {point?.classification === "calculated"
                                      ? "Calculated"
                                      : point?.classification === "reported"
                                        ? "Reported"
                                        : ""}
                                  </small>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CompanyResearchTable>
                {shown.length === 0 && (
                  <p className={s.notice}>
                    No companies match this view and search. Try Financial
                    overview or clear the search.
                  </p>
                )}
                {shown.length > limit && (
                  <button
                    className={s.secondary}
                    onClick={() => setLimit((value) => value + 20)}
                  >
                    Show next {Math.min(20, shown.length - limit)} companies
                  </button>
                )}
                {evidence && (
                  <section
                    ref={evidenceRef}
                    tabIndex={-1}
                    className={s.evidence}
                    aria-labelledby="demo-evidence-heading"
                  >
                    <div className={s.sectionHeading}>
                      <div>
                        <p className={s.eyebrow}>
                          Behind the number · {evidence.company.ticker}
                        </p>
                        <h3 id="demo-evidence-heading">
                          {METRICS[evidence.key] || evidence.key}:{" "}
                          {present(evidence.point)}
                        </h3>
                      </div>
                      <button
                        onClick={() => {
                          setEvidence(null);
                          if (evidenceTrigger.current?.isConnected)
                            evidenceTrigger.current.focus();
                          else {
                            const region = companyTabRef.current
                              ?.closest("aside")
                              ?.parentElement?.querySelector(
                                "[data-portfolio-view]",
                              ) as HTMLElement | null;
                            region?.focus({ preventScroll: true });
                          }
                        }}
                        aria-label="Close example metric evidence"
                      >
                        Close
                      </button>
                    </div>
                    <p>
                      {evidence.company.name} ·{" "}
                      {evidence.point?.classification?.replaceAll("_", " ") ||
                        "unavailable"}{" "}
                      · {evidence.point?.unit || "Unit unavailable"}
                    </p>
                    <p>
                      Metric period:{" "}
                      {evidence.point?.period?.start
                        ? `${day(evidence.point.period.start)} to `
                        : ""}
                      {day(evidence.point?.period?.end)}. Company evidence
                      captured {day(evidence.company.retrievedAt)}.
                    </p>
                    {evidence.point?.formula && (
                      <p>
                        Calculation:{" "}
                        {typeof evidence.point.formula === "string"
                          ? evidence.point.formula
                          : JSON.stringify(evidence.point.formula)}
                      </p>
                    )}
                    {evidence.point?.reason && <p>{evidence.point.reason}</p>}
                    {evidence.point?.sources?.length ? (
                      <ul className={s.sourceList}>
                        {evidence.point.sources.map(
                          (source: any, index: number) => (
                            <li
                              key={`${source.documentUrl}:${source.tag}:${index}`}
                            >
                              <a
                                href={source.documentUrl || source.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {source.form || "SEC filing"} ·{" "}
                                {source.tag || "Source evidence"} ↗
                              </a>
                              <span>
                                Filed {day(source.filed || source.filingDate)} ·{" "}
                                {source.accession || "Accession unavailable"}
                              </span>
                              {typeof source.value === "number" && (
                                <small>
                                  Source input:{" "}
                                  {source.value.toLocaleString("en-US")}{" "}
                                  {source.unit || source.units || ""}
                                </small>
                              )}
                            </li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p>
                        No supported SEC source is available for this measure.
                        Open the full demo to review coverage details and
                        company filings.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
            <PortfolioResearchDesk
              rows={rows}
              companies={companies}
              activeTab={reportingLoading ? "" : area}
              request={disclosureRequest}
              onEvidence={captureSources}
            />
            {area === "followups" && !reportingLoading && (
              <>
                <div className={s.explanation}>
                  <h3>The next questions are part of the result.</h3>
                  <p>
                    These checks were generated from the captured evidence on{" "}
                    {day(reportingDemo?.captured_at)}. They point to missing
                    coverage, reporting freshness, recent filings, or negative
                    reported measures. They are research prompts, not investment
                    ratings.
                  </p>
                  <p>
                    {weighted
                      ? "The selected hypothetical weights show how much allocation is affected by evidence gaps. Financial findings remain tied to the captured company facts."
                      : "This view uses company counts. Switch to hypothetical or equal weights to see how allocation changes the evidence coverage."}
                  </p>
                </div>
                <div className={s.followups}>
                  {priorities.slice(0, 6).map((item: any) => (
                    <article key={item.key}>
                      <span className={s.eyebrow}>{item.kind}</span>
                      <h3>{item.label}</h3>
                      <p>{item.reason}</p>
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noreferrer">
                          Verify SEC evidence ↗
                        </a>
                      )}
                    </article>
                  ))}
                </div>
                <p className={s.tableHelp}>
                  {priorities.length
                    ? `Showing ${Math.min(6, priorities.length)} of ${priorities.length} captured review prompts. Open the full demo to inspect company evidence and refresh the portfolio research.`
                    : "No review prompts were raised by these checks at capture time. This does not establish completeness or investment quality."}{" "}
                  “What changed” starts with this capture and becomes useful
                  after a subsequent research refresh.
                </p>
              </>
            )}
          </ResearchWorkspace>
          {focusedRowId && rows.find((row: any) => row.id === focusedRowId) && (
            <CompanyFocus
              row={rows.find((row: any) => row.id === focusedRowId)}
              company={
                byCik[
                  rows.find((row: any) => row.id === focusedRowId).resolution
                    .cik
                ]
              }
              relatedRows={rows.filter(
                (row: any) =>
                  row.resolution.cik ===
                  rows.find((item: any) => item.id === focusedRowId).resolution
                    .cik,
              )}
              allocations={allocation.allocations}
              onClose={() => setFocusedRowId(null)}
              onInspectMetric={(key: string, point: any) => {
                const row = rows.find((item: any) => item.id === focusedRowId);
                setFocusedRowId(null);
                setArea("companies");
                setPreset("overview");
                setQuery(
                  byCik[row.resolution.cik]?.name ||
                    row.resolution.name ||
                    row.input.ticker ||
                    row.resolution.ticker ||
                    "",
                );
                setEvidence({
                  company: {
                    ...byCik[row.resolution.cik],
                    ticker: row.input.ticker || row.resolution.ticker,
                  },
                  key,
                  point,
                });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
