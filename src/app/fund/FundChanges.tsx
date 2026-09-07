"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookmarkPlus,
  RefreshCw,
} from "lucide-react";
import { fundChangeEvidence } from "../../utils/fundChanges.js";
import { ageDays, money, number, pct } from "./fundUi";
import s from "./fund.module.css";
import c from "./FundChanges.module.css";

type Source = {
  ticker: string;
  name: string;
  cik: string;
  seriesId: string;
  accession: string;
  asOf: string;
  filingDate: string;
  form: string;
  sourceUrl: string;
  filingUrl: string;
};
type Report = {
  accession: string;
  reportDate: string | null;
  filingDate: string;
  form: string;
};
type Side = {
  count: number;
  value: number | null;
  weight: number | null;
  quantity: number | null;
  units: string | null;
  absent: boolean;
  absentConfirmed: boolean;
};
type Row = {
  key: string;
  name: string;
  ids: string[];
  direction: string;
  status: string;
  before: Side;
  after: Side;
  deltaValue: number | null;
  deltaWeight: number | null;
  deltaQuantity: number | null;
  quantityReason: string | null;
  warnings: string[];
};
type Coverage = {
  positions: number;
  identified: number;
  unidentified: number;
  ambiguous: number;
  complete: boolean;
  valued: number;
  weighted: number;
};
type Changes = {
  available: boolean;
  reason: string | null;
  comparisonType: string | null;
  before: Source | null;
  after: Source | null;
  coverage: { before: Coverage; after: Coverage } | null;
  warnings: string[];
  rows: Row[];
  summary: {
    total: number;
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    unverified: number;
  };
  scope: string;
  query: string;
  methodology: string;
};
type Response = {
  funds: (Source & { reports: Report[] })[];
  errors?: { ticker: string; message: string }[];
  result: Changes;
  pagination: {
    page: number;
    pageCount: number;
    pageSize: number;
    total: number;
  };
  resolvedBefore?: string;
  resolvedAfter?: string;
};
type Settings = {
  reportMap?: Record<string, string>;
  changeTicker?: string;
  changeBefore?: string;
  changeAfter?: string;
  changeScope?: string;
  changeQuery?: string;
};
const statusLabel: Record<string, string> = {
  added: "Observed only after",
  removed: "Observed only before",
  changed: "Measured change",
  unchanged: "No measured change",
  unverified: "Unverified match",
};
const signed = (value: number | null, format: (value: number) => string) =>
  value == null ? "—" : `${value > 0 ? "+" : ""}${format(value)}`;

