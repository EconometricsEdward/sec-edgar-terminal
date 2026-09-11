"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  allocationSummary,
  companyAvailable,
  finiteFinancialMetric,
} from "../../../utils/portfolioModel.js";
import { portfolioFilingFeed } from "../../../utils/portfolioClient.js";
import { portfolioReviewPriorities } from "../../../utils/portfolioInsights.js";
import {
  PORTFOLIO_VIEW_PRESETS,
  rowMatchesPortfolioView,
} from "../../../utils/portfolioViews.js";
import {
  validatePortfolioDemo,
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

const METRICS: Record<string, string> = {
  revenue: "Revenue",
  netIncome: "Net income",
  operatingCashFlow: "Operating cash flow",
  freeCashFlow: "Free cash flow",
  capex: "Capital expenditures",
  cash: "Cash",
  debt: "Reported debt",
  netInterestIncome: "Net interest income",
  deposits: "Deposits",
  loans: "Net loans",
  loanDeposits: "Loans / deposits",
  operatingMargin: "Operating margin",
  netMargin: "Net margin",
  debtAssets: "Reported debt / assets",
  currentRatio: "Current ratio",
  roa: "Return on assets",
  revenueGrowth: "Revenue growth",
  roe: "Return on equity",
  totalAssets: "Total assets",
};
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
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [area, setArea] = useState("analytics");
  const [allocationBasis, setAllocationBasis] = useState("example");
  const [analyticsArea, setAnalyticsArea] = useState("concentration");
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
        if (!controller.signal.aborted) setDemo(next);
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

  const companies = useMemo(() => demo?.snapshot.companies || [], [demo]);
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
  const weightGroups = useMemo(() => {
    const groups = new Map<number, number>();
    if (weighted)
      allocation.allocations.forEach((row: any) =>
        groups.set(row.weightPct, (groups.get(row.weightPct) || 0) + 1),
      );
    return [...groups]
      .sort(([a], [b]) => b - a)
      .map(([weight, count]) => ({ weight, count, total: weight * count }));
  }, [allocation, weighted]);
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
        demo ? Date.parse(demo.captured_at) : 0,
      ),
    [rows, companies, allocation, demo],
  );
  const view =
    PORTFOLIO_VIEW_PRESETS.find((item: any) => item.id === preset) ||
    PORTFOLIO_VIEW_PRESETS[0];
  const shown = useMemo(
    () =>
      rows
        .filter((row: any) => {
          const company = byCik[row.resolution?.cik];
          const text =
            `${row.input.ticker} ${company?.name || row.resolution?.name || ""} ${company?.sicDescription || ""}`.toLowerCase();
          return (
            text.includes(query.trim().toLowerCase()) &&
            rowMatchesPortfolioView(row, company, preset)
          );
        })
        .sort(
          (a: any, b: any) =>
            (weighted
              ? Number(weights.get(b.id)) - Number(weights.get(a.id))
              : 0) || a.input.ticker.localeCompare(b.input.ticker),
        ),
    [rows, byCik, query, preset, weights, weighted],
  );

  const shownColumns = view.columns.filter((key: string) =>
    shown.some((row: any) =>
      finiteFinancialMetric(byCik[row.resolution?.cik]?.metrics?.[key]),
    ),
  );
  const supported = companies.filter(companyAvailable).length;
  const missing = rows.filter(
    (row: any) => !companyAvailable(byCik[row.resolution?.cik]),
  ).length;

  function downloadReport() {
    if (!demo) return;
    const bundle = buildPortfolioResearchPackage(
      createDemoPortfolio(demo, { allocationBasis }),
      { includeAllocations: true },
    );
    downloadText(
      `edgar-demo-${settings.basis}-research.html`,
      portfolioReportHtml(bundle, sourceEvidence),
      "text/html;charset=utf-8",
    );
  }
  function openInHub() {
    if (!demo || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const { portfolio } = saveDemoPortfolio(localStorage, demo, {
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
      <div className={s.sectionHeading}>
        <div>
          <h2 id="demo-results-heading">Explore the portfolio</h2>
        </div>
        <span className={s.badge}>
          {demo
            ? `Captured ${day(demo.captured_at)} · UTC`
            : "Captured example"}
        </span>
      </div>
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
          <div className={s.basisControl}>
            <div
              role="group"
              aria-label="Demo allocation basis"
              className={s.basisButtons}
            >
              {[
                ["example", "Hypothetical weights"],
                ["equal", "Equal weights"],
                ["none", "Company counts"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={allocationBasis === value}
                  onClick={() => setAllocationBasis(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <p aria-live="polite">
              {settings.basis === "weights"
                ? "Unequal example weights total 100%."
                : settings.basis === "equal"
                  ? "A hypothetical 1% allocation to each of the 100 companies."
                  : "Company counts only; no allocation is applied."}{" "}
              {weighted
                ? "Weights change concentration, exposure coverage and scenarios; financial ratios still describe individual companies."
                : "The same SEC financial evidence remains available for comparison."}
            </p>
          </div>
          <div
            className={s.stats}
            aria-label="Demo allocation and evidence coverage"
          >
            <div>
              <strong>{rows.length}</strong>
              <span>Companies in the demo</span>
              <small>
                {weighted
                  ? `${pct(allocation.allocatedWeight)} allocated · hypothetical holdings`
                  : "Research universe · company counts"}
              </small>
            </div>
            <div>
              <strong>
                {weighted
                  ? pct(allocation.topFiveIssuerWeightPct)
                  : feed.length.toLocaleString("en-US")}
              </strong>
              <span>
                {weighted
                  ? "Allocation in the five largest companies"
                  : "Captured filing references"}
              </span>
              <small>
                {weighted
                  ? `${allocation.topHoldings.map((holding: any) => holding.ticker).join(" · ")}`
                  : "Up to 30 recent filings per issuer"}
              </small>
            </div>
            <div>
              <strong>
                {pct(
                  weighted
                    ? allocation.coverage.percentOfSuppliedWeight
                    : allocation.coverage.companyPct,
                )}
              </strong>
              <span>
                {weighted
                  ? "Allocation with financial evidence"
                  : "Companies with financial evidence"}
              </span>
              <small>
                {supported} of {rows.length} companies · {missing} without
                supported measures. At least one usable metric; coverage varies
                by measure.
              </small>
            </div>
          </div>
          {weighted && (
            <details className={s.weightMethod}>
              <summary>How the hypothetical weights work</summary>
              <p>
                {settings.basis === "equal"
                  ? "Each company receives 1%. This comparison changes the allocation only; it does not change the SEC evidence or overwrite the downloaded example weights."
                  : demo.allocation_example.methodology}
              </p>
              <div className={s.weightStrip} aria-hidden="true">
                {weightGroups.map((group) => (
                  <span key={group.weight} style={{ flexGrow: group.total }} />
                ))}
              </div>
              <ul className={s.weightLegend}>
                {weightGroups.map((group) => (
                  <li key={group.weight}>
                    <span>
                      {group.count} companies × {pct(group.weight)}
                    </span>
                    <strong>{pct(group.total)} total</strong>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className={s.exploreBar}>
            <div>
              <h3>Make a copy and explore your own assumptions.</h3>
              <p>
                Your selected allocation basis carries into the full Hub and
                report. Edit the weights or refresh the financial evidence in
                your saved copy.
              </p>
            </div>
            <div className={s.copyActions}>
              <button
                className={s.primary}
                onClick={openInHub}
                disabled={saving}
              >
                {saving
                  ? "Opening the example…"
                  : "Open full demo in Research Hub →"}
              </button>
              <button className={s.secondary} onClick={downloadReport}>
                Download example report
              </button>
            </div>
          </div>
          <p className={s.captureNote}>
            Hypothetical allocations are educational inputs, not actual holdings
            or investment recommendations. Financial values are public SEC
            evidence captured on {day(demo.captured_at)}; company reporting
            periods differ. {feed.length.toLocaleString("en-US")} filing
            references are included. Refreshing can change financial values and
            coverage.
          </p>
          {saveError && (
            <p role="alert" className={s.notice}>
              {saveError}
            </p>
          )}
          <nav className={s.tabs} aria-label="Example result sections">
            <button
              aria-pressed={area === "analytics"}
              onClick={() => {
                setArea("analytics");
                setEvidence(null);
              }}
            >
              Portfolio analytics
            </button>
            <button
              ref={companyTabRef}
              aria-pressed={area === "companies"}
              onClick={() => {
                setArea("companies");
                setLimit(20);
                setEvidence(null);
              }}
            >
              Company results
            </button>
            <button
              aria-pressed={area === "filings"}
              onClick={() => {
                setArea("filings");
                setLimit(20);
                setEvidence(null);
              }}
            >
              Filing library
            </button>
            <button
              aria-pressed={area === "followups"}
              onClick={() => {
                setArea("followups");
                setEvidence(null);
              }}
            >
              Example follow-ups
            </button>
            {["disclosures", "ownership"].map((tab) => (
              <button
                key={tab}
                aria-pressed={area === tab}
                onClick={() => setArea(tab)}
              >
                {tab === "disclosures" ? "Disclosure search" : "Fund ownership"}
              </button>
            ))}
          </nav>
          <div hidden={area !== "analytics"}>
            <PortfolioAnalytics
              rows={rows}
              settings={settings}
              analyticsArea={analyticsArea}
              onAreaChange={setAnalyticsArea}
              companies={companies}
              capturedAt={demo.captured_at}
              onDisclosure={openDisclosures}
              onInspectCompany={setFocusedRowId}
              onReviewRows={openInHub}
              onRefresh={openInHub}
              refreshing={saving}
              preview
            />
          </div>
          {area === "companies" && (
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
              {area === "companies" && (
                <label>
                  Research view
                  <select
                    value={preset}
                    onChange={(event) => {
                      setPreset(event.target.value);
                      setLimit(20);
                      setEvidence(null);
                    }}
                  >
                    {PORTFOLIO_VIEW_PRESETS.map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
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
          {area === "companies" && (
            <>
              <p className={s.tableHelp}>
                {view.description} Click a financial measure to see its
                reporting period, calculation, and SEC sources. Missing values
                are never treated as zero.
              </p>
              <div
                className={s.tableScroll}
                role="region"
                aria-label="100-company example results table"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      {weighted && <th scope="col">Hypothetical weight</th>}
                      <th scope="col">Coverage & annual period</th>
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
                              {company?.sicDescription ||
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
                            <small>Ending {day(company?.period?.end)}</small>
                          </td>
                          {shownColumns.map((key: string) => {
                            const point = company?.metrics?.[key];
                            if (!finiteFinancialMetric(point))
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
              </div>
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
                        else companyTabRef.current?.focus();
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
                      Open the full demo to review coverage details and issuer
                      filings.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
          <PortfolioResearchDesk
            rows={rows}
            companies={companies}
            activeTab={area}
            request={disclosureRequest}
            onEvidence={captureSources}
          />
          {area === "followups" && (
            <>
              <div className={s.explanation}>
                <h3>The next questions are part of the result.</h3>
                <p>
                  These checks were generated from the captured evidence on{" "}
                  {day(demo.captured_at)}. They point to missing coverage,
                  reporting freshness, recent filings, or negative reported
                  measures. They are research prompts, not investment ratings.
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
                  ? `Showing ${Math.min(6, priorities.length)} of ${priorities.length} captured review prompts. Open the full demo to inspect the portfolio and use the Review inbox.`
                  : "No review prompts were raised by these checks at capture time. This does not establish completeness or investment quality."}{" "}
                “What changed” starts with this capture and becomes useful after
                a subsequent research refresh.
              </p>
            </>
          )}
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
