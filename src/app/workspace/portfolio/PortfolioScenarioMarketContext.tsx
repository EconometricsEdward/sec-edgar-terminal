"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined, RefreshCw } from "lucide-react";
import {
  clearPreparedCftc,
  fetchPreparedCftc,
} from "../../../utils/cftcClient.js";
import {
  scenarioMarketCandidates,
  scenarioMarketHistory,
} from "../../../utils/portfolioScenarioMarket.js";
import s from "./PortfolioScenarioMarketContext.module.css";

type Props = { company: any; scenarioId: string };
const numeric = (value: unknown, digits = 1, suffix = "", signed = false) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits, signDisplay: signed ? "exceptZero" : "auto" })}${suffix}`
    : "Unavailable";

export default function PortfolioScenarioMarketContext(props: Props) {
  const ticker = String(
    props.company?.ticker || props.company?.tickers?.[0] || "",
  )
    .trim()
    .toUpperCase();
  return (
    <MarketContext
      key={`${props.company?.cik || ""}:${ticker}`}
      {...props}
      ticker={ticker}
    />
  );
}

function MarketContext({
  company,
  scenarioId,
  ticker,
}: Props & { ticker: string }) {
  const id = useId();
  const [context, setContext] = useState<any>(null);
  const [contextPending, setContextPending] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextRetry, setContextRetry] = useState(0);
  const [choice, setChoice] = useState({ scenarioId: "", key: "" });
  const [history, setHistory] = useState<{ path: string; data: any } | null>(
    null,
  );
  const [historyPending, setHistoryPending] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const contextPath = /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)
    ? `/api/v1/cftc/company-context?${new URLSearchParams({ ticker })}`
    : "";

  useEffect(() => {
    if (!contextPath) return;
    const controller = new AbortController();
    setContextPending(true);
    setContextError("");
    fetchPreparedCftc(contextPath, {
      signal: controller.signal,
      timeoutMs: 46_000,
    })
      .then((data) => {
        if (!controller.signal.aborted) setContext(data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setContextError(
            "The SEC filing connection could not be retrieved. Your scenario results remain available.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setContextPending(false);
      });
    return () => controller.abort();
  }, [contextPath, contextRetry]);

  const discovery: any = useMemo(
    () => scenarioMarketCandidates(context, company, scenarioId),
    [context, company, scenarioId],
  );
  const candidate =
    discovery.links.find(
      (item: any) =>
        choice.scenarioId === scenarioId && item.key === choice.key,
    ) ||
    discovery.links[0] ||
    null;
  const historyPath = candidate
    ? `/api/v1/cftc/history?${new URLSearchParams({ family: candidate.family, contract: candidate.contract, group: candidate.group, window: "1y", date: "latest" })}`
    : "";
  useEffect(() => {
    if (!historyPath) return;
    const controller = new AbortController();
    setHistoryPending(true);
    setHistoryError("");
    fetchPreparedCftc(historyPath, {
      signal: controller.signal,
      timeoutMs: 46_000,
    })
      .then((data) => {
        if (!controller.signal.aborted) setHistory({ path: historyPath, data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setHistoryError(
            "CFTC positioning is temporarily unavailable. The scenario does not depend on this market data.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryPending(false);
      });
    return () => controller.abort();
  }, [historyPath, historyRetry]);
  const rawHistory = history?.path === historyPath ? history.data : null;
  const market: any = useMemo(
    () =>
      rawHistory && candidate
        ? scenarioMarketHistory(rawHistory, candidate)
        : null,
    [rawHistory, candidate],
  );
  const chart = market?.chart;
  const invalidContext =
    context && !contextPending && !contextError && !discovery.verified;
  const invalidHistory =
    rawHistory && !historyPending && !historyError && !market;
  const retryContext = () => {
    clearPreparedCftc(contextPath);
    setContext(null);
    setContextRetry((value) => value + 1);
  };
  const retryHistory = () => {
    clearPreparedCftc(historyPath);
    setHistory(null);
    setHistoryRetry((value) => value + 1);
  };

  return (
    <section className={s.panel} aria-labelledby={`${id}-heading`}>
      <header className={s.heading}>
        <div>
          <span className={s.eyebrow}>
            <ChartNoAxesCombined size={15} aria-hidden="true" /> SEC + CFTC
            context
          </span>
          <h4 id={`${id}-heading`}>
            {ticker ? `Markets to investigate for ${ticker}` : "Market context"}
          </h4>
        </div>
        <span className={s.badge}>Separate from your assumptions</span>
      </header>
      <p className={s.intro}>
        Filing passages suggest markets to review. CFTC positions add context;
        they do not determine the scenario’s shock or financial impact.
      </p>
      {!contextPath && (
        <p className={s.note}>
          Choose an identified company to review its market context.
        </p>
      )}
      {contextPending && (
        <p className={s.note} role="status">
          Checking the latest accessible annual filing for market connections…
        </p>
      )}
      {(contextError || invalidContext) && (
        <div className={s.notice} role="status">
          <p>
            {contextError ||
              "The returned SEC evidence could not be verified against this company’s identity. No market connection is assumed."}
          </p>
          <button type="button" onClick={retryContext}>
            <RefreshCw size={14} aria-hidden="true" /> Retry filing context
          </button>
        </div>
      )}
      {context &&
        discovery.verified &&
        !contextPending &&
        !contextError &&
        !discovery.links.length && (
          <div className={s.notice}>
            <p>
              {context.status === "no_filing"
                ? "No usable annual filing was found for this company."
                : "No verified market passage was found in the bounded annual-filing scan."}{" "}
              This does not establish that market exposure is absent.
            </p>
            <button type="button" onClick={retryContext}>
              Check filing context again
            </button>
          </div>
        )}
      {candidate && !contextPending && !contextError && (
        <>
          <div className={s.marketChoice}>
            <label htmlFor={`${id}-market`}>
              Filing-linked market
              <select
                id={`${id}-market`}
                value={candidate.key}
                onChange={(event) => {
                  setChoice({ scenarioId, key: event.target.value });
                  setHistoryError("");
                }}
              >
                {discovery.links.map((item: any) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              {candidate.groupLabel} · Futures only
              <br />
              <span>Contract {candidate.contract}</span>
            </p>
          </div>
          {discovery.preferredCount === 0 && (
            <p className={s.note}>
              No market in this filing scan directly matches the selected
              scenario category. These are other filing-linked markets for
              separate research.
            </p>
          )}
          {historyPending && (
            <p className={s.note} role="status">
              Loading {candidate.label} positioning…
            </p>
          )}
          {(historyError || invalidHistory) && (
            <div className={s.notice} role="status">
              <p>
                {historyError ||
                  "The returned report did not verify the chosen contract, trader category and futures-only dataset."}
              </p>
              <button type="button" onClick={retryHistory}>
                <RefreshCw size={14} aria-hidden="true" /> Retry CFTC context
              </button>
            </div>
          )}
          {market && !historyPending && !historyError && (
            <>
              <div className={s.metrics}>
                <div>
                  <span>Net / open interest</span>
                  <strong>{numeric(market.current?.netPctOi, 2, "%")}</strong>
                  <small>{candidate.groupLabel}</small>
                </div>
                <div>
                  <span>Weekly change</span>
                  <strong>
                    {numeric(market.weekly?.netPctChange, 2, "", true)}
                  </strong>
                  <small>Percentage points · exact 7 days</small>
                </div>
                <div>
                  <span>Positions as of</span>
                  <strong className={s.date}>{market.reportDate}</strong>
                  <small>{market.ageDays} days old · observation date</small>
                </div>
              </div>
              {(market.stale || market.incomplete) && (
                <p className={s.notice}>
                  {market.stale
                    ? "This is an older or last successful market snapshot. "
                    : "Some market observations are missing or were excluded. "}
                  Available dates remain visible; missing values are not treated
                  as zero.
                </p>
              )}
              {chart ? (
                <figure className={s.figure}>
                  <figcaption>
                    {candidate.groupLabel} net positioning / total open interest
                  </figcaption>
                  <svg
                    className={s.chart}
                    viewBox="0 0 680 210"
                    role="img"
                    aria-labelledby={`${id}-chart-title ${id}-chart-description`}
                  >
                    <title id={`${id}-chart-title`}>
                      {candidate.label} net positioning history
                    </title>
                    <desc id={`${id}-chart-description`}>
                      {chart.count} observations from {chart.start} to{" "}
                      {chart.end}. Values are percentages of each report’s total
                      open interest. The line breaks across missing weeks. Exact
                      values are available under sources and observations.
                    </desc>
                    <line
                      x1="48"
                      x2="640"
                      y1={chart.zeroY}
                      y2={chart.zeroY}
                      className={s.zeroLine}
                    />
                    {chart.paths.map((path: string, index: number) => (
                      <path key={index} d={path} />
                    ))}
                    {chart.dots.map((point: any) => (
                      <circle key={point.date} cx={point.x} cy={point.y} r="2">
                        <title>
                          {point.date}: {numeric(point.value, 2, "%")}
                        </title>
                      </circle>
                    ))}
                    <text x="3" y="40">
                      {numeric(chart.max, 1, "%")}
                    </text>
                    <text x="3" y="174">
                      {numeric(chart.min, 1, "%")}
                    </text>
                    <text x="48" y="201">
                      {chart.start}
                    </text>
                    <text x="640" y="201" textAnchor="end">
                      {chart.end}
                    </text>
                  </svg>
                </figure>
              ) : (
                <p className={s.note}>
                  At least two compatible observations are needed for a history
                  chart.
                </p>
              )}
              <div className={s.actions}>
                <a href={market.marketPath} target="_blank" rel="noreferrer">
                  Explore this market{" "}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
                <button type="button" onClick={retryHistory}>
                  Refresh context
                </button>
              </div>
            </>
          )}
          <details className={s.details}>
            <summary>
              Why this market · SEC evidence and CFTC observations
            </summary>
            <p>{candidate.reason}</p>
            {candidate.evidence.map((item: any, index: number) => (
              <blockquote key={`${item.accession}:${index}`}>
                <p>“{item.text}”</p>
                <cite>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.form} · Filed {item.filed} · Period{" "}
                    {item.reportDate || "not provided"}{" "}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </a>
                </cite>
              </blockquote>
            ))}
            <p>
              <strong>Question to investigate:</strong>{" "}
              {candidate.reviewQuestion}
            </p>
            <p>
              The scan covers the latest accessible complete annual report.
              Later quarters, amendments, unscanned text and unsupported markets
              may contain additional exposures. A passage match does not measure
              materiality, hedge size or sensitivity.
              {context.coverage?.textTruncated ||
              context.coverage?.historyLimited
                ? " This filing scan was limited."
                : ""}
              {discovery.omitted > 0
                ? ` ${discovery.omitted} candidate links failed validation and were excluded.`
                : ""}
            </p>
            {market && !historyPending && !historyError && (
              <>
                <p>
                  <a href={market.sourceUrl} target="_blank" rel="noreferrer">
                    Official CFTC source{" "}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </a>{" "}
                  · {candidate.groupLabel},{" "}
                  {candidate.family === "tff"
                    ? "Traders in Financial Futures"
                    : "Disaggregated"}
                  , futures only. Positions describe outstanding contracts, not
                  cash flows. Net / open interest = 100 × (long − short) / total
                  open interest; each date uses its own denominator.
                </p>
                <p>
                  {market.weekly.available
                    ? market.weekly.explanation
                    : market.weekly.reason}{" "}
                  Total market open interest changed by{" "}
                  {numeric(market.openInterestChangePct, 2, "%", true)} over the
                  same exact week.
                </p>
                <p>
                  Report dates are position observation dates. COT is normally
                  published on Friday for Tuesday positions, with schedule
                  exceptions. Publication time is not verified here.
                </p>
                <div
                  className={s.tableWrap}
                  role="region"
                  aria-label={`${ticker} market context numeric observations`}
                  tabIndex={0}
                >
                  <table>
                    <caption>
                      {candidate.label} · Latest 52 weeks of available
                      observations
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Positions as of</th>
                        <th scope="col">Long</th>
                        <th scope="col">Short</th>
                        <th scope="col">Open interest</th>
                        <th scope="col">Net / OI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...market.points].reverse().map((point: any) => (
                        <tr key={point.reportDate}>
                          <th scope="row">{point.reportDate}</th>
                          <td>{numeric(point.long, 0)}</td>
                          <td>{numeric(point.short, 0)}</td>
                          <td>{numeric(point.openInterest, 0)}</td>
                          <td>{numeric(point.netPctOi, 2, "%")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </details>
        </>
      )}
      <p className={s.scope}>
        CFTC positioning describes market-wide trader groups. It does not
        identify this company’s trades or establish prices, scenario
        probabilities, earnings sensitivity or portfolio returns.
      </p>
    </section>
  );
}