export default function FundChanges({
  tickers,
  settings,
  onPatch,
  onEvidence,
  onFunds,
}: {
  tickers: string[];
  settings: Settings;
  onPatch: (patch: Record<string, unknown>) => void;
  onEvidence: (evidence: unknown) => boolean | void;
  onFunds?: (funds: (Source & { reports: Report[] })[]) => void;
}) {
  const ticker = tickers.includes(settings.changeTicker || "")
    ? settings.changeTicker!
    : tickers[0] || "";
  const before = settings.changeBefore || "",
    selectedAfter = settings.changeAfter || "",
    after = selectedAfter || settings.reportMap?.[ticker] || "",
    scope = settings.changeScope || "all",
    query = settings.changeQuery || "";
  const [data, setData] = useState<Response | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(query),
    [notice, setNotice] = useState("");
  const [reportList, setReportList] = useState<{
    ticker: string;
    reports: Report[];
  }>({ ticker: "", reports: [] });
  const patchRef = useRef(onPatch);
  const fundsRef = useRef(onFunds);
  useEffect(() => {
    patchRef.current = onPatch;
  }, [onPatch]);
  useEffect(() => {
    fundsRef.current = onFunds;
  }, [onFunds]);
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    setPage(1);
    setNotice("");
  }, [ticker, before, after, scope, query]);
  const params = useMemo(() => {
    const value = new URLSearchParams({
      mode: "changes",
      ticker,
      scope,
      q: query,
      page: String(page),
    });
    if (before) value.set("before", before);
    if (after) value.set("after", after);
    return value;
  }, [ticker, before, after, scope, query, page]);
  useEffect(() => {
    if (!ticker) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    fetch(`/api/fund-workspace?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(
            payload.error || "The selected reports could not be compared.",
          );
        if (!controller.signal.aborted) {
          setData(payload);
          setReportList({ ticker, reports: payload.funds?.[0]?.reports || [] });
          fundsRef.current?.(payload.funds || []);
          const resolved: Record<string, string> = {};
          if (!before && payload.result?.before?.accession)
            resolved.changeBefore = payload.result.before.accession;
          if (!selectedAfter && payload.result?.after?.accession)
            resolved.changeAfter = payload.result.after.accession;
          if (Object.keys(resolved).length) patchRef.current(resolved);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause.message || "The reports could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ticker, params, attempt, before, selectedAfter]);
  const result = data?.result,
    reports = reportList.ticker === ticker ? reportList.reports : [];
  const exportParams = new URLSearchParams(params);
  exportParams.set("format", "csv");
  exportParams.delete("page");
  if (result?.before?.accession)
    exportParams.set("before", result.before.accession);
  if (result?.after?.accession)
    exportParams.set("after", result.after.accession);
  const reportOptions = (selected: string) => (
    <>
      {selected && !reports.some((report) => report.accession === selected) && (
        <option value={selected}>{selected} · validating report</option>
      )}
      {reports.map((report) => (
        <option value={report.accession} key={report.accession}>
          {report.reportDate || "Period verified on selection"} · {report.form}{" "}
          · filed {report.filingDate} · {report.accession}
        </option>
      ))}
    </>
  );
  const pin = (row: Row) => {
    if (
      !result?.available ||
      !result.before ||
      !result.after ||
      !result.coverage
    )
      return;
    const accepted = onEvidence(fundChangeEvidence(result, row));
    setNotice(
      accepted === false
        ? "This evidence could not be saved. Check the research-board message."
        : `Pinned ${row.name} with both filing sources and comparison assumptions.`,
    );
  };
  return (
    <section className={s.panel} aria-label="Fund report changes">
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Between reports</p>
          <h2>What changed in the reported portfolio?</h2>
          <p className={s.caption}>
            Compare complete SEC reports. Follow changes in weights, values, and
            comparable quantities with the original evidence close by.
          </p>
        </div>
        <button
          type="button"
          className={s.secondary}
          onClick={() => setAttempt((value) => value + 1)}
          disabled={loading || !ticker}
        >
          <RefreshCw size={14} /> Refresh reports
        </button>
      </div>
      {!tickers.length ? (
        <p className={s.empty}>
          Add a fund to the research basket to compare its reports.
        </p>
      ) : (
        <>
          <div className={c.reportControls}>
            <label>
              Fund to track
              <select
                value={ticker}
                onChange={(event) =>
                  onPatch({
                    changeTicker: event.target.value,
                    changeBefore: "",
                    changeAfter: "",
                  })
                }
              >
                {tickers.map((symbol) => (
                  <option key={symbol}>{symbol}</option>
                ))}
              </select>
            </label>
            <label>
              Earlier report
              <select
                value={before}
                onChange={(event) =>
                  onPatch({ changeBefore: event.target.value })
                }
              >
                <option value="">Previous verified reporting period</option>
                {reportOptions(before)}
              </select>
            </label>
            <label>
              Later report
              <select
                value={after}
                onChange={(event) => {
                  const accession = event.target.value;
                  onPatch(
                    accession
                      ? { changeAfter: accession }
                      : {
                          changeAfter: "",
                          changeBefore: "",
                          reportMap: Object.fromEntries(
                            Object.entries(settings.reportMap || {}).filter(
                              ([symbol]) => symbol !== ticker,
                            ),
                          ),
                        },
                  );
                }}
              >
                <option value="">Latest available portfolio report</option>
                {reportOptions(after)}
              </select>
            </label>
          </div>
          <p className={s.caption}>
            The default comparison uses the previous distinct reporting period
            from the recent reports checked. Same-date versions remain
            selectable and are labeled as revisions.
          </p>
          {loading && (
            <p className={s.loading} role="status">
              Reading both full portfolios and matching reported identifiers…
            </p>
          )}
          {error && (
            <p role="alert" className={s.notice}>
              {error} Your selected report settings have been preserved; refresh
              or choose another filing.
            </p>
          )}
          {data?.errors?.map((issue, index) => (
            <p
              key={`${issue.ticker}:${index}`}
              className={s.notice}
              role="alert"
            >
              {issue.ticker}: {issue.message}
            </p>
          ))}
          {result && (
            <>
              <div className={c.sources}>
                {(["before", "after"] as const).map((side) => {
                  const source = result[side],
                    coverage = result.coverage?.[side];
                  return (
                    <article key={side} className={c.source}>
                      <span className={c.kicker}>
                        {side === "before"
                          ? "Earlier checked report"
                          : "Later checked report"}
                      </span>
                      {source ? (
                        <>
                          <h3>{source.asOf}</h3>
                          <p>
                            {source.ticker} · {source.form} · filed{" "}
                            {source.filingDate}
                          </p>
                          <p>
                            {source.seriesId || "Series unverified"} · CIK{" "}
                            {source.cik}
                          </p>
                          <p className={c.age}>
                            {ageDays(source.asOf)} days since the portfolio date
                            · historical holdings
                          </p>
                          {coverage && (
                            <p>
                              {coverage.positions.toLocaleString()} positions
                              read · {coverage.identified.toLocaleString()} with
                              matchable identifiers ·{" "}
                              {coverage.complete
                                ? "complete report"
                                : "completeness unverified"}
                            </p>
                          )}
                          <a
                            href={source.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Read N-PORT <ArrowUpRight size={13} />
                          </a>
                          <span className={c.accession}>
                            {source.accession}
                          </span>
                        </>
                      ) : (
                        <p>No verified report selected.</p>
                      )}
                    </article>
                  );
                })}
              </div>
              {!result.available ? (
                <p role="status" className={s.notice}>
                  {result.reason}
                </p>
              ) : (
                <>
                  {result.comparisonType === "same-period-revision" && (
                    <p className={c.revision}>
                      Same-period filing revision · this comparison does not
                      measure changes over time.
                    </p>
                  )}
                  <div
                    className={c.metrics}
                    aria-label="All report comparison counts"
                  >
                    {(
                      [
                        ["added", "Only in later report"],
                        ["removed", "Only in earlier report"],
                        ["changed", "Measured changes"],
                        ["unverified", "Unverified matches"],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key}>
                        <strong>{result.summary[key].toLocaleString()}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                  <p className={s.caption}>
                    {result.summary.total.toLocaleString()}{" "}
                    security-and-direction observations across both reports;{" "}
                    {result.summary.unchanged.toLocaleString()} have no measured
                    change in comparable fields. Summary counts cover the full
                    comparison before filters.
                  </p>
                  <details className={c.method}>
                    <summary>
                      Coverage, matching rules, and interpretation
                    </summary>
                    <p>{result.methodology}</p>
                    <ul>
                      {result.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                    {result.coverage && (
                      <p>
                        Reported values present: {result.coverage.before.valued}
                        /{result.coverage.before.positions} before;{" "}
                        {result.coverage.after.valued}/
                        {result.coverage.after.positions} after. NAV weights
                        present: {result.coverage.before.weighted}/
                        {result.coverage.before.positions} before;{" "}
                        {result.coverage.after.weighted}/
                        {result.coverage.after.positions} after. Unknown inputs
                        are never counted as zero.
                      </p>
                    )}
                  </details>
                  <p className={c.interpretation}>
                    “Observed only” does not establish a purchase or sale. Value
                    changes include market movements; NAV-weight changes also
                    reflect changes in portfolio net assets.
                  </p>
                  <form
                    className={c.filters}
                    onSubmit={(event) => {
                      event.preventDefault();
                      onPatch({ changeQuery: search.trim().slice(0, 100) });
                    }}
                  >
                    <label>
                      Find a reported security
                      <input
                        value={search}
                        maxLength={100}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Security name, CUSIP, or ISIN"
                      />
                    </label>
                    <label>
                      Observations
                      <select
                        value={scope}
                        onChange={(event) =>
                          onPatch({ changeScope: event.target.value })
                        }
                      >
                        <option value="all">All observations</option>
                        <option value="added">Only in later report</option>
                        <option value="removed">Only in earlier report</option>
                        <option value="changed">Measured changes</option>
                      </select>
                    </label>
                    <button type="submit" className={s.secondary}>
                      Search changes
                    </button>
                    <a
                      href={`/api/fund-workspace?${exportParams}`}
                      className={s.secondary}
                      download
                    >
                      <ArrowDownToLine size={14} /> Export all{" "}
                      {data!.pagination.total.toLocaleString()} filtered rows
                    </a>
                  </form>
                  {notice && (
                    <p role="status" className={c.notice}>
                      {notice}
                    </p>
                  )}
                  <div className={s.tableWrap}>
                    <table className={`${s.table} ${c.table}`}>
                      <caption>
                        Largest absolute NAV-weight changes first. Signed
                        changes are later minus earlier; pp means percentage
                        points.
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Security / observation</th>
                          <th scope="col">Earlier NAV weight</th>
                          <th scope="col">Later NAV weight</th>
                          <th scope="col">Weight change</th>
                          <th scope="col">USD value change</th>
                          <th scope="col">Quantity change</th>
                          <th scope="col">Evidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row) => (
                          <tr key={row.key}>
                            <th scope="row">
                              <span>{row.name}</span>
                              <small>
                                {row.ids.join(" · ") ||
                                  "Identifier unavailable"}{" "}
                                · {row.direction}
                              </small>
                              <span
                                className={c.badge}
                                data-status={row.status}
                              >
                                {statusLabel[row.status] || row.status}
                              </span>
                              <details className={c.rowDetails}>
                                <summary>Reported values and caveats</summary>
                                <p>
                                  USD value: {money(row.before.value)} →{" "}
                                  {money(row.after.value)}. Reported lots:{" "}
                                  {row.before.count} → {row.after.count}.
                                </p>
                                <p>
                                  Quantity: {number(row.before.quantity)}{" "}
                                  {row.before.units || "units unavailable"} →{" "}
                                  {number(row.after.quantity)}{" "}
                                  {row.after.units || "units unavailable"}.
                                </p>
                                {row.quantityReason && (
                                  <p>{row.quantityReason}</p>
                                )}
                                {row.warnings.map((warning) => (
                                  <p key={warning}>{warning}</p>
                                ))}
                              </details>
                            </th>
                            <td>
                              {pct(row.before.weight)}
                              {row.before.absentConfirmed && (
                                <small>Not observed</small>
                              )}
                            </td>
                            <td>
                              {pct(row.after.weight)}
                              {row.after.absentConfirmed && (
                                <small>Not observed</small>
                              )}
                            </td>
                            <td>
                              {signed(
                                row.deltaWeight,
                                (value) => `${value.toFixed(2)} pp`,
                              )}
                            </td>
                            <td>{signed(row.deltaValue, money)}</td>
                            <td>
                              {signed(row.deltaQuantity, number)}
                              <small>
                                {row.deltaQuantity == null
                                  ? "See comparability note"
                                  : row.before.units}
                              </small>
                            </td>
                            <td>
                              <button
                                type="button"
                                className={s.secondary}
                                onClick={() => pin(row)}
                                aria-label={`Pin change evidence for ${row.name}`}
                              >
                                <BookmarkPlus size={14} /> Pin
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!result.rows.length && (
                      <p className={s.empty}>
                        No observations match these filters in the checked
                        reports. Broaden the search or select all observations.
                      </p>
                    )}
                  </div>
                  <nav
                    className={c.pagination}
                    aria-label="Report change result pages"
                  >
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={data!.pagination.page <= 1}
                      onClick={() => setPage(data!.pagination.page - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {data!.pagination.page} of{" "}
                      {Math.max(1, data!.pagination.pageCount)} ·{" "}
                      {data!.pagination.total.toLocaleString()} filtered
                      observations
                    </span>
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={
                        data!.pagination.page >= data!.pagination.pageCount
                      }
                      onClick={() => setPage(data!.pagination.page + 1)}
                    >
                      Next
                    </button>
                  </nav>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
