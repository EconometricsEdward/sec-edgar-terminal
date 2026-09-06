"use client";
import { Download, FolderOpen, Bookmark, Trash2 } from "lucide-react";
import {
  exportCompareCsv,
  exportCompareBrief,
} from "../../../utils/compareNotebook.js";
import {
  displayValue,
  downloadFile,
  type CompareEvidence,
} from "../compareTypes";
import styles from "../compare.module.css";

export default function CompareNotebook({
  notebook,
  mutate,
  load,
  inspect,
  notice,
}: {
  notebook: any;
  mutate: (update: (n: any) => any) => void;
  load: (item: any) => void;
  inspect: (e: CompareEvidence) => void;
  notice: (s: string) => void;
}) {
  const exportFile = (brief: boolean) => {
    downloadFile(
      brief ? "peer-comparison-brief.html" : "peer-comparison-evidence.csv",
      brief
        ? exportCompareBrief(notebook)
        : exportCompareCsv(notebook.pins, notebook),
      brief ? "text/html;charset=utf-8" : "text/csv;charset=utf-8",
    );
    notice(`${brief ? "Research brief" : "Evidence CSV"} downloaded.`);
  };
  return (
    <section className={styles.panel}>
      <div className={styles.sectionHead}>
        <div>
          <span className={styles.eyebrow}>04 / Research notebook</span>
          <h2>Make the comparison useful.</h2>
          <p>
            Save setups, collect evidence, and add the interpretation that
            belongs in your research memo.
          </p>
        </div>
        <span className={styles.badge}>Saved in this browser</span>
      </div>
      <div className={styles.notebookGrid}>
        <div>
          <h3>
            <Bookmark size={16} /> Saved comparisons
          </h3>
          {!notebook.searches.length && (
            <p className={styles.emptySmall}>
              Use “Save comparison” above to retain your peer set, period,
              metrics, exclusions, and benchmark.
            </p>
          )}
          {notebook.searches.map((search: any) => (
            <article key={search.id} className={styles.saved}>
              <strong>{search.name}</strong>
              <small>
                {search.tickers.join(" · ")}
                <br />
                {search.settings.basis} ·{" "}
                {search.settings.asOf || "Latest filings"} · Saved{" "}
                {search.savedAt.slice(0, 10)}
              </small>
              <div className={styles.actions}>
                <button onClick={() => load(search)}>
                  <FolderOpen size={14} /> Open comparison
                </button>
                <button
                  aria-label={`Delete saved comparison ${search.name}`}
                  onClick={() =>
                    mutate((n) => ({
                      ...n,
                      searches: n.searches.filter(
                        (s: any) => s.id !== search.id,
                      ),
                    }))
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          ))}
          <p className={styles.emptySmall}>
            Saved setups refresh public SEC data when opened. Evidence
            collections retain the values and sources captured when saved.
            Export a brief to keep a portable copy.
          </p>
        </div>
        <div>
          <label className={styles.field}>
            Collection name
            <input
              value={notebook.collectionName}
              maxLength={120}
              onChange={(e) =>
                mutate((n) => ({ ...n, collectionName: e.target.value }))
              }
            />
          </label>
          <label className={styles.field}>
            Research memo
            <textarea
              value={notebook.notes}
              maxLength={16000}
              rows={5}
              placeholder="What explains the peer differences? What needs further review?"
              onChange={(e) => mutate((n) => ({ ...n, notes: e.target.value }))}
            />
          </label>
          <div className={styles.actions}>
            <button
              disabled={!notebook.pins.length}
              onClick={() => exportFile(true)}
            >
              <Download size={14} /> Export readable brief
            </button>
            <button
              disabled={!notebook.pins.length}
              onClick={() => exportFile(false)}
            >
              <Download size={14} /> Export evidence CSV
            </button>
            <span className={styles.badge}>
              {notebook.pins.length} saved observations
            </span>
          </div>
        </div>
      </div>
      {!notebook.pins.length && (
        <div className={styles.emptySmall}>
          Choose a financial value and save it from the evidence inspector to
          start your collection.
        </div>
      )}
      <div className={styles.evidenceGrid}>
        {notebook.pins.map((pin: any) => (
          <article key={pin.id} className={styles.saved}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.eyebrow}>
                  {pin.ticker} / {pin.point?.period?.end}
                </span>
                <h3>{pin.label}</h3>
              </div>
              <strong>{displayValue(pin.point?.value, pin.format)}</strong>
            </div>
            <small>
              {pin.point?.period?.kind} · {pin.point?.classification} · Saved{" "}
              {pin.savedAt.slice(0, 10)}
            </small>
            <label className={styles.field}>
              Observation notes
              <textarea
                rows={3}
                value={pin.notes}
                maxLength={8000}
                onChange={(e) =>
                  mutate((n) => ({
                    ...n,
                    pins: n.pins.map((p: any) =>
                      p.id === pin.id ? { ...p, notes: e.target.value } : p,
                    ),
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              Tags
              <input
                placeholder="liquidity, funding, follow-up"
                maxLength={300}
                value={pin.tags}
                onChange={(e) =>
                  mutate((n) => ({
                    ...n,
                    pins: n.pins.map((p: any) =>
                      p.id === pin.id ? { ...p, tags: e.target.value } : p,
                    ),
                  }))
                }
              />
            </label>
            <div className={styles.actions}>
              <button
                onClick={() =>
                  inspect({
                    metric: {
                      key: pin.metric,
                      label: pin.label,
                      format: pin.format,
                    },
                    cell: {
                      ticker: pin.ticker,
                      name: pin.name,
                      cik: pin.cik,
                      period: pin.point.period,
                      point: pin.point,
                    },
                  })
                }
              >
                Review saved sources
              </button>
              <button
                aria-label={`Remove saved evidence ${pin.ticker} ${pin.label}`}
                onClick={() =>
                  mutate((n) => ({
                    ...n,
                    pins: n.pins.filter((p: any) => p.id !== pin.id),
                  }))
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
