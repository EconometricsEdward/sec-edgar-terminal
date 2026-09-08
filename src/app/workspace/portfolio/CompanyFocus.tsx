"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { ArrowUpRight, FileText, X } from "lucide-react";
import {
  portfolioNumber,
  finiteFinancialMetric,
} from "../../../utils/portfolioModel.js";
import s from "./CompanyFocus.module.css";

type Props = {
  row: any;
  company: any;
  relatedRows: any[];
  allocations: any[];
  onClose: () => void;
  onInspectMetric: (key: string, point: any) => void;
  onCreateBrief?: (draft: any) => void;
  onSaveFiling?: (filing: any) => void;
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const secUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const percent = (value: number) =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const numberText = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 3 });
function metricValue(point: any, compact = false) {
  if (!finiteFinancialMetric(point))
    return point?.classification === "not_applicable"
      ? "Not applicable"
      : "Unavailable";
  if (point.unit === "%") return percent(point.value);
  if (point.unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 2 : 0,
    }).format(point.value);
  return `${numberText(point.value)}${point.unit && point.unit !== "ratio" ? ` ${point.unit}` : ""}`;
}
const METRICS: Record<string, [string, string][]> = {
  corporate: [
    ["revenue", "Revenue"],
    ["netIncome", "Net income"],
    ["operatingCashFlow", "Operating cash flow"],
    ["freeCashFlow", "Free cash flow"],
    ["cash", "Cash"],
    ["debt", "Reported debt"],
    ["revenueGrowth", "Revenue growth"],
    ["operatingMargin", "Operating margin"],
    ["netMargin", "Net margin"],
    ["roe", "Return on equity"],
    ["roa", "Return on assets"],
    ["debtAssets", "Reported debt / assets"],
    ["currentRatio", "Current ratio"],
  ],
  banking: [
    ["bankRevenue", "Net interest + noninterest income"],
    ["netIncome", "Net income"],
    ["deposits", "Deposits"],
    ["loans", "Reported net loans"],
    ["loanDeposits", "Net loans / deposits"],
    ["roe", "Return on equity"],
    ["roa", "Return on assets"],
  ],
  insurance: [
    ["premiumsEarned", "Net premiums earned"],
    ["investmentIncome", "Investment income"],
    ["netIncome", "Net income"],
    ["totalAssets", "Total assets"],
    ["stockholdersEquity", "Equity"],
    ["roe", "Return on equity"],
  ],
  common: [
    ["netIncome", "Net income"],
    ["totalAssets", "Total assets"],
    ["stockholdersEquity", "Equity"],
    ["cash", "Cash"],
    ["roe", "Return on equity"],
    ["roa", "Return on assets"],
  ],
};

