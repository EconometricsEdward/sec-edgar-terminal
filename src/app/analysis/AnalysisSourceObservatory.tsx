"use client";

import { useMemo, useState } from "react";
import { ExternalLink, FileSearch, Layers3, Search } from "lucide-react";
import { analysisValue } from "../../utils/analysisNotebook.js";
import {
  analysisRevisionLedger,
  analysisSourceCoherence,
  buildAnalysisSourceMatrix,
} from "../../utils/analysisSources.js";
import styles from "./AnalysisSources.module.css";

const categories = {
  income: "Income statement",
  balance: "Balance sheet",
  cashflow: "Cash flow",
  ratios: "Industry ratios",
  drivers: "Return drivers",
  checks: "Reconciliation inputs",
};
const states = {
  reported: "Reported",
  calculated: "Calculated",
  missing: "Missing",
};
const sourceValue = (value: number, unit: string) =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${unit || ""}`;

export default function AnalysisSourceObservatory({
  data,
  settings,
  index,
  onInspect,
}: any) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [state, setState] = useState("all");
  const [ledgerLimit, setLedgerLimit] = useState(12);
  const matrix = useMemo(
    () => buildAnalysisSourceMatrix(data, settings, index),
    [data, settings, index],
  );
  const ledger = useMemo(
    () =>
      analysisRevisionLedger(
        data,
        matrix.periods.map((p) => p.index),
      ),
    [data, matrix],
  );
  const coherence = useMemo(
    () =>
      analysisSourceCoherence(
        {
          sources: data.definitions.flatMap(
            (definition) =>
              data.metrics[definition.key]?.[index]?.sources || [],
          ),
        },
        settings.asOf,
      ),
    [data, index, settings.asOf],
  );
  const needle = query.trim().toLowerCase();
  const visible = matrix.rows.filter(
    ({ definition, cells }) =>
      (category === "all" || definition.category === category) &&
      (!needle ||
        `${definition.label} ${definition.key} ${cells.flatMap((cell) => (cell.point?.sources || []).map((source) => source.tag)).join(" ")}`
          .toLowerCase()
          .includes(needle)) &&
      (state === "all" ||
        cells.some((cell) =>
          state === "revised" ? cell.revised : cell.kind === state,
        )),
  );
  const visibleKeys = new Set(visible.map((row) => row.definition.key));
  const visibleLedger = ledger.filter((entry) =>
    entry.uses.some((use) => visibleKeys.has(use.definition.key)),
  );

  return (
    <section
      className={styles.observatory}
      aria-labelledby="analysis-sources-title"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Trace every figure</p>
          <h2 id="analysis-sources-title">Source observatory</h2>
          <p>
            See where reported evidence ends and calculations begin. Open any
            cell to inspect its inputs, including unavailable figures.
          </p>
        </div>
        <FileSearch size={30} aria-hidden="true" />
      </div>
      <div
        className={styles.stats}
        aria-label="Coverage in the retained period window"
      >
        <article>
          <span>Available metric-period cells</span>
          <strong>
            {matrix.totals.available}
            <small> / {matrix.totals.total}</small>
          </strong>
        </article>
        <article>
          <span>Reported / calculated</span>
          <strong>
            {matrix.totals.reported}
            <small> / {matrix.totals.calculated}</small>
          </strong>
        </article>
        <article>
          <span>Missing inputs</span>
          <strong>{matrix.totals.missing}</strong>
        </article>
        <article>
          <span>Cells with revised inputs</span>
          <strong>{matrix.totals.revised}</strong>
        </article>
      </div>
      <p className={styles.note}>
        Counts cover all metrics across the {matrix.periods.length} displayed
        periods before filters. A missing cell means the required normalized
        XBRL context is unavailable; it does not mean zero or that the company
        made no disclosure. Revisions can overlap reported and calculated cells.
      </p>
      <div className={styles.filters}>
        <label className={styles.search}>
          <span>
            <Search size={14} aria-hidden="true" /> Find a metric or SEC tag
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={80}
            placeholder="Cash, equity, NetIncomeLoss…"
          />
        </label>
        <label>
          Statement
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">All statements & diagnostics</option>
            {Object.entries(categories).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Evidence state
          <select
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="all">All evidence</option>
            {Object.entries(states).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
            <option value="revised">Has revised inputs</option>
          </select>
        </label>
      </div>
      <div className={styles.legend} aria-label="Coverage key">
        <span data-kind="reported">R · Reported</span>
        <span data-kind="calculated">C · Calculated</span>
        <span data-kind="missing">— · Missing</span>
        <span>↻ · Revised input history</span>
      </div>
      <p className={styles.note} role="status">
        {visible.length} metric rows match. Cells show the underlying value in
        the selected units; common-size display does not alter this source
        inventory.
      </p>
      {visible.length ? (
        <div
          className={styles.tableScroll}
          tabIndex={0}
          role="region"
          aria-label="Scrollable metric and period coverage matrix"
        >
          <table>
            <caption>
              SEC source coverage · {data.ticker} · {data.basis} · filing cutoff{" "}
              {settings.asOf || "latest available"}. Periods are shown newest
              first.
            </caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                {matrix.periods.map(({ period }) => (
                  <th scope="col" key={period.end}>
                    {period.label || period.end}
                    <small>{period.end}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(({ definition, cells }) => (
                <tr key={definition.key}>
                  <th scope="row">
                    {definition.label}
                    <small>
                      {categories[definition.category] || definition.category}
                    </small>
                  </th>
                  {cells.map((cell) => (
                    <td key={cell.period.end}>
                      <button
                        className={styles.cell}
                        data-kind={cell.kind}
                        data-selected={cell.index === index}
                        aria-label={`Inspect ${definition.label}, ${cell.period.end}, ${states[cell.kind]}${cell.revised ? ", revised inputs" : ""}, ${analysisValue(cell.point?.value, definition.format, settings.units)}`}
                        title={
                          cell.kind === "missing"
                            ? cell.point?.reason ||
                              "Required source inputs are unavailable."
                            : `${cell.sourceCount} unique reported input${cell.sourceCount === 1 ? "" : "s"}`
                        }
                        onClick={() =>
                          onInspect({
                            definition,
                            point: cell.point || {
                              period: cell.period,
                              value: null,
                              sources: [],
                              reason:
                                "A required normalized source context is unavailable.",
                            },
                          })
                        }
                      >
                        <span>
                          {cell.kind === "reported"
                            ? "R"
                            : cell.kind === "calculated"
                              ? "C"
                              : "—"}
                          {cell.revised && <span aria-hidden="true"> ↻</span>}
                        </span>
                        <strong>
                          {analysisValue(
                            cell.point?.value,
                            definition.format,
                            settings.units,
                          )}
                        </strong>
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.empty}>
          No metrics match these filters.{" "}
          <button
            onClick={() => {
              setQuery("");
              setCategory("all");
              setState("all");
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      <section
        className={styles.provenance}
        aria-labelledby="analysis-filing-coherence"
      >
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>
              Selected period · {data.periods[index]?.end}
            </p>
            <h3 id="analysis-filing-coherence">
              Do the inputs come from the same filing?
            </h3>
          </div>
          <Layers3 size={22} aria-hidden="true" />
        </div>
        <strong>{coherence.status}</strong>
        <p>{coherence.explanation}</p>
        <dl className={styles.facts}>
          <div>
            <dt>Distinct accessions</dt>
            <dd>{coherence.filingCount}</dd>
          </div>
          <div>
            <dt>Unique reported inputs</dt>
            <dd>{coherence.sourceCount}</dd>
          </div>
          <div>
            <dt>Source filing dates</dt>
            <dd>
              {coherence.earliestFiled || "Unavailable"}
              {coherence.latestFiled !== coherence.earliestFiled &&
                ` → ${coherence.latestFiled}`}
            </dd>
          </div>
          <div>
            <dt>Input date contexts</dt>
            <dd>{coherence.contextCount}</dd>
          </div>
        </dl>
        {coherence.afterCutoff > 0 && (
          <p role="alert">
            {coherence.afterCutoff} inputs are filed after the selected cutoff.
            Review these sources before using this view.
          </p>
        )}
        {coherence.filings.length > 0 && (
          <details>
            <summary>
              Inspect source filing dates and accessions (
              {coherence.filings.length})
            </summary>
            <ul className={styles.filingList}>
              {coherence.filings.map((filing, filingIndex) => (
                <li key={`${filing.accession}:${filingIndex}`}>
                  <div>
                    <strong>
                      {filing.filed || "Filing date unavailable"} ·{" "}
                      {filing.form || "Form unavailable"}
                    </strong>
                    <code>{filing.accession || "Accession unavailable"}</code>
                    <small>
                      {filing.sourceCount} unique reported input
                      {filing.sourceCount === 1 ? "" : "s"}
                    </small>
                  </div>
                  {filing.documentUrl && (
                    <a
                      href={filing.documentUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      SEC filing <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section
        className={styles.ledger}
        aria-labelledby="analysis-revisions-title"
      >
        <div className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>One history per reported context</p>
            <h3 id="analysis-revisions-title">Retained revision ledger</h3>
          </div>
          <span className={styles.count}>{visibleLedger.length} contexts</span>
        </div>
        <p className={styles.note}>
          Different filed values may reflect restatements, reclassifications, or
          other reporting changes. The same source reused in several metrics
          appears once. Each context retains up to 12 value changes within the
          filing cutoff; earlier history may be omitted. These are not automatic
          error or risk labels.
        </p>
        {visibleLedger.length === 0 ? (
          <p className={styles.empty}>
            No retained revision history is attached to the metrics matching
            these filters. This does not certify that no filing was amended.
          </p>
        ) : (
          <div className={styles.ledgerItems}>
            {visibleLedger.slice(0, ledgerLimit).map((entry) => (
              <details key={entry.id} className={styles.ledgerEntry}>
                <summary>
                  <span>
                    <strong>{entry.source.label || entry.source.tag}</strong>
                    <small>
                      {entry.source.start || "Instant"} → {entry.source.end} ·{" "}
                      {entry.source.unit}
                    </small>
                  </span>
                  <span>
                    {entry.revisions.length} retained value
                    {entry.revisions.length === 1 ? "" : "s"}
                  </span>
                </summary>
                <code>
                  {entry.source.taxonomy}:{entry.source.tag}
                </code>
                <ol className={styles.history}>
                  {entry.revisions.map((revision, revisionIndex) => (
                    <li
                      key={`${revision.accession}:${revision.value}:${revisionIndex}`}
                    >
                      <span className={styles.historyDate}>
                        {revision.filed || "Date unavailable"} ·{" "}
                        {revision.form || "Form unavailable"}
                      </span>
                      <strong>
                        {sourceValue(revision.value, entry.source.unit)}
                      </strong>
                      <code>
                        {revision.accession || "Accession unavailable"}
                      </code>
                      {revision.documentUrl && (
                        <a
                          href={revision.documentUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open this SEC source{" "}
                          <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
                <p className={styles.note}>
                  Used in{" "}
                  {new Set(entry.uses.map((use) => use.definition.key)).size}{" "}
                  metrics across{" "}
                  {new Set(entry.uses.map((use) => use.period?.end)).size}{" "}
                  displayed periods.
                </p>
                <div className={styles.uses}>
                  {entry.uses.slice(0, 8).map((use) => (
                    <button
                      key={`${use.definition.key}:${use.index}`}
                      onClick={() =>
                        onInspect({
                          definition: use.definition,
                          point: use.point,
                        })
                      }
                    >
                      {use.definition.label} · {use.period?.end}
                    </button>
                  ))}
                  {entry.uses.length > 8 && (
                    <small>
                      Open the coverage matrix for the remaining uses.
                    </small>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
        {visibleLedger.length > ledgerLimit && (
          <button
            className={styles.more}
            onClick={() => setLedgerLimit((count) => count + 24)}
          >
            Show 24 more contexts ({visibleLedger.length - ledgerLimit}{" "}
            remaining)
          </button>
        )}
      </section>
    </section>
  );
}
