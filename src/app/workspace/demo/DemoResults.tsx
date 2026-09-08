"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  allocationSummary,
  companyAvailable,
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
} from "../../../utils/portfolioDemo.js";
import { hubDestination } from "../../../utils/researchHubNavigation.js";
import s from "./demo.module.css";

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
  roe: "Return on equity",
  totalAssets: "Total assets",
};
const day = (value?: string | null) => value?.slice(0, 10) || "Unavailable";
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
  const [demo, setDemo] = useState<any>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [area, setArea] = useState("companies");
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
  const allocation = useMemo(
    () => allocationSummary(rows, { basis: "none", normalize: false }, byCik),
    [rows, byCik],
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
        demo ? Date.parse(demo.captured_at) : 0,
      ),
    [rows, companies, allocation, demo],
  );
  const view =
    PORTFOLIO_VIEW_PRESETS.find((item: any) => item.id === preset) ||
    PORTFOLIO_VIEW_PRESETS[0];
  const shown = useMemo(
    () =>
      rows.filter((row: any) => {
        const company = byCik[row.resolution?.cik];
        const text =
          `${row.input.ticker} ${company?.name || row.resolution?.name || ""} ${company?.sicDescription || ""}`.toLowerCase();
        return (
          text.includes(query.trim().toLowerCase()) &&
          rowMatchesPortfolioView(row, company, preset)
        );
      }),
    [rows, byCik, query, preset],
  );
  const visibleFeed = useMemo(
    () =>
      feed.filter((filing: any) =>
        `${filing.ticker} ${filing.companyName} ${filing.form}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [feed, query],
  );
  const supported = companies.filter(companyAvailable).length;
  const partial = companies.filter(
    (company: any) => company.status === "partial",
  ).length;
  const missing = rows.filter(
    (row: any) => !companyAvailable(byCik[row.resolution?.cik]),
  ).length;

  function openInHub() {
    if (!demo || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const { portfolio } = saveDemoPortfolio(localStorage, demo);
      // Re-enter the workspace with its saved portfolio route initialized.
      window.location.assign(
        hubDestination("portfolios", { portfolioId: portfolio.id }),
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
          <p className={s.eyebrow}>What you get back</p>
          <h2 id="demo-results-heading">Real research. Ready to explore.</h2>
          <p>
            This is a captured run through the same SEC research workflow used
            for your own uploads.
          </p>
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
          <p className={s.notice}>
            Example company list, not a suggested portfolio. Values are
            historical SEC evidence captured on {day(demo.captured_at)}.
            Reporting periods vary by company; a new research run may return
            different results.
          </p>
          <div className={s.stats} aria-label="Captured example coverage">
            <div>
              <strong>{rows.length}</strong>
              <span>Tickers in the template</span>
              <small>Same list in CSV and Excel</small>
            </div>
            <div>
              <strong>
                {supported} / {rows.length}
              </strong>
              <span>Companies with financial evidence</span>
              <small>
                {partial} with partial coverage · {missing} without supported
                measures
              </small>
            </div>
            <div>
              <strong>{feed.length.toLocaleString("en-US")}</strong>
              <span>Captured filing references</span>
              <small>Up to 30 recent filings per issuer</small>
            </div>
          </div>
          <div className={s.exploreBar}>
            <div>
              <h3>Try the full result, with no upload or wait.</h3>
              <p>
                Open a separate copy in your browser to use company focus, saved
                views, coverage, the filing feed, briefs, and exports. Refresh
                research there when you want a new capture.
              </p>
            </div>
            <button className={s.primary} onClick={openInHub} disabled={saving}>
              {saving
                ? "Opening the example…"
                : "Open full demo in Research Hub →"}
            </button>
          </div>
          {saveError && (
            <p role="alert" className={s.notice}>
              {saveError}
            </p>
          )}
          <nav className={s.tabs} aria-label="Example result sections">
            <button
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
              Filing evidence
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
          </nav>
          {area !== "followups" && (
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
                  : `${visibleFeed.length} filing references`}{" "}
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
                      <th scope="col">Coverage & annual period</th>
                      {view.columns.map((key: string) => (
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
                          {view.columns.map((key: string) => {
                            const point = company?.metrics?.[key];
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
                        evidenceTrigger.current?.focus();
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
          {area === "filings" && (
            <>
              <p className={s.tableHelp}>
                Recent filings captured for these companies, newest first.
                Filing dates and financial reporting periods describe different
                things.
              </p>
              <div className={s.filingList}>
                {visibleFeed.slice(0, limit).map((filing: any) => (
                  <article key={`${filing.cik}:${filing.accession}`}>
                    <span className={s.badge}>{filing.form}</span>
                    <div>
                      <h3>{filing.ticker || filing.companyName}</h3>
                      <p>{filing.companyName}</p>
                      <small>
                        Filed {day(filing.filingDate)} · Report period{" "}
                        {day(filing.reportDate)}
                      </small>
                    </div>
                    <a
                      href={filing.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read SEC filing ↗
                    </a>
                  </article>
                ))}
              </div>
              {visibleFeed.length === 0 && (
                <p className={s.notice}>No filings match your search.</p>
              )}
              {visibleFeed.length > limit && (
                <button
                  className={s.secondary}
                  onClick={() => setLimit((value) => value + 20)}
                >
                  Show next {Math.min(20, visibleFeed.length - limit)} filings
                </button>
              )}
            </>
          )}
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
                  No portfolio weights or performance estimates are produced
                  from a ticker-only list. Add allocations in your own copy if
                  you want allocation coverage.
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
        </>
      )}
    </section>
  );
}
