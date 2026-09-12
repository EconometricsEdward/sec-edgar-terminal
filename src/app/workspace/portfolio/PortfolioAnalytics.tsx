"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ArrowUpRight,
  BarChart3,
  CircleHelp,
  ClipboardList,
  ListFilter,
  Layers3,
  Search,
  ShieldCheck,
} from "lucide-react";
import { buildPortfolioAnalytics } from "../../../utils/portfolioAnalytics.js";
import PortfolioScenario from "./PortfolioScenario";
import { buildCatalogReport } from "../../../utils/portfolioEnrichment.js";
const PortfolioInsightTools = dynamic(() => import("./PortfolioInsightTools"));
import s from "./PortfolioAnalytics.module.css";

const PortfolioMetricExplorer = dynamic(
  () => import("./PortfolioMetricExplorer"),
);
const loading = () => <p role="status">Opening analytics tools…</p>;
const PortfolioBriefing = dynamic(() => import("./PortfolioBriefing"), {
  loading,
});
const PortfolioConcentrationTools = dynamic(
  () => import("./PortfolioConcentrationTools"),
  { loading },
);
const PortfolioConcentrationHeatMap = dynamic(
  () => import("./PortfolioConcentrationHeatMap"),
  { loading },
);
const PortfolioFinancialProfile = dynamic(
  () => import("./PortfolioFinancialProfile"),
  { loading },
);
const PortfolioScreener = dynamic(() => import("./PortfolioScreener"), {
  loading,
});
const PortfolioCoverageMatrix = dynamic(
  () => import("./PortfolioCoverageMatrix"),
  { loading },
);

