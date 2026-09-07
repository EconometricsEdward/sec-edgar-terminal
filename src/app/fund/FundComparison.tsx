"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Download, RefreshCw, BookmarkPlus } from "lucide-react";
import { money, pct } from "./fundUi";
import s from "./fund.module.css";
import c from "./FundComparison.module.css";

type Settings = {
  reportMap?: Record<string, string>;
  comparisonLeft?: string;
  comparisonRight?: string;
  comparisonScope?: string;
  comparisonQuery?: string;
};
type Evidence = {
  ticker: string;
  name?: string;
  asOf: string;
  filingDate: string;
  accession: string;
  sourceUrl: string;
};
type FundMeta = Evidence & {
  seriesId: string | null;
  classId: string | null;
  reports: {
    accession: string;
    reportDate: string | null;
    filingDate: string;
    form: string;
  }[];
  fundInfo: { netAssets: number | null };
  summary: { count: number };
};
type Row = {
  key: string;
  ids: string[];
  name: string;
  kind: string;
  leftWeight: number;
  rightWeight: number;
  difference: number;
  sharedWeight: number;
  leftPositions: number;
  rightPositions: number;
};
type Pair = {
  left: string;
  right: string;
  overlap: number | null;
  count: number;
  samePeriod: boolean;
  samePortfolio: boolean;
};
type Result = {
  available: boolean;
  reason?: string;
  left: Evidence | null;
  right: Evidence | null;
  samePeriod?: boolean;
  gapDays?: number | null;
  samePortfolio?: boolean;
  overlap?: number | null;
  sharedCount?: number;
  pairs: Pair[];
  coverage: {
    ticker: string;
    totalPositions: number;
    eligiblePositions: number;
    eligibleWeight: number | null;
    excludedPositions: number;
    exclusions: Record<string, number>;
  }[];
  rows: Row[];
  methodology?: string;
};
type ResponseData = {
  funds: FundMeta[];
  errors: { ticker: string; message: string }[];
  resolvedReports: Record<string, string>;
  result: Result;
  pagination: { page: number; pageCount: number; total: number };
};
type Pin = {
  kind: "coverage";
  title: string;
  summary: string;
  values: { label: string; value: number | string | null; unit?: string }[];
  sources: Evidence[];
  methodology?: string;
};

