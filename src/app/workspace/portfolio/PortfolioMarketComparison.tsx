"use client";

import { useId, useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import s from "./PortfolioMarketComparison.module.css";

type SortOrder = "holdings" | "allocation" | "movement" | "date";

type Props = {
  markets: any[];
  allocationAvailable: boolean;
  eligibleCompanies: number;
  basis: "companies" | "allocation";
  selectedKey: string | null;
  onSelect: (key: string) => void;
  summaries: Record<string, { status: "ready" | "unavailable"; summary: any | null }>;
  loading: boolean;
  error?: string;
  onRetry: () => void;
};

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const percent = (value: unknown) => finite(value) ? `${number.format(value)}%` : "—";
const signed = (value: number) => `${value > 0 ? "+" : ""}${number.format(value)}`;
function date(value: unknown) {
  if (typeof value !== "string" || !value) return "Date unavailable";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? dateFormat.format(timestamp) : "Date unavailable";
}

function Range({ summary }: { summary: any }) {
  const range = summary?.range;
  if (!range || !finite(range.min) || !finite(range.max)) {
    return (
      <div className={s.rangeEmpty}>
        <span>Range unavailable</span>
        <small>{summary?.observationCount ?? 0} valid observations</small>
      </div>
    );
  }
  const position = finite(range.position) ? Math.min(100, Math.max(0, range.position)) : null;
  const description = `Observed net positioning range: ${percent(range.min)} to ${percent(range.max)} of open interest. ${range.count} observations${position === null ? ". No distinct range location." : `; latest report is ${number.format(position)} percent of the distance from the observed minimum to maximum.`}`;
  return (
    <div className={s.range}>
      <div className={s.rangeRail} role="img" aria-label={description}>
        <span className={s.rangeMiddle} />
        {position !== null && <span className={s.rangeDot} style={{ left: `${position}%` }} />}
      </div>
      <div className={s.rangeEnds}><span>{percent(range.min)}</span><span>{percent(range.max)}</span></div>
      <small>{range.count} observations</small>
      {range.start && range.end && (
        <small className={s.rangeDates}>{date(range.start)} – {date(range.end)}</small>
      )}
    </div>
  );
}

export default function PortfolioMarketComparison({
  markets,
  allocationAvailable,
  eligibleCompanies,
  basis,
  selectedKey,
  onSelect,
  summaries,
  loading,
  error,
  onRetry,
}: Props) {
  const headingId = useId();
  const sortId = useId();
  const [sort, setSort] = useState<SortOrder>("holdings");
  const effectiveSort = sort === "allocation" && !allocationAvailable ? "holdings" : sort;
  const orderedMarkets = useMemo(() => {
    const value = (market: any): number | null => {
      if (effectiveSort === "holdings") return finite(market.count) ? market.count : null;
      if (effectiveSort === "allocation") return finite(market.allocationPct) ? market.allocationPct : null;
      const summary = summaries[market.key]?.summary;
      if (effectiveSort === "movement") return finite(summary?.weeklyChangePp) ? Math.abs(summary.weeklyChangePp) : null;
      const timestamp = summary?.reportDate ? Date.parse(summary.reportDate) : NaN;
      return Number.isFinite(timestamp) ? timestamp : null;
    };
    return [...markets].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      return (b ?? 0) - (a ?? 0) || right.count - left.count || left.label.localeCompare(right.label);
    });
  }, [markets, summaries, effectiveSort]);
  const readyCount = markets.filter((market) => summaries[market.key]?.status === "ready").length;
  const unavailableCount = markets.filter((market) => summaries[market.key]?.status === "unavailable").length;
  const staleCount = markets.filter((market) => summaries[market.key]?.summary?.stale).length;

  return (
    <section className={s.root} aria-labelledby={headingId}>
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>SEC CONNECTIONS · CFTC POSITIONING</p>
          <h4 id={headingId}>Compare connected markets</h4>
          <p>See the holdings behind each connection, then open a market for its filing evidence and positioning history.</p>
        </div>
        <label className={s.sort} htmlFor={sortId}>
          Sort markets
          <select id={sortId} value={effectiveSort} onChange={(event) => setSort(event.target.value as SortOrder)}>
            <option value="holdings">Linked holdings</option>
            {allocationAvailable && <option value="allocation">Linked allocation</option>}
            <option value="movement">Largest weekly move</option>
            <option value="date">Latest report</option>
          </select>
        </label>
      </div>
      <div className={s.status} role="status" aria-live="polite">
        <span>{loading ? "Loading CFTC comparisons…" : `${readyCount} of ${markets.length} market${markets.length === 1 ? "" : "s"} with CFTC context`}</span>
        {(error || unavailableCount > 0 || staleCount > 0) && !loading && (
          <>
            {(error || unavailableCount > 0) && <span className={s.statusMessage}>{error || "Some CFTC context is unavailable. Filing connections remain available."}</span>}
            <button type="button" className={s.retry} onClick={onRetry}><RefreshCw size={13} aria-hidden="true" />{error || unavailableCount > 0 ? "Retry CFTC" : "Check updates"}</button>
          </>
        )}
      </div>
      <div className={s.tableWrap}>
        <table className={s.table} role="table">
          <caption className={s.srOnly}>Connected markets, holdings, allocation in linked companies, CFTC net positioning, weekly change, observed range and report dates. Select a market to open its evidence.</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Market / trader group</th>
              <th scope="col" role="columnheader">Linked holdings</th>
              <th scope="col" role="columnheader">Net / open interest<small>Weekly change</small></th>
              <th scope="col" role="columnheader">Observed 52-week range<small>Net / open interest</small></th>
              <th scope="col" role="columnheader">CFTC report date</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {orderedMarkets.map((market) => {
              const entry = summaries[market.key];
              const summary = entry?.status === "ready" ? entry.summary : null;
              const pending = !entry && loading;
              const missingLabel = pending ? "Loading…" : "Unavailable";
              const allocation = allocationAvailable && finite(market.allocationPct) ? market.allocationPct : null;
              const barValue = basis === "allocation" && allocation !== null ? allocation : eligibleCompanies > 0 ? market.count / eligibleCompanies * 100 : 0;
              return (
                <tr key={market.key} role="row" data-selected={selectedKey === market.key}>
                  <th scope="row" role="rowheader" className={s.marketCell}>
                    <button type="button" className={s.marketButton} aria-pressed={selectedKey === market.key} onClick={() => onSelect(market.key)} aria-label={`Review ${market.label}, ${market.groupLabel}: ${market.count} linked holdings${allocation !== null ? `, ${number.format(allocation)} percent allocation in linked companies` : ""}`}>
                      <span className={s.marketTitle}>{market.label}<ArrowUpRight size={15} aria-hidden="true" /></span>
                      <span className={s.group}>{market.groupLabel}</span>
                      <span className={s.marketMeta}>{market.family === "tff" ? "Financial futures" : "Commodity futures"}{market.contract === "043602" ? " · Rates proxy" : ""}</span>
                    </button>
                  </th>
                  <td role="cell" data-label="Linked holdings">
                    <strong className={s.value}>{market.count}<small> / {eligibleCompanies}</small></strong>
                    <span className={s.secondary}>{allocation !== null ? `${percent(allocation)} allocation` : "Allocation unavailable"}</span>
                    <div className={s.allocationRail} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, barValue))}%` }} /></div>
                    <small className={s.sectors}>{market.sectorCount} sector{market.sectorCount === 1 ? "" : "s"}</small>
                  </td>
                  <td role="cell" data-label="Net / open interest">
                    {summary ? <>
                      <strong className={s.value}>{percent(summary.netPctOi)}</strong>
                      <span className={s.change}>{finite(summary.weeklyChangePp) ? `${signed(summary.weeklyChangePp)} pp` : "Weekly change unavailable"}</span>
                      {finite(summary.weeklyChangePp) && <small className={s.secondary}>vs. {date(summary.priorDate)}</small>}
                    </> : <span className={s.missing}>{missingLabel}</span>}
                  </td>
                  <td role="cell" data-label="Observed 52-week range">{summary ? <Range summary={summary} /> : <span className={s.missing}>{missingLabel}</span>}</td>
                  <td role="cell" data-label="CFTC report date">
                    {summary ? <>
                      <time className={s.reportDate} dateTime={summary.reportDate}>{date(summary.reportDate)}</time>
                      {summary.stale && <span className={s.ageBadge}>Older snapshot{finite(summary.ageDays) ? ` · ${summary.ageDays}d` : ""}</span>}
                      {summary.incomplete && <span className={s.historyBadge}>Partial history</span>}
                    </> : <span className={s.missing}>{missingLabel}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!markets.length && <p className={s.empty}>No connected markets in this view.</p>}
      </div>
      <details className={s.methodology}>
        <summary>How to read this comparison</summary>
        <div>
          <p><strong>Connections are not measured exposure.</strong> Holdings counts identify companies with source-backed filing links. Allocation is the share of the full portfolio invested in those companies; it does not estimate commodity exposure, hedges or price sensitivity. Companies can connect to several markets, so rows overlap and should not be added together.</p>
          <p><strong>Positioning uses each market’s stated trader group.</strong> Net / open interest is long minus short positions, divided by open interest. Weekly change compares reports exactly seven days apart, using each report’s own open interest, and is shown in percentage points (pp). Trader groups and markets differ; a larger value is not a better investment.</p>
          <p><strong>The range shows available observations in the 52-week window ending on the latest report.</strong> Its dot locates the latest value between the observed minimum and maximum. It is not a percentile or a prediction. Partial history, missing weekly comparisons and older report dates remain visible; missing data is never treated as zero.</p>
        </div>
      </details>
    </section>
  );
}
