"use client";

import { useMemo } from "react";
import { ArrowUpRight, ArrowRight } from "lucide-react";
import { buildPortfolioOverview } from "../../../utils/portfolioOverview.js";
import s from "./PortfolioBriefing.module.css";

const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const percent = (value: number) => `${number(value)}%`;
const width = (value: number, total: number) =>
  `${total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0}%`;

export default function PortfolioBriefing({
  report,
  onNavigate,
  onInspectCompany,
}: {
  report: any;
  onNavigate: (area: string) => void;
  onInspectCompany: (rowId: string) => void;
}) {
  const overview = useMemo(() => buildPortfolioOverview(report), [report]);
  if (!report.holdingCount) return null;
  return (
    <section className={s.root} aria-label="Portfolio briefing">
      <header className={s.heading}>
        <div>
          <h3>Portfolio at a glance</h3>
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
        <div>
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
        </div>
        {(overview.complete || overview.industryCount > 0) && (
          <div>
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
          </div>
        )}
        {overview.companyCount > 0 && (
          <div>
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
          </div>
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
            <>
              <div className={s.mixBar} aria-hidden="true">
                {overview.mix.map((entry, index) => (
                  <span
                    key={entry.label}
                    data-color={index}
                    style={{ width: width(entry.value, overview.mixTotal) }}
                  />
                ))}
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
                      {entry.label === "Funds (company metrics not applicable)"
                        ? "Funds"
                        : entry.label}
                    </span>
                    <strong>
                      {overview.complete
                        ? percent(entry.value)
                        : number(entry.value)}
                    </strong>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className={s.context}>
              Identify your holdings to see the portfolio mix.
            </p>
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
            Explore concentration <ArrowUpRight size={16} aria-hidden="true" />
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
                    <div key={entry.id} data-tone={entry.tone}>
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
                    </div>
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
                ? "Explore financial profile"
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
            Evidence coverage <ArrowRight size={16} aria-hidden="true" />
          </button>
        </footer>
      )}
    </section>
  );
}
