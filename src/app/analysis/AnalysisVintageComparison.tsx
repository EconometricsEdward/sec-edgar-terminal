"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, History, LoaderCircle } from "lucide-react";
import { unpackAnalysisCompany } from "../../utils/analysisResearch.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import {
  analysisSecUrl,
  uniqueAnalysisSources,
} from "../../utils/analysisSources.js";
import {
  buildAnalysisVintageComparison,
  exportAnalysisVintageCsv,
  validateVintageDate,
  VINTAGE_STATES,
} from "../../utils/analysisVintage.js";
import { downloadText } from "../../utils/download.js";
import base from "./analysis.module.css";
import styles from "./AnalysisVintageComparison.module.css";

function SourceClues({ point }: any) {
  const sources = uniqueAnalysisSources(point);
  if (!sources.length)
    return (
      <small className={styles.source}>
        {point.reason || "No retained source inputs."}
      </small>
    );
  return (
    <details className={styles.sources}>
      <summary>
        {sources.length} source input{sources.length === 1 ? "" : "s"}
      </summary>
      <ul>
        {sources.map((source, i) => {
          const url = analysisSecUrl(source.documentUrl);
          return (
            <li key={`${source.accession}:${source.tag}:${i}`}>
              <strong>{source.tag}</strong>
              <span>
                {source.start || "Instant"} → {source.end} · {source.unit}
              </span>
              <span>
                Filed {source.filed || "date unavailable"} ·{" "}
                {source.form || "form unavailable"}
              </span>
              <code>{source.accession || "Accession unavailable"}</code>
              {url && (
                <a href={url} target="_blank" rel="noreferrer">
                  SEC filing <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export default function AnalysisVintageComparison(props: any) {
  const { data, settings, index } = props;
  const period = data.periods[index];
  const context = JSON.stringify([
    data.ticker,
    data.basis,
    data.asOf ?? settings.asOf,
    period?.kind,
    period?.end,
    data.observedAt,
  ]);
  // Remounting the request owner aborts and discards historical results when
  // the company, information set, reporting basis or selected period changes.
  return <VintageRequest key={context} {...props} />;
}

function VintageRequest({ data, settings, index, onInspect, onPatch }: any) {
  const [snapshot, setSnapshot] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("meaningful");
  const request = useRef<AbortController | null>(null);
  const currentCutoff = data.asOf ?? settings.asOf ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const limit = currentCutoff && currentCutoff < today ? currentCutoff : today;
  const maxDate = new Date(Date.parse(limit) - 86400000)
    .toISOString()
    .slice(0, 10);
  const period = data.periods[index];

  useEffect(() => () => request.current?.abort(), []);
  const comparison: any = useMemo(
    () =>
      snapshot
        ? buildAnalysisVintageComparison(data, snapshot.data, index, {
            earlierCutoff: snapshot.cutoff,
            currentCutoff,
          })
        : null,
    [data, snapshot, index, currentCutoff],
  );
  const needle = query.trim().toLowerCase();
  const visible = (comparison?.rows || []).filter(
    (row: any) =>
      (filter === "all" ||
        (filter === "meaningful"
          ? !["unchanged", "missing"].includes(row.state)
          : row.state === filter)) &&
      (!needle ||
        `${row.definition.label} ${row.definition.key} ${[...uniqueAnalysisSources(row.before), ...uniqueAnalysisSources(row.current)].map((source) => `${source.tag} ${source.accession}`).join(" ")}`
          .toLowerCase()
          .includes(needle)),
  );

  const cancel = () => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
  };
  async function compare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the submitted control, including values entered by the native date
    // picker, before any state update. Saved settings are a committed cutoff,
    // not the draft value while a user types a partial date.
    const requested = String(
      new FormData(event.currentTarget).get("vintageDate") || "",
    );
    cancel();
    setSnapshot(null);
    const validation = validateVintageDate(requested, currentCutoff);
    setError(validation);
    if (validation) return;
    onPatch?.({ vintageDate: requested });
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/analysis-research?${new URLSearchParams({ ticker: data.ticker, basis: data.basis, asOf: requested })}`,
        { signal: controller.signal },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ||
            "The earlier filing snapshot could not be retrieved. Try again.",
        );
      const historical = unpackAnalysisCompany(result);
      if (
        !Array.isArray(historical.periods) ||
        !Array.isArray(historical.definitions) ||
        !historical.metrics
      )
        throw new Error("The earlier snapshot was incomplete. Try again.");
      if (!controller.signal.aborted && request.current === controller)
        setSnapshot({ data: historical, cutoff: requested });
    } catch (cause: any) {
      if (!controller.signal.aborted && request.current === controller)
        setError(
          cause.message ||
            "The earlier filing snapshot could not be retrieved. Try again.",
        );
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        setLoading(false);
        request.current = null;
      }
    }
  }
  const inspect = (row: any, side: "before" | "current") => {
    const original = side === "before" ? row.earlierDefinition : row.definition;
    const snapshotSettings =
      side === "before"
        ? comparison.earlierSettings
        : comparison.currentSettings;
    onInspect({
      // Distinct keys prevent the shared inspector from finding an unrelated
      // earlier period in the active dataset for this separate snapshot.
      definition: { ...original, key: `vintage:${side}:${original.key}` },
      label: `${original.label} · filings ${snapshotSettings.asOf ? `through ${snapshotSettings.asOf}` : "latest available"}`,
      point: row[side],
      analysisSettings: snapshotSettings,
    });
  };

  return (
    <section
      className={`${base.panel} ${styles.vintage}`}
      aria-labelledby="analysis-vintage-title"
    >
      <div className={styles.heading}>
        <div>
          <p className={base.eyebrow}>One period, two information sets</p>
          <h2 id="analysis-vintage-title">
            What changed after the original filing?
          </h2>
        </div>
        <History size={26} aria-hidden="true" />
      </div>
      <p className={base.muted}>
        Hold the {data.basis} period ending <strong>{period?.end}</strong> fixed
        and compare the current extract with an earlier filing cutoff. Later
        comparative reports can change historical figures. These observed
        changes are not automatic restatement or error labels.
      </p>
      <form className={styles.controls} onSubmit={compare}>
        <label>
          Earlier filing cutoff
          <input
            type="date"
            name="vintageDate"
            key={settings.vintageDate || ""}
            defaultValue={settings.vintageDate || ""}
            required
            max={maxDate}
            onChange={() => {
              cancel();
              setSnapshot(null);
              setError("");
            }}
            aria-describedby="analysis-vintage-context"
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? (
            <LoaderCircle
              size={15}
              className={styles.spinner}
              aria-hidden="true"
            />
          ) : (
            <History size={15} aria-hidden="true" />
          )}
          {loading ? "Loading earlier snapshot…" : "Compare filing snapshots"}
        </button>
        {loading && (
          <button type="button" onClick={cancel}>
            Cancel request
          </button>
        )}
      </form>
      <p id="analysis-vintage-context" className={styles.note}>
        Current snapshot:{" "}
        {currentCutoff
          ? `filings through ${currentCutoff}`
          : "latest available filings"}
        ; observed {data.observedAt || "time unavailable"}. Earlier snapshots
        are reconstructed from the SEC facts available now, filtered by filing
        date; they are not archived copies of the SEC feed from that date.
        Values use reported units; common-size display does not change this
        comparison.
      </p>
      <div role="status" aria-live="polite">
        {loading && (
          <p className={styles.notice}>
            Retrieving the earlier information set. The current reporting period
            stays selected.
          </p>
        )}
        {!snapshot && !loading && !error && (
          <p className={styles.notice}>
            Choose a date after the selected period’s original filing and before
            the current cutoff to investigate subsequent changes.
          </p>
        )}
      </div>
      {error && (
        <p className={styles.notice} role="alert">
          {error}
        </p>
      )}
      {comparison?.status !== "ready" && comparison?.reason && (
        <p className={styles.notice} role="status">
          {comparison.reason}
        </p>
      )}
      {comparison?.status === "ready" && (
        <>
          <div
            className={styles.stats}
            aria-label="Snapshot comparison coverage before filters"
          >
            <article>
              <span>Earlier available</span>
              <strong>
                {comparison.totals.earlierAvailable}
                <small> / {comparison.totals.total}</small>
              </strong>
            </article>
            <article>
              <span>Current available</span>
              <strong>
                {comparison.totals.currentAvailable}
                <small> / {comparison.totals.total}</small>
              </strong>
            </article>
            <article>
              <span>Compatible value changes</span>
              <strong>{comparison.totals.changed}</strong>
            </article>
            <article>
              <span>Newly available / unavailable now</span>
              <strong>
                {comparison.totals.added}
                <small> / {comparison.totals.removed}</small>
              </strong>
            </article>
          </div>
          <p className={styles.note}>
            Coverage counts normalized metrics, including calculations and
            diagnostics, for this exact period before filters. Missing inputs
            remain unavailable, never zero. Earlier snapshot observed{" "}
            {comparison.earlierObservedAt || "time unavailable"}.
          </p>
          <div className={styles.counts} aria-label="All comparison states">
            {Object.entries(VINTAGE_STATES).map(([key, label]) => (
              <span key={key}>
                {label}: <strong>{comparison.totals[key]}</strong>
              </span>
            ))}
          </div>
          <div className={styles.filters}>
            <label>
              Find metric, source tag, or accession
              <input
                type="search"
                value={query}
                maxLength={100}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Revenue, NetIncomeLoss…"
              />
            </label>
            <label>
              Show
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="meaningful">
                  Changes & comparability issues
                </option>
                <option value="all">All metrics</option>
                {Object.entries(VINTAGE_STATES).map(([key, label]) => (
                  <option value={key} key={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!visible.length}
              onClick={() =>
                downloadText(
                  `${data.ticker}_${period.end}_filing-snapshots.csv`,
                  exportAnalysisVintageCsv(comparison, data, visible, {
                    query,
                    state: filter,
                  }),
                  "text/csv",
                )
              }
            >
              <Download size={14} aria-hidden="true" /> Export visible CSV
            </button>
          </div>
          <p className={styles.note} role="status">
            {visible.length} of {comparison.totals.total} metrics shown. Each
            figure opens evidence from its own filing cutoff.
          </p>
          {visible.length ? (
            <div
              className={styles.tableWrap}
              role="region"
              aria-label="Scrollable filing snapshot comparison"
              tabIndex={0}
            >
              <table>
                <caption>
                  {data.ticker} · {period.end} ·{" "}
                  {comparison.earlierSettings.asOf} versus{" "}
                  {currentCutoff || "latest available"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">
                      Earlier cutoff{" "}
                      <small>{comparison.earlierSettings.asOf}</small>
                    </th>
                    <th scope="col">
                      Current snapshot{" "}
                      <small>{currentCutoff || "Latest available"}</small>
                    </th>
                    <th scope="col">Observed change</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row: any) => (
                    <tr key={row.definition.key}>
                      <th scope="row">
                        {row.definition.label}
                        <small>{row.definition.category}</small>
                      </th>
                      {(["before", "current"] as const).map((side) => (
                        <td key={side}>
                          <button
                            className={styles.value}
                            onClick={() => inspect(row, side)}
                            aria-label={`Inspect ${side === "before" ? "earlier" : "current"} snapshot ${row.definition.label}`}
                          >
                            {analysisValue(
                              row[side].value,
                              side === "before"
                                ? row.earlierDefinition.format
                                : row.definition.format,
                              settings.units,
                            )}
                          </button>
                          <small className={styles.source}>
                            {row[side].classification || "Unavailable"}
                          </small>
                          <SourceClues point={row[side]} />
                        </td>
                      ))}
                      <td>
                        <span className={styles.state} data-state={row.state}>
                          {VINTAGE_STATES[row.state]}
                        </span>
                        {row.delta != null && row.state === "changed" && (
                          <strong className={styles.delta}>
                            {row.delta > 0 ? "+" : ""}
                            {row.definition.format === "percent"
                              ? `${row.delta.toFixed(2)} percentage points`
                              : analysisValue(
                                  row.delta,
                                  row.definition.format,
                                  settings.units,
                                )}
                            {row.percent != null && (
                              <small>
                                {row.percent > 0 ? "+" : ""}
                                {row.percent.toFixed(2)}% from earlier value
                              </small>
                            )}
                          </strong>
                        )}
                        <small className={styles.reason}>{row.reason}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className={styles.notice}>
              No metrics match these filters.{" "}
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Show all metrics
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}
