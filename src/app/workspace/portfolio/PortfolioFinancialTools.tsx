"use client";

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, Download, X } from "lucide-react";
import {
  buildFinancialComparison,
  buildMetricRelationship,
  buildPeerBenchmarks,
  financialToolIssuers,
  peerBenchmarksCsv,
} from "../../../utils/portfolioFinancialTools.js";
import { downloadText } from "../../../utils/download.js";
import s from "./PortfolioFinancialTools.module.css";

type View = "peers" | "relationships" | "compare";
type Props = {
  report: any;
  onInspectCompany: (rowId: string) => void;
  view?: View;
};
const VIEWS: { id: View; label: string }[] = [
  { id: "peers", label: "Peer benchmarks" },
  { id: "relationships", label: "Metric relationships" },
  { id: "compare", label: "Compare companies" },
];
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const num = (value: unknown, signed = false) =>
  finite(value)
    ? value.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        signDisplay: signed ? "exceptZero" : "auto",
      })
    : "Unavailable";
const valueLabel = (value: unknown, unit: string) =>
  finite(value) ? `${num(value)}${unit}` : "Unavailable or not applicable";
const dateLabel = (value: string | null) => value || "Date unavailable";

function EvidenceLink({ point }: { point: any }) {
  return point?.sourceUrl ? (
    <a
      href={point.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={s.source}
    >
      SEC source <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  ) : (
    <small>Source unavailable</small>
  );
}

function CompanyButton({
  point,
  onInspectCompany,
}: {
  point: any;
  onInspectCompany: Props["onInspectCompany"];
}) {
  return (
    <button
      type="button"
      className={s.companyButton}
      onClick={() => onInspectCompany(point.rowId)}
    >
      <strong>{point.ticker || point.name}</strong>
      <span>{point.name}</span>
    </button>
  );
}

function extent(points: any[], key: "x" | "y") {
  const values = points.map((point) => point[key]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding =
    min === max ? Math.max(1, Math.abs(min) * 0.1) : (max - min) * 0.08;
  return [min - padding, max + padding];
}

function RelationshipChart({
  relationship,
  selectedCik,
  onSelect,
}: {
  relationship: any;
  selectedCik: string;
  onSelect: (cik: string) => void;
}) {
  const id = useId();
  if (!relationship.points.length)
    return (
      <div className={s.empty}>
        No companies have both measures within these filters. Try another metric
        pair or include differing reporting ends.
      </div>
    );
  const width = 780,
    height = 420;
  const left = 84,
    right = width - 30,
    top = 28,
    bottom = height - 76;
  const [minX, maxX] = extent(relationship.points, "x");
  const [minY, maxY] = extent(relationship.points, "y");
  const px = (value: number) =>
    left + ((value - minX) / (maxX - minX)) * (right - left);
  const py = (value: number) =>
    bottom - ((value - minY) / (maxY - minY)) * (bottom - top);
  return (
    <div className={s.chartWrap}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={s.chart}
        role="group"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>
          {relationship.xMetric.label} and {relationship.yMetric.label}:{" "}
          {relationship.points.length} companies
        </title>
        <desc id={`${id}-description`}>
          Each point represents one company. Select a point for its values and
          reporting dates. The table below provides the same observations and
          company evidence links.
        </desc>
        {[0, 0.25, 0.5, 0.75, 1].map((part) => (
          <g key={part}>
            <line
              x1={left}
              x2={right}
              y1={top + part * (bottom - top)}
              y2={top + part * (bottom - top)}
              className={s.gridLine}
            />
            <text
              x={left - 10}
              y={top + part * (bottom - top) + 4}
              textAnchor="end"
              className={s.tick}
            >
              {num(maxY - part * (maxY - minY))}
              {relationship.yMetric.unit}
            </text>
            <text
              x={left + part * (right - left)}
              y={bottom + 24}
              textAnchor="middle"
              className={s.tick}
            >
              {num(minX + part * (maxX - minX))}
              {relationship.xMetric.unit}
            </text>
          </g>
        ))}
        {minX < 0 && maxX > 0 ? (
          <line
            x1={px(0)}
            x2={px(0)}
            y1={top}
            y2={bottom}
            className={s.zeroLine}
          />
        ) : null}
        {minY < 0 && maxY > 0 ? (
          <line
            x1={left}
            x2={right}
            y1={py(0)}
            y2={py(0)}
            className={s.zeroLine}
          />
        ) : null}
        <text
          x={(left + right) / 2}
          y={height - 20}
          textAnchor="middle"
          className={s.axisTitle}
        >
          {relationship.xMetric.label}
        </text>
        <text
          transform={`translate(19 ${(top + bottom) / 2}) rotate(-90)`}
          textAnchor="middle"
          className={s.axisTitle}
        >
          {relationship.yMetric.label}
        </text>
        {relationship.points.map((point: any) => (
          <circle
            key={point.cik}
            cx={px(point.x)}
            cy={py(point.y)}
            r={point.cik === selectedCik ? 7 : 5}
            tabIndex={0}
            role="button"
            aria-label={`Select ${point.ticker || point.name}: ${relationship.xMetric.label} ${valueLabel(point.x, relationship.xMetric.unit)}, ${relationship.yMetric.label} ${valueLabel(point.y, relationship.yMetric.unit)}`}
            aria-pressed={point.cik === selectedCik}
            className={`${s.point} ${point.cik === selectedCik ? s.selectedPoint : ""}`}
            onClick={() => onSelect(point.cik)}
            onFocus={() => onSelect(point.cik)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(point.cik);
              }
            }}
          >
            <title>
              {point.ticker || point.name}:{" "}
              {valueLabel(point.x, relationship.xMetric.unit)} /{" "}
              {valueLabel(point.y, relationship.yMetric.unit)}
            </title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

export default function PortfolioFinancialTools({
  report,
  onInspectCompany,
  view,
}: Props) {
  const id = useId();
  const [activeView, setActiveView] = useState<View>("peers");
  const selectedView = view || activeView;
  const [industry, setIndustry] = useState("");
  const [requestedMetricId, setMetricId] = useState("netMargin");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [peerLimit, setPeerLimit] = useState(20);
  const [requestedXMetricId, setXMetricId] = useState("revenueGrowth");
  const [requestedYMetricId, setYMetricId] = useState("netMargin");
  const [matchingPeriodOnly, setMatchingPeriodOnly] = useState(false);
  const [selectedCik, setSelectedCik] = useState("");
  const [pairLimit, setPairLimit] = useState(20);
  const [compareCiks, setCompareCiks] = useState<string[]>([]);
  const [candidateCik, setCandidateCik] = useState("");
  const [compareSearch, setCompareSearch] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const issuers = useMemo(() => financialToolIssuers(report), [report]);
  const industries = useMemo(
    () => [...new Set<string>(issuers.map((issuer) => issuer.industry))].sort(),
    [issuers],
  );
  const metrics = useMemo(
    () =>
      (report.metrics || []).filter(
        (item: any) =>
          buildPeerBenchmarks(report, {
            metricId: item.id,
            industry,
            ...(selectedView === "peers" ? { periodFrom, periodTo } : {}),
          }).measuredCount > 0,
      ),
    [report, industry, periodFrom, periodTo, selectedView],
  );
  const metricId = String(
    metrics.find((item: any) => item.id === requestedMetricId)?.id ||
      metrics[0]?.id ||
      "",
  );
  const xMetricId = String(
    metrics.find((item: any) => item.id === requestedXMetricId)?.id ||
      metrics[0]?.id ||
      "",
  );
  const pairedMetrics = metrics.filter(
    (item: any) =>
      item.id !== xMetricId &&
      buildMetricRelationship(report, {
        xMetricId,
        yMetricId: item.id,
        industry,
        matchingPeriodOnly,
      }).points.length > 0,
  );
  const yMetricId = String(
    pairedMetrics.find((item: any) => item.id === requestedYMetricId)?.id ||
      pairedMetrics[0]?.id ||
      "",
  );
  const cohort = useMemo(
    () =>
      buildPeerBenchmarks(report, { metricId, industry, periodFrom, periodTo }),
    [report, metricId, industry, periodFrom, periodTo],
  );
  const relationship = useMemo(
    () =>
      buildMetricRelationship(report, {
        xMetricId,
        yMetricId,
        industry,
        matchingPeriodOnly,
      }),
    [report, xMetricId, yMetricId, industry, matchingPeriodOnly],
  );
  const comparison = useMemo(() => {
    const result = buildFinancialComparison(report, compareCiks);
    return {
      ...result,
      metrics: result.metrics.filter(
        (item) =>
          item.values.length > 0 &&
          item.values.every((point) => point && finite(point.value)),
      ),
    };
  }, [report, compareCiks]);
  const selected = relationship.points.find(
    (point) => point.cik === selectedCik,
  );
  const metric = cohort.metric;
  const selectedCompareCiks = new Set(
    comparison.companies.map((issuer) => issuer.cik),
  );
  const choices = issuers.filter(
    (issuer) =>
      !selectedCompareCiks.has(issuer.cik) &&
      `${issuer.name} ${issuer.tickers.join(" ")}`
        .toLowerCase()
        .includes(compareSearch.trim().toLowerCase()),
  );
  const chosenCandidate = choices.find((issuer) => issuer.cik === candidateCik);
  const heading =
    selectedView === "peers"
      ? "Put each company in context."
      : selectedView === "relationships"
        ? "Explore two financial measures together."
        : "Compare the companies behind the numbers.";
  const description =
    selectedView === "peers"
      ? "Compare a company with other included companies in the same SEC industry. Benchmarks use the companies in this portfolio, not the wider market."
      : selectedView === "relationships"
        ? "See which companies combine growth, profitability, leverage or liquidity characteristics. Every plotted company has both selected measures."
        : "Choose up to four included companies to review eight supported financial measures, reporting dates and original SEC evidence side by side.";
  const changeIndustry = (value: string) => {
    setIndustry(value);
    setPeerLimit(20);
    setPairLimit(20);
    setSelectedCik("");
  };

  return (
    <section className={s.root} aria-labelledby={`${id}-heading`}>
      {!view ? (
        <div className={s.navigation} aria-label="Financial analysis tools">
          {VIEWS.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={selectedView === item.id}
              onClick={() => setActiveView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className={s.heading}>
        <span className={s.eyebrow}>
          {VIEWS.find((item) => item.id === selectedView)?.label}
        </span>
        <h3 id={`${id}-heading`}>{heading}</h3>
        <p>{description}</p>
      </div>
      {selectedView !== "compare" ? (
        <div className={s.cohortControl}>
          <label htmlFor={`${id}-industry`}>Peer group</label>
          <select
            id={`${id}-industry`}
            value={industry}
            onChange={(event) => changeIndustry(event.target.value)}
          >
            <option value="">
              All included operating companies ({issuers.length})
            </option>
            {industries.map((item) => (
              <option key={item} value={item}>
                {item} (
                {issuers.filter((issuer) => issuer.industry === item).length})
              </option>
            ))}
          </select>
          <p>
            One observation per issuer. Share classes are combined; funds are
            excluded from company measures.
          </p>
        </div>
      ) : null}

      {selectedView === "peers" ? (
        <>
          <div className={s.controls}>
            <label>
              Benchmark measure
              <select
                value={metricId}
                onChange={(event) => {
                  setMetricId(event.target.value);
                  setPeerLimit(20);
                }}
              >
                {metrics.map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Earliest reporting end
              <input
                type="date"
                value={periodFrom}
                onChange={(event) => {
                  setPeriodFrom(event.target.value);
                  setPeerLimit(20);
                }}
              />
            </label>
            <label>
              Latest reporting end
              <input
                type="date"
                value={periodTo}
                onChange={(event) => {
                  setPeriodTo(event.target.value);
                  setPeerLimit(20);
                }}
              />
            </label>
            {periodFrom || periodTo ? (
              <button
                type="button"
                onClick={() => {
                  setPeriodFrom("");
                  setPeriodTo("");
                }}
              >
                Clear dates
              </button>
            ) : null}
          </div>
          {cohort.error ? (
            <p role="alert" className={s.notice}>
              {cohort.error}
            </p>
          ) : null}
          {cohort.measuredCount > 0 && (
            <div className={s.stats}>
              <div>
                <span>Cohort median</span>
                <strong>
                  {metric
                    ? valueLabel(cohort.median, metric.unit)
                    : "Unavailable"}
                </strong>
                <small>Unweighted company values</small>
              </div>
              <div>
                <span>Middle 50% of values</span>
                <strong>
                  {cohort.measuredCount && metric
                    ? `${valueLabel(cohort.p25, metric.unit)} – ${valueLabel(cohort.p75, metric.unit)}`
                    : "Unavailable"}
                </strong>
                <small>25th to 75th percentile</small>
              </div>
              <div>
                <span>Measured in this view</span>
                <strong>
                  {cohort.measuredCount} <em>/ {cohort.cohortCount}</em>
                </strong>
                <small>Companies in selected peer group</small>
              </div>
            </div>
          )}
          <div className={s.coverage} role="status">
            {cohort.eligibleCount !== null ? (
              <span>
                {cohort.eligibleCount} applicable · {cohort.missingCount}{" "}
                unavailable · {cohort.notApplicableCount} not applicable
              </span>
            ) : (
              <span>
                {cohort.unavailableOrNotApplicableCount} unavailable or not
                applicable
              </span>
            )}
            {periodFrom || periodTo ? (
              <span>
                {cohort.outsidePeriodCount} outside date range ·{" "}
                {cohort.undatedExcludedCount} without a reporting end
              </span>
            ) : null}
          </div>
          {!metrics.length && (
            <p role="status" className={s.notice}>
              No financial measures match these filters. Clear the dates or
              choose another industry.
            </p>
          )}
          <p className={s.caption}>
            {metric?.description} Reporting ends may differ, and the same ending
            date can cover different durations. Higher values are not always
            preferable.
          </p>
          {cohort.measuredCount === 1 ? (
            <p className={s.notice}>
              Only one company has this measure within the filters. Its value is
              shown; a peer percentile needs at least two observed companies.
            </p>
          ) : null}
          {cohort.measuredCount > 1 && cohort.measuredCount < 5 ? (
            <p className={s.notice}>
              Small peer group: {cohort.measuredCount} measured companies.
              Percentiles describe this group and may change substantially when
              a company is added.
            </p>
          ) : null}
          {cohort.measuredCount ? (
            <>
              <div
                className={s.tableWrap}
                tabIndex={0}
                role="region"
                aria-label="Company peer benchmarks"
              >
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">{metric?.label}</th>
                      <th scope="col">Versus median</th>
                      <th scope="col">Peer percentile</th>
                      <th scope="col">Reporting evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohort.observations.slice(0, peerLimit).map((point) => (
                      <tr key={point.cik}>
                        <th scope="row">
                          <CompanyButton
                            point={point}
                            onInspectCompany={onInspectCompany}
                          />
                        </th>
                        <td className={s.numeric}>
                          {valueLabel(point.value, metric?.unit || "")}
                        </td>
                        <td className={s.numeric}>
                          {num(point.differenceFromMedian, true)}{" "}
                          {metric?.unit === "%" ? "percentage points" : "x"}
                        </td>
                        <td>
                          <div className={s.percentile}>
                            <strong>
                              {point.percentile === null
                                ? "No peers"
                                : `${num(point.percentile)}%`}
                            </strong>
                            {point.percentile !== null ? (
                              <span aria-hidden="true">
                                <i style={{ width: `${point.percentile}%` }} />
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          <span>{dateLabel(point.periodEnd)}</span>
                          <EvidenceLink point={point} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={s.footer}>
                <span>
                  Showing {Math.min(peerLimit, cohort.measuredCount)} of{" "}
                  {cohort.measuredCount} measured companies.
                </span>
                {peerLimit < cohort.measuredCount ? (
                  <button
                    type="button"
                    onClick={() => setPeerLimit((value) => value + 20)}
                  >
                    Show next 20 companies
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    try {
                      downloadText(
                        "portfolio-peer-benchmarks.csv",
                        peerBenchmarksCsv(cohort, report.capturedAt),
                        "text/csv",
                      );
                      setDownloadError("");
                    } catch {
                      setDownloadError(
                        "The download could not start. Please try again.",
                      );
                    }
                  }}
                >
                  <Download size={14} aria-hidden="true" /> Download benchmark
                  CSV
                </button>
              </div>
            </>
          ) : (
            <div className={s.empty}>
              {cohort.error
                ? "Correct the reporting dates to calculate this cohort."
                : "No supported observations match these filters. Choose another industry or measure, or clear the date range."}
            </div>
          )}
          {downloadError ? (
            <p role="alert" className={s.notice}>
              {downloadError}
            </p>
          ) : null}
          <details className={s.method}>
            <summary>How peer percentiles work</summary>
            <p>
              Each included issuer contributes one value, regardless of
              portfolio weight. The percentile is 100 × (companies with lower
              values + half the companies tied at this value) / measured
              companies. This includes the selected company; equal values
              receive the same percentile. The median and quartiles use linear
              interpolation. A percentile describes relative magnitude, not
              financial quality or expected returns.
            </p>
          </details>
        </>
      ) : null}

      {selectedView === "relationships" ? (
        <>
          <div className={s.controls}>
            <label>
              Horizontal measure
              <select
                value={xMetricId}
                onChange={(event) => {
                  setXMetricId(event.target.value);
                  setSelectedCik("");
                  setPairLimit(20);
                }}
              >
                {metrics.map((item: any) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={item.id === yMetricId}
                  >
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vertical measure
              <select
                value={yMetricId}
                onChange={(event) => {
                  setYMetricId(event.target.value);
                  setSelectedCik("");
                  setPairLimit(20);
                }}
              >
                {pairedMetrics.map((item: any) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={item.id === xMetricId}
                  >
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!pairedMetrics.length && (
            <p role="status" className={s.notice}>
              No pair of financial measures has shared company evidence in this
              selection. Change the industry or reporting-period filter.
            </p>
          )}
          <label className={s.check}>
            <input
              type="checkbox"
              checked={matchingPeriodOnly}
              onChange={(event) => {
                setMatchingPeriodOnly(event.target.checked);
                setSelectedCik("");
                setPairLimit(20);
              }}
            />{" "}
            Only pairs with the same known reporting end
          </label>
          <div className={s.stats}>
            <div>
              <span>Companies with both measures</span>
              <strong>
                {relationship.points.length}{" "}
                <em>/ {relationship.cohortCount}</em>
              </strong>
              <small>Plotted / selected peer group</small>
            </div>
            <div>
              <span>Without a usable pair</span>
              <strong>{relationship.unavailablePairCount}</strong>
              <small>One or both measures unavailable or not applicable</small>
            </div>
            <div>
              <span>
                {matchingPeriodOnly
                  ? "Excluded by date alignment"
                  : "Pairs with different reporting ends"}
              </span>
              <strong>
                {matchingPeriodOnly
                  ? relationship.dateExcludedCount
                  : relationship.mismatchedPeriodCount}
              </strong>
              <small>
                {relationship.unknownPeriodCount} pairs have an unknown
                reporting end
              </small>
            </div>
          </div>
          <p className={s.caption}>
            {relationship.xAvailableCount} companies have{" "}
            {relationship.xMetric?.label.toLowerCase()};{" "}
            {relationship.yAvailableCount} have{" "}
            {relationship.yMetric?.label.toLowerCase()}. A shared reporting end
            does not establish equal reporting durations. These are company
            financial measures, not market returns or a forecast.
          </p>
          {relationship.points.length === 1 ? (
            <p className={s.notice}>
              Only one paired company is available. Its position is shown, but
              there are no other points to compare.
            </p>
          ) : null}
          {relationship.xMetric && relationship.yMetric ? (
            <RelationshipChart
              relationship={relationship}
              selectedCik={selectedCik}
              onSelect={setSelectedCik}
            />
          ) : null}
          {selected ? (
            <div className={s.pointDetail} aria-live="polite">
              <div>
                <strong>
                  {selected.ticker} · {selected.name}
                </strong>
                <span>{selected.industry}</span>
              </div>
              <div>
                <small>{relationship.xMetric?.label}</small>
                <strong>
                  {valueLabel(selected.x, relationship.xMetric?.unit || "")}
                </strong>
                <span>{dateLabel(selected.xPoint.periodEnd)}</span>
                <EvidenceLink point={selected.xPoint} />
              </div>
              <div>
                <small>{relationship.yMetric?.label}</small>
                <strong>
                  {valueLabel(selected.y, relationship.yMetric?.unit || "")}
                </strong>
                <span>{dateLabel(selected.yPoint.periodEnd)}</span>
                <EvidenceLink point={selected.yPoint} />
              </div>
              <button
                type="button"
                onClick={() => onInspectCompany(selected.rowId)}
              >
                Inspect {selected.ticker || "company"}{" "}
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </div>
          ) : relationship.points.length ? (
            <p className={s.caption}>
              Select a point to view its values, dates and SEC sources.
              Overlapping points remain individually available in the table.
            </p>
          ) : null}
          {relationship.points.length ? (
            <>
              <div
                className={s.tableWrap}
                tabIndex={0}
                role="region"
                aria-label="Paired financial observations"
              >
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th scope="col">Company</th>
                      <th scope="col">{relationship.xMetric?.label}</th>
                      <th scope="col">{relationship.yMetric?.label}</th>
                      <th scope="col">Reporting ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relationship.points.slice(0, pairLimit).map((point) => (
                      <tr
                        key={point.cik}
                        className={
                          selectedCik === point.cik ? s.selectedRow : undefined
                        }
                      >
                        <th scope="row">
                          <CompanyButton
                            point={point}
                            onInspectCompany={onInspectCompany}
                          />
                        </th>
                        <td className={s.numeric}>
                          {valueLabel(
                            point.x,
                            relationship.xMetric?.unit || "",
                          )}
                          <EvidenceLink point={point.xPoint} />
                        </td>
                        <td className={s.numeric}>
                          {valueLabel(
                            point.y,
                            relationship.yMetric?.unit || "",
                          )}
                          <EvidenceLink point={point.yPoint} />
                        </td>
                        <td>
                          <span>
                            Horizontal: {dateLabel(point.xPoint.periodEnd)}
                          </span>
                          <span>
                            Vertical: {dateLabel(point.yPoint.periodEnd)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={s.footer}>
                <span>
                  Showing {Math.min(pairLimit, relationship.points.length)} of{" "}
                  {relationship.points.length} paired companies.
                </span>
                {pairLimit < relationship.points.length ? (
                  <button
                    type="button"
                    onClick={() => setPairLimit((value) => value + 20)}
                  >
                    Show next 20 pairs
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {selectedView === "compare" ? (
        <>
          <div className={s.comparePicker}>
            <label>
              Find a company to compare
              <input
                type="search"
                value={compareSearch}
                onChange={(event) => {
                  setCompareSearch(event.target.value);
                  setCandidateCik("");
                }}
                placeholder="Company name or ticker"
              />
            </label>
            <label>
              Choose a company
              <select
                value={chosenCandidate?.cik || ""}
                onChange={(event) => setCandidateCik(event.target.value)}
                disabled={comparison.companies.length >= 4}
              >
                <option value="">
                  {comparison.companies.length >= 4
                    ? "Four companies selected"
                    : choices.length
                      ? `Select from ${choices.length} companies`
                      : "No matching companies"}
                </option>
                {choices.map((issuer) => (
                  <option key={issuer.cik} value={issuer.cik}>
                    {issuer.tickers.join(" / ")} — {issuer.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!chosenCandidate || comparison.companies.length >= 4}
              onClick={() => {
                if (!chosenCandidate) return;
                setCompareCiks([
                  ...comparison.companies.map((issuer) => issuer.cik),
                  chosenCandidate.cik,
                ]);
                setCandidateCik("");
                setCompareSearch("");
              }}
            >
              Add to comparison
            </button>
          </div>
          <div className={s.selection} aria-live="polite">
            <span>{comparison.companies.length} of 4 companies selected</span>
            {comparison.companies.map((issuer) => (
              <button
                type="button"
                key={issuer.cik}
                onClick={() =>
                  setCompareCiks(
                    comparison.companies
                      .filter((item) => item.cik !== issuer.cik)
                      .map((item) => item.cik),
                  )
                }
                aria-label={`Remove ${issuer.tickers.join(" / ") || issuer.name} from comparison`}
              >
                {issuer.tickers.join(" / ") || issuer.name}
                <X size={13} aria-hidden="true" />
              </button>
            ))}
            {comparison.companies.length ? (
              <button type="button" onClick={() => setCompareCiks([])}>
                Clear comparison
              </button>
            ) : null}
          </div>
          {comparison.companies.length ? (
            <>
              <p className={s.caption}>
                Company values are shown as reported or derived in the captured
                research. Business models, reporting dates and durations may
                differ. Only measures available for every selected company are
                included.
              </p>
              {!comparison.metrics.length && (
                <p className={s.empty}>
                  These companies have no common financial measures. Adjust the
                  selection to compare similar businesses.
                </p>
              )}
              <div
                className={s.tableWrap}
                tabIndex={0}
                role="region"
                aria-label="Side-by-side financial comparison"
              >
                <table className={`${s.table} ${s.comparison}`}>
                  <thead>
                    <tr>
                      <th scope="col">Financial measure</th>
                      {comparison.companies.map((issuer) => (
                        <th key={issuer.cik} scope="col">
                          <CompanyButton
                            point={{
                              ...issuer,
                              ticker: issuer.tickers.join(" / "),
                              rowId: issuer.rowIds[0],
                            }}
                            onInspectCompany={onInspectCompany}
                          />
                          <small>{issuer.industry}</small>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.metrics.map((item) => (
                      <tr key={item.id}>
                        <th scope="row">
                          <strong>{item.label}</strong>
                          <small>{item.description}</small>
                        </th>
                        {item.values.map((point, index) => (
                          <td key={comparison.companies[index].cik}>
                            {point ? (
                              <>
                                <strong className={s.numeric}>
                                  {valueLabel(point.value, item.unit)}
                                </strong>
                                <span>{dateLabel(point.periodEnd)}</span>
                                <EvidenceLink point={point} />
                              </>
                            ) : (
                              <span className={s.unavailable}>
                                {item.statuses[index] === "not-applicable"
                                  ? "Not applicable"
                                  : item.statuses[index] === "missing"
                                    ? "Unavailable"
                                    : "Unavailable or not applicable"}
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className={s.empty}>
              <strong>Start with two companies you want to understand.</strong>
              <p>
                Add companies above to compare their profitability, growth,
                leverage and liquidity using the same set of financial measures.
              </p>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
