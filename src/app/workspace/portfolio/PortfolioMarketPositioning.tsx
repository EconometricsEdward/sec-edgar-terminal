"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ArrowUpRight, ChartNoAxesCombined, RefreshCw } from "lucide-react";
import {
  clearPreparedCftc,
  fetchPreparedCftc,
} from "../../../utils/cftcClient.js";
import { scenarioMarketHistory } from "../../../utils/portfolioScenarioMarket.js";
import { cftcConcentrationMatchesHistory } from "../../../utils/cftcConcentration.js";
import s from "./PortfolioMarketPositioning.module.css";

type Props = { market: any; active: boolean };
type RequestState = {
  path: string;
  status: "loading" | "ready" | "error";
  data: any;
};

const numeric = (value: unknown, digits = 1, suffix = "", signed = false) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
        signDisplay: signed ? "exceptZero" : "auto",
      })}${suffix}`
    : "Unavailable";

/** Mount only the selected, visible market; shared prepared requests stay cached. */
export default function PortfolioMarketPositioning({ market, active }: Props) {
  if (!active || !market) return null;
  return (
    <MarketPositioning
      key={`${market.family}:${market.contract}:${market.group}`}
      candidate={market}
    />
  );
}

function MarketPositioning({ candidate }: { candidate: any }) {
  const id = useId();
  const path = `/api/v1/cftc/history?${new URLSearchParams({
    family: candidate.family,
    contract: candidate.contract,
    group: candidate.group,
    window: "1y",
    date: "latest",
  })}`;
  const [request, setRequest] = useState<RequestState>({
    path,
    status: "loading",
    data: null,
  });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchPreparedCftc(path, {
      signal: controller.signal,
      timeoutMs: 46_000,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setRequest({ path, status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRequest({ path, status: "error", data: null });
      });
    return () => controller.abort();
  }, [path, retry]);

  const raw = request.path === path ? request.data : null;
  const positioning: any = useMemo(
    () => (raw ? scenarioMarketHistory(raw, candidate) : null),
    [raw, candidate],
  );
  const pending = request.path !== path || request.status === "loading";
  const unavailable = request.status === "error";
  const invalid = !pending && !unavailable && !positioning;
  const chart = positioning?.chart;
  const refresh = () => {
    clearPreparedCftc(path);
    if (positioning?.reportDate)
      clearPreparedCftc(concentrationPath(candidate, positioning.reportDate));
    setRequest({ path, status: "loading", data: null });
    setRetry((value) => value + 1);
  };

  return (
    <section className={s.panel} aria-labelledby={`${id}-heading`}>
      <header className={s.heading}>
        <div>
          <span className={s.eyebrow}>
            <ChartNoAxesCombined size={15} aria-hidden="true" /> CFTC context
          </span>
          <h4 id={`${id}-heading`}>Market positioning</h4>
          <p className={s.marketName}>{candidate.label}</p>
        </div>
        <span className={s.badge}>{candidate.groupLabel} · Futures only</span>
      </header>

      <p className={s.scope}>
        Aggregate futures positions; these are not portfolio holdings or
        measured company exposure.
      </p>

      {pending && (
        <p className={s.notice} role="status">
          Loading {candidate.label} positioning…
        </p>
      )}
      {(unavailable || invalid) && (
        <div className={s.notice} role="status">
          <p>
            {unavailable
              ? "CFTC positioning is temporarily unavailable. Filing-linked company connections remain available."
              : "The returned report did not verify this contract, trader group and futures-only dataset. No positioning values are assumed."}
          </p>
          <button type="button" onClick={refresh}>
            <RefreshCw size={14} aria-hidden="true" /> Retry positioning
          </button>
        </div>
      )}

      {positioning && !pending && !unavailable && (
        <>
          <div className={s.metrics}>
            <div>
              <span>Net / open interest</span>
              <strong>{numeric(positioning.current?.netPctOi, 2, "%")}</strong>
              <small>Long positions minus short positions</small>
            </div>
            <div>
              <span>Weekly change</span>
              <strong>
                {numeric(positioning.weekly?.netPctChange, 2, "", true)}
              </strong>
              <small>Percentage points · exact seven days</small>
            </div>
            <div>
              <span>Positions as of</span>
              <strong className={s.date}>{positioning.reportDate}</strong>
              <small>{positioning.ageDays} days old · observation date</small>
            </div>
          </div>

          {(positioning.stale || positioning.incomplete) && (
            <p className={s.notice}>
              {positioning.stale
                ? "This is an older or last successful market snapshot. "
                : "Some market observations are missing or were excluded. "}
              Available dates remain visible; missing values are not treated as
              zero.
            </p>
          )}

          {chart ? (
            <figure className={s.figure}>
              <figcaption>
                <span>{candidate.groupLabel} net / total open interest</span>
                <span>52-week view</span>
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
                  {chart.count} observations from {chart.start} to {chart.end}.
                  Values are percentages of each report’s total open interest.
                  Positive values indicate more long than short positions in the
                  selected trader group; negative values indicate more short
                  than long positions. Lines break at unavailable observations
                  or gaps longer than eight days. Exact values are in the
                  observations table below.
                </desc>
                <line
                  x1="48"
                  x2="640"
                  y1={chart.zeroY}
                  y2={chart.zeroY}
                  className={s.zeroLine}
                />
                {chart.paths.map((line: string, index: number) => (
                  <path key={index} d={line} />
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

          <TraderConcentration
            key={`${candidate.family}:${candidate.contract}:${positioning.reportDate}`}
            candidate={candidate}
            selected={raw.selected}
            openInterest={positioning.current?.openInterest}
          />

          <div className={s.actions}>
            <a href={positioning.marketPath} target="_blank" rel="noreferrer">
              Explore this market <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            <button type="button" onClick={refresh}>
              <RefreshCw size={14} aria-hidden="true" /> Refresh positioning
            </button>
          </div>

          <details className={s.details}>
            <summary>Source, methodology & observations</summary>
            <p>
              <a href={positioning.sourceUrl} target="_blank" rel="noreferrer">
                Official CFTC source{" "}
                <ArrowUpRight size={12} aria-hidden="true" />
              </a>{" "}
              ·{" "}
              {candidate.family === "tff"
                ? "Traders in Financial Futures"
                : "Disaggregated"}
              , futures only · Contract {candidate.contract} ·{" "}
              {candidate.groupLabel}.
            </p>
            <p>
              Net / open interest = 100 × (long − short) / total market open
              interest. Each report date uses its own denominator. Positions
              describe outstanding contracts, not cash flows. This does not
              establish company sensitivity, market direction or portfolio risk.
            </p>
            <p>
              {positioning.weekly.available
                ? positioning.weekly.explanation
                : positioning.weekly.reason}{" "}
              Total market open interest changed by{" "}
              {numeric(positioning.openInterestChangePct, 2, "%", true)} over
              the same exact week.
            </p>
            <p>
              Report dates are position observation dates. COT is normally
              published on Friday for Tuesday positions, with schedule
              exceptions. Publication time is not verified here.
            </p>
            <div
              className={s.tableWrap}
              role="region"
              aria-label={`${candidate.label} positioning observations`}
              tabIndex={0}
            >
              <table>
                <caption>
                  {candidate.label} · Available observations within the latest
                  52 weeks
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
                  {[...positioning.points].reverse().map((point: any) => (
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
          </details>
        </>
      )}
    </section>
  );
}

function concentrationPath(candidate: any, reportDate: string) {
  return `/api/v1/cftc/concentration?${new URLSearchParams({
    family: candidate.family,
    contract: candidate.contract,
    date: reportDate,
  })}`;
}

function TraderConcentration({
  candidate,
  selected,
  openInterest,
}: {
  candidate: any;
  selected: any;
  openInterest: number | null;
}) {
  const id = useId();
  const path = concentrationPath(candidate, selected.reportDate);
  const [request, setRequest] = useState<RequestState>({
    path,
    status: "loading",
    data: null,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchPreparedCftc(path, {
      signal: controller.signal,
      timeoutMs: 46_000,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setRequest({ path, status: "ready", data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRequest({ path, status: "error", data: null });
      });
    return () => controller.abort();
  }, [path, retry]);
  const raw = request.path === path ? request.data : null;
  const pending = request.path !== path || request.status === "loading";
  const valid =
    raw &&
    cftcConcentrationMatchesHistory(raw, selected) &&
    raw.contract?.openInterest === openInterest;
  const concentration = valid ? raw.concentration : null;
  const available = concentration && ["ready", "partial"].includes(raw.status);
  const refresh = () => {
    clearPreparedCftc(path);
    setRequest({ path, status: "loading", data: null });
    setRetry((value) => value + 1);
  };

  return (
    <section className={s.concentration} aria-labelledby={`${id}-heading`}>
      <div className={s.concentrationHeading}>
        <h5 id={`${id}-heading`}>Largest traders in this market</h5>
        <span>All reportable trader groups</span>
      </div>
      <p>
        Gross positions held by the largest four or eight traders (or fewer),
        as a share of total market open interest on {selected.reportDate}.
      </p>
      {pending && (
        <p className={s.note} role="status">
          Loading trader concentration for the same report date…
        </p>
      )}
      {!pending && !available && (
        <div className={s.concentrationUnavailable} role="status">
          <p>
            Trader concentration is unavailable for this exact contract and
            report date. Positioning above remains available.
          </p>
          <button type="button" onClick={refresh}>
            <RefreshCw size={13} aria-hidden="true" /> Retry trader
            concentration
          </button>
        </div>
      )}
      {!pending && available && (
        <>
          <div
            className={s.concentrationTableWrap}
            role="region"
            aria-label={`${candidate.label} largest trader concentration`}
            tabIndex={0}
          >
            <table className={s.concentrationTable}>
              <caption className={s.srOnly}>
                Largest four or eight reportable traders (or fewer), with gross
                positions as percentages of total open interest. Each bar uses
                a scale of zero to 100%.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Largest traders</th>
                  <th scope="col">Gross long</th>
                  <th scope="col">Gross short</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Top 4", concentration.top4],
                  ["Top 8", concentration.top8],
                ].map(([label, values]: any) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {["longPct", "shortPct"].map((side) => (
                      <td key={side}>
                        <div className={s.concentrationValue}>
                          <span>{numeric(values[side], 1, "%")}</span>
                          <span className={s.barTrack} aria-hidden="true">
                            {typeof values[side] === "number" && (
                              <span
                                className={
                                  side === "longPct" ? s.longBar : s.shortBar
                                }
                                style={{ width: `${values[side]}%` }}
                              />
                            )}
                          </span>
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={s.concentrationScope}>
            Top 4 is included within Top 8. Long and short sides may involve
            different traders and must not be added together. These figures
            cover all reportable traders, not only {candidate.groupLabel}.
          </p>
          {raw.status === "partial" && (
            <p className={s.note}>
              Some published concentration fields are unavailable; they are not
              shown as zero.
            </p>
          )}
          <a
            className={s.concentrationSource}
            href={raw.source.url}
            target="_blank"
            rel="noreferrer"
          >
            CFTC concentration source{" "}
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </>
      )}
    </section>
  );
}
