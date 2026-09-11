"use client";
import { useMemo, useState } from "react";
import {
  PORTFOLIO_METRIC_CATALOG,
  portfolioMetricDefinitionFor,
} from "../../../utils/portfolioMetricCatalog.js";
import {
  rankPortfolioMetric,
  portfolioResearchIssuers,
  metricDisplay,
  metricPeriodKey,
  metricUnit,
  portfolioMetricObservation,
  portfolioMetricCoverage,
  portfolioCaptureCoverage,
  filterPortfolioMetricIssuers,
  PORTFOLIO_COVERAGE_REASONS,
} from "../../../utils/portfolioDeepResearch.js";
import { analysisMetricGuide } from "../../../utils/analysisMetricGuide.js";
import { portfolioMetricSourceUrl } from "../../../utils/portfolioAnalytics.js";
import { csvString } from "../../../utils/portfolioFiles.js";
import { downloadText } from "../../../utils/download.js";
import s from "../ResearchTools.module.css";

export default function PortfolioMetricExplorer({
  report,
  companies,
  onInspect,
  onDisclosure,
  onRefresh,
  refreshing = false,
  preview = false,
}: {
  report: any;
  companies: any[];
  onInspect: (id: string) => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  preview?: boolean;
}) {
  const [requestedMetricId, setMetricId] = useState("netMargin"),
    [category, setCategory] = useState("all"),
    [lens, setLens] = useState("all"),
    [industry, setIndustry] = useState("all"),
    [period, setPeriod] = useState("all"),
    [query, setQuery] = useState(""),
    [direction, setDirection] = useState("desc");
  const [limit, setLimit] = useState(25),
    [selected, setSelected] = useState<string[]>([]),
    [inspector, setInspector] = useState<any>(null);
  const [compareKeys, setCompareKeys] = useState([
    "revenueGrowth",
    "netMargin",
    "operatingCashFlow",
    "cashAfterReturns",
    "roe",
    "debtAssets",
  ]);
  const issuers = useMemo(
    () => portfolioResearchIssuers(report, companies),
    [report, companies],
  );
  const scopedIssuers = useMemo(
    () => filterPortfolioMetricIssuers(issuers, { lens, industry, query }),
    [issuers, lens, industry, query],
  );
  // Do not prune the measure menu by the period filter: changing measures resets it.
  const coverage = useMemo(
    () => portfolioMetricCoverage(scopedIssuers),
    [scopedIssuers],
  );
  const captureCoverage = useMemo(
    () => portfolioCaptureCoverage(issuers),
    [issuers],
  );
  const familyCoverage = coverage.filter(
    (d) => category === "all" || d.category === category,
  );
  const definitions = familyCoverage.filter((d) => d.available > 0);
  const metricId =
    definitions.find((d) => d.key === requestedMetricId)?.key ||
    definitions.find((d) => d.key === "netMargin")?.key ||
    definitions[0]?.key ||
    familyCoverage[0]?.key ||
    requestedMetricId;
  const result = useMemo(
    () =>
      rankPortfolioMetric(report, companies, {
        metricId,
        lens,
        industry,
        period,
        query,
        direction,
      }),
    [report, companies, metricId, lens, industry, period, query, direction],
  );
  const periods = [
    ...new Set<string>(
      issuers
        .map((i) => metricPeriodKey(i.company?.metrics?.[metricId]))
        .filter(Boolean),
    ),
  ]
    .sort()
    .reverse();
  const chosen = issuers.filter((i) => selected.includes(i.cik));
  const comparisonCoverage = portfolioMetricCoverage(chosen).filter(
    (d) => d.available > 0,
  );
  const visibleCompareKeys = compareKeys.filter((key) =>
    comparisonCoverage.some((d) => d.key === key),
  );
  const measuredRows = result.rows.filter((row) => row.state === "available");
  const excludedRows = result.rows.filter((row) => row.state !== "available");
  const missingDefinitions = familyCoverage.filter((d) => !d.available);
  const refreshLabel = refreshing
    ? "Refreshing research…"
    : preview
      ? "Open demo in Research Hub"
      : "Refresh financial research";
  const clearFilters = () => {
    setCategory("all");
    setLens("all");
    setIndustry("all");
    setQuery("");
    setPeriod("all");
    setLimit(25);
  };
  const guide = inspector
    ? analysisMetricGuide(
        portfolioMetricDefinitionFor(inspector.key),
        inspector.point,
        inspector.issuer.lens,
      )
    : null;
  const value = (n: number | null) =>
    n === null
      ? "Unavailable"
      : metricDisplay({
          value: n,
          unit: metricUnit(result.definition.format),
          classification: "calculated",
        });
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
    <section className={s.root} aria-labelledby="portfolio-metrics-title">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>
            The Analysis catalog, applied to your companies
          </p>
          <h3 id="portfolio-metrics-title">
            Explore, rank and compare financial measures
          </h3>
        </div>
        <button
          onClick={() =>
            downloadText(
              "portfolio-metric-ranking.csv",
              csvString([
                [
                  "metric",
                  "definition",
                  "query",
                  "lens",
                  "industry",
                  "period_filter",
                  "direction",
                  "eligible_count",
                  "cik",
                  "ticker",
                  "rank",
                  "value",
                  "unit",
                  "status",
                  "coverage_reason",
                  "report_start",
                  "report_end",
                  "captured_at",
                  "source",
                ],
                ...result.rows.map((r) => [
                  metricId,
                  result.definition.label,
                  query,
                  lens,
                  industry,
                  period,
                  direction,
                  result.available,
                  r.cik,
                  r.ticker,
                  r.rank,
                  r.state === "available" ? r.point.value : null,
                  r.point?.unit,
                  r.state,
                  r.reason,
                  r.point?.period?.start,
                  r.point?.period?.end,
                  r.company?.retrievedAt,
                  portfolioMetricSourceUrl(r.point),
                ]),
              ]),
              "text/csv",
            )
          }
        >
          Export this ranking
        </button>
      </div>
      <p>
        Statements, cash flows, ratios and accounting checks share the same
        financial engine as Analysis. Select a measure to understand it, then
        compare companies with similar business models and reporting periods.
        Only measures with usable observations appear in the menu. Coverage
        remains visible, and missing values are never replaced by zero.
      </p>
      {captureCoverage.legacy + captureCoverage.outdated > 0 && (
        <div className={s.finding} role="status">
          <strong>Update your saved financial capture</strong>
          <p>
            {captureCoverage.legacy + captureCoverage.outdated} of{" "}
            {captureCoverage.population} issuers use an earlier financial
            calculation version. Fields absent from those captures are not
            evidence that the companies failed to report them. Refresh to
            retrieve the expanded catalog and current metric definitions; your
            company list and allocations stay in place.
          </p>
          {onRefresh && (
            <div>
              <button onClick={onRefresh} disabled={refreshing}>
                {refreshLabel}
              </button>
            </div>
          )}
        </div>
      )}
      <div className={s.controls}>
        <label>
          Metric family
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              const first = coverage.find(
                (d) =>
                  d.available > 0 &&
                  (e.target.value === "all" || d.category === e.target.value),
              );
              if (first) setMetricId(first.key);
              setPeriod("all");
              setLimit(25);
            }}
          >
            {[
              "all",
              ...new Set(PORTFOLIO_METRIC_CATALOG.map((d) => d.category)),
            ].map((c) => (
              <option key={c} value={c}>
                {c === "all"
                  ? "All financial measures"
                  : c.replace(/([A-Z])/g, " $1")}
              </option>
            ))}
          </select>
        </label>
        <label className={s.metricControl}>
          Financial measure · measured issuers
          <select
            disabled={!definitions.length}
            value={definitions.length ? metricId : ""}
            onChange={(e) => {
              setMetricId(e.target.value);
              setPeriod("all");
              setLimit(25);
            }}
          >
            {!definitions.length && (
              <option value="">No measured values in this scope</option>
            )}
            {definitions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label} · {d.available}/{d.population}
              </option>
            ))}
          </select>
        </label>
        <label>
          Business model
          <select
            value={lens}
            onChange={(e) => {
              setLens(e.target.value);
              setLimit(25);
            }}
          >
            {["all", ...new Set<string>(issuers.map((i) => i.lens))].map(
              (l) => (
                <option key={l} value={l}>
                  {l === "all" ? "All business models" : l}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          SEC industry
          <select
            value={industry}
            onChange={(e) => {
              setIndustry(e.target.value);
              setLimit(25);
            }}
          >
            <option value="all">All industries</option>
            {[...new Set<string>(issuers.map((i) => i.industry))]
              .sort()
              .map((i) => (
                <option key={i}>{i}</option>
              ))}
          </select>
        </label>
        <label>
          Reporting period
          <select
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setLimit(25);
            }}
          >
            <option value="all">All captured periods</option>
            {periods.map((p) => (
              <option key={p} value={p}>
                {p.replaceAll("|", " · ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          Value order
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            <option value="desc">Highest to lowest</option>
            <option value="asc">Lowest to highest</option>
          </select>
        </label>
        <label>
          Find a company
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(25);
            }}
            maxLength={120}
            placeholder="Ticker or company name"
          />
        </label>
      </div>
      {result.available > 0 ? (
        <div className={s.finding} aria-live="polite">
          <strong>
            {result.available} of {result.population} selected issuers have a
            measured {result.definition.label.toLowerCase()}.
          </strong>
          <p>
            Median {value(result.median)} · middle 50% {value(result.p25)} to{" "}
            {value(result.p75)} · {result.periodCount} reporting periods.{" "}
            {result.excluded} excluded from ranks. {result.interpretation}
          </p>
          <p>
            {result.guide.meaning} {result.guide.caution}
          </p>
        </div>
      ) : (
        <div className={s.finding} role="status">
          <strong>No comparable observations in this selection</strong>
          <p>
            {scopedIssuers.length === 0
              ? "No companies match the current filters. Clear them to return to your portfolio."
              : period !== "all"
                ? "No measured values match this full reporting period. Choose all captured periods or adjust the company filters."
                : "No measures in this family have the complete inputs, units and reporting periods needed for a comparison. Try another family or review coverage below."}
          </p>
          <div className={s.actions}>
            <button onClick={clearFilters}>Clear filters</button>
            {onRefresh && (
              <button onClick={onRefresh} disabled={refreshing}>
                {refreshLabel}
              </button>
            )}
          </div>
        </div>
      )}
      <details className={s.details}>
        <summary>
          Coverage: {result.excluded} excluded issuers ·{" "}
          {missingDefinitions.length} measures without results in this family
        </summary>
        <p>
          The measured denominator always includes only compatible observations.
          These exclusions remain in ranking exports.
        </p>
        {Object.entries(result.reasons).length > 0 && (
          <ul>
            {Object.entries(result.reasons).map(([code, count]) => (
              <li key={code}>
                {
                  PORTFOLIO_COVERAGE_REASONS[
                    code as keyof typeof PORTFOLIO_COVERAGE_REASONS
                  ]
                }
                : {String(count)}
              </li>
            ))}
          </ul>
        )}
        {excludedRows.length > 0 && (
          <details>
            <summary>
              Review excluded companies for {result.definition.label}
            </summary>
            <ul className={s.coverageList}>
              {excludedRows.map((row) => (
                <li key={row.cik}>
                  <button onClick={() => onInspect(row.rowIds[0])}>
                    {row.ticker}
                  </button>{" "}
                  {row.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        {missingDefinitions.length > 0 && (
          <details>
            <summary>Review measures omitted from the menu</summary>
            <ul className={s.coverageList}>
              {missingDefinitions.map((d) => (
                <li key={d.key}>
                  <strong>{d.label}</strong> —{" "}
                  {Object.entries(d.reasons)
                    .map(
                      ([code, count]) =>
                        `${count} ${PORTFOLIO_COVERAGE_REASONS[code as keyof typeof PORTFOLIO_COVERAGE_REASONS].toLowerCase()}`,
                    )
                    .join("; ") || "No companies match the current filters"}
                  .
                </li>
              ))}
            </ul>
          </details>
        )}
        {onRefresh && (
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshLabel}
          </button>
        )}
        <p>
          Refreshing retrieves supported SEC facts through the shared cache and
          request queue. It cannot fill facts a company does not report
          separately or make an inapplicable ratio meaningful.
        </p>
      </details>
      {inspector && (
        <section
          className={s.finding}
          aria-label="Metric explanation and SEC evidence"
        >
          <div className={s.heading}>
            <strong>
              {inspector.issuer.ticker} ·{" "}
              {portfolioMetricDefinitionFor(inspector.key)?.label} ·{" "}
              {metricDisplay(inspector.point)}
            </strong>
            <button onClick={() => setInspector(null)}>
              Close explanation
            </button>
          </div>
          <p>{guide?.meaning}</p>
          <p>
            {guide?.movement} {guide?.caution}
          </p>
          {guide?.scopeNotes.map((note: string) => (
            <p key={note}>{note}</p>
          ))}
          <p>
            {inspector.point.formula ||
              inspector.point.definitionFormula ||
              inspector.point.reason ||
              "Reported value; review the source concept below."}
          </p>
          <small>
            {inspector.point.period?.start || "Instant / unknown start"} to{" "}
            {inspector.point.period?.end || "Unknown end"} ·{" "}
            {inspector.point.period?.kind || "Unknown basis"} · captured{" "}
            {inspector.issuer.company?.retrievedAt || "unknown"}
          </small>
          <ul>
            {(inspector.point.sources || []).map(
              (source: any, index: number) => {
                const url = portfolioMetricSourceUrl({ sources: [source] });
                return url ? (
                  <li key={index}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {source.tag || source.label || "SEC evidence"} ·{" "}
                      {source.form} · {source.filed} ↗
                    </a>
                  </li>
                ) : null;
              },
            )}
          </ul>
          {onDisclosure && (
            <button
              onClick={() =>
                onDisclosure(guide?.query || "liquidity", [
                  inspector.issuer.cik,
                ])
              }
            >
              Search this company’s related disclosures
            </button>
          )}
        </section>
      )}
      {measuredRows.length > 0 && (
        <>
          <p>
            Select up to six issuers for a comparison below. Selection stays
            fixed while you filter or rank.
          </p>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Portfolio metric rankings"
          >
            <table>
              <thead>
                <tr>
                  <th>Compare</th>
                  <th>Rank</th>
                  <th>Company</th>
                  <th>{result.definition.label}</th>
                  <th>Full reporting period</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {measuredRows.slice(0, limit).map((row) => (
                  <tr key={row.cik}>
                    <td>
                      <input
                        aria-label={`Compare ${row.ticker}`}
                        type="checkbox"
                        checked={selected.includes(row.cik)}
                        disabled={
                          !selected.includes(row.cik) && selected.length >= 6
                        }
                        onChange={() =>
                          setSelected((v) =>
                            v.includes(row.cik)
                              ? v.filter((c) => c !== row.cik)
                              : [...v, row.cik],
                          )
                        }
                      />
                    </td>
                    <td>{row.rank ?? "—"}</td>
                    <th>
                      {row.ticker}
                      <small>
                        {row.name} · {row.lens}
                      </small>
                    </th>
                    <td>
                      <button onClick={() => inspect(row, metricId)}>
                        {metricDisplay(row.point)}
                      </button>
                      {row.state !== "available" && (
                        <small>{row.state.replaceAll("-", " ")}</small>
                      )}
                    </td>
                    <td>
                      {row.point?.period?.start || "Instant / unknown"} to{" "}
                      {row.point?.period?.end || "unknown"}
                      <small>{row.point?.period?.kind}</small>
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
          </div>
          {measuredRows.length > limit && (
            <button onClick={() => setLimit((n) => n + 25)}>
              Show 25 more companies
            </button>
          )}
        </>
      )}
      {chosen.length > 0 && (
        <section>
          <div className={s.heading}>
            <h4>Compare {chosen.length} selected issuers</h4>
            <button onClick={() => setSelected([])}>Clear selection</button>
          </div>
          <p>
            Measures with no usable values among these companies are omitted.
            Each remaining cell retains its own reporting period; “Not measured”
            is excluded, not zero.
          </p>
          {visibleCompareKeys.length === 0 && (
            <p>Choose an available comparison measure below.</p>
          )}
          <details open={visibleCompareKeys.length === 0}>
            <summary>Choose comparison measures (up to 10)</summary>
            <div className={s.controls}>
              {comparisonCoverage.map((d) => (
                <label key={d.key}>
                  <span>
                    <input
                      type="checkbox"
                      checked={visibleCompareKeys.includes(d.key)}
                      disabled={
                        !visibleCompareKeys.includes(d.key) &&
                        visibleCompareKeys.length >= 10
                      }
                      onChange={() =>
                        setCompareKeys((v) =>
                          v.includes(d.key)
                            ? v.filter((k) => k !== d.key)
                            : [
                                ...v.filter((k) =>
                                  comparisonCoverage.some((c) => c.key === k),
                                ),
                                d.key,
                              ],
                        )
                      }
                    />{" "}
                    {d.label} · {d.available}/{d.population}
                  </span>
                </label>
              ))}
            </div>
          </details>
          <div
            className={s.tableWrap}
            tabIndex={0}
            role="region"
            aria-label="Selected company comparison"
          >
            <table>
              <thead>
                <tr>
                  <th>Measure</th>
                  {chosen.map((i) => (
                    <th key={i.cik}>
                      {i.ticker}
                      <small>
                        {i.lens} · {i.company?.period?.end}
                      </small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleCompareKeys.map((key) => (
                  <tr key={key}>
                    <th>{portfolioMetricDefinitionFor(key)?.label}</th>
                    {chosen.map((i) => {
                      const observation = portfolioMetricObservation(
                        i,
                        portfolioMetricDefinitionFor(key),
                      );
                      return (
                        <td key={i.cik}>
                          {observation.state === "available" ? (
                            <>
                              <button onClick={() => inspect(i, key)}>
                                {metricDisplay(observation.point)}
                              </button>
                              <small>
                                {observation.point.period.start} to{" "}
                                {observation.point.period.end} ·{" "}
                                {observation.point.period.kind}
                              </small>
                            </>
                          ) : (
                            <span title={observation.reason || ""}>
                              {observation.state === "not-applicable"
                                ? "Not applicable"
                                : "Not measured"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
