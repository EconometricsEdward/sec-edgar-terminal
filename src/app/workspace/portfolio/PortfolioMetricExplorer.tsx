"use client";
import { useMemo, useState } from "react";
import { portfolioMetricDefinitionFor } from "../../../utils/portfolioMetricCatalog.js";
import {
  rankPortfolioMetric,
  portfolioResearchIssuers,
  metricDisplay,
  metricPeriodKey,
  metricUnit,
  portfolioAvailableMetrics,
  portfolioMetricState,
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
}: {
  report: any;
  companies: any[];
  onInspect: (id: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  onDisclosure?: (query: string, ciks: string[]) => void;
}) {
  const [requestedMetricId, setMetricId] = useState("netMargin"),
    [requestedCategory, setCategory] = useState("all"),
    [lens, setLens] = useState("all"),
    [industry, setIndustry] = useState("all"),
    [period, setPeriod] = useState("all"),
    [query, setQuery] = useState(""),
    [direction, setDirection] = useState("desc");
  const [limit, setLimit] = useState(25),
    [selected, setSelected] = useState<string[]>([]),
    [inspector, setInspector] = useState<any>(null);
  const [requestedCompareKeys, setCompareKeys] = useState<string[] | null>(
    null,
  );
  const issuers = useMemo(
    () => portfolioResearchIssuers(report, companies),
    [report, companies],
  );
  const cohort = useMemo(
    () =>
      issuers.filter(
        (i) =>
          (lens === "all" || i.lens === lens) &&
          (industry === "all" || i.industry === industry) &&
          `${i.ticker} ${i.name}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [issuers, lens, industry, query],
  );
  const availableDefinitions = useMemo(
    () =>
      portfolioAvailableMetrics(
        cohort.map((i) => i.company),
        { period },
      ),
    [cohort, period],
  );
  // Resolve stale saved selections during render, before any empty panel appears.
  const category = availableDefinitions.some(
    (d) => d.category === requestedCategory,
  )
    ? requestedCategory
    : "all";
  const definitions = availableDefinitions.filter(
    (d) => category === "all" || d.category === category,
  );
  const metricId = String(
    definitions.find((d) => d.key === requestedMetricId)?.key ||
      definitions.find((d) => d.key === "netMargin")?.key ||
      definitions[0]?.key ||
      "",
  );
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
  const measuredRows = result.rows.filter((r) => r.state === "available");
  const periods = [
    ...new Set<string>(
      cohort
        .filter(
          (i) =>
            portfolioMetricState(i.company, result.definition) === "available",
        )
        .map((i) => metricPeriodKey(i.company.metrics[metricId])),
    ),
  ]
    .sort()
    .reverse();
  const chosen = issuers.filter((i) => selected.includes(i.cik));
  const comparisonDefinitions = portfolioAvailableMetrics(
    chosen.map((i) => i.company),
    { requireAll: true },
  );
  const compareKeys = (
    requestedCompareKeys ?? [
      metricId,
      "revenueGrowth",
      "netMargin",
      "operatingCashFlow",
      "cashAfterReturns",
      "roe",
      "debtAssets",
      ...comparisonDefinitions.map((d) => d.key),
    ]
  )
    .filter(
      (key, index, keys) =>
        keys.indexOf(key) === index &&
        comparisonDefinitions.some((d) => d.key === key),
    )
    .slice(0, requestedCompareKeys ? 10 : 6);
  const legacyCount = cohort.filter(
    (i) => i.company && !i.company.analysisVersion,
  ).length;
  const resetFilters = () => {
    setLens("all");
    setIndustry("all");
    setPeriod("all");
    setQuery("");
    setCategory("all");
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
          disabled={!metricId}
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
                  "report_start",
                  "report_end",
                  "captured_at",
                  "source",
                ],
                ...measuredRows.map((r) => [
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
        Only measures with usable values in this selection are offered.
      </p>
      {legacyCount > 0 && onRefresh && (
        <div className={s.finding} role="status">
          <strong>More financial measures can be retrieved.</strong>
          <p>
            {legacyCount} companies use an older capture from before the
            expanded financial catalog.
          </p>
          <button disabled={refreshing} onClick={onRefresh}>
            {refreshing
              ? "Refreshing financial measures…"
              : "Refresh financial measures"}
          </button>
        </div>
      )}
      <div className={s.controls}>
        <label hidden={!metricId}>
          Metric family
          <select
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
              const first = availableDefinitions.find(
                (d) =>
                  e.target.value === "all" || d.category === e.target.value,
              );
              if (first) setMetricId(first.key);
              setPeriod("all");
              setLimit(25);
            }}
          >
            {[
              "all",
              ...new Set(availableDefinitions.map((d) => d.category)),
            ].map((c) => (
              <option key={c} value={c}>
                {c === "all"
                  ? "All financial measures"
                  : c.replace(/([A-Z])/g, " $1")}
              </option>
            ))}
          </select>
        </label>
        <label hidden={!metricId}>
          Financial measure
          <select
            value={metricId}
            onChange={(e) => {
              setMetricId(e.target.value);
              setLimit(25);
            }}
          >
            {definitions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label} · {d.availableCount} companies
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
              setPeriod("all");
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
              setPeriod("all");
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
            {period !== "all" && !periods.includes(period) && (
              <option value={period}>{period.replaceAll("|", " · ")}</option>
            )}
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
          <div className={s.finding}>
            <strong>
              {result.available} of {result.population} selected issuers have a
              measured {result.definition.label.toLowerCase()}.
            </strong>
            <p>
              Median {value(result.median)} · middle 50% {value(result.p25)} to{" "}
              {value(result.p75)} · {result.periodCount} reporting periods.{" "}
              {result.excluded > 0 &&
                `${result.excluded} companies are omitted because they lack a comparable value. `}
              {result.interpretation}
            </p>
            <p>
              {result.guide.meaning} {result.guide.caution}
            </p>
          </div>
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
            Comparison measures have usable values for every selected company.
            Reporting dates are shown with each value.
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
                <div className={s.controls}>
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
                    {compareKeys.map((key) => (
                      <tr key={key}>
                        <th>{portfolioMetricDefinitionFor(key)?.label}</th>
                        {chosen.map((i) => (
                          <td key={i.cik}>
                            <button onClick={() => inspect(i, key)}>
                              {metricDisplay(i.company?.metrics?.[key])}
                            </button>
                            <small>
                              {i.company?.metrics?.[key]?.period?.end ||
                                "Unknown period"}
                            </small>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </section>
  );
}
