"use client";
import {
  ArrowUpRight,
  Activity,
  Layers,
  SearchCheck,
  FlaskConical,
  FileText,
} from "lucide-react";
import {
  analysisMovements,
  analysisOverview,
} from "../../utils/analysisOverview.js";
import {
  analysisBaseline,
  analysisChange,
} from "../../utils/analysisResearch.js";
import { analysisValue } from "../../utils/analysisNotebook.js";
import styles from "./analysis.module.css";
import ui from "./overview.module.css";

export default function AnalysisOverview({
  data,
  settings,
  index,
  onInspect,
  onPatch,
}: any) {
  const overview = analysisOverview(data, index);
  const moves = analysisMovements(data, index, settings);
  const beforeIndex = analysisBaseline(data.periods, index, settings.baseline);
  const definitions = new Map(data.definitions.map((d: any) => [d.key, d]));
  const select = (key: string) =>
    onInspect({
      definition: definitions.get(key),
      point: data.metrics[key]?.[index],
    });
  const unit =
    settings.movementSort === "growth"
      ? "%"
      : settings.movementScope === "ratios"
        ? "percentage points"
        : "USD";
  return (
    <div className={ui.stack}>
      <section className={ui.intro}>
        <div>
          <p className={styles.eyebrow}>The analyst’s starting point</p>
          <h2>What deserves your attention?</h2>
          <p>Read the movement. Test an explanation. Keep the evidence.</p>
        </div>
        <div className={ui.coverage}>
          <strong>
            {overview.checks.available}
            <span> / {overview.checks.total}</span>
          </strong>
          <span>financial metrics available</span>
          <button onClick={() => onPatch({ view: "checks" })}>
            Examine coverage <ArrowUpRight size={14} />
          </button>
        </div>
      </section>
      <div className={ui.metrics}>
        {overview.primary.map((key: string) => {
          const d: any = definitions.get(key);
          const point = data.metrics[key]?.[index];
          const delta = analysisChange(
            point,
            data.metrics[key]?.[beforeIndex],
            d.format,
          );
          return (
            <article key={key}>
              <span>{d.label}</span>
              <button onClick={() => select(key)}>
                {analysisValue(point?.value, d.format, settings.units)}
                <ArrowUpRight size={14} />
              </button>
              <small>
                {delta.delta === null
                  ? "Comparable prior input unavailable"
                  : `${delta.delta >= 0 ? "+" : "−"}${d.format === "percent" ? `${Math.abs(delta.delta).toFixed(2)} percentage points` : analysisValue(Math.abs(delta.delta), d.format, settings.units)} vs ${data.periods[beforeIndex]?.end}`}
              </small>
            </article>
          );
        })}
      </div>
      <div className={ui.mainGrid}>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Prioritize your review</p>
              <h2>Largest financial movements</h2>
            </div>
            <Activity size={22} />
          </div>
          <div className={styles.tools}>
            <label>
              Movement category
              <select
                value={settings.movementScope}
                onChange={(e) =>
                  onPatch({
                    movementScope: e.target.value,
                    movementThreshold: 0,
                    movementSort: "absolute",
                  })
                }
              >
                {[
                  ["income", "Income"],
                  ["balance", "Balance sheet"],
                  ["cashflow", "Cash flow"],
                  ["ratios", "Percentage ratios"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rank movements by
              <select
                value={settings.movementSort}
                onChange={(e) =>
                  onPatch({
                    movementSort: e.target.value,
                    movementThreshold: 0,
                  })
                }
              >
                <option value="absolute">Absolute change</option>
                <option
                  value="growth"
                  disabled={settings.movementScope === "ratios"}
                >
                  Percentage growth
                </option>
              </select>
            </label>
            <label>
              Minimum change ({unit})
              <input
                type="number"
                min="0"
                max="1000000000000000"
                step="any"
                value={settings.movementThreshold}
                onChange={(e) =>
                  onPatch({ movementThreshold: Number(e.target.value) })
                }
              />
            </label>
          </div>
          <p className={styles.muted}>
            {data.periods[index].end} versus{" "}
            {data.periods[moves.beforeIndex]?.end ||
              "no compatible prior period"}
            . Ranked by magnitude in {unit}; direction does not indicate quality
            or risk. {moves.comparable}/{moves.considered} metrics eligible.
            Currency ranking excludes per-share figures; growth requires a
            positive prior base.
          </p>
          <ol className={ui.movements}>
            {moves.rows.slice(0, 8).map((r: any) => (
              <li key={r.definition.key}>
                <button onClick={() => select(r.definition.key)}>
                  <span>
                    {r.definition.label}
                    <small>
                      {analysisValue(
                        r.before?.value,
                        r.definition.format,
                        settings.units,
                      )}{" "}
                      →{" "}
                      {analysisValue(
                        r.point?.value,
                        r.definition.format,
                        settings.units,
                      )}
                    </small>
                  </span>
                  <strong data-direction={r.change.delta < 0 ? "down" : "up"}>
                    {r.change.delta >= 0 ? "+" : "−"}
                    {settings.movementSort === "growth"
                      ? `${Math.abs(r.change.percent).toFixed(1)}%`
                      : r.definition.format === "percent"
                        ? `${Math.abs(r.change.delta).toFixed(2)} pp`
                        : analysisValue(
                            Math.abs(r.change.delta),
                            r.definition.format,
                            settings.units,
                          )}
                  </strong>
                  <ArrowUpRight size={15} />
                </button>
              </li>
            ))}
          </ol>
          {!moves.rows.length && (
            <p className={styles.notice}>
              No comparable movements meet this threshold. Lower the filter or
              choose another reporting basis.
            </p>
          )}
          <button
            onClick={() =>
              onPatch({ view: "changes", statement: settings.movementScope })
            }
          >
            Explain these changes <ArrowUpRight size={14} />
          </button>
        </section>
        <aside className={ui.side}>
          <section className={styles.panel}>
            <p className={styles.eyebrow}>Build an explanation</p>
            <h3>Your research path</h3>
            <div className={ui.paths}>
              {[
                [
                  Layers,
                  "trends",
                  "Growth & seasonality",
                  "Is the movement persistent or seasonal?",
                ],
                [
                  Activity,
                  "cash",
                  "Cash quality",
                  data.lens === "corporate"
                    ? "Do earnings turn into cash?"
                    : "Which cash movements require context?",
                ],
                [
                  FlaskConical,
                  "scenarios",
                  "Test an assumption",
                  "How sensitive are reported balances?",
                ],
                [
                  SearchCheck,
                  "checks",
                  "Verify the inputs",
                  "Are periods and filing sources consistent?",
                ],
                [
                  FileText,
                  "notebook",
                  "Compose a brief",
                  "Turn your evidence into a review.",
                ],
              ].map(([Icon, view, title, copy]: any) => (
                <button key={view} onClick={() => onPatch({ view })}>
                  <Icon size={17} />
                  <span>
                    {title}
                    <small>{copy}</small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </section>
          <section className={styles.panel}>
            <p className={styles.eyebrow}>Evidence context</p>
            <h3>{overview.reports} source filings behind these highlights</h3>
            <p className={styles.muted}>
              {overview.firstFiled
                ? `Filed ${overview.firstFiled}${overview.lastFiled !== overview.firstFiled ? ` through ${overview.lastFiled}` : ""}.`
                : "Filing dates unavailable."}{" "}
              Later reports can update historical values. Use the filing cutoff
              to reproduce an earlier information set.
            </p>
            <span className={styles.badge}>{data.lens} financial lens</span>
            <p className={styles.muted}>
              {data.lens === "banking"
                ? "GAAP funding and returns; no regulatory capital or liquidity certification."
                : data.lens === "insurance"
                  ? "Premiums and investment income remain separate; no universal underwriting margin is inferred."
                  : "Standard consolidated XBRL concepts. Segment and custom-tag disclosures may add context."}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
