"use client";

import { useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  CircleHelp,
  Layers3,
  Search,
  ShieldCheck,
} from "lucide-react";
import { buildPortfolioAnalytics } from "../../../utils/portfolioAnalytics.js";
import PortfolioScenario from "./PortfolioScenario";
import s from "./PortfolioAnalytics.module.css";

type Props = {
  rows: any[];
  settings: any;
  companies: any[];
  capturedAt?: string | null;
  onInspectCompany: (rowId: string) => void;
  onReviewRows: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  preview?: boolean;
};
type Issuer = {
  cik: string;
  name: string;
  tickers: string[];
  rowIds: string[];
  kind: string;
  weightPct: number | null;
  weightComplete: boolean;
  industry: string;
};
const AREAS = [
  { id: "concentration", label: "Concentration", icon: Layers3 },
  { id: "financial", label: "Financial profile", icon: BarChart3 },
  { id: "scenario", label: "Scenario lab", icon: CircleHelp },
  { id: "coverage", label: "Evidence coverage", icon: ShieldCheck },
] as const;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const count = (value: number) => value.toLocaleString("en-US");
const number = (value: unknown, digits = 1) =>
  finite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "Unavailable";
const percent = (value: unknown) =>
  finite(value) ? `${number(value, 2)}%` : "Unknown";
const metricValue = (value: unknown, unit: string) =>
  finite(value) ? `${number(value, 2)}${unit}` : "Unavailable";
const metricRange = (low: unknown, high: unknown, unit: string) =>
  finite(low) && finite(high)
    ? `${metricValue(low, unit)} – ${metricValue(high, unit)}`
    : "Unavailable";
const dateLabel = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not captured";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
};
const barWidth = (value: number, maximum: number) =>
  `${maximum > 0 ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0}%`;

