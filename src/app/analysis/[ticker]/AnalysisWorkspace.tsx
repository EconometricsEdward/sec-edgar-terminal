"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  Download,
  ExternalLink,
  Pin,
  RefreshCw,
  Share2,
} from "lucide-react";
import CompanySearch from "../CompanySearch";
import AnalysisInspector from "../AnalysisInspector";
import { useWorkspace } from "../../../components/research/WorkspaceProvider";
import {
  analysisBaseline,
  analysisChange,
  analysisChecks,
  commonSizePoint,
  unpackAnalysisCompany,
} from "../../../utils/analysisResearch.js";
import {
  ANALYSIS_SETTINGS,
  analysisPath,
  analysisValue,
  exportAnalysisBrief,
  exportAnalysisCsv,
  normalizeAnalysisSettings,
  readAnalysisSettings,
} from "../../../utils/analysisNotebook.js";
import { downloadText } from "../../../utils/download.js";
import styles from "../analysis.module.css";
const AnalysisChart = dynamic(() => import("../AnalysisChart"), {
  loading: () => <p role="status">Loading chart…</p>,
});
const ExtendedAnalysis = dynamic(() => import("./AnalysisClient"), {
  loading: () => <p role="status">Loading extended research tools…</p>,
});
const views = [
  ["statements", "Statements"],
  ["changes", "Changes"],
  ["trends", "Trends"],
  ["cash", "Cash & capital"],
  ["drivers", "Return drivers"],
  ["checks", "Data checks"],
  ["notebook", "Notebook"],
  ["extended", "More research"],
];
const statementNames = {
  income: "Income statement",
  balance: "Balance sheet",
  cashflow: "Cash flow",
  ratios: "Industry ratios",
};
const basisNames = {
  annual: "Annual",
  quarter: "Standalone quarter",
  ytd: "Year to date",
  ttm: "Trailing twelve months",
};
function changeText(change: any, format: string, units = "auto") {
  if (change.delta == null) return "—";
  if (format === "percent")
    return `${change.delta >= 0 ? "+" : ""}${change.delta.toFixed(2)} pp`;
  if (format === "decimal")
    return `${change.delta >= 0 ? "+" : ""}${change.delta.toFixed(2)}×`;
  return `${change.delta >= 0 ? "+" : "−"}${analysisValue(Math.abs(change.delta), format, units)}`;
}
export default function AnalysisWorkspace(props: any) {
  return <Workspace key={props.urlTicker} {...props} />;
}
function Workspace(props: any) {
  const ticker = props.urlTicker.toUpperCase();
  const [settings, setSettings] = useState<any>({ ...ANALYSIS_SETTINGS });
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<any>(null);
  const [status, setStatus] = useState("");
  const [notes, setNotes] = useState("");
  const [viewName, setViewName] = useState("");
  const [extended, setExtended] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const notesLoaded = useRef(false);
  const cache = useRef(new Map<string, any>());
  const workspace = useWorkspace();
  const saved = workspace.data.companies[ticker];
  useEffect(() => {
    const read = () => {
      setSettings(readAnalysisSettings(window.location.search));
      setSelection(null);
    };
    read();
    setHydrated(true);
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    if (hydrated) {
      const path = analysisPath(ticker, settings);
      if (window.location.pathname + window.location.search !== path)
        window.history.replaceState(null, "", path);
    }
  }, [hydrated, ticker, settings]);
  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    let live = true;
    const id = `${ticker}:${settings.basis}:${settings.asOf}:${retry}`;
    setSelection(null);
    setError("");
    if (cache.current.has(id)) {
      setData(cache.current.get(id));
      setLoading(false);
      return () => controller.abort();
    }
    setData(null);
    setLoading(true);
    fetch(
      `/api/analysis-research?${new URLSearchParams({ ticker, basis: settings.basis, asOf: settings.asOf })}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error || "Financial data could not be retrieved.",
          );
        return unpackAnalysisCompany(result);
      })
      .then((result) => {
        if (live) {
          cache.current.set(id, result);
          setData(result);
        }
      })
      .catch((e) => {
        if (live && !controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [hydrated, ticker, settings.basis, settings.asOf, retry]);
  useEffect(() => {
    if (workspace.ready && !notesLoaded.current) {
      setNotes(saved?.notes || "");
      notesLoaded.current = true;
    }
  }, [workspace.ready, saved?.notes]);
  useEffect(() => {
    const header = document.querySelector("body header");
    const measure = () => {
      root.current?.style.setProperty(
        "--analysis-header-height",
        `${header?.getBoundingClientRect().height || 90}px`,
      );
      root.current?.style.setProperty(
        "--analysis-controls-height",
        `${controls.current?.getBoundingClientRect().height || 80}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    if (controls.current) observer.observe(controls.current);
    measure();
    return () => observer.disconnect();
  }, []);
  const patch = useCallback((next: any) => {
    setSelection(null);
    setStatus("");
    setSettings((s) => normalizeAnalysisSettings({ ...s, ...next }));
  }, []);
  function save(patchValue: any, message: string) {
    const ok = workspace.update((w) => ({
      ...w,
      companies: {
        ...w.companies,
        [ticker]: {
          ticker,
          name: data?.name || ticker,
          cik: data?.cik,
          saved: true,
          ...w.companies[ticker],
          ...patchValue,
        },
      },
    }));
    setStatus(
      ok ? message : "Could not save. Export a brief to preserve your work.",
    );
    return ok;
  }
  function collect(item: any) {
    const evidence = saved?.evidence || [];
    const id = `${item.label}:${item.point?.period?.kind}:${item.point?.period?.end}:${settings.asOf}`;
    save(
      {
        evidence: [
          ...evidence.filter((e) => e.analysisId !== id),
          { ...item, analysisId: id, collectedAt: new Date().toISOString() },
        ].slice(-100),
      },
      "Evidence and note collected in your notebook.",
    );
  }
  function inspect(key: string, index: number, override?: any) {
    evidenceTrigger.current = document.activeElement as HTMLElement;
    setStatus("");
    setSelection({
      definition: data.definitions.find((d) => d.key === key),
      point: override || data.metrics[key]?.[index],
    });
  }
  function closeInspector() {
    setSelection(null);
    evidenceTrigger.current?.focus({ preventScroll: true });
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${analysisPath(ticker, settings)}`,
      );
      setStatus(
        "Link copied with these financial settings. Notes and collected evidence are private.",
      );
    } catch {
      setStatus("Copy the current address to share these financial settings.");
    }
  }
  const index = data
    ? settings.end === "latest"
      ? 0
      : data.periods.findIndex((p) => p.end === settings.end)
    : -1;
  const period = data?.periods[index];
  const beforeIndex = data
    ? analysisBaseline(data.periods, index, settings.baseline)
    : -1;
  const beforePeriod = data?.periods[beforeIndex];
  const checks = data && index >= 0 ? analysisChecks(data, index) : null;
  const definitions = data?.definitions || [];
  const filteredRows = definitions
    .filter((d) =>
      settings.search
        ? `${d.label} ${d.key}`
            .toLowerCase()
            .includes(settings.search.toLowerCase())
        : d.category === settings.statement || settings.pins.includes(d.key),
    )
    .sort(
      (a, b) =>
        Number(settings.pins.includes(b.key)) -
        Number(settings.pins.includes(a.key)),
    );
  const displayedPeriods =
    data?.periods.slice(
      Math.max(0, index),
      Math.max(0, index) + settings.years,
    ) || [];
  function displayed(key: string, i: number) {
    return settings.display === "common"
      ? commonSizePoint(data, key, i)
      : data.metrics[key]?.[i];
  }
  function rowFormat(d: any) {
    return settings.display === "common" &&
      d.format === "currency" &&
      ["income", "balance", "cashflow"].includes(d.category)
      ? "percent"
      : d.format;
  }
  function pin(key: string) {
    patch({
      pins: settings.pins.includes(key)
        ? settings.pins.filter((k) => k !== key)
        : [...settings.pins, key],
    });
  }
  function valueButton(
    key: string,
    i: number,
    override?: any,
    format?: string,
  ) {
    const def = definitions.find((d) => d.key === key);
    const point = override || data.metrics[key]?.[i];
    return (
      <button
        className={styles.valueButton}
        onClick={() => {
          inspect(key, i, override);
          if (format) setSelection({ definition: { ...def, format }, point });
        }}
        aria-label={`Inspect ${def?.label}, ${point?.period?.end || data.periods[i]?.end}, ${analysisValue(point?.value, format || def?.format, settings.units)}`}
      >
        <span>
          {analysisValue(point?.value, format || def?.format, settings.units)}
        </span>
        {point?.classification === "calculated" && (
          <small title="Calculated from reported inputs">ƒ</small>
        )}
        {point?.sources?.some((s) => s.revised) && (
          <small title="Different values were filed for this context">↺</small>
        )}
      </button>
    );
  }
  function exportBrief() {
    downloadText(
      `${ticker}-${period?.end || "analysis"}-research-brief.html`,
      exportAnalysisBrief(data, settings, index, notes, saved?.evidence || []),
      "text/html",
    );
  }
  function markReviewed() {
    save(
      {
        analysisBaseline: {
          version: data.version,
          basis: data.basis,
          asOf: settings.asOf,
          period,
          metrics: Object.fromEntries(
            definitions.map((d) => [d.key, data.metrics[d.key][index]]),
          ),
          observedAt: data.observedAt,
        },
        analysisReviewedAt: new Date().toISOString(),
        notes,
      },
      "Review baseline and notes saved.",
    );
  }
  function statementControls() {
    return (
      <div className={styles.tools}>
        <label>
          Statement
          <select
            value={settings.statement}
            onChange={(e) => patch({ statement: e.target.value, search: "" })}
          >
            {Object.entries(statementNames).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Find a metric
          <input
            value={settings.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Search all financial metrics"
          />
        </label>
        <label>
          Compare with
          <select
            value={settings.baseline}
            onChange={(e) => patch({ baseline: e.target.value })}
          >
            <option value="year">Same period last year</option>
            <option value="previous" disabled={settings.basis === "ytd"}>
              Previous reporting period
            </option>
            {data.periods
              .filter((p) => p.end < period.end)
              .map((p) => (
                <option key={p.end} value={p.end}>
                  {p.end}
                </option>
              ))}
          </select>
        </label>
      </div>
    );
  }
  return (
    <div id="analysis-workspace" ref={root} className={styles.page}>
      <header className={styles.companyHeader}>
        <div>
          <Link href="/analysis" className={styles.eyebrow}>
            Analysis / Company workspace
          </Link>
          <h1>
            <span>{ticker}</span>{" "}
            {data?.name || props.preloadedCompanyName || "Financial analysis"}
          </h1>
          <div className={styles.inline}>
            <span className={styles.badge}>
              {data ? `${data.lens} lens` : "SEC financial data"}
            </span>
            {data && (
              <span className={styles.muted}>
                CIK {data.cik} · SIC {data.sic}
              </span>
            )}
            <Link href={`/compare/${ticker}`} className={styles.textLink}>
              Compare peers <ArrowUpRight size={14} />
            </Link>
            <Link href={`/risk?ticker=${ticker}`} className={styles.textLink}>
              Risk profile <ArrowUpRight size={14} />
            </Link>
          </div>
        </div>
        <CompanySearch compact />
      </header>
      <div className={styles.controls} ref={controls}>
        <div className={styles.tools}>
          <label>
            Reporting basis
            <select
              value={settings.basis}
              onChange={(e) =>
                patch({
                  basis: e.target.value,
                  end: "latest",
                  baseline: "year",
                })
              }
            >
              {Object.entries(basisNames).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Period ending
            <select
              value={settings.end}
              onChange={(e) => patch({ end: e.target.value })}
            >
              <option value="latest">Latest available</option>
              {data?.periods.map((p) => (
                <option key={p.end} value={p.end}>
                  {p.end} · {p.fp}
                </option>
              ))}
            </select>
          </label>
          <label>
            Display units
            <select
              value={settings.units}
              onChange={(e) => patch({ units: e.target.value })}
            >
              <option value="millions">USD millions</option>
              <option value="billions">USD billions</option>
              <option value="auto">Compact</option>
              <option value="raw">Full values</option>
            </select>
          </label>
          <div className={styles.actions}>
            <details className={styles.savePopover}>
              <summary>Save view</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name =
                    viewName.trim() ||
                    `${basisNames[settings.basis]} ${settings.view}`;
                  if (
                    save(
                      {
                        analysisViews: [
                          ...(saved?.analysisViews || []).filter(
                            (v) => v.name !== name,
                          ),
                          { name, settings, savedAt: new Date().toISOString() },
                        ].slice(-20),
                      },
                      "Current view saved with its period, cutoff, pins, and chart settings.",
                    )
                  ) {
                    setViewName("");
                    (e.currentTarget.parentElement as HTMLDetailsElement).open =
                      false;
                  }
                }}
              >
                <label>
                  Save this view as
                  <input
                    value={viewName}
                    maxLength={80}
                    onChange={(e) => setViewName(e.target.value)}
                    placeholder="Annual credit review"
                  />
                </label>
                <button type="submit" disabled={!workspace.ready}>
                  Save financial view
                </button>
              </form>
            </details>
            <button onClick={share}>
              <Share2 size={15} />
              Share
            </button>
            <button
              onClick={() => setRetry((r) => r + 1)}
              disabled={loading}
              aria-label="Refresh financial data"
            >
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
        <details className={styles.advanced}>
          <summary>
            Filing cutoff & display settings
            {settings.asOf ? ` · Filed through ${settings.asOf}` : ""}
          </summary>
          <div className={styles.tools}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const cutoff = String(
                  new FormData(e.currentTarget).get("asOf") || "",
                );
                patch({ asOf: cutoff, end: "latest" });
              }}
            >
              <label>
                Use only filings available by
                <input
                  key={settings.asOf}
                  name="asOf"
                  type="date"
                  defaultValue={settings.asOf}
                  max={new Date().toISOString().slice(0, 10)}
                />
              </label>
              <button type="submit">Apply cutoff</button>
              {settings.asOf && (
                <button
                  type="button"
                  onClick={() => patch({ asOf: "", end: "latest" })}
                >
                  Clear cutoff
                </button>
              )}
            </form>
            <label>
              Statement display
              <select
                value={settings.display}
                onChange={(e) => patch({ display: e.target.value })}
              >
                <option value="reported">Reported values</option>
                <option value="common">Common size</option>
              </select>
            </label>
            <label>
              Visible periods
              <select
                value={settings.years}
                onChange={(e) => patch({ years: Number(e.target.value) })}
              >
                {[4, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} periods
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
        <nav className={styles.viewNav} aria-label="Analysis views">
          {views.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={settings.view === key}
              onClick={() => patch({ view: key })}
            >
              {label}
              {key === "notebook" && saved?.evidence?.length
                ? ` (${saved.evidence.length})`
                : ""}
            </button>
          ))}
        </nav>
      </div>
      {(status || workspace.error) && (
        <p className={styles.notice} role="status">
          {workspace.error || status}
        </p>
      )}
      {loading && (
        <div className={styles.loading} role="status">
          <span className={styles.badge}>Loading SEC evidence</span>
          <h2>Building {ticker}’s financial workspace</h2>
          <p>
            Resolving reporting periods, financial inputs, and source filings…
          </p>
          <div />
          <div />
          <div />
        </div>
      )}
      {error && (
        <section className={styles.panel} role="alert">
          <h2>Financial data is unavailable</h2>
          <p>{error}</p>
          <p>
            No figures have been substituted. Check the ticker or retry the SEC
            request.
          </p>
          <button
            className={styles.primary}
            onClick={() => setRetry((r) => r + 1)}
          >
            Retry {ticker}
          </button>
          <Link href={`/fund/${ticker}`} className={styles.textLink}>
            Looking for a fund or ETF?
          </Link>
        </section>
      )}
      {data && !period && (
        <section className={styles.panel}>
          <h2>No matching reporting period</h2>
          <p>
            The selected period or filing cutoff has no compatible financial
            observations.
          </p>
          <button onClick={() => patch({ end: "latest", asOf: "" })}>
            Show latest available data
          </button>
        </section>
      )}
      {data && period && checks && (
        <>
          <div className={styles.periodBanner}>
            <div>
              <strong>
                {basisNames[settings.basis]} ·{" "}
                {period.start || "Start unavailable"} → {period.end}
              </strong>
              <span>
                Balance-sheet figures are as of {period.end}.{" "}
                {settings.asOf
                  ? `Filings through ${settings.asOf}.`
                  : "Latest available filed values."}
              </span>
            </div>
            <button onClick={() => patch({ view: "checks" })}>
              {checks.available}/{checks.total} metrics available{" "}
              <ArrowUpRight size={14} />
            </button>
          </div>
          <div className={styles.workspaceGrid} data-inspector={!!selection}>
            <div className={styles.content}>
              {settings.view === "statements" && (
                <>
                  <div className={styles.kpis}>
                    {(settings.pins.length ? settings.pins : data.highlights)
                      .slice(0, 6)
                      .map((key) => {
                        const d = definitions.find((d) => d.key === key);
                        if (!d) return null;
                        const point = data.metrics[key][index];
                        const change = analysisChange(
                          point,
                          data.metrics[key][beforeIndex],
                          d.format,
                        );
                        return (
                          <article key={key}>
                            <span>{d.label}</span>
                            {valueButton(key, index)}
                            <small>
                              {beforePeriod
                                ? `${changeText(change, d.format)} vs ${beforePeriod.end}`
                                : "Comparable prior period unavailable"}
                            </small>
                          </article>
                        );
                      })}
                  </div>
                  <section className={styles.panel}>
                    <div className={styles.sectionHeading}>
                      <div>
                        <p className={styles.eyebrow}>Read the financials</p>
                        <h2>
                          {settings.search
                            ? "Metric search results"
                            : statementNames[settings.statement]}
                        </h2>
                      </div>
                      <button
                        onClick={() =>
                          downloadText(
                            `${ticker}-financial-evidence.csv`,
                            exportAnalysisCsv(data, settings),
                            "text/csv",
                          )
                        }
                      >
                        <Download size={15} />
                        Evidence CSV
                      </button>
                    </div>
                    {statementControls()}
                    <p className={styles.muted}>
                      {settings.display === "common"
                        ? `Common size: balance sheet ÷ total assets; income and cash flow ÷ ${data.revenueKey ? definitions.find((d) => d.key === data.revenueKey)?.label : "unavailable insurance revenue denominator"}. EPS, shares and ratios keep their original units.`
                        : "Click any value to inspect its SEC inputs. Pin up to 12 metrics to keep them across statement views."}{" "}
                      ƒ = calculated · ↺ = different filed values.
                    </p>
                    <div className={styles.tableScroll}>
                      <table>
                        <caption>
                          {ticker} normalized SEC financial extract.{" "}
                          {settings.units === "millions"
                            ? "Currency and shares in millions; per-share values and ratios unscaled."
                            : settings.units === "billions"
                              ? "Currency and shares in billions; per-share values and ratios unscaled."
                              : "Units are displayed with each value."}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Metric</th>
                            {displayedPeriods.map((p) => (
                              <th key={p.end} scope="col">
                                <span>{p.end}</span>
                                <small>
                                  {p.fp} · {settings.basis}
                                </small>
                              </th>
                            ))}
                            <th scope="col">
                              Change
                              <small>
                                {beforePeriod?.end || "No comparable period"}
                              </small>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRows.map((d) => {
                            const format = rowFormat(d);
                            const change = analysisChange(
                              displayed(d.key, index),
                              beforeIndex >= 0
                                ? displayed(d.key, beforeIndex)
                                : null,
                              format,
                            );
                            return (
                              <tr key={d.key}>
                                <th scope="row">
                                  <button
                                    className={styles.pin}
                                    onClick={() => pin(d.key)}
                                    aria-label={`${settings.pins.includes(d.key) ? "Unpin" : "Pin"} ${d.label}`}
                                    aria-pressed={settings.pins.includes(d.key)}
                                    disabled={
                                      !settings.pins.includes(d.key) &&
                                      settings.pins.length >= 12
                                    }
                                  >
                                    <Pin size={13} />
                                  </button>
                                  {d.label}
                                </th>
                                {displayedPeriods.map((p, offset) => (
                                  <td key={p.end}>
                                    {valueButton(
                                      d.key,
                                      index + offset,
                                      displayed(d.key, index + offset),
                                      format,
                                    )}
                                  </td>
                                ))}
                                <td title={change.reason || ""}>
                                  {changeText(change, format, settings.units)}
                                  {change.percent != null && (
                                    <small>
                                      {change.percent >= 0 ? "+" : ""}
                                      {change.percent.toFixed(1)}%
                                    </small>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {!filteredRows.length && (
                      <p className={styles.notice}>
                        No metrics match this search. Try “cash”, “equity”, or
                        “margin”.
                      </p>
                    )}
                  </section>
                </>
              )}
              {settings.view === "changes" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>Explain the movement</p>
                  <h2>What changed in the financials?</h2>
                  {statementControls()}
                  <p className={styles.muted}>
                    {period.end} versus{" "}
                    {beforePeriod?.end || "an unavailable comparison period"}.
                    Percentages use a positive prior base; ratios change in
                    percentage points. Incompatible durations remain
                    unavailable. These are financial changes, not risk scores.
                  </p>
                  <div className={styles.tableScroll}>
                    <table>
                      <thead>
                        <tr>
                          <th>Metric</th>
                          <th>{period.end}</th>
                          <th>{beforePeriod?.end || "Prior period"}</th>
                          <th>Change</th>
                          <th>Context</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map((d) => {
                          const point = data.metrics[d.key][index];
                          const prior = data.metrics[d.key][beforeIndex];
                          const change = analysisChange(point, prior, d.format);
                          return (
                            <tr key={d.key}>
                              <th scope="row">{d.label}</th>
                              <td>{valueButton(d.key, index)}</td>
                              <td>
                                {beforeIndex >= 0
                                  ? valueButton(d.key, beforeIndex)
                                  : "—"}
                              </td>
                              <td>
                                {changeText(change, d.format, settings.units)}
                                {change.percent != null && (
                                  <small>{change.percent.toFixed(1)}%</small>
                                )}
                              </td>
                              <td className={styles.contextCell}>
                                {change.reason ||
                                  (point.sources?.some((s) => s.revised)
                                    ? "Revised source context — inspect the filing history."
                                    : "Compatible reporting periods.")}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className={styles.muted}>
                    For passage-level changes between filings, open More
                    research → What changed?
                  </p>
                </section>
              )}
              {settings.view === "trends" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>Explore the trajectory</p>
                  <h2>Build a financial trend</h2>
                  <div className={styles.tools}>
                    <label className={styles.checkLabel}>
                      <input
                        type="checkbox"
                        checked={settings.indexed}
                        onChange={(e) => patch({ indexed: e.target.checked })}
                      />
                      Index to 100
                    </label>
                    <span className={styles.muted}>
                      Select up to three metrics. Chart uses the selected ending
                      period and visible-period setting.
                    </span>
                  </div>
                  <details>
                    <summary>
                      Choose chart metrics ({settings.chart.length || 2}/3)
                    </summary>
                    <div className={styles.metricPicker}>
                      {definitions
                        .filter(
                          (d) => !["checks", "drivers"].includes(d.category),
                        )
                        .map((d) => {
                          const keys = settings.chart.length
                            ? settings.chart
                            : [
                                data.revenueKey || "premiumsEarned",
                                "netIncome",
                              ];
                          return (
                            <label key={d.key}>
                              <input
                                type="checkbox"
                                checked={keys.includes(d.key)}
                                disabled={
                                  !keys.includes(d.key) && keys.length >= 3
                                }
                                onChange={() =>
                                  patch({
                                    chart: keys.includes(d.key)
                                      ? keys.filter((k) => k !== d.key)
                                      : [...keys, d.key],
                                  })
                                }
                              />
                              {d.label}
                            </label>
                          );
                        })}
                    </div>
                  </details>
                  <AnalysisChart
                    data={data}
                    settings={settings}
                    index={index}
                  />
                  <div className={styles.tableScroll}>
                    <table>
                      <thead>
                        <tr>
                          <th>Period ending</th>
                          {(settings.chart.length
                            ? settings.chart
                            : [data.revenueKey || "premiumsEarned", "netIncome"]
                          ).map((key) => (
                            <th key={key}>
                              {definitions.find((d) => d.key === key)?.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayedPeriods.map((p, offset) => (
                          <tr key={p.end}>
                            <th scope="row">{p.end}</th>
                            {(settings.chart.length
                              ? settings.chart
                              : [
                                  data.revenueKey || "premiumsEarned",
                                  "netIncome",
                                ]
                            )
                              .filter((key) => data.metrics[key])
                              .map((key) => (
                                <td key={key}>
                                  {valueButton(key, index + offset)}
                                </td>
                              ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {settings.view === "cash" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>Follow the cash</p>
                  <h2>Earnings, cash conversion & capital allocation</h2>
                  {data.lens !== "corporate" && (
                    <p className={styles.notice}>
                      For financial institutions, lending, deposits, and
                      investments affect cash flows. OCF less PP&E purchases is
                      not a measure of distributable cash or regulatory capital.
                    </p>
                  )}
                  <div className={styles.bridgeGrid}>
                    {[
                      [
                        "From earnings to operating cash",
                        [
                          ["netIncome", "Starting earnings"],
                          ["cashAdjustments", "Residual adjustment"],
                          ["operatingCashFlow", "Operating cash result"],
                        ],
                      ],
                      [
                        "After investment and shareholder returns",
                        [
                          ["operatingCashFlow", "Operating cash"],
                          ["capex", "Less PP&E purchases"],
                          ["freeCashFlow", "Cash after PP&E"],
                          ["dividendsPaid", "Less reported dividends"],
                          ["stockRepurchased", "Less common buybacks"],
                          ["cashAfterReturns", "Remaining cash in this bridge"],
                        ],
                      ],
                      [
                        "Reported investing and financing",
                        [
                          ["investingCashFlow", "Net investing flow"],
                          ["financingCashFlow", "Net financing flow"],
                          [
                            "netLongTermDebt",
                            "Long-term proceeds less repayments",
                          ],
                        ],
                      ],
                    ].map(([title, rows]: any) => (
                      <article className={styles.bridge} key={title}>
                        <h3>{title}</h3>
                        {rows.map(([key, label]) => {
                          const val = data.metrics[key]?.[index]?.value;
                          const scale = Math.max(
                            ...rows.map(([k]) =>
                              Math.abs(data.metrics[k]?.[index]?.value || 0),
                            ),
                            1,
                          );
                          return (
                            <div key={key}>
                              <span>{label}</span>
                              {valueButton(key, index)}
                              <div className={styles.barTrack}>
                                <div
                                  style={{
                                    width: `${(Math.abs(val || 0) / scale) * 100}%`,
                                  }}
                                  data-negative={val < 0}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </article>
                    ))}
                  </div>
                  <p className={styles.muted}>
                    The earnings-to-cash adjustment is a residual covering all
                    noncash items and working-capital movements; it does not
                    assign causes. The allocation bridge excludes other
                    investing and financing flows and does not represent the
                    change in the cash balance. Missing components keep
                    calculated totals unavailable.
                  </p>
                </section>
              )}
              {settings.view === "drivers" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>{data.lens} fundamentals</p>
                  <h2>Understand the drivers of returns</h2>
                  <p className={styles.muted}>
                    {data.lens === "banking"
                      ? "Bank revenue uses net interest income before provision plus noninterest income. Loans are reported net of allowances. These GAAP measures are distinct from regulatory capital and risk-weighted returns."
                      : data.lens === "insurance"
                        ? "Premiums, investment income, and capital are shown separately. A universal underwriting margin is not inferred from incomplete or incompatible insurance tags."
                        : "A three-part ROE decomposition separates profitability, asset productivity, and financial leverage. Average balances use the beginning and end of the selected duration."}
                  </p>
                  {data.revenueKey && (
                    <div className={styles.driverEquation}>
                      {[
                        data.lens === "banking" ? "bankNetMargin" : "netMargin",
                        "assetTurnover",
                        "equityMultiplier",
                        "dupontRoe",
                      ].map((key, i) => (
                        <div key={key}>
                          <span>{i === 0 ? "" : i === 3 ? "=" : "×"}</span>
                          <article>
                            <h3>
                              {definitions.find((d) => d.key === key)?.label}
                            </h3>
                            {valueButton(key, index)}
                          </article>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className={styles.muted}>
                    ROE and ROA use average beginning and ending balances.
                    Quarter and YTD income are annualized by 365 ÷ duration
                    days. Negative or missing average equity is not converted
                    into a meaningful return ratio.
                  </p>
                  <div className={styles.kpis}>
                    {(data.lens === "banking"
                      ? [
                          "roe",
                          "roa",
                          "efficiency",
                          "equityAssets",
                          "loanDeposits",
                          "allowanceLoans",
                          "provisionLoans",
                          "deposits",
                        ]
                      : data.lens === "insurance"
                        ? [
                            "premiumsEarned",
                            "investmentIncome",
                            "roe",
                            "roa",
                            "equityAssets",
                            "cashAssets",
                          ]
                        : [
                            "grossMargin",
                            "operatingMargin",
                            "cashConversion",
                            "currentRatio",
                            "debtAssets",
                            "equityAssets",
                          ]
                    ).map((key) => (
                      <article key={key}>
                        <span>
                          {definitions.find((d) => d.key === key)?.label}
                        </span>
                        {valueButton(key, index)}
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {settings.view === "checks" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>Trust through verification</p>
                  <h2>Coverage, reconciliation & filing history</h2>
                  <div className={styles.kpis}>
                    <article>
                      <span>Available metrics</span>
                      <strong>
                        {checks.available} / {checks.total}
                      </strong>
                    </article>
                    <article>
                      <span>Calculated metrics</span>
                      <strong>{checks.calculated}</strong>
                    </article>
                    <article>
                      <span>Revised input contexts</span>
                      <strong>{checks.revised}</strong>
                    </article>
                  </div>
                  <div className={styles.checks}>
                    {checks.checks.map((c) => (
                      <article key={c.key}>
                        <span className={styles.badge} data-state={c.status}>
                          {c.status}
                        </span>
                        <h3>{c.title}</h3>
                        {valueButton(c.key, index)}
                        <p className={styles.muted}>
                          {c.status === "Incomplete"
                            ? "One or more required inputs are missing. The check cannot be completed."
                            : `Rounding tolerance: ${analysisValue(c.tolerance)}. A residual can reflect scope differences or tagging; it is a review prompt, not an accounting error determination.`}
                        </p>
                      </article>
                    ))}
                  </div>
                  <details open>
                    <summary>
                      Unavailable metrics ({checks.missing.length})
                    </summary>
                    <p className={styles.muted}>
                      Unavailable is distinct from zero. This extract does not
                      substitute custom company tags or different currencies.
                    </p>
                    <div className={styles.metricPicker}>
                      {checks.missing.map((d) => (
                        <button
                          key={d.key}
                          onClick={() => inspect(d.key, index)}
                        >
                          {d.label}
                          <ArrowUpRight size={13} />
                        </button>
                      ))}
                    </div>
                  </details>
                  <details>
                    <summary>
                      Recent reports and events within the filing cutoff
                    </summary>
                    <p className={styles.muted}>
                      Loaded SEC submissions feed; older input sources remain
                      accessible in the inspector even when absent from this
                      list.
                    </p>
                    <div className={styles.tableScroll}>
                      <table>
                        <thead>
                          <tr>
                            <th>Form</th>
                            <th>Reporting date</th>
                            <th>Filed</th>
                            <th>Accession</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.filings.slice(0, 30).map((f) => (
                            <tr key={f.accession}>
                              <th>
                                <a
                                  href={f.documentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {f.form} <ExternalLink size={12} />
                                </a>
                              </th>
                              <td>{f.reportDate || "Not supplied"}</td>
                              <td>{f.filingDate}</td>
                              <td>{f.accession}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <p className={styles.muted}>{data.note}</p>
                </section>
              )}
              {settings.view === "notebook" && (
                <section className={styles.panel}>
                  <div className={styles.sectionHeading}>
                    <div>
                      <p className={styles.eyebrow}>
                        Research that carries forward
                      </p>
                      <h2>{ticker} notebook</h2>
                    </div>
                    <Link href="/workspace" className={styles.textLink}>
                      All saved research <ArrowUpRight size={14} />
                    </Link>
                  </div>
                  <div className={styles.tools}>
                    <button
                      disabled={!workspace.ready}
                      onClick={() =>
                        save(
                          { saved: !saved?.saved },
                          saved?.saved
                            ? "Company removed from saved list."
                            : "Company saved.",
                        )
                      }
                    >
                      <Bookmark size={15} />
                      {saved?.saved ? "Unsave company" : "Save company"}
                    </button>
                    <button disabled={!workspace.ready} onClick={markReviewed}>
                      <Check size={15} />
                      Mark reviewed
                    </button>
                    <button onClick={exportBrief}>
                      <Download size={15} />
                      Export readable brief
                    </button>
                    <button
                      onClick={() =>
                        downloadText(
                          `${ticker}-financial-evidence.csv`,
                          exportAnalysisCsv(data, settings),
                          "text/csv",
                        )
                      }
                    >
                      Evidence CSV
                    </button>
                  </div>
                  <label className={styles.noteLabel}>
                    Research notes
                    <textarea
                      rows={6}
                      maxLength={50000}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Your thesis, open questions, and next steps…"
                    />
                  </label>
                  <div className={styles.sectionHeading}>
                    <p className={styles.muted}>
                      Stored in this browser. Existing company notes and
                      evidence are preserved. Export a portable copy before
                      changing browsers.
                    </p>
                    <button
                      onClick={() => save({ notes }, "Research notes saved.")}
                      disabled={!workspace.ready}
                    >
                      Save notes
                    </button>
                  </div>
                  <section className={styles.subpanel}>
                    <h3>Saved financial views</h3>
                    <form
                      className={styles.tools}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name =
                          viewName.trim() ||
                          `${basisNames[settings.basis]} review`;
                        if (
                          save(
                            {
                              analysisViews: [
                                ...(saved?.analysisViews || []).filter(
                                  (v) => v.name !== name,
                                ),
                                {
                                  name,
                                  settings,
                                  savedAt: new Date().toISOString(),
                                },
                              ].slice(-20),
                            },
                            "Financial view saved with period, cutoff, pins, and chart settings.",
                          )
                        )
                          setViewName("");
                      }}
                    >
                      <label>
                        View name
                        <input
                          value={viewName}
                          maxLength={80}
                          onChange={(e) => setViewName(e.target.value)}
                          placeholder="Annual credit review"
                        />
                      </label>
                      <button disabled={!workspace.ready}>
                        Save current view
                      </button>
                    </form>
                    <ul className={styles.savedList}>
                      {(saved?.analysisViews || []).map((v, i) => (
                        <li key={i}>
                          <button onClick={() => patch(v.settings)}>
                            {v.name} · {v.settings.basis}
                          </button>
                          <button
                            aria-label={`Delete saved view ${v.name}`}
                            onClick={() =>
                              save(
                                {
                                  analysisViews: saved.analysisViews.filter(
                                    (_, n) => n !== i,
                                  ),
                                },
                                "Saved view removed.",
                              )
                            }
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section className={styles.subpanel}>
                    <h3>Since your last financial review</h3>
                    {saved?.analysisBaseline ? (
                      <>
                        <p className={styles.muted}>
                          Reviewed {saved.analysisReviewedAt?.slice(0, 10)} ·{" "}
                          {saved.analysisBaseline.basis} ending{" "}
                          {saved.analysisBaseline.period?.end}. Filing cutoff:{" "}
                          {saved.analysisBaseline.asOf || "Latest at review"}.
                        </p>
                        {saved.analysisBaseline.version !== data.version ||
                        saved.analysisBaseline.basis !== data.basis ? (
                          <p className={styles.notice}>
                            Select the same reporting basis as your saved review
                            to compare figures.
                          </p>
                        ) : (
                          <ul className={styles.savedList}>
                            {definitions
                              .filter((d) => data.highlights.includes(d.key))
                              .map((d) => {
                                const previous =
                                  saved.analysisBaseline.metrics[d.key];
                                const current = data.metrics[d.key][index];
                                const change = analysisChange(
                                  current,
                                  previous,
                                  d.format,
                                );
                                return (
                                  <li key={d.key}>
                                    <span>
                                      {d.label}
                                      <small>
                                        {previous?.period?.end ===
                                        current?.period?.end
                                          ? "Same period: possible revision"
                                          : "Different reporting periods"}
                                      </small>
                                    </span>
                                    <span>
                                      {changeText(change, d.format)}
                                      {change.reason && (
                                        <small>{change.reason}</small>
                                      )}
                                    </span>
                                  </li>
                                );
                              })}
                          </ul>
                        )}
                      </>
                    ) : (
                      <p className={styles.muted}>
                        Mark reviewed to preserve the exact values, source
                        accessions, period basis, and filing cutoff you
                        reviewed. Future comparisons do not overwrite this
                        baseline automatically.
                      </p>
                    )}
                  </section>
                  <section className={styles.subpanel}>
                    <h3>Collected evidence ({saved?.evidence?.length || 0})</h3>
                    <p className={styles.muted}>
                      Open any financial value and choose “Collect this
                      evidence” to add the figure, its source inputs, and your
                      note to this brief.
                    </p>
                    <ul className={styles.savedList}>
                      {(saved?.evidence || []).map((e, i) => (
                        <li key={i}>
                          <div>
                            {e.point ? (
                              <button
                                onClick={() => {
                                  evidenceTrigger.current =
                                    document.activeElement as HTMLElement;
                                  setSelection({
                                    definition: {
                                      label: e.label,
                                      format: e.format || "currency",
                                    },
                                    point: {
                                      ...e.point,
                                      sources:
                                        e.point.sources ||
                                        (e.point.source
                                          ? [e.point.source]
                                          : []),
                                    },
                                  });
                                }}
                              >
                                {e.label} · {e.point.period?.end}
                              </button>
                            ) : (
                              <a href={e.url} target="_blank" rel="noreferrer">
                                {e.label}
                              </a>
                            )}
                            <p>{e.notes || e.text}</p>
                          </div>
                          <button
                            onClick={() =>
                              save(
                                {
                                  evidence: saved.evidence.filter(
                                    (_, n) => n !== i,
                                  ),
                                },
                                "Evidence removed.",
                              )
                            }
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                </section>
              )}
              {settings.view === "extended" && (
                <section className={styles.panel}>
                  <p className={styles.eyebrow}>Extended company research</p>
                  <h2>Filings, quality, market & ownership tools</h2>
                  <p className={styles.muted}>
                    Open the existing research panels for filing-language
                    comparisons, disclosure radar, deeper quality diagnostics,
                    price history, insiders, and institutional holders. These
                    tools use their own latest-data controls; the financial
                    filing cutoff above applies to this new workspace.
                  </p>
                  <button
                    className={styles.primary}
                    onClick={() => setExtended((v) => !v)}
                  >
                    {extended
                      ? "Close extended tools"
                      : "Open extended research tools"}
                  </button>
                  {extended && (
                    <div className={styles.extended}>
                      <ExtendedAnalysis {...props} />
                    </div>
                  )}
                </section>
              )}
            </div>
            {selection && (
              <AnalysisInspector
                key={`${selection.definition.key || selection.definition.label}:${selection.point?.period?.end}:${selection.point?.formula}`}
                selection={selection}
                close={closeInspector}
                save={collect}
                status={status}
              />
            )}
          </div>
          <footer className={styles.methodology}>
            <p>{data.note}</p>
            <p>
              Data observed {data.observedAt.slice(0, 16).replace("T", " ")}{" "}
              UTC.{" "}
              <a
                href={`https://www.sec.gov/edgar/browse/?CIK=${data.cik}`}
                target="_blank"
                rel="noreferrer"
              >
                Company filings on SEC.gov <ExternalLink size={12} />
              </a>
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
