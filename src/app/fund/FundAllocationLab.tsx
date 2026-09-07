"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Download, RefreshCw } from "lucide-react";
import {
  equalFundAllocations,
  validateFundAllocations,
} from "../../utils/fundAllocation.js";
import { pct } from "./fundUi";
import s from "./FundAllocationLab.module.css";

type Source = {
  ticker: string;
  name?: string;
  accession: string;
  asOf: string;
  filingDate: string;
  sourceUrl: string;
};
type Contribution = {
  ticker: string;
  allocation: number;
  holdingWeight: number | null;
  contribution: number | null;
  positionCount: number;
  source: Source;
};
type Row = {
  key: string;
  name: string;
  ids: string[];
  weight: number | null;
  contributions: Contribution[];
  fundCount: number;
  portfolioCount: number;
  duplicated: boolean;
};
type FundCoverage = {
  ticker: string;
  allocation: number;
  available: boolean;
  zeroAllocation: boolean;
  source: Source | null;
  error: string | null;
  positionCount: number;
  eligibleCount: number;
  excludedCount: number;
  unknownWeightCount: number;
  ambiguousCount: number;
  unidentifiedCount: number;
  eligibleWeight: number | null;
  excludedPositiveWeight: number | null;
  nonpositiveWeight: number | null;
};
type Result = {
  ready: boolean;
  rows: Row[];
  largestDuplicated: Row[];
  funds: FundCoverage[];
  coverage: {
    reviewedAllocation: number;
    unavailableAllocation: number;
    eligibleWeight: number | null;
    excludedPositiveWeight: number | null;
    nonpositiveWeight: number | null;
    unknownWeightCount: number;
    top10Weight: number | null;
    securityCount: number;
    duplicatedSecurityCount: number;
    reviewedFundCount: number;
    requestedFundCount: number;
    ambiguousCount: number;
    unidentifiedCount: number;
  };
  partial: boolean;
  mixedDates: boolean;
  samePortfolioGroups: string[][];
  notes: string[];
};
type Evidence = {
  kind: "allocation";
  title: string;
  summary: string;
  values: { label: string; value: number | string | null; unit?: string }[];
  sources: Source[];
  methodology?: string;
};
type Props = {
  tickers: string[];
  settings: {
    allocations?: Record<string, string | number>;
    reportMap?: Record<string, string>;
    board?: string;
  };
  onPatch: (patch: {
    allocations?: Record<string, string>;
    reportMap?: Record<string, string>;
  }) => boolean | void;
  onEvidence?: (evidence: Evidence) => boolean | void;
  onFunds?: (funds: any[]) => void;
};
export default function FundAllocationLab({
  tickers,
  settings,
  onPatch,
  onEvidence,
  onFunds,
}: Props) {
  const patchRef = useRef(onPatch);
  const fundsRef = useRef(onFunds);
  useEffect(() => {
    fundsRef.current = onFunds;
  }, [onFunds]);
  useEffect(() => {
    patchRef.current = onPatch;
  }, [onPatch]);
  const tickersKey = tickers.join(","),
    allocationsKey = JSON.stringify(settings.allocations || {}),
    reportsKey = JSON.stringify(settings.reportMap || {});
  const initial = useMemo(
    () =>
      Object.fromEntries(
        tickersKey
          .split(",")
          .filter(Boolean)
          .map((ticker) => [
            ticker,
            String(
              (JSON.parse(allocationsKey) as Record<string, string | number>)[
                ticker
              ] ?? "",
            ),
          ]),
      ),
    [tickersKey, allocationsKey],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(initial),
    [message, setMessage] = useState(""),
    [showValidation, setShowValidation] = useState(false);
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [loading, setLoading] = useState(false),
    [exporting, setExporting] = useState(false);
  const [paging, setPaging] = useState({ key: "", page: 1 }),
    [pagination, setPagination] = useState({
      page: 1,
      pageCount: 1,
      pageSize: 50,
      total: 0,
    });
  const [search, setSearch] = useState("");
  const previousInputs = useRef({ initial, board: settings.board });
  useEffect(() => {
    const previous = previousInputs.current;
    setDrafts((current) =>
      Object.fromEntries(
        Object.entries(initial).map(([ticker, value]) => [
          ticker,
          previous.board === settings.board &&
          previous.initial[ticker] === value &&
          Object.hasOwn(current, ticker)
            ? current[ticker]
            : value,
        ]),
      ),
    );
    previousInputs.current = { initial, board: settings.board };
    setShowValidation(false);
    setMessage("");
  }, [initial, settings.board]);
  const committedValidation = useMemo(
    () =>
      validateFundAllocations(
        tickersKey.split(",").filter(Boolean),
        JSON.parse(allocationsKey),
      ),
    [tickersKey, allocationsKey],
  );
  const draftValidation = validateFundAllocations(tickers, drafts);
  const dirty = tickers.some((ticker) => drafts[ticker] !== initial[ticker]);
  const requestKey = `${tickersKey}|${allocationsKey}|${reportsKey}`,
    page = paging.key === requestKey ? paging.page : 1;
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      mode: "allocation",
      tickers: tickersKey,
      reports: reportsKey,
      weights: allocationsKey,
    });
    return `/api/fund-workspace?${params}`;
  }, [tickersKey, reportsKey, allocationsKey]);
  useEffect(() => {
    if (!committedValidation.valid) {
      setResult(null);
      setError("");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setResult(null);
    fetch(`${apiUrl}&page=${page}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok)
          throw new Error(
            payload.error || "Could not calculate this allocation.",
          );
        if (!payload.result?.ready)
          throw new Error(
            payload.result?.validation?.errors?.join(" ") ||
              "The allocation could not be calculated.",
          );
        if (!controller.signal.aborted) {
          setResult(payload.result);
          if (Array.isArray(payload.funds)) fundsRef.current?.(payload.funds);
          setPagination(
            payload.pagination || {
              page: 1,
              pageCount: 1,
              pageSize: 50,
              total: payload.result.rows.length,
            },
          );
          const originalReports = JSON.parse(reportsKey);
          const resolved = Object.fromEntries(
            Object.entries(payload.resolvedReports || {}).filter(
              ([ticker]) => !originalReports[ticker],
            ),
          );
          if (Object.keys(resolved).length)
            patchRef.current({
              reportMap: { ...originalReports, ...resolved } as Record<
                string,
                string
              >,
            });
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load the allocation.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [apiUrl, page, attempt, committedValidation.valid, reportsKey]);
  function apply(next = drafts) {
    const validation = validateFundAllocations(tickers, next);
    setShowValidation(true);
    if (!validation.valid) return;
    if (
      onPatch({
        allocations: Object.fromEntries(
          tickers.map((ticker) => [ticker, next[ticker].trim()]),
        ),
      }) === false
    )
      return;
    setMessage(
      "Allocations applied. Results use these weights and the selected SEC reports.",
    );
  }
  async function exportCsv() {
    setExporting(true);
    setMessage("");
    try {
      const response = await fetch(`${apiUrl}&format=csv`);
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "The export could not be prepared.");
      }
      const url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `fund-allocation-${tickers.join("-")}.csv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        "Exported all eligible securities, fund contributions, and SEC evidence.",
      );
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "The export could not be prepared.",
      );
    } finally {
      setExporting(false);
    }
  }
  function pin(row: Row) {
    if (!onEvidence || !result) return;
    const evidence: Evidence = {
      kind: "allocation",
      title: `${row.name.slice(0, 210)} · combined allocation`,
      summary: `${pct(row.weight)} of the chosen allocation, combining ${row.contributions.map((c) => `${c.ticker} at ${c.allocation}%`).join(", ")}. ${result.partial ? "Incomplete fund coverage. " : ""}${result.mixedDates ? "Mixed reporting dates. " : ""}Historical disclosed holdings.`,
      values: [
        { label: "Combined eligible allocation", value: row.weight, unit: "%" },
        ...row.contributions.flatMap((c) => [
          {
            label: `${c.ticker} chosen allocation`,
            value: c.allocation,
            unit: "%",
          },
          {
            label: `${c.ticker} holding NAV weight`,
            value: c.holdingWeight,
            unit: "%",
          },
          {
            label: `${c.ticker} contribution`,
            value: c.contribution,
            unit: "percentage points",
          },
        ]),
      ],
      sources: row.contributions.map((c) => c.source),
      methodology: `${row.ids.join("; ")}. ${result.notes.join(" ")}`,
    };
    if (onEvidence(evidence) !== false)
      setMessage(`Selected ${row.name} for the research board.`);
  }
  const visible =
    result?.rows.filter(
      (row) =>
        !search.trim() ||
        `${row.name} ${row.ids.join(" ")}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ) || [];
  return (
    <section className={s.lab} aria-label="Combined fund allocation">
      <div className={s.heading}>
        <div>
          <p className={s.eyebrow}>Allocation lab</p>
          <h2>See what your funds add up to.</h2>
          <p className={s.muted}>
            Choose fund weights to reveal security concentration and repeated
            holdings across your portfolios.
          </p>
        </div>
        <button
          className={s.secondary}
          onClick={() => setAttempt((n) => n + 1)}
          disabled={!committedValidation.valid || loading}
        >
          <RefreshCw size={14} /> Retry / refresh
        </button>
      </div>
      <form
        className={s.editor}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className={s.inputs}>
          {tickers.map((ticker) => (
            <label key={ticker} htmlFor={`allocation-${ticker}`}>
              {ticker} allocation (%)
              <input
                id={`allocation-${ticker}`}
                inputMode="decimal"
                value={drafts[ticker] ?? ""}
                maxLength={24}
                autoComplete="off"
                placeholder="0–100"
                onChange={(event) => {
                  setDrafts((value) => ({
                    ...value,
                    [ticker]: event.target.value,
                  }));
                  setMessage("");
                }}
                aria-invalid={
                  showValidation &&
                  draftValidation.errors.some((error) =>
                    error.startsWith(`${ticker}:`),
                  )
                }
                aria-describedby="allocation-edit-help"
              />
            </label>
          ))}
        </div>
        <div className={s.actions}>
          <strong className={draftValidation.valid ? s.valid : s.muted}>
            Total: {Number(draftValidation.sum.toFixed(8))}%
          </strong>
          <button
            type="submit"
            className={s.primary}
            disabled={!tickers.length}
          >
            Apply allocations
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={!tickers.length}
            onClick={() => {
              const next = equalFundAllocations(tickers);
              setDrafts(next);
              apply(next);
            }}
          >
            Use equal weights
          </button>
          {dirty && (
            <button
              type="button"
              className={s.secondary}
              onClick={() => {
                setDrafts(initial);
                setShowValidation(false);
              }}
            >
              Discard edits
            </button>
          )}
        </div>
        <p id="allocation-edit-help" className={s.caption}>
          Weights must total 100%. A fund assigned 0% is omitted from the
          calculation. Reported holdings keep their original NAV denominator.
        </p>
        {showValidation && !draftValidation.valid && (
          <ul role="alert" className={s.notice}>
            {draftValidation.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </form>
      {dirty && (
        <p className={s.notice}>
          Your allocation edits are not applied. Apply or discard them before
          pinning evidence or exporting results.
        </p>
      )}
      {message && (
        <p role="status" className={s.notice}>
          {message}
        </p>
      )}
      {!committedValidation.valid && (
        <p className={s.empty}>
          Set your allocations above, or choose equal weights to begin.
        </p>
      )}
      {loading && (
        <p role="status" className={s.empty}>
          Reading complete SEC portfolios and combining eligible securities…
        </p>
      )}
      {error && (
        <p role="alert" className={s.notice}>
          {error} Use Retry / refresh to try again.
        </p>
      )}
      {result && (
        <>
          {result.partial && (
            <p className={s.notice}>
              <strong>Incomplete coverage.</strong>{" "}
              {pct(result.coverage.unavailableAllocation)} of the chosen
              allocation could not be reviewed. Available funds keep their
              chosen weights.
            </p>
          )}
          {result.mixedDates && (
            <p className={s.notice}>
              <strong>Different reporting dates.</strong> This blend combines
              historical snapshots from the dates shown below.
            </p>
          )}
          {result.samePortfolioGroups.map((group) => (
            <p className={s.notice} key={group.join(",")}>
              <strong>
                {group.join(" + ")} share a reported SEC portfolio.
              </strong>{" "}
              Their contributions count toward combined weights, but they do not
              create diversification between distinct portfolios.
            </p>
          ))}
          <div className={s.stats}>
            <div>
              <span>Fund allocation reviewed</span>
              <strong>{pct(result.coverage.reviewedAllocation)}</strong>
              <small>
                {result.coverage.reviewedFundCount} of{" "}
                {result.coverage.requestedFundCount} positive allocations
              </small>
            </div>
            <div>
              <span>Eligible security weight</span>
              <strong>{pct(result.coverage.eligibleWeight)}</strong>
              <small>
                {result.coverage.securityCount.toLocaleString()} identified
                securities
              </small>
            </div>
            <div>
              <span>Top 10 eligible securities</span>
              <strong>{pct(result.coverage.top10Weight)}</strong>
              <small>Of chosen allocation; no rescaling</small>
            </div>
            <div>
              <span>Held in distinct portfolios</span>
              <strong>
                {result.coverage.duplicatedSecurityCount.toLocaleString()}
              </strong>
              <small>Eligible securities in 2+ portfolios</small>
            </div>
          </div>
          <details
            className={s.details}
            open={result.partial || result.coverage.unknownWeightCount > 0}
          >
            <summary>Review coverage, exclusions, and source reports</summary>
            <p className={s.caption}>
              Excluded positive weight:{" "}
              {pct(result.coverage.excludedPositiveWeight)} of the chosen
              allocation. Zero/negative weight:{" "}
              {pct(result.coverage.nonpositiveWeight)}. Unknown weights:{" "}
              {result.coverage.unknownWeightCount.toLocaleString()} positions.
              Ambiguous identifiers: {result.coverage.ambiguousCount}; missing
              identifiers: {result.coverage.unidentifiedCount}.
            </p>
            <div className={s.tableWrap}>
              <table>
                <caption>
                  Complete report coverage before any securities are excluded
                </caption>
                <thead>
                  <tr>
                    <th>Fund / allocation</th>
                    <th>Portfolio date</th>
                    <th>Eligible weight / fund NAV</th>
                    <th>Excluded / unknown positions</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {result.funds.map((fund) => (
                    <tr key={fund.ticker}>
                      <th scope="row">
                        {fund.ticker}
                        <small>{fund.allocation}%</small>
                      </th>
                      <td>
                        {fund.source?.asOf ||
                          (fund.zeroAllocation
                            ? "Not required"
                            : "Unavailable")}
                      </td>
                      <td>{fund.available ? pct(fund.eligibleWeight) : "—"}</td>
                      <td>
                        {fund.available
                          ? `${fund.excludedCount} / ${fund.unknownWeightCount}`
                          : "—"}
                      </td>
                      <td>
                        {fund.source ? (
                          <a
                            href={fund.source.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            SEC report · {fund.source.filingDate}
                            <small>{fund.source.accession}</small>
                          </a>
                        ) : (
                          fund.error || "0% allocation"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className={s.method}>
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
          {result.largestDuplicated?.length > 0 && (
            <section className={s.duplicates}>
              <h3>Biggest repeated holdings</h3>
              <p className={s.caption}>
                Ranked by combined eligible weight across distinct SEC
                portfolios. Separate share classes of one portfolio do not
                create an extra match.
              </p>
              <div className={s.repeatGrid}>
                {result.largestDuplicated.slice(0, 6).map((row) => (
                  <article key={row.key}>
                    <div className={s.cardHeading}>
                      <strong>{row.name}</strong>
                      <b>{pct(row.weight)}</b>
                    </div>
                    <p>
                      {row.contributions
                        .map(
                          (c) =>
                            `${c.ticker}: ${c.contribution == null ? "unavailable" : `${c.contribution.toFixed(2)} percentage points`}`,
                        )
                        .join(" · ")}
                    </p>
                    <small>{row.key}</small>
                    {onEvidence && (
                      <button
                        disabled={dirty}
                        className={s.secondary}
                        onClick={() => pin(row)}
                      >
                        <BookmarkPlus size={14} /> Pin holding
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className={s.heading}>
            <div>
              <h3>Combined security holdings</h3>
              <p className={s.caption}>
                Every contribution remains traceable to its fund’s original NAV
                weight.
              </p>
            </div>
            <button
              className={s.secondary}
              onClick={exportCsv}
              disabled={
                dirty || exporting || !result.coverage.reviewedFundCount
              }
            >
              <Download size={14} />{" "}
              {exporting ? "Preparing…" : "Export all holdings CSV"}
            </button>
          </div>
          {result.rows.length > 0 ? (
            <>
              <label className={s.pageSearch}>
                Find within this page
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Security name, CUSIP, or ISIN"
                />
              </label>
              <div className={s.tableWrap}>
                <table>
                  <caption>
                    {result.partial
                      ? "Available funds only — incomplete allocation"
                      : "Eligible disclosed positions"}
                    . Contribution = fund allocation × reported holding NAV
                    weight ÷ 100.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Security</th>
                      <th scope="col">Combined weight</th>
                      {tickers.map((ticker) => (
                        <th scope="col" key={ticker}>
                          {ticker} contribution
                        </th>
                      ))}
                      <th scope="col">Research</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">
                          {row.name}
                          <small>{row.ids.join(" · ")}</small>
                        </th>
                        <td>
                          <strong>{pct(row.weight)}</strong>
                          <small>
                            {row.portfolioCount} distinct{" "}
                            {row.portfolioCount === 1
                              ? "portfolio"
                              : "portfolios"}
                          </small>
                        </td>
                        {tickers.map((ticker) => {
                          const item = row.contributions.find(
                            (c) => c.ticker === ticker,
                          );
                          return (
                            <td key={ticker}>
                              {item ? (
                                <>
                                  {pct(item.contribution)}
                                  <small>
                                    {item.allocation}% ×{" "}
                                    {pct(item.holdingWeight)} NAV
                                  </small>
                                  <a
                                    href={item.source.sourceUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {item.source.asOf} · SEC ↗
                                  </a>
                                </>
                              ) : result.funds.find((f) => f.ticker === ticker)
                                  ?.zeroAllocation ? (
                                "0% allocation"
                              ) : result.funds.find((f) => f.ticker === ticker)
                                  ?.available ? (
                                "No eligible match"
                              ) : (
                                "Unavailable"
                              )}
                            </td>
                          );
                        })}
                        <td>
                          {onEvidence && (
                            <button
                              className={s.secondary}
                              disabled={dirty}
                              onClick={() => pin(row)}
                              aria-label={`Pin allocation evidence for ${row.name}`}
                            >
                              <BookmarkPlus size={14} /> Pin
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!visible.length && (
                <p className={s.empty}>
                  No matches on this page. Clear the filter or try another page;
                  the export includes all eligible securities.
                </p>
              )}
              <div className={s.actions}>
                <button
                  className={s.secondary}
                  disabled={page <= 1 || loading}
                  onClick={() => {
                    setPaging({ key: requestKey, page: page - 1 });
                    setSearch("");
                  }}
                >
                  Previous
                </button>
                <span>
                  Page {pagination.page} of {pagination.pageCount} ·{" "}
                  {pagination.total.toLocaleString()} securities
                </span>
                <button
                  className={s.secondary}
                  disabled={page >= pagination.pageCount || loading}
                  onClick={() => {
                    setPaging({ key: requestKey, page: page + 1 });
                    setSearch("");
                  }}
                >
                  Next
                </button>
              </div>
            </>
          ) : (
            <p className={s.empty}>
              {result.coverage.reviewedFundCount
                ? "No identified long, non-derivative positions qualify in the available portfolios. Review the exclusions above."
                : "No positive-allocation portfolio could be reviewed. Source failures are shown above."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