type Props = {
  reportingBasis?: string;
  onReportingBasisChange?: (basis: string) => void;
  reportingLoading?: boolean;
  reportingProgress?: { completed: number; total: number };
  onCancelReporting?: () => void;
  onDisclosure?: (query: string, ciks: string[]) => void;
  analyticsArea?: string;
  onAreaChange?: (area: string) => void;
  rows: any[];
  settings: any;
  companies: any[];
  capturedAt?: string | null;
  onInspectCompany: (rowId: string) => void;
  onReviewRows: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  preview?: boolean;
  embedded?: boolean;
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
  sector: string | null;
  sic: string | null;
};
const AREAS = [
  { id: "overview", label: "Portfolio briefing", icon: ClipboardList },
  { id: "metrics", label: "Metrics & rankings", icon: BarChart3 },
  { id: "concentration", label: "Concentration", icon: Layers3 },
  { id: "financial", label: "Financial profile", icon: BarChart3 },
  { id: "screener", label: "Company screener", icon: ListFilter },
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
              <th scope="col">Sector / SEC industry</th>
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
                <td>
                  {issuer.sector && <strong>{issuer.sector}</strong>}
                  <div>{issuer.industry}</div>
                  <small>{issuer.sic ? `SEC SIC ${issuer.sic}` : ""}</small>
                </td>
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
  embedded = false,
  analyticsArea,
  onAreaChange,
  onDisclosure,
  reportingBasis,
  onReportingBasisChange,
  reportingLoading = false,
  reportingProgress,
  onCancelReporting,
}: Props) {
  const titleId = useId();
  const coverageSelectionId = useId();
  const areaButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const [localArea, setLocalArea] = useState<string>("overview");
  const area = AREAS.some((entry) => entry.id === analyticsArea)
    ? analyticsArea!
    : localArea;
  const [visitedAreas, setVisitedAreas] = useState(() => new Set(["overview"]));
  useEffect(() => {
    setVisitedAreas((current) =>
      current.has(area) ? current : new Set([...current, area]),
    );
  }, [area]);
  const [coverageMode, setCoverageMode] = useState("summary");
  const [matrixVisited, setMatrixVisited] = useState(false);
  const [financialRequest, setFinancialRequest] = useState<{
    metricId: string;
    nonce: number;
  } | null>(null);
  const changeArea = (next: string) => {
    if (!AREAS.some((entry) => entry.id === next)) return;
    setLocalArea(next);
    onAreaChange?.(next);
    setVisitedAreas((current) => new Set([...current, area, next]));
  };
  const [industry, setIndustry] = useState("");
  const [sector, setSector] = useState("");
  const [grouping, setGrouping] = useState("sector");
  const membersHeading = useRef<HTMLHeadingElement>(null);
  const [focusMembers, setFocusMembers] = useState(false);
  useEffect(() => {
    if (area === "concentration" && focusMembers && membersHeading.current) {
      membersHeading.current.focus();
      membersHeading.current.scrollIntoView({ block: "start" });
      setFocusMembers(false);
    }
  }, [area, focusMembers]);
  const [query, setQuery] = useState("");
  const [showIndustries, setShowIndustries] = useState(false);
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
  const classificationSources: any[] = [
    ...new Map(
      issuers
        .filter((holding: any) => holding.sectorSource)
        .map((holding: any) => [
          holding.sectorSource.url,
          holding.sectorSource,
        ]),
    ).values(),
  ];
  const mixGroups =
    grouping === "sector" ? concentration.sectors : concentration.industries;
  const catalogReport = useMemo(
    () => buildCatalogReport(report, companies),
    [report, companies],
  );
  const weighted = report.weighted;
  const queryText = query.trim().toLowerCase();
  const members = issuers.filter(
    (issuer) =>
      (!industry || issuer.industry === industry) &&
      (!sector ||
        (issuer.kind === "fund"
          ? "Funds (company metrics not applicable)"
          : issuer.sector || "Sector not covered") === sector) &&
      (!queryText ||
        `${issuer.tickers.join(" ")} ${issuer.name} ${issuer.industry} ${issuer.sector || ""} ${issuer.sic || ""}`
          .toLowerCase()
          .includes(queryText)),
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
    ...mixGroups.map((entry: any) =>
      weighted ? entry.weightPct || 0 : entry.count,
    ),
  );
  const maxPeriod = Math.max(
    0,
    ...report.coverage.periodEnds.map((entry: any) => entry.count),
  );

  return (
    <section
      className={s.root}
      aria-labelledby={embedded ? undefined : titleId}
      aria-label={embedded ? "Portfolio analytics" : undefined}
    >
      {!embedded && (
        <>
          <header className={s.briefingHeading}>
            <h2 id={titleId}>Portfolio research</h2>
            <span className={s.badge}>{report.label}</span>
          </header>
          <nav className={s.nav} aria-label="Portfolio analytics views">
            {AREAS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                ref={(node) => {
                  areaButtons.current[id] = node;
                }}
                type="button"
                aria-pressed={area === id}
                onClick={() => changeArea(id)}
              >
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
        </>
      )}
      <div className={s.retained} hidden={area !== "overview"}>
        <PortfolioBriefing
          report={report}
          onExploreGroup={(dimension, label) => {
            setGrouping(dimension);
            setSector(dimension === "sector" ? label : "");
            setIndustry(dimension === "industry" ? label : "");
            setQuery("");
            changeArea("concentration");
            setFocusMembers(true);
          }}
          onNavigate={(next) => {
            if (next === "coverage") setCoverageMode("summary");
            changeArea(next);
            if (!embedded) areaButtons.current[next]?.focus();
          }}
          onInspectCompany={onInspectCompany}
        />
      </div>

      {(visitedAreas.has("metrics") || area === "metrics") && (
        <div hidden={area !== "metrics"}>
          <PortfolioMetricExplorer
            reportingBasis={reportingBasis}
            onReportingBasisChange={onReportingBasisChange}
            reportingLoading={reportingLoading}
            reportingProgress={reportingProgress}
            onCancelReporting={onCancelReporting}
            onRefresh={onRefresh}
            refreshing={refreshing}
            report={report}
            companies={companies}
            onInspect={onInspectCompany}
            onDisclosure={onDisclosure}
          />
        </div>
      )}
      {(visitedAreas.has("concentration") || area === "concentration") && (
        <div className={s.panel} hidden={area !== "concentration"}>
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
                  ? "Holding weights combine all included share classes. Known weights retain the portfolio allocation denominator."
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
                  ["Largest holding", concentration.largestIssuerWeightPct],
                  ["Top 5 holdings", concentration.topFiveIssuerWeightPct],
                  ["Top 10 holdings", concentration.topTenIssuerWeightPct],
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
                  <span>Effective holding count</span>
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
                  ? "Effective holding count is 1 ÷ the sum of squared holding weights expressed as fractions (1% = 0.01). Ten equally sized holdings produce a count of 10; larger concentrations lower it. This measures allocation concentration, not diversification across economic risks."
                  : concentration.reason}
              </p>
            </>
          )}
          <PortfolioConcentrationHeatMap
            report={report}
            onInspectCompany={onInspectCompany}
            onReviewRows={onReviewRows}
            onSelectGroup={(dimension, label) => {
              setGrouping(dimension);
              setSector(dimension === "sector" ? label : "");
              setIndustry(dimension === "industry" ? label : "");
              setQuery("");
              setFocusMembers(true);
            }}
          />
          {weighted && (
            <details className={s.toolDetails}>
              <summary>Review allocation limits & cumulative exposure</summary>
              <PortfolioConcentrationTools
                report={report}
                onInspectCompany={onInspectCompany}
              />
            </details>
          )}
          <div className={s.twoColumns}>
            {weighted && (
              <section
                className={s.chartCard}
                aria-label={
                  weighted
                    ? "Largest holding allocations"
                    : "Included positions by holding"
                }
              >
                <div className={s.cardHeading}>
                  <h4>
                    {weighted
                      ? "Largest holding allocations"
                      : "Included positions by holding"}
                  </h4>
                  <span>{weighted ? "Known weight" : "Positions"}</span>
                </div>
                <p className={s.chartHelp}>
                  {weighted
                    ? "Top 10 holdings by known allocation. Select a company to inspect its evidence."
                    : "Share classes of the same company are combined. Select a company to inspect its evidence."}
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
                    Identify your companies to see holding concentration.
                  </p>
                )}
              </section>
            )}
            <section
              className={s.chartCard}
              aria-label="Sector and industry concentration"
            >
              <div className={s.cardHeading}>
                <h4>
                  {grouping === "sector" ? "Sector mix" : "SEC industry mix"}
                </h4>
                <span>{weighted ? "Known weight" : "Companies"}</span>
              </div>
              <p className={s.chartHelp}>
                {grouping === "sector"
                  ? "Fund-reported sectors matched by SEC company ID. Companies outside this reference retain their SEC industry; fund holdings stay separate."
                  : "Exact SEC SIC classifications. Choose an industry to explore its companies below."}
              </p>
              {grouping === "sector" && classificationSources.length > 0 && (
                <p className={s.note}>
                  Sector reference:{" "}
                  {classificationSources.map((source, index) => (
                    <span key={source.url}>
                      {index > 0 ? " · " : ""}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.provider} {source.fund}
                      </a>{" "}
                      ({source.asOf})
                    </span>
                  ))}
                </p>
              )}
              <label className={s.groupingControl}>
                Group companies by
                <select
                  value={grouping}
                  onChange={(event) => {
                    setGrouping(event.target.value);
                    setSector("");
                    setIndustry("");
                    setShowIndustries(false);
                  }}
                >
                  <option value="sector">Sector</option>
                  <option value="industry">SEC industry</option>
                </select>
              </label>
              <div className={s.barList}>
                {mixGroups
                  .slice(
                    0,
                    grouping === "sector" || showIndustries ? undefined : 8,
                  )
                  .map((entry: any) => (
                    <button
                      className={s.barButton}
                      type="button"
                      key={entry.label}
                      aria-pressed={
                        (grouping === "sector" ? sector : industry) ===
                        entry.label
                      }
                      onClick={() => {
                        if (grouping === "sector") {
                          setSector(sector === entry.label ? "" : entry.label);
                          setIndustry("");
                        } else {
                          setIndustry(
                            industry === entry.label ? "" : entry.label,
                          );
                          setSector("");
                        }
                        setQuery("");
                        setFocusMembers(true);
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
              {grouping === "industry" &&
                concentration.industries.length > 8 && (
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
              <h4
                ref={membersHeading}
                tabIndex={-1}
                className={s.membersHeading}
              >
                {sector || industry || "Explore all companies"}
              </h4>
              {(industry || sector) && (
                <button
                  type="button"
                  onClick={() => {
                    setIndustry("");
                    setSector("");
                  }}
                >
                  Clear classification filters
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
                <span>Sector</span>
                <select
                  value={sector}
                  onChange={(event) => {
                    setSector(event.target.value);
                    setIndustry("");
                  }}
                >
                  <option value="">All sectors</option>
                  {concentration.sectors.map((entry: any) => (
                    <option key={entry.label}>{entry.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>SEC industry</span>
                <select
                  value={industry}
                  onChange={(event) => setIndustry(event.target.value)}
                >
                  <option value="">All industries</option>
                  {concentration.industries
                    .filter(
                      (entry: any) =>
                        !sector ||
                        entry.ciks.some((cik: string) =>
                          issuers.some(
                            (issuer) =>
                              issuer.cik === cik &&
                              (issuer.kind === "fund"
                                ? "Funds (company metrics not applicable)"
                                : issuer.sector || "Sector not covered") ===
                                sector,
                          ),
                        ),
                    )
                    .map((entry: any) => (
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
                : "Each identified holding counts once, including holdings with more than one share class."}
            </p>
            {(industry === "Unresolved positions" ||
              sector === "Unresolved positions") && (
              <button type="button" onClick={onReviewRows}>
                {preview
                  ? "Open full demo to review"
                  : "Review unresolved positions"}
              </button>
            )}
            <MemberList
              key={`${sector}:${industry}:${query}`}
              issuers={members}
              weighted={weighted}
              onInspectCompany={onInspectCompany}
              empty={
                industry === "Unresolved positions" ||
                sector === "Unresolved positions"
                  ? "These positions need confirmed identities before they can appear as companies. Review the input rows to resolve them."
                  : undefined
              }
            />
          </section>
        </div>
      )}

      {(visitedAreas.has("financial") || area === "financial") && (
        <div className={s.panel} hidden={area !== "financial"}>
          <PortfolioFinancialProfile
            report={report}
            catalogReport={catalogReport}
            companies={companies}
            capturedAt={capturedAt}
            onInspectCompany={onInspectCompany}
            onDisclosure={onDisclosure}
            financialRequest={financialRequest}
          />
        </div>
      )}
      {(visitedAreas.has("screener") || area === "screener") && (
        <div className={s.retained} hidden={area !== "screener"}>
          <PortfolioScreener
            onDisclosure={onDisclosure}
            report={catalogReport}
            companies={companies}
            onInspectCompany={onInspectCompany}
          />
        </div>
      )}

      {(visitedAreas.has("scenario") || area === "scenario") && (
        <div className={s.retained} hidden={area !== "scenario"}>
          <PortfolioScenario
            report={report}
            rows={rows}
            settings={settings}
            companies={companies}
            onInspectCompany={onInspectCompany}
          />
        </div>
      )}

      {(visitedAreas.has("coverage") || area === "coverage") && (
        <div className={s.panel} hidden={area !== "coverage"}>
          {report.warnings.length > 0 && (
            <details className={s.notes}>
              <summary>{report.warnings.length} coverage notes</summary>
              <ul>
                {report.warnings.map((warning: string) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <nav className={s.subnav} aria-label="Evidence coverage tools">
            <button
              type="button"
              aria-pressed={coverageMode === "impact"}
              onClick={() => setCoverageMode("impact")}
            >
              Allocation & evidence priorities
            </button>
            <button
              type="button"
              aria-pressed={coverageMode === "summary"}
              onClick={() => setCoverageMode("summary")}
            >
              Coverage summary
            </button>
            <button
              type="button"
              aria-pressed={coverageMode === "matrix"}
              onClick={() => {
                setCoverageMode("matrix");
                setMatrixVisited(true);
              }}
            >
              Company & metric matrix
            </button>
          </nav>
          {coverageMode === "impact" && (
            <PortfolioInsightTools
              report={report}
              companies={companies}
              view="impact"
              onInspect={onInspectCompany}
            />
          )}
          <div className={s.subpanel} hidden={coverageMode !== "summary"}>
            <div className={s.sectionHeading}>
              <div>
                <p className={s.eyebrow}>Know what supports the analysis</p>
                <h3>Make the gaps visible.</h3>
                <p>
                  Coverage shows what is present in this research snapshot.
                  Different measures can cover different companies, and a
                  reported value may describe an older period.
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
              Status counts combine share classes for identified holdings;
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
                <span>Unique operating companies</span>
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
                              setFinancialRequest({
                                metricId: entry.id,
                                nonce: Date.now(),
                              });
                              changeArea("financial");
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
                        <td className={s.numeric}>
                          {entry.notApplicableCount}
                        </td>
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
                    <a
                      className={s.sourceLink}
                      href={`#${coverageSelectionId}`}
                    >
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
                    No missing company identities or tracked financial measures
                    in this snapshot. Measures that do not apply remain separate
                    in the coverage table.
                  </p>
                )}
              </section>
            </div>
          </div>
          {matrixVisited && (
            <div className={s.retained} hidden={coverageMode !== "matrix"}>
              <PortfolioCoverageMatrix
                report={report}
                companies={companies}
                onInspectCompany={onInspectCompany}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
