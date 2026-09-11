"use client";
import { useMemo, useState } from "react";
import { Camera, ExternalLink, RotateCcw, Trash2 } from "lucide-react";
import {
  createCompareSnapshot,
  compareSnapshot,
  MAX_COMPARE_SNAPSHOTS,
  SNAPSHOT_STATUS_LABELS,
} from "../../../utils/compareSnapshots.js";
import {
  displayValue,
  displayDelta,
  type CompareEvidence,
  type CompareSettings,
} from "../compareTypes";
import shared from "../compare.module.css";
import styles from "./CompareSnapshots.module.css";

type SnapshotProps = {
  notebook: any;
  mutate: (update: (notebook: any) => any) => boolean;
  entries: any[];
  metrics: any[];
  settings: CompareSettings;
  tickers: string[];
  inspect: (evidence: CompareEvidence) => void;
  load: (item: any) => void;
};
const periodText = (evidence: any) => {
  const period = evidence?.cell?.point?.period || evidence?.cell?.period;
  return period
    ? `${period.start || "Balance at"} → ${period.end || "Unknown end"} · ${period.kind || "Unknown basis"}`
    : "No reporting period";
};
export default function CompareSnapshots({
  notebook,
  mutate,
  entries,
  metrics,
  settings,
  tickers,
  inspect,
  load,
}: SnapshotProps) {
  const snapshots: any[] = notebook.snapshots || [];
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("changes");
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<any>(null);
  const selected =
    snapshots.find((snapshot) => snapshot.id === selectedId) || snapshots[0];
  const comparison = useMemo(() => {
    if (!selected || !entries.length || !metrics.length) return null;
    try {
      return {
        ...compareSnapshot(selected, { metrics, entries, settings, tickers }),
        error: "",
      };
    } catch (error) {
      return {
        rows: [],
        counts: {},
        settingsDifferences: [],
        error:
          error instanceof Error
            ? error.message
            : "This snapshot could not be compared.",
      };
    }
  }, [selected, metrics, entries, settings, tickers]);
  const rows =
    comparison?.rows.filter(
      (row: any) =>
        filter === "all" ||
        (filter === "changes"
          ? !["unchanged", "unavailable", "loading"].includes(row.status)
          : row.status === filter),
    ) || [];
  const capture = () => {
    try {
      const snapshot = createCompareSnapshot({
        name,
        entries,
        metrics,
        settings,
        tickers,
      });
      if (
        mutate((current) => {
          if ((current.snapshots || []).length >= MAX_COMPARE_SNAPSHOTS)
            throw new Error(
              "Eight snapshots are already saved. Remove one before capturing another.",
            );
          return {
            ...current,
            snapshots: [snapshot, ...(current.snapshots || [])],
          };
        })
      ) {
        setSelectedId(snapshot.id);
        setName("");
        setNotice(
          `Saved “${snapshot.name}” with its original reported inputs in this browser.`,
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "This snapshot could not be saved.",
      );
    }
  };
  const remove = () => {
    if (!selected) return;
    if (
      mutate((current) => ({
        ...current,
        snapshots: (current.snapshots || []).filter(
          (snapshot: any) => snapshot.id !== selected.id,
        ),
      }))
    ) {
      setDeleted(selected);
      setSelectedId("");
      setNotice(`Removed “${selected.name}”. You can undo this removal below.`);
    }
  };
  const undo = () => {
    if (!deleted) return;
    if (
      mutate((current) => {
        if (
          (current.snapshots || []).some(
            (snapshot: any) => snapshot.id === deleted.id,
          )
        )
          return current;
        if ((current.snapshots || []).length >= MAX_COMPARE_SNAPSHOTS)
          throw new Error("Remove another snapshot before restoring this one.");
        return {
          ...current,
          snapshots: [deleted, ...(current.snapshots || [])],
        };
      })
    ) {
      setSelectedId(deleted.id);
      setDeleted(null);
      setNotice("Snapshot restored.");
    }
  };
  return (
    <section className={shared.panel} aria-labelledby="compare-snapshots-title">
      <div className={shared.sectionHead}>
        <div>
          <span className={shared.eyebrow}>Research checkpoints</span>
          <h2 id="compare-snapshots-title">
            What changed since your last review?
          </h2>
          <p>
            Freeze the selected metric grid with its filing inputs. Return later
            to distinguish new reporting periods, changed values and changes in
            coverage.
          </p>
        </div>
        <span className={shared.badge}>
          {snapshots.length}/{MAX_COMPARE_SNAPSHOTS} snapshots · this browser
        </span>
      </div>
      <div className={styles.capture}>
        <label>
          Snapshot name
          <input
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="September bank peer review"
            onKeyDown={(event) => {
              if (event.key === "Enter" && name.trim()) capture();
            }}
          />
        </label>
        <button
          className={shared.primary}
          disabled={
            !name.trim() ||
            !entries.length ||
            !metrics.length ||
            entries.some((entry) => entry.loading) ||
            snapshots.length >= MAX_COMPARE_SNAPSHOTS
          }
          onClick={capture}
        >
          <Camera size={15} /> Capture selected grid
        </button>
        <small>
          {entries.length} selected issuers · {metrics.length} metrics. Includes
          missing observations and their coverage status. Scenario assumptions
          are not captured.
        </small>
      </div>
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {deleted && (
        <button className={styles.undo} onClick={undo}>
          <RotateCcw size={14} /> Undo removal of {deleted.name}
        </button>
      )}
      {selected ? (
        <>
          <div className={styles.controls}>
            <label>
              Saved snapshot
              <select
                value={selected.id}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.name} · {snapshot.capturedAt.slice(0, 10)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Show differences
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="changes">
                  Changes and coverage differences
                </option>
                <option value="all">All observations</option>
                {Object.entries(SNAPSHOT_STATUS_LABELS)
                  .filter(([status]) => comparison?.counts?.[status])
                  .map(([status, label]) => (
                    <option key={status} value={status}>
                      {label} ({comparison?.counts?.[status]})
                    </option>
                  ))}
              </select>
            </label>
            <div className={styles.buttons}>
              <button onClick={() => load(selected)}>
                <RotateCcw size={14} /> Restore setup
              </button>
              <button
                onClick={remove}
                aria-label={`Remove snapshot ${selected.name}`}
              >
                <Trash2 size={14} /> Remove
              </button>
            </div>
          </div>
          <p className={styles.context}>
            <strong>{selected.name}</strong> · Captured{" "}
            {new Date(selected.capturedAt).toLocaleString()} ·{" "}
            {selected.companies.length} issuers · {selected.metrics.length}{" "}
            metrics. Filing cutoff:{" "}
            {selected.settings.asOf || "latest available at capture"}. Restoring
            a setup reloads current SEC data; use saved evidence to inspect the
            frozen values.
          </p>
          {!!comparison?.settingsDifferences.length && (
            <p className={styles.notice}>
              Current settings differ:{" "}
              {comparison.settingsDifferences.join(", ")}. Company and metric
              membership changes remain visible. Value differences require
              identical reporting start, end, basis and metric definition.
            </p>
          )}
          {comparison?.error ? (
            <p className={styles.notice} role="alert">
              {comparison.error}
            </p>
          ) : comparison ? (
            <>
              <div className={styles.summary}>
                {Object.entries(comparison.counts).map(([status, count]) => (
                  <button
                    key={status}
                    onClick={() => setFilter(status)}
                    aria-pressed={filter === status}
                  >
                    <strong>{String(count)}</strong>{" "}
                    {
                      SNAPSHOT_STATUS_LABELS[
                        status as keyof typeof SNAPSHOT_STATUS_LABELS
                      ]
                    }
                  </button>
                ))}
              </div>
              <div
                className={shared.tableScroll}
                tabIndex={0}
                role="region"
                aria-label="Snapshot differences, scroll horizontally to inspect saved and current evidence"
              >
                <table className={shared.table}>
                  <thead>
                    <tr>
                      <th scope="col">Company / metric</th>
                      <th scope="col">Saved observation</th>
                      <th scope="col">Current observation</th>
                      <th scope="col">What changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: any) => (
                      <tr key={row.id}>
                        <th scope="row">
                          {row.ticker}
                          <small>{row.metric.label}</small>
                        </th>
                        {[row.prior, row.current].map((evidence, index) => (
                          <td key={index}>
                            {evidence ? (
                              <>
                                <button
                                  className={shared.valueButton}
                                  onClick={() => inspect(evidence)}
                                  aria-label={`Inspect ${index === 0 ? "saved" : "current"} ${row.ticker} ${row.metric.label}`}
                                >
                                  <strong>
                                    {displayValue(
                                      evidence.cell.point?.value,
                                      evidence.metric.format,
                                    )}
                                  </strong>
                                  <ExternalLink size={12} />
                                </button>
                                <small>{periodText(evidence)}</small>
                                <small>
                                  {evidence.cell.point?.reason ||
                                    evidence.cell.status}
                                </small>
                              </>
                            ) : (
                              <span>
                                {index === 0 ? "Not captured" : "Not selected"}
                              </span>
                            )}
                          </td>
                        ))}
                        <td>
                          <strong>
                            {
                              SNAPSHOT_STATUS_LABELS[
                                row.status as keyof typeof SNAPSHOT_STATUS_LABELS
                              ]
                            }
                          </strong>
                          {row.delta != null && (
                            <small>
                              {displayDelta(row.delta, row.metric.format)} ·
                              current minus saved
                            </small>
                          )}
                          <small>{row.detail}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && (
                  <p className={styles.empty}>
                    No observations match this filter. Choose “All observations”
                    to review the full saved and current grid.
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className={styles.empty}>
              Load a company comparison and select metrics to compare it with
              this snapshot.
            </p>
          )}
        </>
      ) : (
        <p className={styles.empty}>
          Your first snapshot becomes a review checkpoint. Save one before the
          next filing cycle, then return here to inspect exactly which
          observations changed.
        </p>
      )}
      <div className={shared.panelFoot}>
        A changed input or value does not by itself establish a restatement or
        explain economic performance. Source links, original values and capture
        settings remain available for review. Snapshots are stored in this
        browser.
      </div>
    </section>
  );
}