export default function CompanyFocus({
  row,
  company,
  relatedRows,
  allocations,
  onClose,
  onInspectMetric,
  onCreateBrief,
  onSaveFiling,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    headingRef.current?.focus();
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const identity = row?.resolution || {};
  const cik = /^\d{10}$/.test(company?.cik || identity.cik || "")
    ? company?.cik || identity.cik
    : "";
  const ticker =
    (identity.status === "resolved" || identity.status === "unsupported"
      ? identity.ticker
      : "") ||
    company?.ticker ||
    "";
  const name =
    company?.name ||
    identity.name ||
    row?.input?.company_name ||
    ticker ||
    "Unidentified position";
  const fund = company?.kind === "fund" || identity.kind === "fund";
  const lens = METRICS[company?.lens] ? company.lens : "common";
  const summaryMetrics = METRICS[lens];
  const filings = (company?.filings || [])
    .filter((filing: any) => secUrl(filing.documentUrl))
    .slice(0, 8);
  const positionRows = relatedRows.length ? relatedRows : [row];
  const included = positionRows.filter(
    (entry: any) => !entry.excluded && entry.duplicateChoice !== "remove",
  );
  const byRow = new Map(allocations.map((entry: any) => [entry.rowId, entry]));
  const known = included
    .map((entry: any) => byRow.get(entry.id)?.weightPct)
    .filter(finite);
  const weight = known.reduce(
    (total: number, value: number) => total + value,
    0,
  );
  const warnings = [
    ...new Set<string>(
      [...(identity.warnings || []), ...(company?.warnings || [])].filter(
        (warning) => typeof warning === "string",
      ),
    ),
  ];
  const fundHref =
    typeof company?.fundUrl === "string" &&
    /^\/fund(?:\?tickers=[A-Z0-9][A-Z0-9.%,-]{0,60})?$/.test(company.fundUrl)
      ? company.fundUrl
      : ticker
        ? `/fund?tickers=${encodeURIComponent(ticker)}`
        : "/fund";
  const retrieval =
    company?.refreshStatus === "not_checked"
      ? "Not checked in the last refresh"
      : company?.refreshStatus === "pending"
        ? "Refresh pending"
        : company?.refreshStatus === "failed"
          ? "Last refresh failed"
          : company?.cache?.status === "stale"
            ? "Older cached evidence"
            : company?.status === "failed"
              ? "Retrieval failed"
              : company?.status === "partial"
                ? "Partial evidence"
                : company?.status === "ready"
                  ? "Evidence available"
                  : company?.status === "unsupported"
                    ? "Company analysis unavailable"
                    : "Research not retrieved";

  return (
    <dialog
      ref={dialogRef}
      className={s.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className={s.content}>
        <header className={s.header}>
          <div>
            <p className={s.eyebrow}>
              {fund ? "Fund focus" : "Company focus"}
              {ticker ? ` · ${ticker}` : ""}
            </p>
            <h2 ref={headingRef} id={titleId} tabIndex={-1}>
              {name}
            </h2>
            <p id={descriptionId}>
              {cik ? `CIK ${cik}` : "Identity needs review"}
              {company?.sicDescription
                ? ` · ${company.sicDescription}`
                : company?.industry
                  ? ` · ${company.industry}`
                  : ""}
            </p>
          </div>
          <button
            className={s.close}
            type="button"
            onClick={onClose}
            aria-label="Close company focus"
          >
            <X size={22} />
          </button>
        </header>

        <div className={s.summary}>
          <div>
            <span>Research status</span>
            <strong>{retrieval}</strong>
            <small>
              {company?.retrievedAt
                ? `Retrieved ${company.retrievedAt.slice(0, 10)}`
                : "Run portfolio research to retrieve SEC evidence."}
            </small>
          </div>
          <div>
            <span>Selected reporting period</span>
            <strong>{company?.period?.end || "Unavailable"}</strong>
            <small>
              {company?.period?.kind === "ttm"
                ? "Trailing twelve months"
                : company?.period?.kind === "annual"
                  ? "Annual reporting"
                  : "No supported period"}
              {company?.period?.start ? ` · from ${company.period.start}` : ""}
            </small>
          </div>
          <div>
            <span>Included positions</span>
            <strong>{included.length}</strong>
            <small>
              {known.length
                ? `${percent(weight)} ${known.length === included.length ? "combined modeled weight" : `known weight · ${known.length}/${included.length} positions weighted`}`
                : "No modeled allocation supplied"}
            </small>
          </div>
        </div>

        <div className={s.actions}>
          {onCreateBrief && (
            <button
              className={s.primary}
              type="button"
              onClick={() => {
                onClose();
                onCreateBrief({
                  title: `Review ${name}`.slice(0, 200),
                  question: fund
                    ? `What does the latest portfolio disclosure show about ${name}'s holdings and concentration?`
                    : `What changed in ${name}'s latest SEC evidence, and what supports or challenges the research thesis?`,
                  cik,
                  ticker,
                  sources: filings.slice(0, 5).map((filing: any) => ({
                    label: `${filing.form} · ${filing.filingDate}`,
                    url: secUrl(filing.documentUrl),
                    annotation: "context",
                    origin: "Company focus",
                    capturedAt:
                      company?.retrievedAt || new Date().toISOString(),
                  })),
                });
              }}
            >
              <FileText size={17} /> Start a research brief
            </button>
          )}
          {fund ? (
            <Link href={fundHref}>
              Open fund holdings <ArrowUpRight size={15} />
            </Link>
          ) : (
            <>
              {ticker && (
                <Link href={`/analysis/${encodeURIComponent(ticker)}`}>
                  Financial analysis <ArrowUpRight size={15} />
                </Link>
              )}
              {ticker && (
                <Link href={`/risk?ticker=${encodeURIComponent(ticker)}`}>
                  Risk research <ArrowUpRight size={15} />
                </Link>
              )}
            </>
          )}
          {(ticker || cik) && (
            <Link
              href={`/disclosures?tickers=${encodeURIComponent(ticker || cik)}&mode=companies`}
            >
              Search disclosures <ArrowUpRight size={15} />
            </Link>
          )}
          {cik && (
            <a
              href={`https://www.sec.gov/edgar/browse/?CIK=${cik}&owner=exclude`}
              target="_blank"
              rel="noreferrer"
            >
              SEC issuer page <ArrowUpRight size={15} />
            </a>
          )}
        </div>

        {fund ? (
          <section className={s.note}>
            <h3>Read the fund’s portfolio evidence</h3>
            <p>
              This is a fund position. Holdings, security exposure and
              concentration belong in the Funds workspace. Corporate revenue,
              cash flow and banking ratios are not applied to this position.
            </p>
          </section>
        ) : (
          <section>
            <div className={s.sectionHeading}>
              <h3>
                {lens === "banking"
                  ? "Banking fundamentals"
                  : lens === "insurance"
                    ? "Insurance fundamentals"
                    : lens === "corporate"
                      ? "Operating fundamentals"
                      : "Common financial measures"}
              </h3>
              <span>Values retain their own period, unit and source.</span>
            </div>
            <div className={s.metrics}>
              {summaryMetrics.map(([key, label]) => {
                const point = company?.metrics?.[key];
                const sources = (point?.sources || []).filter((source: any) =>
                  secUrl(source.documentUrl),
                );
                return (
                  <article className={s.metric} key={key}>
                    <h4>{point?.label || label}</h4>
                    <strong>{metricValue(point, true)}</strong>
                    {finiteFinancialMetric(point) && (
                      <small>
                        {metricValue(point)}
                        {point.unit === "USD" ? " USD" : ""}
                      </small>
                    )}
                    <p>
                      {point?.period?.end
                        ? `Period ending ${point.period.end}`
                        : "Period unavailable"}{" "}
                      ·{" "}
                      {point?.classification === "calculated"
                        ? "Calculated"
                        : point?.classification === "reported"
                          ? "Reported"
                          : point?.classification === "not_applicable"
                            ? "Not applicable"
                            : finiteFinancialMetric(point)
                              ? "SEC evidence"
                              : "Missing evidence"}
                    </p>
                    {!finiteFinancialMetric(point) && (
                      <p>
                        {point?.reason || "No supported value was retrieved."}
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={!point}
                      onClick={() => {
                        onClose();
                        onInspectMetric(key, point);
                      }}
                    >
                      Inspect{" "}
                      {sources.length
                        ? `${sources.length} source${sources.length === 1 ? "" : "s"}`
                        : "evidence"}{" "}
                      <ArrowUpRight size={14} />
                    </button>
                  </article>
                );
              })}
            </div>
            {company?.lens === "common" && (
              <p className={s.muted}>
                Common measures are used because this company’s business model
                needs a separate assessment from industrial companies and
                deposit-taking banks.
              </p>
            )}
          </section>
        )}

        <section>
          <h3>Positions in this issuer</h3>
          <p className={s.muted}>
            Issuer evidence is retrieved once. Your original positions and share
            classes stay separate.
          </p>
          <div
            className={s.tableScroll}
            role="region"
            aria-label="Positions in this issuer"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Position</th>
                  <th scope="col">Included</th>
                  <th scope="col">Modeled weight</th>
                  <th scope="col">Entered weight</th>
                  <th scope="col">As of</th>
                </tr>
              </thead>
              <tbody>
                {positionRows.map((entry: any) => {
                  const allocation = byRow.get(entry.id);
                  const enteredWeight = portfolioNumber(
                    entry.input?.weight_pct,
                  );
                  const included =
                    !entry.excluded && entry.duplicateChoice !== "remove";
                  return (
                    <tr key={entry.id}>
                      <th scope="row">
                        {entry.resolution?.ticker ||
                          entry.input?.ticker ||
                          entry.input?.company_name ||
                          "CIK position"}
                      </th>
                      <td>{included ? "Yes" : "Excluded"}</td>
                      <td>
                        {included && finite(allocation?.weightPct)
                          ? percent(allocation.weightPct)
                          : "—"}
                      </td>
                      <td>
                        {enteredWeight !== null ? percent(enteredWeight) : "—"}
                      </td>
                      <td>{entry.input?.as_of_date || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className={s.sectionHeading}>
            <h3>Latest source filings</h3>
            <span>
              {company?.filingCoverage?.scope || "Retrieved SEC filing history"}
            </span>
          </div>
          {filings.length ? (
            <ul className={s.filings}>
              {filings.map((filing: any) => (
                <li key={filing.accession || filing.documentUrl}>
                  <div>
                    <a
                      href={secUrl(filing.documentUrl)!}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {filing.form} <ArrowUpRight size={14} />
                    </a>
                    <strong>{filing.description || "SEC filing"}</strong>
                    <span>
                      Filed {filing.filingDate}
                      {filing.reportDate
                        ? ` · report ${filing.reportDate}`
                        : ""}
                    </span>
                  </div>
                  {onSaveFiling && (
                    <button
                      type="button"
                      onClick={() =>
                        onSaveFiling({
                          ...filing,
                          cik,
                          ticker,
                          companyName: name,
                        })
                      }
                    >
                      Save filing
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.note}>
              No source filings are available in the current snapshot. Run
              research or open the SEC issuer page.
            </p>
          )}
        </section>

        {warnings.length > 0 && (
          <section className={s.note}>
            <h3>Evidence and coverage notes</h3>
            <ul>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        )}
        <footer className={s.footer}>
          <span>
            Historical SEC evidence · research context, not a trading
            recommendation
          </span>
          <button type="button" onClick={onClose}>
            Return to portfolio
          </button>
        </footer>
      </div>
    </dialog>
  );
}