export default function FundComparison({
  tickers,
  settings = {},
  onPatch = () => {},
  onEvidence,
  onFunds,
}: {
  tickers: string[];
  settings?: Settings;
  onPatch?: (patch: Record<string, unknown>) => void;
  onEvidence?: (evidence: Pin) => void;
  onFunds?: (funds: any[]) => void;
}) {
  const [data, setData] = useState<ResponseData | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [page, setPage] = useState(1);
  const [draft, setDraft] = useState(settings.comparisonQuery || "");
  const patchRef = useRef(onPatch);
  const fundsRef = useRef(onFunds);
  useEffect(() => {
    patchRef.current = onPatch;
    fundsRef.current = onFunds;
  }, [onPatch, onFunds]);
  useEffect(() => {
    setDraft(settings.comparisonQuery || "");
  }, [settings.comparisonQuery]);
  const left = tickers.includes(settings.comparisonLeft || "")
    ? settings.comparisonLeft!
    : tickers[0];
  const right =
    tickers.includes(settings.comparisonRight || "") &&
    settings.comparisonRight !== left
      ? settings.comparisonRight!
      : tickers.find((ticker) => ticker !== left);
  const reports = JSON.stringify(
    Object.fromEntries(
      tickers
        .filter((ticker) => settings.reportMap?.[ticker])
        .map((ticker) => [ticker, settings.reportMap![ticker]]),
    ),
  );
  const base = new URLSearchParams({
    mode: "compare",
    tickers: tickers.join(","),
    reports,
    left: left || "",
    right: right || "",
    scope: settings.comparisonScope || "all",
    q: settings.comparisonQuery || "",
  }).toString();
  const url = `/api/fund-workspace?${base}&page=${page}`;
  useEffect(() => {
    setPage(1);
  }, [base]);
  useEffect(() => {
    if (tickers.length < 2) return;
    const controller = new AbortController();
    setData(null);
    setError("");
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(payload.error || "Comparison could not be loaded.");
        if (controller.signal.aborted) return;
        setData(payload);
        fundsRef.current?.(payload.funds);
        const current = JSON.parse(reports);
        const additions = Object.fromEntries(
          Object.entries(payload.resolvedReports).filter(
            ([ticker]) => !current[ticker],
          ),
        );
        if (Object.keys(additions).length)
          patchRef.current({ reportMap: { ...current, ...additions } });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [url, reports, tickers.length, attempt]);
  const result = data?.result;
  const csv = new URLSearchParams(base);
  if (data)
    csv.set(
      "reports",
      JSON.stringify({ ...JSON.parse(reports), ...data.resolvedReports }),
    );
  csv.set("format", "csv");
  const pin = (row: Row) => {
    if (!result?.left || !result.right) return;
    onEvidence?.({
      kind: "coverage",
      title: `${row.name}: ${left} versus ${right}`,
      summary: `Eligible long security weights in ${result.left.asOf} and ${result.right.asOf} portfolios. ${row.ids.join("; ")}.`,
      values: [
        { label: `${left} NAV weight`, value: row.leftWeight, unit: "%" },
        { label: `${right} NAV weight`, value: row.rightWeight, unit: "%" },
        {
          label: `${left} minus ${right}`,
          value: row.difference,
          unit: "percentage points",
        },
        {
          label: "Shared NAV weight",
          value: row.sharedWeight,
          unit: "percentage points",
        },
      ],
      sources: [result.left, result.right],
      methodology: result.methodology,
    });
  };
  return (
    <section
      className={`${s.panel} ${c.panel}`}
      aria-label="Fund comparison results"
    >
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Compare the underlying holdings</p>
          <h2>Find overlap and meaningful differences</h2>
          <p className={c.muted}>
            Choose each report, then investigate every shared or distinct
            eligible security.
          </p>
        </div>
        <button
          className={s.secondary}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw size={14} /> Retry reports
        </button>
      </div>
      {tickers.length < 2 ? (
        <p className={s.notice}>
          Add at least two funds to compare their portfolios.
        </p>
      ) : (
        <>
          <div className={c.controls}>
            <label>
              First fund
              <select
                value={left}
                onChange={(event) =>
                  onPatch({
                    comparisonLeft: event.target.value,
                    comparisonRight:
                      event.target.value === right ? left : right,
                  })
                }
              >
                {tickers.map((ticker) => (
                  <option key={ticker}>{ticker}</option>
                ))}
              </select>
            </label>
            <label>
              Second fund
              <select
                value={right || ""}
                onChange={(event) =>
                  onPatch({ comparisonRight: event.target.value })
                }
              >
                {tickers
                  .filter((ticker) => ticker !== left)
                  .map((ticker) => (
                    <option key={ticker}>{ticker}</option>
                  ))}
              </select>
            </label>
            <label>
              Positions to show
              <select
                value={settings.comparisonScope || "all"}
                onChange={(event) =>
                  onPatch({ comparisonScope: event.target.value })
                }
              >
                <option value="all">All eligible securities</option>
                <option value="shared">Shared eligible securities</option>
                <option value="left">Only in first eligible set</option>
                <option value="right">Only in second eligible set</option>
              </select>
            </label>
            <form
              className={c.search}
              onSubmit={(event) => {
                event.preventDefault();
                onPatch({ comparisonQuery: draft.trim() });
              }}
            >
              <label>
                Search differences
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Security name, CUSIP, or ISIN"
                  maxLength={100}
                />
              </label>
              <button className={s.secondary} type="submit">
                Search
              </button>
            </form>
          </div>
          {error ? (
            <p role="alert" className={s.notice}>
              {error}
            </p>
          ) : !data ? (
            <p role="status" className={s.loading}>
              Reading complete portfolios and reconciling security identifiers…
            </p>
          ) : (
            <>
              {data.errors.length > 0 && (
                <div className={s.notice} role="status">
                  <b>Some reports could not be reviewed.</b>
                  {data.errors.map((failure) => (
                    <p key={failure.ticker}>
                      {failure.ticker}: {failure.message}{" "}
                      <button
                        className={c.inline}
                        onClick={() =>
                          onPatch({
                            reportMap: {
                              ...settings.reportMap,
                              [failure.ticker]: "",
                            },
                          })
                        }
                      >
                        Try latest report
                      </button>
                    </p>
                  ))}
                  <p>
                    Unavailable funds are shown separately from successfully
                    searched portfolios.
                  </p>
                </div>
              )}
              <div className={c.reports}>
                {tickers.map((ticker) => {
                  const fund = data.funds.find(
                    (item) => item.ticker === ticker,
                  );
                  return (
                    <div key={ticker} className={c.report}>
                      <b>{ticker}</b>
                      {fund ? (
                        <>
                          <label>
                            Report for {ticker}
                            <select
                              value={fund.accession}
                              onChange={(event) =>
                                onPatch({
                                  reportMap: {
                                    ...settings.reportMap,
                                    [ticker]: event.target.value,
                                  },
                                })
                              }
                            >
                              {fund.reports.map((report) => (
                                <option
                                  key={report.accession}
                                  value={report.accession}
                                >
                                  {report.reportDate ||
                                    "Period not in report index"}{" "}
                                  · filed {report.filingDate}
                                  {report.form.endsWith("/A")
                                    ? " · amendment"
                                    : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p>
                            {fund.asOf} · {money(fund.fundInfo.netAssets)} NAV ·{" "}
                            {fund.summary.count.toLocaleString()} positions
                          </p>
                          <a
                            href={fund.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            SEC source <ArrowUpRight size={12} />
                          </a>
                        </>
                      ) : (
                        <p>Report unavailable</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className={s.tableWrap}>
                <table className={`${s.table} ${c.matrix}`}>
                  <caption>
                    All selected pairs · shared eligible NAV weight, in
                    percentage points. Select a pair to investigate it.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Fund</th>
                      {tickers.map((ticker) => (
                        <th scope="col" key={ticker}>
                          {ticker}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tickers.map((a) => (
                      <tr key={a}>
                        <th scope="row">{a}</th>
                        {tickers.map((b) => {
                          const pair = result?.pairs.find(
                            (p) =>
                              (p.left === a && p.right === b) ||
                              (p.left === b && p.right === a),
                          );
                          return (
                            <td key={b}>
                              {a === b ? (
                                "—"
                              ) : pair && pair.overlap != null ? (
                                <button
                                  className={c.cell}
                                  aria-label={`Compare ${a} with ${b}, shared weight ${pair.overlap.toFixed(2)} percentage points${pair.samePeriod ? "" : ", different reporting dates"}`}
                                  aria-pressed={
                                    (left === a && right === b) ||
                                    (left === b && right === a)
                                  }
                                  onClick={() =>
                                    onPatch({
                                      comparisonLeft: a,
                                      comparisonRight: b,
                                    })
                                  }
                                >
                                  {pair.overlap.toFixed(2)}
                                  <small>
                                    {pair.samePortfolio
                                      ? "Same portfolio"
                                      : pair.samePeriod
                                        ? "Same date"
                                        : "Different dates"}
                                  </small>
                                </button>
                              ) : (
                                <span className={c.muted}>Unavailable</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!result?.available ? (
                <p className={s.notice}>{result?.reason}</p>
              ) : (
                <>
                  <div className={c.summary}>
                    <div>
                      <b>
                        {result.overlap?.toFixed(2) ?? "—"}
                        <small> percentage points</small>
                      </b>
                      <p>Shared eligible NAV weight</p>
                    </div>
                    <div>
                      <b>{result.sharedCount?.toLocaleString()}</b>
                      <p>Shared identified securities</p>
                    </div>
                    <div>
                      <b>
                        {result.samePeriod
                          ? "Same reporting date"
                          : `${result.gapDays ?? "Unknown"} days apart`}
                      </b>
                      <p>
                        {result.left?.asOf} / {result.right?.asOf}
                      </p>
                    </div>
                  </div>
                  {!result.samePeriod && (
                    <p className={s.notice}>
                      These reports cover different dates. Their differences
                      combine portfolio differences with changes across time.
                      Select matching reporting dates above when available.
                    </p>
                  )}
                  {result.samePortfolio && (
                    <p className={s.notice}>
                      These tickers share the same SEC portfolio. Different
                      share classes can have different fees and prices; the
                      holdings do not create a second independent portfolio.
                    </p>
                  )}
                  <details className={c.coverage}>
                    <summary>What this comparison covers</summary>
                    <p>{result.methodology}</p>
                    {result.coverage
                      .filter((item) => [left, right].includes(item.ticker))
                      .map((item) => (
                        <p key={item.ticker}>
                          <b>{item.ticker}:</b>{" "}
                          {item.eligiblePositions.toLocaleString()} of{" "}
                          {item.totalPositions.toLocaleString()} positions
                          qualify, representing {pct(item.eligibleWeight)} of
                          NAV. {item.excludedPositions.toLocaleString()}{" "}
                          excluded.{" "}
                          {Object.entries(item.exclusions)
                            .map(
                              ([reason, count]) =>
                                `${count} ${reason.toLowerCase()}`,
                            )
                            .join("; ")}
                        </p>
                      ))}
                  </details>
                  <div className={c.resultsHeading}>
                    <h3>
                      {data.pagination.total.toLocaleString()} matching
                      securities
                    </h3>
                    <a
                      className={s.secondary}
                      href={`/api/fund-workspace?${csv}`}
                    >
                      <Download size={14} /> Export all matching differences
                    </a>
                  </div>
                  <p className={c.muted}>
                    Sorted by absolute NAV-weight difference. Zero denotes no
                    eligible matching position; it does not establish zero
                    economic exposure.
                  </p>
                  <div className={s.tableWrap}>
                    <table className={s.table}>
                      <caption>
                        Complete portfolio differences · page{" "}
                        {data.pagination.page} of {data.pagination.pageCount}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Security</th>
                          <th scope="col">{left} / NAV</th>
                          <th scope="col">{right} / NAV</th>
                          <th scope="col">
                            {left} − {right}
                          </th>
                          <th scope="col">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row) => (
                          <tr key={row.key}>
                            <th scope="row">
                              {row.name}
                              <small>{row.ids.join(" · ")}</small>
                              <small>
                                {row.kind === "shared"
                                  ? "Both eligible sets"
                                  : row.kind === "left"
                                    ? `${left} eligible set only`
                                    : `${right} eligible set only`}
                              </small>
                            </th>
                            <td>{pct(row.leftWeight)}</td>
                            <td>{pct(row.rightWeight)}</td>
                            <td>
                              {row.difference > 0 ? "+" : ""}
                              {row.difference.toFixed(2)} pp
                            </td>
                            <td>
                              {onEvidence && (
                                <button
                                  className={s.secondary}
                                  onClick={() => pin(row)}
                                  aria-label={`Pin comparison for ${row.name}`}
                                >
                                  <BookmarkPlus size={14} /> Pin
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!result.rows.length && (
                      <p className={s.empty}>
                        No eligible securities match these filters. Review
                        coverage above or broaden the search.
                      </p>
                    )}
                  </div>
                  <div className={c.pagination}>
                    <button
                      className={s.secondary}
                      disabled={data.pagination.page <= 1}
                      onClick={() => setPage(data.pagination.page - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {data.pagination.page} of {data.pagination.pageCount}
                    </span>
                    <button
                      className={s.secondary}
                      disabled={
                        data.pagination.page >= data.pagination.pageCount
                      }
                      onClick={() => setPage(data.pagination.page + 1)}
                    >
                      Next
                    </button>
                  </div>
                  <div className={c.links}>
                    <Link
                      href={`/fund/${left}?accession=${result.left?.accession}`}
                    >
                      Open {left} portfolio <ArrowUpRight size={13} />
                    </Link>
                    <Link
                      href={`/fund/${right}?accession=${result.right?.accession}`}
                    >
                      Open {right} portfolio <ArrowUpRight size={13} />
                    </Link>
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
