"use client";

import { useMemo } from "react";
import { Search, Target } from "lucide-react";
import { benchmarkDistribution } from "../../../utils/compareBenchmarks.js";
import { METRIC_BY_KEY } from "../../../utils/compareResearch.js";
import {
  displayDelta,
  displayValue,
  type CompareEvidence,
  type CompareSettings,
} from "../compareTypes";
import shared from "../compare.module.css";
import styles from "./CompareBenchmarks.module.css";

export default function CompareBenchmarks({
  entries,
  metrics,
  settings,
  update,
  inspect,
}: {
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  update: (patch: Partial<CompareSettings>) => void;
  inspect: (evidence: CompareEvidence) => void;
}) {
  const metric = METRIC_BY_KEY[settings.metric] || metrics[0];
  const study = useMemo(
    () => benchmarkDistribution(entries, metric.key, settings),
    [entries, metric.key, settings],
  );
  const plotted = [study.focus, ...study.peers].filter((cell) =>
    Number.isFinite(cell?.point?.value),
  );
  const values = plotted.map((cell) => cell.point.value);
  const low = Math.min(...values),
    high = Math.max(...values);
  const position = (value: number) =>
    high === low ? 50 : 4 + ((value - low) / (high - low)) * 92;
  return (
    <section className={shared.panel} aria-labelledby="benchmark-title">
      <div className={shared.sectionHead}>
        <div>
          <span className={shared.eyebrow}>Focus company / Peer context</span>
          <h2 id="benchmark-title">
            How much does the peer set change the answer?
          </h2>
          <p>
            Compare a company with other issuers, see exactly who enters the
            benchmark, and test whether one peer drives the result.
          </p>
        </div>
        <span className={shared.badge}>
          <Target size={14} /> Focus excluded from median
        </span>
      </div>
      <div className={shared.inlineControls}>
        <label>
          Focus company
          <select
            value={study.focusTicker}
            onChange={(event) => update({ focus: event.target.value })}
          >
            {entries.map((entry) => (
              <option key={entry.ticker} value={entry.ticker}>
                {entry.ticker} · {entry.data?.name || "Awaiting company data"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Benchmark metric
          <select
            value={metric.key}
            onChange={(event) => update({ metric: event.target.value })}
          >
            {metrics.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={settings.benchmark === "peers"}
          onClick={() =>
            update({ benchmark: "peers", focus: study.focusTicker })
          }
        >
          {settings.benchmark === "peers"
            ? "Other-peer benchmark selected"
            : "Use this benchmark in comparison table"}
        </button>
      </div>
      {study.reason && (
        <p className={styles.notice} role="status">
          Benchmark unavailable: {study.reason} Original observations remain
          inspectable below.
        </p>
      )}
      {study.definitionNote && (
        <p className={styles.notice}>{study.definitionNote}</p>
      )}
      <div className={styles.summary}>
        <div>
          <span>{study.focusTicker || "Focus"}</span>
          <strong>
            {displayValue(study.focus?.point?.value, metric.format)}
          </strong>
          <small>{study.focus?.period?.end || "No selected period"}</small>
        </div>
        <div>
          <span>Other-peer median</span>
          <strong>{displayValue(study.median, metric.format)}</strong>
          <small>
            {study.count} eligible other issuers
            {study.reason ? " · comparison paused" : ""}
          </small>
        </div>
        <div>
          <span>Focus minus peer median</span>
          <strong>{displayDelta(study.focusDelta, metric.format)}</strong>
          <small>
            Arithmetic difference; higher is not necessarily better.
          </small>
        </div>
        <div>
          <span>Observed peer range</span>
          <strong>
            {study.min == null
              ? "—"
              : `${displayValue(study.min, metric.format)} – ${displayValue(study.max, metric.format)}`}
          </strong>
          <small>
            {study.q1 == null
              ? "Quartiles require four other issuers."
              : `Middle 50%: ${displayValue(study.q1, metric.format)} – ${displayValue(study.q3, metric.format)}`}
          </small>
        </div>
      </div>
      {study.median != null && (
        <div
          className={styles.distribution}
          aria-label={`${metric.label} distribution for ${study.focusTicker} and ${study.count} other issuers`}
        >
          <div className={styles.distributionHead}>
            <h3>{metric.label} · every included observation</h3>
            <span>Gold marker: focus · dashed guide: other-peer median</span>
          </div>
          {plotted.map((cell) => (
            <div key={cell.ticker} className={styles.plotRow}>
              <span>
                {cell.ticker}
                {cell.ticker === study.focus?.ticker ? " (focus)" : ""}
              </span>
              <div className={styles.track} aria-hidden="true">
                {study.q1 != null && (
                  <span
                    className={styles.quartile}
                    style={{
                      left: `${position(study.q1)}%`,
                      width: `${position(study.q3) - position(study.q1)}%`,
                    }}
                  />
                )}
                <span
                  className={styles.median}
                  style={{ left: `${position(study.median)}%` }}
                />
                <span
                  className={
                    cell.ticker === study.focus?.ticker
                      ? styles.focusDot
                      : styles.peerDot
                  }
                  style={{ left: `${position(cell.point.value)}%` }}
                />
              </div>
              <button
                className={shared.valueButton}
                onClick={() => inspect({ metric, cell })}
                aria-label={`Inspect ${cell.ticker} ${metric.label} benchmark observation`}
              >
                {displayValue(cell.point.value, metric.format)}{" "}
                <Search size={12} />
              </button>
            </div>
          ))}
          <p className={styles.caption}>
            The shaded band appears with four peers and shows linearly
            interpolated sample quartiles. This small selected set is not a
            market-wide distribution.
          </p>
        </div>
      )}
      <div
        className={shared.tableScroll}
        tabIndex={0}
        role="region"
        aria-label="Exact benchmark membership and exclusion reasons"
      >
        <table className={shared.table}>
          <caption>
            Exact membership ·{" "}
            {study.peers.map((cell) => cell.ticker).join(", ") ||
              "No eligible peers"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Issuer / SEC identity</th>
              <th scope="col">Selected observation</th>
              <th scope="col">Benchmark treatment</th>
            </tr>
          </thead>
          <tbody>
            {study.cohort.map((cell) => (
              <tr key={cell.ticker}>
                <th scope="row">
                  {cell.ticker}
                  <small>CIK {cell.cik || "unresolved"}</small>
                </th>
                <td>
                  <button
                    className={shared.valueButton}
                    disabled={!cell.point}
                    onClick={() => inspect({ metric, cell })}
                    aria-label={`Inspect ${cell.ticker} ${metric.label} cohort evidence`}
                  >
                    {displayValue(cell.point?.value, metric.format)}{" "}
                    <Search size={12} />
                  </button>
                  <small>
                    {cell.period?.start
                      ? `${cell.period.start} to `
                      : "Balance at "}
                    {cell.period?.end || "unavailable"} ·{" "}
                    {cell.period?.kind || "unknown basis"}
                  </small>
                </td>
                <td>
                  <strong>
                    {cell.included
                      ? study.reason
                        ? "Eligible; group comparison paused"
                        : "Included peer"
                      : cell.isFocus
                        ? "Focus issuer"
                        : "Excluded"}
                  </strong>
                  <small>
                    {cell.reason ||
                      "Usable source inputs and compatible reporting dates."}
                  </small>
                  {cell.quality.issues.map((issue) => (
                    <small key={issue}>{issue}</small>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className={shared.details}>
        <summary>Remove one peer at a time · benchmark sensitivity</summary>
        <p>
          Each row recalculates the same metric after excluding just that
          issuer. The focus company remains excluded. Nothing changes in your
          selected peer set.
        </p>
        <div className={shared.tableScroll}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th scope="col">Peer removed</th>
                <th scope="col">Peers remaining</th>
                <th scope="col">New median</th>
                <th scope="col">Median shift</th>
                <th scope="col">Focus minus new median</th>
              </tr>
            </thead>
            <tbody>
              {study.sensitivity.map((row) => (
                <tr key={row.omitted}>
                  <th scope="row">{row.omitted}</th>
                  <td>
                    {row.members.join(", ") || "None"}
                    <small>N = {row.count}</small>
                  </td>
                  <td>
                    {displayValue(row.median, metric.format)}
                    {row.reason && <small>{row.reason}</small>}
                  </td>
                  <td>{displayDelta(row.shift, metric.format)}</td>
                  <td>{displayDelta(row.focusDelta, metric.format)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!study.sensitivity.length && (
          <p>
            No eligible other peers are available for this sensitivity check.
          </p>
        )}
      </details>
      <div className={shared.panelFoot}>
        At least two other SEC issuers are required. One issuer is counted once
        even if multiple share classes are requested. Reporting ends must span
        no more than 45 days and flow durations no more than 14 days. No
        percentile, quality rating, or risk score is inferred from this sample.
      </div>
    </section>
  );
}
