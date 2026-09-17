"use client";

import { useMemo, useState } from "react";
import { Activity, ArrowUpRight, ArrowRight, FileText, Network, ShieldCheck } from "lucide-react";
import { buildPortfolioOverview } from "../../../utils/portfolioOverview.js";
import s from "./PortfolioBriefing.module.css";

const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const percent = (value: number) => `${number(value)}%`;
const width = (value: number, total: number) =>
  `${total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0}%`;
const COLORS = ["#f7c65a", "#79b8d0", "#a4a1e4", "#85bba8", "#60728e", "#d598ba", "#dca279", "#8ca9e6", "#b0c77c", "#73c8c1", "#ceadc8", "#7e899c"];

export default function PortfolioBriefing({
  report,
  onNavigate,
  onInspectCompany,
  onExploreGroup,
  onOpenChanges,
  onOpenMarkets,
  onOpenHoldings,
}: {
  report: any;
  onExploreGroup?: (dimension: string, label: string) => void;
  onNavigate: (area: string) => void;
  onInspectCompany: (rowId: string) => void;
  onOpenChanges?: () => void;
  onOpenMarkets?: () => void;
  onOpenHoldings?: () => void;
}) {
  const overview = useMemo(() => buildPortfolioOverview(report), [report]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const selected = overview.mix.find((entry: any) => entry.label === highlighted);
  const segments = useMemo(() => {
    return overview.mix.map((entry: any, index: number) => {
      const preceding = overview.mix.slice(0, index).reduce((total: number, item: any) => total + item.value, 0);
      const start = overview.mixTotal > 0 ? Math.max(0, Math.min(1, preceding / overview.mixTotal)) : 0;
      const portion = overview.mixTotal > 0 ? entry.value / overview.mixTotal : 0;
      return { ...entry, start, portion: Math.max(0, Math.min(1 - start, portion)), color: COLORS[index % COLORS.length] };
    });
  }, [overview]);
  const capturedDate = report.capturedAt && Number.isFinite(Date.parse(report.capturedAt))
    ? new Date(report.capturedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
  if (!report.holdingCount) return null;
  return (
    <section className={s.root} aria-label="Portfolio briefing">
      <header className={s.heading}>
        <div>
          <p className={s.eyebrow}>YOUR PORTFOLIO, IN FOCUS</p>
          <h3>Understand what you own.</h3>
          <p className={s.intro}>
            {overview.companyCount > 0
              ? `${number(overview.companyCount)} ${overview.companyCount === 1 ? "company" : "companies"}${overview.industryCount ? ` across ${number(overview.industryCount)} SEC ${overview.industryCount === 1 ? "industry" : "industries"}` : ""}`
              : "Your holdings"}
            {overview.fundCount > 0
              ? `${overview.companyCount ? ", plus" : " include"} ${number(overview.fundCount)} ${overview.fundCount === 1 ? "fund" : "funds"}`
              : ""}
            .
            {overview.complete && overview.topFiveWeight !== null
              ? ` The ${Math.min(5, report.issuerCount) === 1 ? "largest holding represents" : `${Math.min(5, report.issuerCount)} largest holdings represent`} ${percent(overview.topFiveWeight)} of the allocation.`
              : " Explore the mix and the financial picture below."}
          </p>
        </div>
        <div className={s.sourceStamp}><FileText size={16} aria-hidden="true" /><span>SEC financial evidence<small>{capturedDate ? `Captured ${capturedDate}` : "From your research snapshot"}</small></span></div>
      </header>
      {(report.unresolvedCount > 0 ||
        (report.weighted && !overview.complete)) && (
        <p className={s.notice}>
          {report.unresolvedCount > 0 &&
            `${report.unresolvedCount} ${report.unresolvedCount === 1 ? "position needs" : "positions need"} identification. `}
          {report.weighted &&
            !overview.complete &&
            "Allocation needs review. The breakdown below uses identified company counts until the weights are complete."}
          <button
            type="button"
            onClick={() =>
              onNavigate(report.weighted ? "concentration" : "coverage")
            }
          >
            Review <ArrowRight size={14} aria-hidden="true" />
          </button>
        </p>
      )}
      <div className={s.stats}>
        <button type="button" onClick={onOpenHoldings || (() => onNavigate("concentration"))}>
          <span>
            {overview.companyCount
              ? "Companies"
              : overview.fundCount
                ? "Funds"
                : "Positions to identify"}
          </span>
          <strong>
            {number(
              overview.companyCount ||
                overview.fundCount ||
                report.unresolvedCount,
            )}
          </strong>
          <small>
            {overview.fundCount > 0 && overview.companyCount > 0
              ? `${overview.fundCount} ${overview.fundCount === 1 ? "fund tracked separately" : "funds tracked separately"}`
              : "Share classes combined"}
          </small>
        </button>
        {(overview.complete || overview.industryCount > 0) && (
          <button type="button" onClick={() => onNavigate("concentration")}>
            <span>
              {overview.complete
                ? `Top ${Math.min(5, report.issuerCount)} holdings`
                : "SEC industries"}
            </span>
            <strong>
              {overview.complete
                ? percent(overview.topFiveWeight ?? 0)
                : number(overview.industryCount)}
            </strong>
            <small>
              {overview.complete
                ? "Share of the allocation"
                : "Among identified companies"}
            </small>
          </button>
        )}
        {overview.companyCount > 0 && (
          <button type="button" onClick={() => onNavigate("coverage")}>
            <span>Financial evidence</span>
            <strong>
              {overview.complete ? (
                percent(overview.financialWeight ?? 0)
              ) : (
                <>
                  {number(overview.financialCount)}
                  <em> / {number(overview.companyCount)}</em>
                </>
              )}
            </strong>
            <small>
              {overview.complete
                ? `Of allocation · ${overview.financialCount} of ${overview.companyCount} companies`
                : "Companies with financial measures"}
            </small>
          </button>
        )}
      </div>
      <div className={s.body}>
        <section className={s.mix} aria-label="Portfolio composition">
          <div className={s.sectionHeading}>
            <h4>
              {overview.complete
                ? "Where the portfolio is invested"
                : overview.companyCount
                  ? "The company mix"
                  : "Fund holdings"}
            </h4>
            <span>
              {overview.complete
                ? "Allocation"
                : overview.companyCount
                  ? "Company counts"
                  : "Holding counts"}
            </span>
          </div>
          {overview.mix.length > 0 ? (
            <div className={s.composition}>
              <div className={s.ring} onMouseLeave={() => setHighlighted(null)}>
                <svg viewBox="0 0 220 220" aria-hidden="true">
                  <circle cx="110" cy="110" r="88" fill="none" stroke="var(--p-line, #29364c)" strokeWidth="25" />
                  {segments.map((entry: any) => <circle key={entry.label} cx="110" cy="110" r="88" pathLength="100" fill="none" stroke={entry.color} strokeWidth={highlighted === entry.label ? 32 : 25}
                    strokeDasharray={`${Math.max(0, entry.portion * 100 - Math.min(.7, entry.portion * 20))} 100`} strokeDashoffset={-entry.start * 100} transform="rotate(-90 110 110)"
                    opacity={!highlighted || highlighted === entry.label ? 1 : .28} onMouseEnter={() => setHighlighted(entry.label)} />)}
                </svg>
                <div className={s.ringCenter}><strong>{selected ? overview.complete ? percent(selected.value) : number(selected.value) : number(overview.companyCount || overview.fundCount)}</strong><span>{selected ? selected.label === "Funds (company metrics not applicable)" ? "Funds" : selected.label : overview.companyCount ? "companies" : "funds"}</span><small>{selected ? overview.complete ? "of the allocation" : "in this group" : "Explore the mix"}</small></div>
              </div>
              <ul className={s.mixList}>
                {overview.mix.map((entry, index) => (
                  <li key={entry.label}>
                    <span
                      className={s.dot}
                      data-color={index}
                      aria-hidden="true"
                    />
                    <span>
                      <button
                        type="button"
                        className={s.groupLink}
                        onMouseEnter={() => setHighlighted(entry.label)}
                        onMouseLeave={() => setHighlighted(null)}
                        onFocus={() => setHighlighted(entry.label)}
                        onBlur={() => setHighlighted(null)}
                        onClick={() =>
                          onExploreGroup && overview.companyCount > 0
                            ? onExploreGroup(overview.mixDimension, entry.label)
                            : onNavigate("concentration")
                        }
                        aria-label={`Explore ${entry.label}`}
                      >
                        {entry.label ===
                        "Funds (company metrics not applicable)"
                          ? "Funds"
                          : entry.label}
                      </button>
                    </span>
                    <strong>
                      {overview.complete
                        ? percent(entry.value)
                        : number(entry.value)}
                    </strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={s.context}>
              Identify your holdings to see the portfolio mix.
            </p>
          )}
          {overview.companyCount > 0 && (
            <div className={s.classificationNote}>
              <p>
                {overview.mixDimension === "sector"
                  ? `Fund-reported sectors · ${overview.sectorCompanyCount} of ${overview.companyCount} companies covered`
                  : `SEC industries · ${overview.industryCompanyCount} of ${overview.companyCount} companies classified`}
              </p>
              {overview.sectorSources.length > 0 && (
                <p>
                  iShares holdings as of{" "}
                  {[
                    ...new Set(
                      overview.sectorSources.map((source: any) => source.asOf),
                    ),
                  ].join(", ")}
                  .{" "}
                  {overview.sectorSources.map((source: any, index: number) => (
                    <span key={source.url}>
                      {index > 0 ? " · " : ""}
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.fund} source ↗
                      </a>
                    </span>
                  ))}
                </p>
              )}
              {overview.mixDimension === "sector" &&
                overview.sectorCompanyCount < overview.companyCount && (
                  <p>
                    Companies outside the sector reference keep their SEC
                    industry. Funds are shown separately without looking through
                    to their holdings.
                  </p>
                )}
            </div>
          )}
          {overview.largestHoldings.length > 0 && (
            <div className={s.holdings}>
              <p>Largest holdings</p>
              <div>
                {overview.largestHoldings.map((holding: any) => (
                  <button
                    type="button"
                    key={holding.cik}
                    onClick={() => onInspectCompany(holding.rowIds[0])}
                    title={holding.name}
                  >
                    {holding.tickers.join(" / ") || holding.name}
                    <span>{percent(holding.weightPct)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            className={s.link}
            type="button"
            onClick={() => onNavigate("concentration")}
          >
            Explore sectors & industries{" "}
            <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        </section>
        {overview.companyCount > 0 ? (
          <section
            className={s.financial}
            aria-label="Company financial snapshot"
          >
            <div className={s.sectionHeading}>
              <h4>How the companies are doing</h4>
            </div>
            {overview.pulse.length > 0 ? (
              <>
                <div className={s.pulse}>
                  {overview.pulse.map((entry) => (
                    <button type="button" key={entry.id} data-tone={entry.tone} onClick={() => onNavigate("financial")}>
                      <div className={s.pulseHeading}>
                        <span>{entry.label}</span>
                        <strong>
                          {entry.count}
                          <em> / {entry.measured}</em>
                        </strong>
                      </div>
                      <div className={s.pulseBar} aria-hidden="true">
                        <span
                          style={{ width: width(entry.count, entry.measured) }}
                        />
                      </div>
                      <p>
                        {entry.context} · {entry.measured} measured companies
                      </p>
                    </button>
                  ))}
                </div>
                <p className={s.context}>
                  Company counts, based on available reported periods. These are
                  observations, not portfolio returns.
                </p>
              </>
            ) : (
              <p className={s.context}>
                {overview.financialCount > 0
                  ? "Revenue and profitability summaries are not in this capture."
                  : "Capture company financials to see a summary of revenue and profitability here."}
              </p>
            )}
            <button
              className={s.link}
              type="button"
              onClick={() =>
                onNavigate(overview.pulse.length ? "financial" : "coverage")
              }
            >
              {overview.pulse.length
                ? "Explore financials"
                : "Review financial evidence"}{" "}
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          </section>
        ) : (
          <section className={s.financial}>
            <div className={s.sectionHeading}>
              <h4>
                {overview.fundCount
                  ? "About your fund holdings"
                  : "Start with your holdings"}
              </h4>
            </div>
            <p className={s.context}>
              {overview.fundCount
                ? "Funds are shown as direct holdings. Company financial measures do not look through to the investments inside each fund."
                : "Resolve your positions to build the portfolio overview."}
            </p>
            <button
              className={s.link}
              type="button"
              onClick={() => onNavigate("coverage")}
            >
              Review holdings <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          </section>
        )}
      </div>
      <div className={s.researchPaths}>
        <button type="button" className={s.marketPath} onClick={onOpenMarkets || (() => onNavigate("concentration"))}>
          <span className={s.pathIcon}><Network size={24} aria-hidden="true" /></span><span className={s.pathCopy}><span className={s.pathEyebrow}>SEC CONNECTIONS · CFTC CONTEXT</span><strong>Look beyond the sector labels.</strong><span>Find companies with links to the same markets, then explore futures positioning.</span><span className={s.pathAction}>Explore shared markets <ArrowRight size={15} aria-hidden="true" /></span></span>
        </button>
        {onOpenChanges && <button type="button" className={s.changesPath} onClick={onOpenChanges}><span className={s.pathIcon}><Activity size={24} aria-hidden="true" /></span><span className={s.pathCopy}><span className={s.pathEyebrow}>YOUR NEXT REVIEW</span><strong>See what has changed.</strong><span>Follow recent SEC filings, changes in financial evidence, and related CFTC updates.</span><span className={s.pathAction}>Review recent updates <ArrowRight size={15} aria-hidden="true" /></span></span></button>}
      </div>
      <p className={s.marketNote}>CFTC describes aggregate futures positioning. Filing connections do not measure the size of a company’s exposure.</p>
      {overview.companyCount > 0 && (
        <footer className={s.footer}>
          <p>
            {overview.financialCount > 0
              ? `Financial evidence at ${overview.financialCount} of ${overview.companyCount} companies. `
              : "Financial evidence is ready to be added. "}
            {overview.missingFinancialCount > 0
              ? `${overview.missingFinancialCount} ${overview.missingFinancialCount === 1 ? "company has" : "companies have"} no financial measures. `
              : ""}
            Coverage means at least one measure; reporting dates and individual
            measures vary.
            {overview.fundCount > 0 &&
              " Fund holdings are excluded from company financial measures."}
            {report.coverage.staleCount > 0
              ? ` ${report.coverage.staleCount} ${report.coverage.staleCount === 1 ? "company may" : "companies may"} need a refresh.`
              : ""}
          </p>
          <button type="button" onClick={() => onNavigate("coverage")}>
            <ShieldCheck size={15} aria-hidden="true" /> Data coverage <ArrowRight size={16} aria-hidden="true" />
          </button>
        </footer>
      )}
    </section>
  );
}
