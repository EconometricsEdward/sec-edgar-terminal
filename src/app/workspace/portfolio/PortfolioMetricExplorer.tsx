"use client";
import { ANALYSIS_VERSION } from "../../../utils/analysisVersion.js";
import { companyAvailable } from "../../../utils/portfolioModel.js";
import { useMemo, useRef, useState } from "react";
import { portfolioMetricDefinitionFor } from "../../../utils/portfolioMetricCatalog.js";
import {
  rankPortfolioMetric,
  portfolioResearchIssuers,
  metricDisplay,
  metricPeriodKey,
  metricUnit,
  portfolioAvailableMetrics,
  portfolioMetricState,
  portfolioMetricPeerOptions,
  filterPortfolioRankingRows,
} from "../../../utils/portfolioDeepResearch.js";
import { portfolioMetricSourceUrl } from "../../../utils/portfolioAnalytics.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import { downloadText } from "../../../utils/download.js";
import s from "../ResearchTools.module.css";
import p from "./PortfolioMetricExplorer.module.css";
import CompanyResearchTable from "./CompanyResearchTable";
import MetricEvidenceDialog from "./MetricEvidenceDialog";
import { SECTOR_NOT_COVERED } from "../../../utils/companyClassification.js";

const FAMILY_LABELS: Record<string, string> = {
  income: "Income statement",
  balance: "Balance sheet",
  cashflow: "Cash flow",
  ratios: "Financial ratios",
  checks: "Accounting checks",
  workingCapitalInputs: "Working capital inputs",
  drivers: "Financial drivers",
  profitability: "Profitability",
  liquidity: "Liquidity",
  leverage: "Debt & leverage",
  growth: "Growth",
  efficiency: "Efficiency",
  banking: "Banking",
  insurance: "Insurance",
  forensic: "Accounting checks",
  dupont: "DuPont analysis",
};
const familyLabel = (key: string) =>
  FAMILY_LABELS[key] || key.replace(/([A-Z])/g, " $1");