function MemberList({
  issuers,
  weighted,
  onInspectCompany,
  empty = "No companies match this selection.",
}: {
  issuers: Issuer[];
  weighted: boolean;
  onInspectCompany: (rowId: string) => void;
  empty?: string;
}) {
  const [limit, setLimit] = useState(20);
  if (!issuers.length) return <p className={s.empty}>{empty}</p>;
  return (
    <>
      <div
        className={s.tableWrap}
        tabIndex={0}
        role="region"
        aria-label="Companies in selection"
      >
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">SEC industry</th>
              <th scope="col">
                {weighted ? "Known allocation" : "Included positions"}
              </th>
              <th scope="col">
                <span className={s.srOnly}>Inspect</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {issuers.slice(0, limit).map((issuer) => (
              <tr key={issuer.cik || issuer.rowIds[0]}>
                <th scope="row">
                  <strong>
                    {issuer.tickers.join(" / ") || "Unidentified"}
                  </strong>
                  <span>{issuer.name}</span>
                  {issuer.tickers.length > 1 && (
                    <small>Share classes combined</small>
                  )}
                </th>
                <td>{issuer.industry}</td>
                <td className={s.numeric}>
                  {weighted ? (
                    <>
                      {percent(issuer.weightPct)}
                      {!issuer.weightComplete && (
                        <small>Incomplete weight</small>
                      )}
                    </>
                  ) : (
                    count(issuer.rowIds.length)
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className={s.inspect}
                    onClick={() => onInspectCompany(issuer.rowIds[0])}
                    aria-label={`Inspect ${issuer.tickers.join(" / ") || issuer.name}`}
                  >
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.listFooter}>
        <span>
          Showing {Math.min(limit, issuers.length)} of {count(issuers.length)}{" "}
          companies.
        </span>
        {limit < issuers.length && (
          <button type="button" onClick={() => setLimit((value) => value + 20)}>
            Show next 20
          </button>
        )}
      </div>
    </>
  );
}

export default function PortfolioAnalytics({
  rows,
  settings,
  companies,
  capturedAt,
  onInspectCompany,
  onReviewRows,
  onRefresh,
  refreshing,
  preview = false,
}: Props) {
  const titleId = useId();
  const coverageSelectionId = useId();
  const areaButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [area, setArea] = useState<string>("concentration");
  const [industry, setIndustry] = useState("");
  const [query, setQuery] = useState("");
  const [showIndustries, setShowIndustries] = useState(false);
  const [metricId, setMetricId] = useState("netMargin");
  const [binIndex, setBinIndex] = useState<number | null>(null);
  const [observationLimit, setObservationLimit] = useState(20);
  const [conditionId, setConditionId] = useState("");
  const [coverageSelection, setCoverageSelection] = useState<{
    kind: "status" | "period";
    id: string;
  } | null>(null);
  const [missingLimit, setMissingLimit] = useState(8);
  const [showPeriods, setShowPeriods] = useState(false);
  const report: any = useMemo(
    () => buildPortfolioAnalytics(rows, settings, companies, { capturedAt }),
    [rows, settings, companies, capturedAt],
  );
  const concentration = report.concentration;
  const issuers: Issuer[] = concentration.issuers;
  const weighted = report.weighted;
  const metric =
    report.metrics.find((entry: any) => entry.id === metricId) ||
    report.metrics[0];
  const bin = binIndex === null ? null : metric?.bins[binIndex];
  const binRows = new Set<string>(bin?.rowIds || []);
  const observations = (metric?.observations || []).filter(
    (entry: any) => !bin || binRows.has(entry.rowId),
  );
  const queryText = query.trim().toLowerCase();
  const members = issuers.filter(
    (issuer) =>
      (!industry || issuer.industry === industry) &&
      (!queryText ||
        `${issuer.tickers.join(" ")} ${issuer.name} ${issuer.industry}`
          .toLowerCase()
          .includes(queryText)),
  );
  const financialCount = new Set(
    report.metrics.flatMap((entry: any) =>
      entry.observations.map((observation: any) => observation.cik),
    ),
  ).size;
  const selectedCondition = report.conditions.find(
    (entry: any) => entry.id === conditionId,
  );
  const conditionRows = new Set<string>(selectedCondition?.rowIds || []);
  const conditionMembers = issuers.filter((issuer) =>
    issuer.rowIds.some((id) => conditionRows.has(id)),
  );
  const coverageGroup =
    coverageSelection?.kind === "status"
      ? report.coverage.statuses.find(
          (entry: any) => entry.id === coverageSelection.id,
        )
      : coverageSelection?.kind === "period"
        ? report.coverage.periodEnds.find(
            (entry: any) => entry.end === coverageSelection.id,
          )
        : null;
  const coverageRows = new Set<string>(coverageGroup?.rowIds || []);
  const coverageMembers = issuers.filter((issuer) =>
    issuer.rowIds.some((id) => coverageRows.has(id)),
  );
  const rankedIssuers = issuers.slice(0, 10);
  const maxIssuer = weighted
    ? Math.max(0, ...rankedIssuers.map((entry) => entry.weightPct || 0))
    : Math.max(0, ...rankedIssuers.map((entry) => entry.rowIds.length));
  const maxIndustry = Math.max(
    0,
    ...concentration.industries.map((entry: any) =>
      weighted ? entry.weightPct || 0 : entry.count,
    ),
  );
  const maxBin = Math.max(
    0,
    ...(metric?.bins || []).map((entry: any) => entry.count),
  );
  const maxPeriod = Math.max(
    0,
    ...report.coverage.periodEnds.map((entry: any) => entry.count),
  );

  return (
    <section className={s.root} aria-labelledby={titleId}>
      <header className={s.hero}>
        <div className={s.heroHeading}>
          <div>
            <p className={s.eyebrow}>
              From individual companies to the whole portfolio
            </p>
            <h2 id={titleId}>
              {weighted
                ? "Understand your portfolio."
                : "Understand your company list."}
            </h2>
            <p className={s.intro}>
              Explore concentration, compare company fundamentals, and test your
              own assumptions. Every result keeps its coverage and reporting
              dates in view.
            </p>
          </div>
          <span className={s.badge}>{report.label}</span>
        </div>
        <div className={s.summary}>
          <div>
            <span>Identified issuers</span>
            <strong>{count(report.issuerCount)}</strong>
            <small>
              {count(report.holdingCount)} included positions ·{" "}
              {count(report.unresolvedCount)} unresolved
            </small>
          </div>
          <div>
            <span>Financial ratio coverage</span>
            <strong>
              {count(financialCount)}
              <em> / {count(report.operatingIssuerCount)}</em>
            </strong>
            <small>At least one of the tracked financial measures</small>
          </div>
          <div>
            <span>{weighted ? "Known allocation" : "Allocation basis"}</span>
            <strong className={!weighted ? s.wordValue : undefined}>
              {weighted ? percent(concentration.knownWeightPct) : "Ticker list"}
            </strong>
            <small>
              {weighted
                ? `${concentration.missingWeightRows} positions without a usable weight`
                : "Company counts; no weights assumed"}
            </small>
          </div>
          <div>
            <span>Research snapshot</span>
            <strong className={s.dateValue}>
              {dateLabel(report.capturedAt)}
            </strong>
            <small>Company reporting periods may differ</small>
          </div>
        </div>
      </header>
      {report.warnings.length > 0 && (
        <details className={s.notes}>
          <summary>
            {report.warnings.length} coverage{" "}
            {report.warnings.length === 1 ? "note" : "notes"} to keep in mind
          </summary>
          <ul>
            {report.warnings.map((warning: string) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <nav className={s.nav} aria-label="Portfolio analytics views">
        {AREAS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            ref={(node) => {
              areaButtons.current[id] = node;
            }}
            type="button"
            aria-pressed={area === id}
            onClick={() => setArea(id)}
          >
            <Icon size={18} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      {area === "concentration" && (
        <div className={s.panel}>
          <div className={s.sectionHeading}>
            <div>
              <p className={s.eyebrow}>Where exposure collects</p>
              <h3>
                {weighted
                  ? "See the biggest concentrations."
                  : "See the shape of your research universe."}
              </h3>
              <p>
                {weighted
                  ? "Issuer weights combine all included share classes. Known weights retain the portfolio allocation denominator."
                  : "Without position weights, this view counts companies and positions. A list of 100 tickers does not imply 1% in each company."}
              </p>
            </div>
            <button type="button" onClick={onReviewRows}>
              {preview
                ? "Open full demo to review"
                : weighted
                  ? "Review allocation"
                  : "Add position weights"}
            </button>
          </div>
          {weighted && (
            <>
              <div className={s.concentrationStats}>
                {[
                  ["Largest issuer", concentration.largestIssuerWeightPct],
                  ["Top 5 issuers", concentration.topFiveIssuerWeightPct],
                  ["Top 10 issuers", concentration.topTenIssuerWeightPct],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <span>{label}</span>
                    <strong>{percent(value)}</strong>
                    <small>
                      {concentration.complete
                        ? "of portfolio allocation"
                        : "known allocation only"}
                    </small>
                  </div>
                ))}
                <div>
                  <span>Effective issuer count</span>
                  <strong>{number(concentration.effectiveIssuerCount)}</strong>
                  <small>
                    {concentration.complete
                      ? `HHI: ${number(concentration.hhi, 0)} · scale 0–10,000`
                      : "Requires complete allocation"}
                  </small>
                </div>
              </div>
              <p className={s.note}>
                {concentration.complete
                  ? "Effective issuer count is 1 ÷ the sum of squared issuer weights expressed as fractions (1% = 0.01). Ten equally sized issuers produce a count of 10; larger concentrations lower it. This measures allocation concentration, not diversification across economic risks."
                  : concentration.reason}
              </p>
            </>
          )}
          <div className={s.twoColumns}>
            <section
              className={s.chartCard}
              aria-label={
                weighted
                  ? "Largest issuer allocations"
                  : "Included positions by issuer"
              }
            >
              <div className={s.cardHeading}>
                <h4>
                  {weighted
                    ? "Largest issuer allocations"
                    : "Included positions by issuer"}
                </h4>
                <span>{weighted ? "Known weight" : "Positions"}</span>
              </div>
              <p className={s.chartHelp}>
                {weighted
                  ? "Top 10 issuers by known allocation. Select a company to inspect its evidence."
                  : "Share classes of the same issuer are combined. Select a company to inspect its evidence."}
              </p>
              <div className={s.barList}>
                {rankedIssuers.map((issuer) => (
                  <button
                    className={s.barButton}
                    type="button"
                    key={issuer.cik || issuer.rowIds[0]}
                    onClick={() => onInspectCompany(issuer.rowIds[0])}
                    aria-label={`Inspect ${issuer.name}, ${weighted ? `${percent(issuer.weightPct)} known allocation` : `${issuer.rowIds.length} included positions`}`}
                  >
                    <span className={s.barCaption}>
                      <span>
                        <strong>
                          {issuer.tickers.join(" / ") || issuer.name}
                        </strong>
                        <small>{issuer.name}</small>
                      </span>
                      <b>
                        {weighted
                          ? percent(issuer.weightPct)
                          : count(issuer.rowIds.length)}
                      </b>
                    </span>
                    <span className={s.barTrack} aria-hidden="true">
                      <span
                        style={{
                          width: barWidth(
                            weighted
                              ? issuer.weightPct || 0
                              : issuer.rowIds.length,
                            maxIssuer,
                          ),
                        }}
                      />
                    </span>
                  </button>
                ))}
              </div>
              {!rankedIssuers.length && (
                <p className={s.empty}>
                  Identify your companies to see issuer concentration.
                </p>
              )}
            </section>
            <section
              className={s.chartCard}
              aria-label="SEC industry concentration"
            >
              <div className={s.cardHeading}>
                <h4>SEC industry mix</h4>
                <span>{weighted ? "Known weight" : "Companies"}</span>
              </div>
              <p className={s.chartHelp}>
                Based on each issuer’s SEC SIC classification. Choose an
                industry to explore its companies below.
              </p>
              <div className={s.barList}>
                {concentration.industries
                  .slice(0, showIndustries ? undefined : 8)
                  .map((entry: any) => (
                    <button
                      className={s.barButton}
                      type="button"
                      key={entry.label}
                      aria-pressed={industry === entry.label}
                      onClick={() => {
                        setIndustry(
                          industry === entry.label ? "" : entry.label,
                        );
                        setQuery("");
                      }}
                      aria-label={`Filter ${entry.label}, ${entry.count} companies${weighted ? `, ${percent(entry.weightPct)} known allocation` : ""}`}
                    >
                      <span className={s.barCaption}>
                        <span>
                          <strong>{entry.label}</strong>
                          <small>
                            {entry.count}{" "}
                            {entry.label === "Unresolved positions"
                              ? "positions"
                              : entry.count === 1
                                ? "company"
                                : "companies"}
                          </small>
                        </span>
                        <b>
                          {weighted
                            ? percent(entry.weightPct)
                            : count(entry.count)}
                        </b>
                      </span>
                      <span className={s.barTrack} aria-hidden="true">
                        <span
                          style={{
                            width: barWidth(
                              weighted ? entry.weightPct || 0 : entry.count,
                              maxIndustry,
                            ),
                          }}
                        />
                      </span>
                    </button>
                  ))}
              </div>
              {concentration.industries.length > 8 && (
                <button
                  className={s.showMore}
                  type="button"
                  onClick={() => setShowIndustries(!showIndustries)}
                >
                  {showIndustries
                    ? "Show top 8 industries"
                    : `Show all ${concentration.industries.length} industries`}
                </button>
              )}
            </section>
          </div>
          <section
            className={s.members}
            aria-label="Explore portfolio companies"
          >
            <div className={s.cardHeading}>
              <h4>{industry || "Explore all companies"}</h4>
              {industry && (
                <button type="button" onClick={() => setIndustry("")}>
                  Clear industry
                </button>
              )}
            </div>
            <div className={s.filters}>
              <label className={s.search}>
                <span>Find a company or industry</span>
                <span>
                  <Search size={17} aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Ticker, name, or industry"
                  />
                </span>
              </label>
              <label>
                <span>SEC industry</span>
                <select
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                >
                  <option value="">All industries</option>
                  {concentration.industries.map((entry: any) => (
                    <option key={entry.label} value={entry.label}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className={s.note}>
              {count(members.length)} companies match.{" "}
              {weighted
                ? "Filtering does not change the portfolio weights or concentration totals above."
                : "Each identified issuer counts once, including issuers with more than one share class."}
            </p>
            {industry === "Unresolved positions" && (
              <button type="button" onClick={onReviewRows}>
                {preview
                  ? "Open full demo to review"
                  : "Review unresolved positions"}
              </button>
            )}
            <MemberList
              key={`${industry}:${query}`}
              issuers={members}
              weighted={weighted}
              onInspectCompany={onInspectCompany}
              empty={
                industry === "Unresolved positions"
                  ? "These positions need confirmed identities before they can appear as companies. Review the input rows to resolve them."
                  : undefined
              }
            />
          </section>
        </div>
      )}

      {area === "financial" && (
        <div className={s.panel}>
          <div className={s.sectionHeading}>
            <div>
              <p className={s.eyebrow}>Company fundamentals, together</p>
              <h3>Find the outliers. Inspect the evidence.</h3>
              <p>
                Each issuer contributes one observation. Medians and percentiles
                describe the companies with supported evidence; they are
                unweighted and do not represent a consolidated portfolio ratio.
              </p>
            </div>
          </div>
          {metric && (
            <>
              <label className={s.metricSelect}>
                <span>Financial measure</span>
                <select
                  value={metric.id}
                  onChange={(event) => {
                    setMetricId(event.target.value);
                    setBinIndex(null);
                    setObservationLimit(20);
                  }}
                >
                  {report.metrics.map((entry: any) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className={s.description}>{metric.description}</p>
              <div className={s.concentrationStats}>
                <div>
                  <span>Observed median</span>
                  <strong>{metricValue(metric.median, metric.unit)}</strong>
                  <small>Middle company observation</small>
                </div>
                <div>
                  <span>Middle 50% of companies</span>
                  <strong className={s.range}>
                    {metricRange(metric.p25, metric.p75, metric.unit)}
                  </strong>
                  <small>25th to 75th percentile</small>
                </div>
                <div>
                  <span>Measured companies</span>
                  <strong>
                    {metric.availableCount}
                    <em> / {metric.eligibleCount}</em>
                  </strong>
                  <small>
                    {metric.missingCount} unavailable ·{" "}
                    {metric.notApplicableCount} not applicable
                  </small>
                </div>
                <div>
                  <span>
                    {weighted ? "Known allocation covered" : "Observed range"}
                  </span>
                  <strong className={s.range}>
                    {weighted
                      ? percent(metric.coveredWeightPct)
                      : metricRange(metric.min, metric.max, metric.unit)}
                  </strong>
                  <small>
                    {weighted
                      ? "Original portfolio allocation denominator"
                      : "Minimum to maximum supported value"}
                  </small>
                </div>
              </div>
              <section
                className={s.distribution}
                aria-label={`${metric.label} distribution`}
              >
                <div className={s.cardHeading}>
                  <h4>How the companies are distributed</h4>
                  <span>{metric.availableCount} measured</span>
                </div>
                <p className={s.chartHelp}>
                  Select a range to see the companies behind it. Bar heights
                  show company counts.
                </p>
                {metric.availableCount > 0 ? (
                  <div className={s.histogram}>
                    {metric.bins.map((entry: any, index: number) => (
                      <button
                        key={entry.label}
                        type="button"
                        className={s.histogramBin}
                        aria-pressed={binIndex === index}
                        aria-label={`${metric.label}: ${entry.label}, ${entry.count} companies${weighted ? `, ${percent(entry.weightPct)} known allocation` : ""}`}
                        onClick={() => {
                          setBinIndex(binIndex === index ? null : index);
                          setObservationLimit(20);
                        }}
                      >
                        <strong>{entry.count}</strong>
                        <span className={s.histogramTrack} aria-hidden="true">
                          <span
                            style={{ height: barWidth(entry.count, maxBin) }}
                          />
                        </span>
                        <span>{entry.label}</span>
                        {weighted && (
                          <small>{percent(entry.weightPct)} allocation</small>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={s.empty}>
                    No supported observations for this measure. Check Evidence
                    coverage for missing data and industry limitations.
                  </p>
                )}
              </section>
              <div className={s.cardHeading}>
                <h4>
                  {bin ? `Companies: ${bin.label}` : "All measured companies"}
                </h4>
                {bin && (
                  <button
                    type="button"
                    onClick={() => {
                      setBinIndex(null);
                      setObservationLimit(20);
                    }}
                  >
                    Clear range
                  </button>
                )}
              </div>
              {observations.length ? (
                <>
                  <div
                    className={s.tableWrap}
                    tabIndex={0}
                    role="region"
                    aria-label={`${metric.label} company observations`}
                  >
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th scope="col">Company</th>
                          <th scope="col">{metric.label}</th>
                          <th scope="col">Reporting end</th>
                          <th scope="col">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {observations
                          .slice(0, observationLimit)
                          .map((entry: any) => (
                            <tr key={entry.cik}>
                              <th scope="row">
                                <button
                                  type="button"
                                  className={s.companyLink}
                                  onClick={() => onInspectCompany(entry.rowId)}
                                >
                                  {entry.ticker || entry.name}
                                  <ArrowUpRight size={15} aria-hidden="true" />
                                </button>
                                <span>{entry.name}</span>
                              </th>
                              <td className={s.numeric}>
                                {metricValue(entry.value, metric.unit)}
                              </td>
                              <td>{entry.periodEnd || "Unavailable"}</td>
                              <td>
                                {entry.sourceUrl ? (
                                  <a
                                    className={s.sourceLink}
                                    href={entry.sourceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label={`Open SEC source for ${entry.ticker || entry.name} ${metric.label} in a new tab`}
                                  >
                                    SEC filing
                                    <ArrowUpRight
                                      size={14}
                                      aria-hidden="true"
                                    />
                                  </a>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onInspectCompany(entry.rowId)
                                    }
                                  >
                                    Inspect company
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={s.listFooter}>
                    <span>
                      Showing {Math.min(observationLimit, observations.length)}{" "}
                      of {observations.length} measured companies.
                    </span>
                    {observationLimit < observations.length && (
                      <button
                        type="button"
                        onClick={() =>
                          setObservationLimit((value) => value + 20)
                        }
                      >
                        Show next 20
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <p className={s.empty}>No measured companies in this range.</p>
              )}
            </>
          )}
          <section
            className={s.conditions}
            aria-label="Financial conditions to review"
          >
            <div className={s.sectionHeading}>
              <div>
                <p className={s.eyebrow}>Start your next review</p>
                <h3>Financial conditions worth examining</h3>
                <p>
                  These are factual screens from reported measures. An
                  unavailable value is excluded, never treated as zero or as a
                  passing result.
                </p>
              </div>
            </div>
            <div className={s.conditionGrid}>
              {report.conditions.map((condition: any) => (
                <button
                  type="button"
                  key={condition.id}
                  className={s.conditionCard}
                  aria-pressed={conditionId === condition.id}
                  disabled={condition.measuredCount === 0}
                  onClick={() =>
                    setConditionId(
                      conditionId === condition.id ? "" : condition.id,
                    )
                  }
                >
                  <span>{condition.label}</span>
                  <strong
                    className={
                      condition.measuredCount === 0 ? s.notAssessed : undefined
                    }
                  >
                    {condition.measuredCount === 0 ? (
                      "Not assessed"
                    ) : (
                      <>
                        {condition.matchedCount}
                        <em> companies</em>
                      </>
                    )}
                  </strong>
                  <small>{condition.description}</small>
                  <span className={s.conditionCoverage}>
                    {condition.measuredCount} measured ·{" "}
                    {condition.missingCount} unavailable ·{" "}
                    {condition.notApplicableCount} not applicable
                  </span>
                  {weighted && condition.measuredCount > 0 && (
                    <b>
                      {percent(condition.knownMatchedWeightPct)} known
                      allocation matches
                    </b>
                  )}
                </button>
              ))}
            </div>
            {selectedCondition && selectedCondition.measuredCount > 0 && (
              <div className={s.conditionMembers}>
                <div className={s.cardHeading}>
                  <h4>{selectedCondition.label}</h4>
                  <button type="button" onClick={() => setConditionId("")}>
                    Close selection
                  </button>
                </div>
                <MemberList
                  key={conditionId}
                  issuers={conditionMembers}
                  weighted={weighted}
                  onInspectCompany={onInspectCompany}
                  empty="No companies with supported evidence meet this condition."
                />
              </div>
            )}
          </section>
        </div>
      )}

      {area === "scenario" && (
        <PortfolioScenario
          rows={rows}
          settings={settings}
          companies={companies}
          onInspectCompany={onInspectCompany}
        />
      )}

      {area === "coverage" && (
        <div className={s.panel}>
          <div className={s.sectionHeading}>
            <div>
              <p className={s.eyebrow}>Know what supports the analysis</p>
              <h3>Make the gaps visible.</h3>
              <p>
                Coverage shows what is present in this research snapshot.
                Different measures can cover different companies, and a reported
                value may describe an older period.
              </p>
            </div>
            <div className={s.actions}>
              <button type="button" onClick={onReviewRows}>
                {preview ? "Open full demo to review" : "Review input rows"}
              </button>
              <button type="button" onClick={onRefresh} disabled={refreshing}>
                {refreshing
                  ? "Refreshing research…"
                  : preview
                    ? "Open full demo to refresh"
                    : "Refresh research"}
              </button>
            </div>
          </div>
          <div className={s.statusGrid}>
            {report.coverage.statuses.map((entry: any) => (
              <button
                type="button"
                className={s.statusCard}
                key={entry.id}
                aria-pressed={
                  coverageSelection?.kind === "status" &&
                  coverageSelection.id === entry.id
                }
                onClick={() =>
                  setCoverageSelection(
                    coverageSelection?.kind === "status" &&
                      coverageSelection.id === entry.id
                      ? null
                      : { kind: "status", id: entry.id },
                  )
                }
              >
                <span>{entry.label}</span>
                <strong>{entry.count}</strong>
                {weighted && (
                  <small>{percent(entry.weightPct)} known allocation</small>
                )}
              </button>
            ))}
          </div>
          <p className={s.note}>
            Status counts combine share classes for identified issuers;
            unresolved entries count individual positions.{" "}
            {report.coverage.staleCount > 0
              ? `${report.coverage.staleCount} companies also have older cached evidence or reporting periods relative to this snapshot.`
              : "No older-evidence flags in this snapshot; freshness is evaluated against its recorded capture date."}{" "}
            {report.fundCount > 0
              ? `${report.fundCount} funds are shown separately because company financial ratios do not look through their holdings.`
              : ""}
          </p>
          {coverageGroup && (
            <section className={s.coverageMembers} id={coverageSelectionId}>
              <div className={s.cardHeading}>
                <h4>
                  {coverageSelection?.kind === "period"
                    ? `Reporting end: ${coverageGroup.end}`
                    : coverageGroup.label}
                </h4>
                <button
                  type="button"
                  onClick={() => setCoverageSelection(null)}
                >
                  Clear selection
                </button>
              </div>
              <MemberList
                key={`${coverageSelection?.kind}:${coverageSelection?.id}`}
                issuers={coverageMembers}
                weighted={weighted}
                onInspectCompany={onInspectCompany}
                empty="No identified companies in this selection. Review input rows to resolve unidentified positions."
              />
            </section>
          )}
          <section className={s.coverageTable}>
            <div className={s.cardHeading}>
              <h4>Coverage by financial measure</h4>
              <span>Unique operating issuers</span>
            </div>
            <div
              className={s.tableWrap}
              tabIndex={0}
              role="region"
              aria-label="Metric evidence coverage"
            >
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col">Measured / eligible</th>
                    <th scope="col">Unavailable</th>
                    <th scope="col">Not applicable</th>
                    {weighted && <th scope="col">Known weight covered</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.coverage.metricRows.map((entry: any) => (
                    <tr key={entry.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className={s.companyLink}
                          onClick={() => {
                            setMetricId(entry.id);
                            setBinIndex(null);
                            setObservationLimit(20);
                            setArea("financial");
                            areaButtons.current.financial?.focus();
                          }}
                        >
                          {entry.label}
                          <ArrowUpRight size={15} aria-hidden="true" />
                        </button>
                      </th>
                      <td className={s.numeric}>
                        {entry.availableCount} / {entry.eligibleCount}
                      </td>
                      <td className={s.numeric}>{entry.missingCount}</td>
                      <td className={s.numeric}>{entry.notApplicableCount}</td>
                      {weighted && (
                        <td className={s.numeric}>
                          {percent(entry.coveredWeightPct)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className={s.twoColumns}>
            <section
              className={s.chartCard}
              aria-label="Reporting date distribution"
            >
              <div className={s.cardHeading}>
                <h4>Reporting periods are not always aligned</h4>
              </div>
              <p className={s.chartHelp}>
                Company counts by reporting end. Select a date to see which
                companies it covers. This is the financial reporting date, not
                the download date.
              </p>
              <div className={s.barList}>
                {report.coverage.periodEnds
                  .slice(0, showPeriods ? undefined : 8)
                  .map((entry: any) => (
                    <button
                      className={s.barButton}
                      key={entry.end}
                      type="button"
                      aria-pressed={
                        coverageSelection?.kind === "period" &&
                        coverageSelection.id === entry.end
                      }
                      onClick={() =>
                        setCoverageSelection(
                          coverageSelection?.kind === "period" &&
                            coverageSelection.id === entry.end
                            ? null
                            : { kind: "period", id: entry.end },
                        )
                      }
                      aria-label={`Reporting end ${entry.end}: ${entry.count} companies`}
                    >
                      <span className={s.barCaption}>
                        <strong>{entry.end}</strong>
                        <b>{entry.count}</b>
                      </span>
                      <span className={s.barTrack} aria-hidden="true">
                        <span
                          style={{ width: barWidth(entry.count, maxPeriod) }}
                        />
                      </span>
                    </button>
                  ))}
              </div>
              {report.coverage.periodEnds.length > 8 && (
                <button
                  type="button"
                  className={s.showMore}
                  onClick={() => setShowPeriods(!showPeriods)}
                >
                  {showPeriods
                    ? "Show newest 8 periods"
                    : `Show all ${report.coverage.periodEnds.length} periods`}
                </button>
              )}
              {coverageSelection?.kind === "period" && coverageGroup && (
                <p className={s.note} role="status">
                  {coverageGroup.count} companies selected for{" "}
                  {coverageGroup.end}.{" "}
                  <a className={s.sourceLink} href={`#${coverageSelectionId}`}>
                    View selected companies ↑
                  </a>
                </p>
              )}
            </section>
            <section
              className={s.chartCard}
              aria-label="Companies needing more evidence"
            >
              <div className={s.cardHeading}>
                <h4>Resolve the next gap</h4>
                <span>{report.coverage.missingRows.length} positions</span>
              </div>
              <p className={s.chartHelp}>
                Unidentified companies, missing research, and unavailable
                tracked measures appear here. Inspect a company to see the
                evidence and the reason for each gap.
              </p>
              {report.coverage.missingRows.length ? (
                <>
                  <ul className={s.missingList}>
                    {report.coverage.missingRows
                      .slice(0, missingLimit)
                      .map((entry: any) => (
                        <li key={entry.rowId}>
                          <div>
                            <strong>
                              {entry.ticker ||
                                entry.name ||
                                "Unidentified position"}
                            </strong>
                            <span>{entry.name}</span>
                            <small>{entry.reason}</small>
                          </div>
                          <button
                            type="button"
                            onClick={() => onInspectCompany(entry.rowId)}
                            aria-label={`Inspect coverage for ${entry.ticker || entry.name || "unidentified position"}`}
                          >
                            <ArrowUpRight size={17} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                  </ul>
                  {missingLimit < report.coverage.missingRows.length && (
                    <button
                      type="button"
                      onClick={() => setMissingLimit((value) => value + 20)}
                    >
                      Show next 20
                    </button>
                  )}
                </>
              ) : (
                <p className={s.empty}>
                  No missing company identities or tracked financial measures in
                  this snapshot. Measures that do not apply remain separate in
                  the coverage table.
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