const companyLanguage = (text: string) =>
  text
    .replace(/\bissuer's\b/gi, "company’s")
    .replace(/\bissuers\b/gi, "companies")
    .replace(/\bissuer\b/gi, "company");
const periodLabel = (key: string) => {
  const [kind, start, end] = key.split("|");
  return `${kind === "ttm" ? "Trailing 12 months" : "Annual"} · ${start} to ${end}`;
};
const PAGE_SIZE = 25;

export default function PortfolioMetricExplorer({
  report,
  companies,
  onInspect,
  onDisclosure,
  onRefresh,
  refreshing = false,
}: {
  report: any;
  companies: any[];
  onInspect: (id: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDisclosure?: (query: string, ciks: string[]) => void;
}) {
  const [requestedMetricId, setMetricId] = useState("netMargin");
  const [requestedCategory, setCategory] = useState("all");
  const [measureQuery, setMeasureQuery] = useState("");
  const [requestedSector, setSector] = useState("all");
  const [requestedIndustry, setIndustry] = useState("all");
  const [requestedPeriod, setPeriod] = useState("all");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [inspector, setInspector] = useState<any>(null);
  const [filterNotice, setFilterNotice] = useState("");
  const comparisonHeading = useRef<HTMLHeadingElement>(null);
  const [requestedCompareKeys, setCompareKeys] = useState<string[] | null>(
    null,
  );
  const issuers = useMemo(
    () => portfolioResearchIssuers(report, companies),
    [report, companies],
  );
  // Metric choice is independent of peer filters and company search. A search must never change the measure being ranked.
  const availableDefinitions = useMemo(
    () => portfolioAvailableMetrics(issuers.map((i) => i.company)),
    [issuers],
  );
  const metricId = String(
    availableDefinitions.find((d) => d.key === requestedMetricId)?.key ||
      availableDefinitions.find((d) => d.key === "netMargin")?.key ||
      availableDefinitions[0]?.key ||
      "",
  );
  const category = availableDefinitions.some(
    (d) => d.category === requestedCategory,
  )
    ? requestedCategory
    : "all";
  const definitions = availableDefinitions.filter(
    (d) =>
      (category === "all" || d.category === category) &&
      `${d.label} ${d.key} ${familyLabel(d.category)}`
        .toLowerCase()
        .includes(measureQuery.trim().toLowerCase()),
  );
  const selectedDefinition = availableDefinitions.find(
    (d) => d.key === metricId,
  );
  const sectorOptions = useMemo(
    () => portfolioMetricPeerOptions(issuers, { metricId }).sectors,
    [issuers, metricId],
  );
  const sector = sectorOptions.some(
    (option) => option.value === requestedSector,
  )
    ? requestedSector
    : "all";
  const industryOptions = useMemo(
    () => portfolioMetricPeerOptions(issuers, { metricId, sector }).industries,
    [issuers, metricId, sector],
  );
  const industry = industryOptions.some(
    (option) => option.value === requestedIndustry,
  )
    ? requestedIndustry
    : "all";
  const cohort = useMemo(
    () =>
      issuers.filter(
        (i) =>
          (sector === "all" || (i.sector || SECTOR_NOT_COVERED) === sector) &&
          (industry === "all" || i.industry === industry),
      ),
    [issuers, sector, industry],
  );
  const periods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of cohort) {
      if (portfolioMetricState(i.company, selectedDefinition) !== "available")
        continue;
      const key = metricPeriodKey(i.company.metrics[metricId]);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts].sort(
      ([a], [b]) =>
        b.split("|")[2].localeCompare(a.split("|")[2]) || b.localeCompare(a),
    );
  }, [cohort, selectedDefinition, metricId]);
  const period = periods.some(([key]) => key === requestedPeriod)
    ? requestedPeriod
    : "all";
  const peerOptions = useMemo(
    () => portfolioMetricPeerOptions(issuers, { metricId, sector, period }),
    [issuers, metricId, sector, period],
  );
  const result = useMemo(
    () =>
      rankPortfolioMetric(report, companies, {
        metricId,
        sector,
        industry,
        period,
        direction,
      }),
    [report, companies, metricId, sector, industry, period, direction],
  );
  const measuredRows = result.rows.filter((row) => row.state === "available");
  const matchingRows = filterPortfolioRankingRows(measuredRows, query);
  const pageCount = Math.max(1, Math.ceil(matchingRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = matchingRows.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const chosen = issuers.filter((i) => selected.includes(i.cik));
  const comparisonDefinitions = portfolioAvailableMetrics(
    chosen.map((i) => i.company),
    { requireAll: true },
  );
  const defaultCompareKeys = [
    ...new Set([
      metricId,
      "revenueGrowth",
      "netMargin",
      "operatingCashFlow",
      "cashAfterReturns",
      "roe",
      "debtAssets",
      ...comparisonDefinitions.map((d) => d.key),
    ]),
  ]
    .filter((key) => comparisonDefinitions.some((d) => d.key === key))
    .slice(0, 6);
  const compatibleRequestedKeys = requestedCompareKeys?.filter((key) =>
    comparisonDefinitions.some((d) => d.key === key),
  );
  const comparisonReset = Boolean(
    requestedCompareKeys?.length &&
      !compatibleRequestedKeys?.length &&
      comparisonDefinitions.length,
  );
  const compareKeys = (
    requestedCompareKeys === null || comparisonReset
      ? defaultCompareKeys
      : compatibleRequestedKeys || []
  ).slice(0, 10);
  const legacyCount = issuers.filter(
    (i) =>
      companyAvailable(i.company) &&
      i.company.analysisVersion !== ANALYSIS_VERSION,
  ).length;
  const resetFilters = () => {
    setSector("all");
    setIndustry("all");
    setPeriod("all");
    setQuery("");
    setCategory("all");
    setMeasureQuery("");
    setPage(1);
    setFilterNotice("");
  };
  const chooseMetric = (key: string) => {
    const nextSectors = portfolioMetricPeerOptions(issuers, {
      metricId: key,
    }).sectors;
    const nextSector = nextSectors.some((option) => option.value === sector)
      ? sector
      : "all";
    const nextIndustries = portfolioMetricPeerOptions(issuers, {
      metricId: key,
      sector: nextSector,
    }).industries;
    const nextIndustry = nextIndustries.some(
      (option) => option.value === industry,
    )
      ? industry
      : "all";
    const definition = portfolioMetricDefinitionFor(key);
    const nextPeriod =
      period !== "all" &&
      issuers.some(
        (i) =>
          (nextSector === "all" ||
            (i.sector || SECTOR_NOT_COVERED) === nextSector) &&
          (nextIndustry === "all" || i.industry === nextIndustry) &&
          portfolioMetricState(i.company, definition, period) === "available",
      )
        ? period
        : "all";
    const reset = [
      sector !== nextSector && "sector",
      industry !== nextIndustry && "industry",
      period !== nextPeriod && "reporting period",
    ].filter(Boolean);
    setFilterNotice(
      reset.length
        ? `Reset ${reset.join(", ")}: no comparable values for the new measure in the previous selection.`
        : "",
    );
    setSector(nextSector);
    setIndustry(nextIndustry);
    setPeriod(nextPeriod);
    setMetricId(key);
    setPage(1);
  };
  const value = (n: number | null) =>
    n === null
      ? "—"
      : metricDisplay({
          value: n,
          unit: metricUnit(result.definition.format),
          classification: "calculated",
        });
  const filtered =
    sector !== "all" ||
    industry !== "all" ||
    period !== "all" ||
    query ||
    measureQuery ||
    category !== "all";
  const exportRanking = () =>
    downloadText(
      "portfolio-metric-ranking.csv",
      csvString([
        [
          "metric",
          "definition",
          "company_search",
          "sector_filter",
          "industry_filter",
          "period_filter",
          "direction",
          "peer_company_count",
          "ranked_company_count",
          "cik",
          "ticker",
          "company",
          "sector",
          "SEC_industry",
          "rank",
          "value",
          "unit",
          "report_basis",
          "report_start",
          "report_end",
          "captured_at",
          "source",
        ],
        ...matchingRows.map((row) => [
          metricId,
          result.definition.label,
          query,
          sector,
          industry,
          period,
          direction,
          result.population,
          result.available,
          row.cik,
          row.ticker,
          row.name,
          row.sector || SECTOR_NOT_COVERED,
          row.industry,
          row.rank,
          row.point.value,
          row.point.unit,
          row.point.period.kind,
          row.point.period.start,
          row.point.period.end,
          row.company?.retrievedAt,
          portfolioMetricSourceUrl(row.point),
        ]),
      ]),
      "text/csv",
    );
  const inspect = (issuer: any, key: string) =>
    setInspector({
      issuer,
      key,
      point: issuer.company?.metrics?.[key] || {
        value: null,
        classification: "unavailable",
        reason:
          "This metric is not in the saved capture. Refresh portfolio research to retrieve the full Analysis catalog.",
      },
    });
  return (
    <section
      className={`${s.root} ${p.root}`}
      aria-labelledby="portfolio-metrics-title"
    >
      <div className={s.heading}>
        <div>
          <h3 id="portfolio-metrics-title">Metrics & rankings</h3>
        </div>
        <button disabled={!matchingRows.length} onClick={exportRanking}>
          Export this ranking
        </button>
      </div>
      <p>
        Choose a financial measure, then compare companies within sectors and
        SEC industries. Accounting compatibility is checked automatically.
      </p>
      {legacyCount > 0 && onRefresh && (
        <details className={p.refreshNote}>
          <summary>
            {legacyCount} companies have an earlier capture · refresh for more
            measures
          </summary>
          <p>
            Refresh to request additional supported measures and current
            calculation corrections.
          </p>
          <button disabled={refreshing} onClick={onRefresh}>
            {refreshing
              ? "Refreshing financial measures…"
              : "Refresh financial measures"}
          </button>
        </details>
      )}
      <div className={`${s.controls} ${p.measureControls}`}>
        <label>
          Metric family
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              setMeasureQuery("");
              if (
                e.target.value !== "all" &&
                selectedDefinition?.category !== e.target.value
              ) {
                const first = availableDefinitions.find(
                  (d) => d.category === e.target.value,
                );
                if (first) chooseMetric(first.key);
              }
            }}
          >
            <option value="all">All financial measures</option>
            {[...new Set(availableDefinitions.map((d) => d.category))].map(
              (key) => (
                <option key={key} value={key}>
                  {familyLabel(key)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Find a measure
          <input
            type="search"
            value={measureQuery}
            onChange={(e) => setMeasureQuery(e.target.value)}
            placeholder="Margin, debt, cash flow…"
            maxLength={100}
          />
        </label>
        <label>
          Financial measure
          <select
            data-financial-measure
            value={metricId}
            disabled={!metricId}
            onChange={(e) => chooseMetric(e.target.value)}
          >
            {!metricId && <option value="">No measured financials</option>}
            {selectedDefinition &&
              !definitions.some((d) => d.key === metricId) && (
                <optgroup label="Current measure">
                  <option value={metricId}>{selectedDefinition.label}</option>
                </optgroup>
              )}
            {definitions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label} · {d.availableCount} portfolio companies
              </option>
            ))}
          </select>
        </label>
      </div>
      {measureQuery && (
        <p className={p.helper} role="status">
          {definitions.length} measures match your search.{" "}
          {definitions.length === 0
            ? "Try another term or clear the search."
            : "Choose one to update the ranking."}{" "}
          <button className={p.textButton} onClick={() => setMeasureQuery("")}>
            Clear measure search
          </button>
        </p>
      )}
      <div className={`${s.controls} ${p.peerControls}`}>
        <label>
          Sector
          <select
            value={sector}
            onChange={(e) => {
              setSector(e.target.value);
              setIndustry("all");
              setPeriod("all");
              setPage(1);
              setFilterNotice("");
            }}
          >
            <option value="all">All measured sectors</option>
            {peerOptions.sectors.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.count}
              </option>
            ))}
          </select>
        </label>
        <label>
          SEC industry
          <select
            value={industry}
            onChange={(e) => {
              setIndustry(e.target.value);
              setPeriod("all");
              setPage(1);
              setFilterNotice("");
            }}
          >
            <option value="all">All measured industries</option>
            {peerOptions.industries.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.count}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reporting period
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPage(1);
              setFilterNotice("");
            }}
          >
            <option value="all">All captured periods</option>
            {periods.map(([key, count]) => (
              <option key={key} value={key}>
                {periodLabel(key)} · {count}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value order
          <select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setPage(1);
            }}
          >
            <option value="desc">Highest to lowest</option>
            <option value="asc">Lowest to highest</option>
          </select>
        </label>
      </div>
      <div className={p.filterHelp}>
        <p className={p.helper}>
          Peer choices show companies with this measure. Sectors are broad
          groups; SEC industries give a closer comparison.
        </p>
        {filtered && <button onClick={resetFilters}>Reset filters</button>}
      </div>
      {filterNotice && (
        <p className={p.helper} role="status">
          {filterNotice}
        </p>
      )}
      {inspector && (
        <MetricEvidenceDialog
          inspector={inspector}
          onClose={() => setInspector(null)}
          onDisclosure={onDisclosure}
        />
      )}
      {!metricId ? (
        <div className={s.finding} role="status">
          <strong>No financial measures match this selection.</strong>
          <p>
            Reset the filters or refresh research to retrieve supported company
            financials.
          </p>
          <button onClick={resetFilters}>Reset metric filters</button>
          {onRefresh && (
            <button disabled={refreshing} onClick={onRefresh}>
              {refreshing ? "Refreshing research…" : "Refresh research"}
            </button>
          )}
        </div>
      ) : (
        <>
          <section className={p.summary} aria-label="Ranking summary">
            <div className={p.summaryHeading}>
              <strong>{result.definition.label}</strong>
              <span>
                {sector === "all" ? "All portfolio sectors" : sector}
                {industry !== "all" ? ` · ${industry}` : ""}
              </span>
            </div>
            <dl className={p.statistics}>
              <div>
                <dt>Companies ranked</dt>
                <dd>
                  {result.available}
                  <small>of {result.population} in the peer group</small>
                </dd>
              </div>
              <div>
                <dt>Peer median</dt>
                <dd>{value(result.median)}</dd>
              </div>
              <div>
                <dt>Middle 50% of values</dt>
                <dd>
                  {value(result.p25)} – {value(result.p75)}
                </dd>
              </div>
            </dl>
            <p className={p.helper}>
              {result.periodCount} reporting periods
              {result.excluded > 0
                ? ` · ${result.excluded} companies omitted without a comparable value`
                : ""}
              . Higher values do not necessarily mean better performance.
            </p>
            <details className={s.methodology}>
              <summary>About this measure & ranking</summary>
              <p>
                {companyLanguage(result.guide.meaning)}{" "}
                {companyLanguage(result.guide.caution)}
              </p>
              <p>
                {result.interpretation} Company search narrows the displayed
                results while preserving peer ranks and statistics.
              </p>
            </details>
          </section>
          <div className={p.resultToolbar}>
            <label>
              Find a company in this ranking
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                maxLength={120}
                placeholder="Ticker, company name or CIK"
              />
            </label>
            <p className={p.helper} role="status">
              {matchingRows.length} of {result.available} ranked companies shown
              {query ? " · peer ranks preserved" : ""}.
            </p>
            {query && (
              <button
                onClick={() => {
                  setQuery("");
                  setPage(1);
                }}
              >
                Clear company search
              </button>
            )}
          </div>
          <div className={p.selectionBar}>
            <span>
              {chosen.length
                ? `${chosen.length} of 6 companies selected`
                : "Select up to 6 companies to compare."}
            </span>
            {chosen.map((company) => (
              <button
                key={company.cik}
                className={p.chip}
                aria-label={`Remove ${company.ticker} from comparison`}
                onClick={() =>
                  setSelected((current) =>
                    current.filter((cik) => cik !== company.cik),
                  )
                }
              >
                {company.ticker} <span aria-hidden="true">×</span>
              </button>
            ))}
            {chosen.length > 0 && (
              <>
                <button
                  onClick={() => {
                    comparisonHeading.current?.scrollIntoView({
                      block: "start",
                    });
                    comparisonHeading.current?.focus({ preventScroll: true });
                  }}
                >
                  View comparison ↓
                </button>
                <button onClick={() => setSelected([])}>Clear selection</button>
              </>
            )}
          </div>
          <CompanyResearchTable
            className={p.rankings}
            label="Portfolio metric rankings"
            selectionColumn
            resetKey={[
              metricId,
              sector,
              industry,
              period,
              direction,
              query,
              currentPage,
            ].join(":")}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Compare</th>
                  <th scope="col">Company</th>
                  <th scope="col" className={p.rankColumn}>
                    Rank
                  </th>
                  <th scope="col">{result.definition.label}</th>
                  <th scope="col">Reporting period</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => (
                  <tr key={row.cik}>
                    <td>
                      <input
                        aria-label={`Compare ${row.ticker}`}
                        type="checkbox"
                        checked={selected.includes(row.cik)}
                        disabled={
                          !selected.includes(row.cik) && chosen.length >= 6
                        }
                        onChange={() =>
                          setSelected((v) =>
                            v.includes(row.cik)
                              ? v.filter((c) => c !== row.cik)
                              : [
                                  ...v.filter((cik) =>
                                    issuers.some((i) => i.cik === cik),
                                  ),
                                  row.cik,
                                ],
                          )
                        }
                      />
                    </td>
                    <th scope="row">
                      {row.ticker}
                      <small>{row.name}</small>
                      <small>{row.sector || SECTOR_NOT_COVERED}</small>
                    </th>
                    <td className={p.rankColumn}>{row.rank}</td>
                    <td>
                      <button onClick={() => inspect(row, metricId)}>
                        {metricDisplay(row.point)}
                      </button>
                      {row.state !== "available" && (
                        <small>{row.state.replaceAll("-", " ")}</small>
                      )}
                    </td>
                    <td>
                      <span>
                        {row.point.period.start} to {row.point.period.end}
                      </span>
                      <small>
                        {row.point.period.kind === "ttm"
                          ? "Trailing 12 months"
                          : "Annual"}
                      </small>
                    </td>
                    <td>
                      <button onClick={() => onInspect(row.rowIds[0])}>
                        Company details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CompanyResearchTable>
          {matchingRows.length === 0 && (
            <p role="status">
              No ranked companies match this search. Clear the company search to
              return to the peer group.
            </p>
          )}
          {matchingRows.length > PAGE_SIZE && (
            <nav className={p.pagination} aria-label="Ranking pages">
              <button
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous page
              </button>
              <span>
                Page {currentPage} of {pageCount} ·{" "}
                {(currentPage - 1) * PAGE_SIZE + 1}–
                {Math.min(currentPage * PAGE_SIZE, matchingRows.length)} of{" "}
                {matchingRows.length}
              </span>
              <button
                disabled={currentPage === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                Next page
              </button>
            </nav>
          )}
        </>
      )}
      {chosen.length > 0 && (
        <section className={p.comparison} aria-label="Company comparison">
          <div className={s.heading}>
            <h4 ref={comparisonHeading} tabIndex={-1}>
              Compare {chosen.length} selected companies
            </h4>
          </div>
          <p>
            Comparison measures have usable values for every selected company.
            Full reporting periods are shown with each value and may differ.
          </p>
          {!comparisonDefinitions.length ? (
            <p>
              No common financial measures for these companies. Adjust the
              selection to compare similar businesses.
            </p>
          ) : (
            <>
              <details>
                <summary>Choose comparison measures (up to 10)</summary>
                <div className={`${s.controls} ${p.compareChoices}`}>
                  {comparisonDefinitions.map((d) => (
                    <label key={d.key}>
                      <span>
                        <input
                          type="checkbox"
                          checked={compareKeys.includes(d.key)}
                          disabled={
                            !compareKeys.includes(d.key) &&
                            compareKeys.length >= 10
                          }
                          onChange={() =>
                            setCompareKeys(
                              compareKeys.includes(d.key)
                                ? compareKeys.filter((k) => k !== d.key)
                                : [...compareKeys, d.key],
                            )
                          }
                        />{" "}
                        {d.label}
                      </span>
                    </label>
                  ))}
                </div>
              </details>
              {comparisonReset && (
                <p className={p.helper} role="status">
                  Comparison measures updated to those available for every
                  selected company.
                </p>
              )}
              {!compareKeys.length ? (
                <p>
                  Choose a comparison measure above to see values side by side.
                </p>
              ) : (
                <div
                  className={s.tableWrap}
                  tabIndex={0}
                  role="region"
                  aria-label="Selected company comparison"
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Measure</th>
                        {chosen.map((i) => (
                          <th key={i.cik} scope="col">
                            {i.ticker}
                            <small>{i.sector || SECTOR_NOT_COVERED}</small>
                            <button
                              className={p.textButton}
                              onClick={() =>
                                setSelected((current) =>
                                  current.filter((cik) => cik !== i.cik),
                                )
                              }
                              aria-label={`Remove ${i.ticker} from comparison table`}
                            >
                              Remove
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {compareKeys.map((key) => (
                        <tr key={key}>
                          <th scope="row">
                            {portfolioMetricDefinitionFor(key)?.label}
                          </th>
                          {chosen.map((i) => (
                            <td key={i.cik}>
                              <button onClick={() => inspect(i, key)}>
                                {metricDisplay(i.company?.metrics?.[key])}
                              </button>
                              <small>
                                {periodLabel(
                                  metricPeriodKey(i.company.metrics[key]),
                                )}
                              </small>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
