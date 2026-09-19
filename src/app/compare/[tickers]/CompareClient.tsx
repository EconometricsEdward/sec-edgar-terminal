"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import {
  GitCompareArrows,
  Plus,
  X,
  RefreshCw,
  Download,
  Link as LinkIcon,
  SlidersHorizontal,
  Table2,
  TrendingUp,
  ScatterChart,
  Loader2,
  CheckCircle2,
  ShieldCheck,
  History,
  Target,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import { TickerContext } from "../../../contexts/TickerContext";
import { PEER_GROUPS } from "../../../utils/peerGroups.js";
import { unpackAnalysisCompany } from "../../../utils/analysisResearch.js";
import {
  COMPARE_METRICS,
  METRIC_BY_KEY,
  MAX_COMPARE_COMPANIES,
  inferLens,
  defaultMetrics,
  comparisonSelection,
  metricComparison,
  uniqueIssuerCompanies,
} from "../../../utils/compareResearch.js";
import {
  DEFAULT_COMPARE_SETTINGS,
  normalizeCompareTickers,
  normalizeCompareSettings,
  readCompareUrl,
  comparePath,
} from "../../../utils/compareSettings.js";
import { exportCompareTableCsv } from "../../../utils/compareCsv.js";
import { createCompareClientCache } from "../../../utils/compareClientCache.js";
import { matchingCompareResult } from "../../../utils/compareResponseValidation.js";
import { buildCompareCompanyIndex, compareCompanySuggestions } from "../../../utils/compareCompanySearch.js";
import { planComparePeers } from "../../../utils/compareWorkspace.js";
import { researchMetricComparison } from "../../../utils/compareBenchmarks.js";
import {
  readCompareEvidencePointer,
  resolveCompareEvidencePointer,
} from "../../../utils/compareEvidenceLinks.js";
import CompareTable from "../components/CompareTable";
import CompareGuide from "../CompareGuide";
const loadingView = () => <p role="status">Loading comparison view…</p>;
const CompareQualityDesk = dynamic(() => import("../components/CompareQualityDesk"), { loading: loadingView });
const CompareBenchmarks = dynamic(() => import("../components/CompareBenchmarks"), { loading: loadingView });
const CompareMovements = dynamic(() => import("../components/CompareMovements"), { loading: loadingView });
const CompareCommonSize = dynamic(() => import("../components/CompareCommonSize"), { loading: loadingView });
const CompareFormula = dynamic(() => import("../components/CompareFormula"), { loading: loadingView });
const CompareTrends = dynamic(() => import("../components/CompareCharts").then((module) => module.CompareTrends), { loading: loadingView });
const CompareMap = dynamic(() => import("../components/CompareCharts").then((module) => module.CompareMap), { loading: loadingView });
const CompareInspector = dynamic(() => import("../components/CompareInspector"), { loading: loadingView });
import {
  COLORS,
  displayValue,
  downloadFile,
  type CompareCompany,
  type CompareSettings,
  type CompareEvidence,
  type PreloadedCompany,
} from "../compareTypes";
import styles from "../compare.module.css";
export type { PreloadedCompany } from "../compareTypes";

const LENSES = {
  auto: "Automatic lens",
  common: "Common financials",
  banking: "Bank financials",
  corporate: "Corporate financials",
  insurance: "Insurance",
};
const VIEWS = [
  { key: "table", label: "Comparison", icon: Table2 },
  { key: "benchmarks", label: "Focus & peers", icon: Target },
  { key: "changes", label: "Changes", icon: History },
  { key: "quality", label: "Comparability", icon: ShieldCheck },
  { key: "trends", label: "Trends & growth", icon: TrendingUp },
  { key: "map", label: "Peer map", icon: ScatterChart },
];
export default function CompareClient({
  initialTickers,
  preloadedCompanies,
}: {
  initialTickers: string[];
  preloadedCompanies: PreloadedCompany[];
}) {
  const ctx = useContext(TickerContext);
  const tickerMap = ctx?.tickerMap;
  const [tickers, setTickers] = useState(() =>
    normalizeCompareTickers(initialTickers),
  );
  const [settings, setSettings] = useState<CompareSettings>(
    DEFAULT_COMPARE_SETTINGS,
  );
  const [companies, setCompanies] = useState<CompareCompany[]>([]);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<CompareEvidence | null>(null);
  const [retry, setRetry] = useState(0);
  const [groupMode, setGroupMode] = useState("replace");
  const [pointer, setPointer] = useState<any>(null);
  const [pointerResolved, setPointerResolved] = useState(false);
  const colorMap = useRef(new Map<string, string>());
  const pageRef = useRef<HTMLDivElement>(null);
  const cache = useRef(createCompareClientCache());
  const peerKey = tickers.join(",");
  const { basis, asOf } = settings;

  useEffect(() => {
    // Restore the actual route before URL synchronization. Next can reuse this
    // client island across /compare and /compare/[tickers] navigation.
    setTickers(
      normalizeCompareTickers(
        decodeURIComponent(window.location.pathname.split("/")[2] || ""),
      ),
    );
    setSettings(readCompareUrl(window.location.search));
    setPointer(readCompareEvidencePointer(window.location.search));
    setPointerResolved(false);
    setReady(true);
    const pop = () => {
      setTickers(
        normalizeCompareTickers(
          decodeURIComponent(window.location.pathname.split("/")[2] || ""),
        ),
      );
      setSettings(readCompareUrl(window.location.search));
      setPointer(readCompareEvidencePointer(window.location.search));
      setPointerResolved(false);
      setEvidence(null);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (ready) {
      const url = new URL(
        comparePath(tickers, settings),
        window.location.origin,
      );
      if (pointer)
        for (const [key, value] of new URLSearchParams(
          window.location.search,
        )) {
          if (key.startsWith("obs")) url.searchParams.set(key, value);
        }
      window.history.replaceState(null, "", url.pathname + url.search);
    }
  }, [ready, tickers, settings, pointer]);
  useEffect(() => {
    const page = pageRef.current,
      header = document.querySelector("body > div > header"),
      controls = page?.querySelector("[data-compare-controls]");
    if (!page || !header || !controls) return;
    const measure = () => {
      page.style.setProperty(
        "--compare-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
      page.style.setProperty(
        "--compare-controls-height",
        `${controls.getBoundingClientRect().height}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(controls);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ready) return;
    const peers = normalizeCompareTickers(peerKey),
      controller = new AbortController();
    const cacheKey = (ticker: string) => `${ticker}:${basis}:${asOf}`;
    for (const ticker of peers)
      if (!colorMap.current.has(ticker)) {
        const used = new Set(colorMap.current.values());
        colorMap.current.set(
          ticker,
          COLORS.find((color) => !used.has(color)) ||
            COLORS[colorMap.current.size % COLORS.length],
        );
      }
    const available = new Map(peers.map((ticker) => [ticker, cache.current.get(cacheKey(ticker))]));
    setCompanies(
      peers.map((ticker) => ({
        ticker,
        color: colorMap.current.get(ticker),
        data: available.get(ticker),
        error: null,
        loading: !available.get(ticker),
      })),
    );
    const queue = peers.filter((ticker) => !available.get(ticker));
    const run = async () => {
      while (queue.length && !controller.signal.aborted) {
        const ticker = queue.shift()!;
        try {
          const requestStartedAt = Date.now();
          const response = await fetch(
            `/api/compare-research?${new URLSearchParams({ ticker, basis, asOf, format: "packed" })}`,
            { signal: controller.signal },
          );
          const payload = await response.text();
          const body = JSON.parse(payload);
          if (!response.ok)
            throw new Error(
              body.error || `SEC request failed (${response.status}).`,
            );
          if (!matchingCompareResult(body, { ticker, basis, asOf }))
            throw new Error(
              "An incompatible company response was returned. Retry this issuer.",
            );
          if (controller.signal.aborted) return;
          const result = unpackAnalysisCompany(body);
          cache.current.set(cacheKey(ticker), result, payload.length * 2, {
            headers: response.headers, requestStartedAt,
          });
          setCompanies((prior) =>
            prior.map((c) =>
              c.ticker === ticker
                ? { ...c, data: result, loading: false, error: null }
                : c,
            ),
          );
        } catch (e) {
          if (!controller.signal.aborted)
            setCompanies((prior) =>
              prior.map((c) =>
                c.ticker === ticker
                  ? {
                      ...c,
                      data: null,
                      loading: false,
                      error:
                        e instanceof Error
                          ? e.message
                          : "Unable to load this issuer.",
                    }
                  : c,
              ),
            );
        }
      }
    };
    void Promise.all([run(), run()]);
    return () => controller.abort();
  }, [peerKey, basis, asOf, ready, retry]);

  const update = useCallback((patch: Partial<CompareSettings>) => {
    setSettings((previous) =>
      normalizeCompareSettings({ ...previous, ...patch }),
    );
    setEvidence(null);
    setPointer(null);
  }, []);
  const inspectEvidence = useCallback(
    (item: CompareEvidence) => {
      setEvidence({ ...item, settings: item.settings || settings });
      setPointer(null);
    },
    [settings],
  );
  const issuerCompanies = useMemo(
    () => uniqueIssuerCompanies(companies),
    [companies],
  );
  const lens =
    settings.lens === "auto"
      ? inferLens(
          issuerCompanies.filter(
            (c) => !c.duplicate && !settings.excluded.includes(c.ticker),
          ),
        )
      : settings.lens;
  const metricOptions = useMemo(
    () => COMPARE_METRICS.filter((m) => m.lenses.includes(lens)),
    [lens],
  );
  const selectedKeys = useMemo(
    () => settings.metrics.length ? settings.metrics : defaultMetrics(lens),
    [settings.metrics, lens],
  );
  const metrics = useMemo(
    () => metricOptions.filter((metric) => selectedKeys.includes(metric.key)),
    [metricOptions, selectedKeys],
  );
  const selection = useMemo(
    () => comparisonSelection(companies, settings),
    [companies, settings],
  );
  useEffect(() => {
    const active = selection.entries;
    if (!active.length) return;
    if (!active.some((entry) => entry.ticker === settings.focus)) {
      setSettings((previous) =>
        normalizeCompareSettings({ ...previous, focus: active[0].ticker }),
      );
    }
  }, [selection.entries, settings.focus]);
  const entries = useMemo(
    () =>
      settings.sort === "peers"
        ? selection.entries
        : [...selection.entries].sort((a, b) => {
            const av = a.data?.metrics[settings.sort]?.[a.index]?.value,
              bv = b.data?.metrics[settings.sort]?.[b.index]?.value;
            if (av == null) return bv == null ? 0 : 1;
            if (bv == null) return -1;
            return (av - bv) * (settings.descending ? -1 : 1);
          }),
    [selection.entries, settings.sort, settings.descending],
  );
  const optionsWithSelected = useMemo(
    () => [
      ...new Map(
        [
          ...metricOptions,
          ...[settings.metric, settings.x, settings.y].map(
            (k) => METRIC_BY_KEY[k],
          ),
        ].map((m) => [m.key, m]),
      ).values(),
    ],
    [metricOptions, settings.metric, settings.x, settings.y],
  );
  const companyIndex = useMemo(() => buildCompareCompanyIndex(tickerMap), [tickerMap]);
  const suggestions = useMemo(
    () => compareCompanySuggestions(companyIndex, input, tickers),
    [companyIndex, input, tickers],
  );
  const addTickers = (value: string | string[]) => {
    const plan = planComparePeers(
      tickers,
      (Array.isArray(value) ? value : value.split(/[\s,;]+/)).map(
        (ticker) => companyIndex.resolveTicker(ticker)?.ticker || ticker,
      ),
      "append",
      MAX_COMPARE_COMPANIES,
    );
    if (plan.error) {
      setError(plan.error);
      return;
    }
    setTickers(plan.tickers);
    setPointer(null);
    setInput("");
    setFocused(false);
    setError("");
    setEvidence(null);
  };
  const submitInput = () => {
    const exact = companyIndex.resolveTicker(input);
    if (exact) addTickers(exact.ticker);
    else if (suggestions.length && !input.includes(",") && !input.includes(";"))
      addTickers(suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))].ticker);
    else addTickers(input);
  };
  const preset = (group: any) => {
    const plan = planComparePeers(
      tickers,
      group.tickers,
      groupMode,
      MAX_COMPARE_COMPANIES,
    );
    if (plan.error) {
      setError(plan.error);
      return;
    }
    setTickers(plan.tickers);
    update({
      excluded: [],
      benchmark: "median",
      metrics: [],
      lens: "auto",
      period: "latest",
      view: "table",
      sort: "peers",
    });
    setError("");
  };
  const exportTable = () => {
    const observations = metrics.flatMap((metric) =>
      researchMetricComparison(entries, metric.key, settings).cells.map((cell) => ({ cell, metric })),
    );
    downloadFile(
      "peer-comparison-table.csv",
      exportCompareTableCsv(observations, { tickers, settings }),
      "text/csv;charset=utf-8",
    );
    setMessage(
      "Comparison CSV downloaded with reporting dates, settings, and every original source input.",
    );
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${comparePath(tickers, settings)}`,
      );
      setMessage("Comparison link copied with the complete setup.");
    } catch {
      setError(
        "Clipboard access was unavailable. Copy the address bar; it contains the complete comparison setup.",
      );
    }
  };
  const coverage = useMemo(
    () => metrics.reduce((sum, metric) => sum + metricComparison(entries, metric.key).count, 0),
    [metrics, entries],
  );
  const totalCells = entries.length * metrics.length;
  const roe = useMemo(() => researchMetricComparison(entries, "roe", settings), [entries, settings]);

  useEffect(() => {
    if (
      !pointer ||
      pointerResolved ||
      !ready ||
      !entries.length ||
      entries.some((entry) => entry.loading)
    )
      return;
    const resolved = resolveCompareEvidencePointer(
      pointer,
      entries,
      metrics,
      settings,
    );
    setPointerResolved(true);
    if (resolved.evidence) setEvidence(resolved.evidence);
    else
      setMessage(
        resolved.reason ||
          "The linked observation could not be verified. Inspect the current evidence before using it.",
      );
  }, [pointer, pointerResolved, ready, entries, metrics, settings]);
  const reorderPeer = (index: number, direction: number) => {
    setTickers((old) => {
      const next = [...old];
      [next[index], next[index + direction]] = [
        next[index + direction],
        next[index],
      ];
      return next;
    });
    update({ sort: "peers" });
  };

  return (
    <div ref={pageRef} className={styles.page}>
      <div className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>
            <GitCompareArrows size={15} /> Research workspace / Peer comparison
          </span>
          <h1>{tickers.length ? `Compare ${tickers.join(", ")}` : "Put performance in perspective."}</h1>
          <p>
            Comparable periods. Industry-aware metrics. A clear path from every
            number to its SEC evidence.
          </p>
        </div>
        <div className={styles.heroMark}>
          <CheckCircle2 size={18} />
          <span>
            Source-linked
            <br />
            <strong>by design</strong>
          </span>
        </div>
      </div>
      <section
        className={styles.controls}
        data-compare-controls
        aria-label="Comparison controls"
      >
        <div className={styles.searchRow}>
          <form
            className={styles.searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              submitInput();
            }}
          >
            <label className={styles.srOnly} htmlFor="compare-company-input">
              Add ticker or company
            </label>
            <GitCompareArrows size={18} />
            <input
              id="compare-company-input"
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={focused && suggestions.length > 0}
              aria-controls="compare-suggestions"
              aria-activedescendant={
                focused && suggestions.length
                  ? `compare-suggestion-${Math.min(suggestionIndex, suggestions.length - 1)}`
                  : undefined
              }
              value={input}
              placeholder="Add company or paste tickers: JPM, BAC…"
              onFocus={() => {
                if (["idle", "error"].includes(ctx?.directoryStatus || ""))
                  void ctx?.refreshTickerMap(ctx.directoryStatus === "error");
                setFocused(true);
              }}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onChange={(e) => {
                setInput(e.target.value);
                setSuggestionIndex(0);
                setFocused(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && suggestions.length) {
                  e.preventDefault();
                  setSuggestionIndex((i) =>
                    Math.min(i + 1, suggestions.length - 1),
                  );
                }
                if (e.key === "ArrowUp" && suggestions.length) {
                  e.preventDefault();
                  setSuggestionIndex((i) => Math.max(0, i - 1));
                }
                if (e.key === "Escape") setFocused(false);
              }}
            />
            <button
              className={styles.primary}
              type="submit"
              disabled={
                !input.trim() || tickers.length >= MAX_COMPARE_COMPANIES
              }
            >
              <Plus size={15} /> Add
            </button>
            {focused && suggestions.length > 0 && (
              <ul
                id="compare-suggestions"
                role="listbox"
                className={styles.suggestions}
              >
                {suggestions.map((s, i) => (
                  <li
                    id={`compare-suggestion-${i}`}
                    key={s.ticker}
                    role="option"
                    aria-selected={suggestionIndex === i}
                  >
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => addTickers(s.ticker)}
                    >
                      <strong>{s.ticker}</strong>
                      <span>{s.name}</span>
                      <small>CIK {s.cik}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>
          <div className={styles.actions}>
            <button
              aria-label="Refresh SEC comparison data"
              disabled={!tickers.length || companies.some((c) => c.loading)}
              onClick={() => {
                cache.current.clear();
                setRetry((v) => v + 1);
                setEvidence(null);
              }}
            >
              <RefreshCw size={15} />
            </button>
            <button onClick={copyLink} aria-label="Copy comparison link">
              <LinkIcon size={15} />
              <span className={styles.desktopLabel}> Share</span>
            </button>
          </div>
        </div>
        <div className={styles.filterRow}>
          <label>
            Basis
            <select
              value={settings.basis}
              onChange={(e) =>
                update({ basis: e.target.value, period: "latest" })
              }
            >
              <option value="annual">Annual</option>
              <option value="quarter">Standalone quarter</option>
              <option value="ttm">Trailing 12 months</option>
            </select>
          </label>
          <label>
            Alignment
            <select
              value={settings.alignment}
              onChange={(e) =>
                update({ alignment: e.target.value, period: "latest" })
              }
            >
              <option value="common">Latest shared end bucket</option>
              <option value="latest">Latest for each issuer</option>
            </select>
          </label>
          <label>
            Period ends in
            <select
              value={settings.period}
              onChange={(e) => update({ period: e.target.value })}
            >
              <option value="latest">
                Automatic{selection.bucket ? ` · ${selection.bucket}` : ""}
              </option>
              {selection.buckets.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {selection.shared.includes(b) ? " · shared" : " · partial"}
                </option>
              ))}
              {settings.period !== "latest" &&
                !selection.buckets.includes(settings.period) && (
                  <option value={settings.period}>
                    {settings.period} · unavailable
                  </option>
                )}
            </select>
          </label>
          <label>
            Financial lens
            <select
              value={settings.lens}
              onChange={(e) => update({ lens: e.target.value, metrics: [] })}
            >
              {Object.entries(LENSES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Benchmark
            <select
              value={settings.benchmark}
              onChange={(e) => update({ benchmark: e.target.value })}
            >
              <option value="median">Selected-issuer median</option>
              <option value="peers">Other peers (excludes focus)</option>
              {tickers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <div aria-live="polite" role="status">
        {message && (
          <div className={styles.status}>
            {message}
            <button aria-label="Dismiss status" onClick={() => setMessage("")}>
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className={styles.setupRow}>
        <details className={styles.playbooks} open={!tickers.length}>
          <summary>
            Curated peer groups <span>12 starting points</span>
          </summary>
          <label className={styles.groupMode}>
            Apply a peer group
            <select
              value={groupMode}
              onChange={(e) => setGroupMode(e.target.value)}
            >
              <option value="replace">Replace current companies</option>
              <option value="append">Add to current companies</option>
            </select>
          </label>
          <div className={styles.presetGrid}>
            {PEER_GROUPS.map((g) => (
              <button
                key={g.id}
                onClick={() => preset(g)}
                title={g.description}
              >
                <span>{g.icon}</span>
                <strong>{g.label}</strong>
                <small>{g.tickers.join(" · ")}</small>
              </button>
            ))}
          </div>
          <small>
            Groups are research starting points. Current SEC identity and data
            availability are checked on loading.
          </small>
        </details>
        <details className={styles.advanced}>
          <summary>
            <SlidersHorizontal size={14} /> Metrics & research settings
          </summary>
          <div className={styles.inlineControls}>
            <form
              className={styles.cutoffForm}
              onSubmit={(event) => {
                event.preventDefault();
                const date = String(
                  new FormData(event.currentTarget).get("asOf") || "",
                );
                const normalized = normalizeCompareSettings({
                  ...settings,
                  asOf: date,
                });
                if (date && normalized.asOf !== date) {
                  setError("Choose a valid filing cutoff no later than today.");
                  return;
                }
                update({ asOf: date, period: "latest" });
              }}
            >
              <label>
                Only facts filed by
                <input
                  key={settings.asOf}
                  name="asOf"
                  type="date"
                  defaultValue={settings.asOf}
                  max={new Date().toISOString().slice(0, 10)}
                />
              </label>
              <button type="submit">Apply cutoff</button>
              <button type="button" onClick={() => update({ asOf: "" })}>
                Use latest filings
              </button>
            </form>
            <label>
              Order companies by
              <select
                value={settings.sort}
                onChange={(e) => update({ sort: e.target.value })}
              >
                <option value="peers">Peer set order</option>
                {metricOptions.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Sort direction
              <select
                value={settings.descending ? "descending" : "ascending"}
                onChange={(e) =>
                  update({ descending: e.target.value === "descending" })
                }
              >
                <option value="descending">Largest first</option>
                <option value="ascending">Smallest first</option>
              </select>
            </label>
          </div>
          <p>
            Reporting buckets use calendar end dates, not fiscal-year labels.
            The filing cutoff applies to each original input, including
            comparative revisions.
          </p>
          <div className={styles.metricPicker}>
            {metricOptions.map((m) => (
              <label key={m.key}>
                <input
                  type="checkbox"
                  checked={selectedKeys.includes(m.key)}
                  onChange={() => {
                    const next = selectedKeys.includes(m.key)
                      ? selectedKeys.filter((k) => k !== m.key)
                      : [...selectedKeys, m.key];
                    if (!next.length) {
                      setMessage("Keep at least one metric selected.");
                      return;
                    }
                    update({ metrics: next });
                  }}
                />
                {m.label}
              </label>
            ))}
          </div>
          <button onClick={() => update({ metrics: [] })}>
            Restore lens defaults
          </button>
        </details>
      </div>
      {!!tickers.length && (
        <>
          <details className={styles.peerManager} open={tickers.length <= 5}>
            <summary>
              Manage {tickers.length} / {MAX_COMPARE_COMPANIES} companies{" "}
              <span>
                {companies.filter((company) => company.loading).length} loading
                · {companies.filter((company) => company.error).length} failed ·{" "}
                {
                  settings.excluded.filter((ticker) => tickers.includes(ticker))
                    .length
                }{" "}
                excluded
              </span>
            </summary>
            <div className={styles.peerActions}>
              <button
                onClick={() => update({ excluded: [] })}
                disabled={!settings.excluded.length}
              >
                Include all companies
              </button>
              <span>
                Move peers to set table order. Duplicate SEC issuers count once.
              </span>
            </div>
            <div className={styles.companyGrid}>
              {tickers.map((ticker, i) => {
                const company = issuerCompanies.find(
                  (c) => c.ticker === ticker,
                );
                const data = company?.data;
                const excluded = settings.excluded.includes(ticker);
                const name =
                  data?.name ||
                  preloadedCompanies.find((c) => c.ticker === ticker)?.name ||
                  tickerMap?.[ticker]?.name ||
                  (company?.error ? "SEC issuer unavailable" : "Resolving SEC issuer…");
                return (
                  <article
                    key={ticker}
                    className={`${styles.companyCard} ${excluded || company?.duplicate ? styles.excluded : ""}`}
                    style={{
                      borderTopColor:
                        company?.color || COLORS[i % COLORS.length],
                    }}
                  >
                    <div className={styles.companyTitle}>
                      <strong>{ticker}</strong>
                      <button
                        aria-label={`Remove ${ticker}`}
                        onClick={() => {
                          setTickers((old) => old.filter((t) => t !== ticker));
                          update({
                            excluded: settings.excluded.filter(
                              (t) => t !== ticker,
                            ),
                            benchmark:
                              settings.benchmark === ticker
                                ? "median"
                                : settings.benchmark,
                          });
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <div className={styles.peerOrder}>
                      <button
                        aria-label={`Move ${ticker} earlier`}
                        disabled={i === 0}
                        onClick={() => reorderPeer(i, -1)}
                      >
                        <ArrowLeft size={13} />
                      </button>
                      <span>Position {i + 1}</span>
                      <button
                        aria-label={`Move ${ticker} later`}
                        disabled={i === tickers.length - 1}
                        onClick={() => reorderPeer(i, 1)}
                      >
                        <ArrowRight size={13} />
                      </button>
                    </div>
                    <p>{name}</p>
                    {company?.loading ? (
                      <small>
                        <Loader2 size={12} className={styles.spin} /> Loading
                        SEC data…
                      </small>
                    ) : company?.error ? (
                      <>
                        <p className={styles.warning}>{company.error}</p>
                        <button
                          onClick={() => {
                            cache.current.delete(`${ticker}:${basis}:${asOf}`);
                            setRetry((v) => v + 1);
                          }}
                        >
                          <RefreshCw size={13} /> Retry {ticker}
                        </button>
                      </>
                    ) : (
                      data && (
                        <>
                          <small>
                            CIK {data.cik} · SIC {data.sic || "Unknown"}
                          </small>
                          <small>
                            {LENSES[data.lens]} · {data.periods.length} periods
                          </small>
                          <small>
                            Retrieved{" "}
                            {new Date(data.observedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </small>
                          {company?.duplicate ? (
                            <p className={styles.warning}>
                              Same CIK as an earlier ticker. This alias is
                              excluded from peer statistics.
                            </p>
                          ) : (
                            <label className={styles.include}>
                              <input
                                type="checkbox"
                                checked={!excluded}
                                onChange={() =>
                                  update({
                                    excluded: excluded
                                      ? settings.excluded.filter(
                                          (t) => t !== ticker,
                                        )
                                      : [...settings.excluded, ticker],
                                  })
                                }
                              />{" "}
                              Include in comparison
                            </label>
                          )}
                        </>
                      )
                    )}
                  </article>
                );
              })}
            </div>
          </details>
          <div className={styles.focusRow}>
            <label>
              Focus company
              <select
                value={
                  entries.some((entry) => entry.ticker === settings.focus)
                    ? settings.focus
                    : entries[0]?.ticker || ""
                }
                onChange={(e) => update({ focus: e.target.value })}
              >
                {entries.map((entry) => (
                  <option key={entry.ticker} value={entry.ticker}>
                    {entry.ticker}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Use Focus & peers to see a benchmark that excludes this company,
              its exact sample, and sensitivity to each peer.
            </p>
            <button
              onClick={() => update({ view: "benchmarks", benchmark: "peers" })}
            >
              Study other peers
            </button>
          </div>
          <div className={styles.summaryGrid}>
            <div>
              <small>Issuers with periods</small>
              <strong>
                {selection.ready}
                <span> / {selection.requested}</span>
              </strong>
            </div>
            <div>
              <small>Metric coverage</small>
              <strong>
                {coverage}
                <span> / {totalCells}</span>
              </strong>
            </div>
            <div>
              <small>Reporting-end spread</small>
              <strong>
                {selection.span == null ? "—" : selection.span}
                <span>{selection.span == null ? "" : " days"}</span>
              </strong>
            </div>
            <div>
              <small>
                {settings.benchmark === "peers"
                  ? "Other-peer median ROE"
                  : "Selected-issuer median ROE"}
              </small>
              <strong>{displayValue(roe.peerMedian, "percent")}</strong>
            </div>
          </div>
          <div className={styles.contextLine}>
            <span className={styles.badge}>{LENSES[lens]}</span>
            <span>
              {settings.basis === "quarter"
                ? "Standalone quarters; return ratios annualized."
                : settings.basis === "ttm"
                  ? "Four consecutive quarters; balance-sheet values at period end."
                  : "Annual flow values; balance-sheet values at period end."}
            </span>
            {lens === "banking" && (
              <span>
                Net loans are used in credit ratios. Equity / assets is not
                regulatory capital. Bank and broker business models differ.
              </span>
            )}
            {lens === "insurance" && (
              <span>
                Life and P&C insurers differ. Combined ratios are omitted when
                underwriting inputs are not consistently defined.
              </span>
            )}
            {lens === "common" && (
              <span>
                Mixed or unresolved industries: shared financial measures only.
              </span>
            )}
          </div>
          {selection.span != null && selection.span > 45 && (
            <p className={styles.notice}>
              Fiscal calendars differ by {selection.span} days. Incompatible
              metric benchmarks are paused. Quarterly or trailing-year periods
              may provide closer reporting dates.
            </p>
          )}
          {!metrics.length && (
            <p className={styles.notice}>
              The selected metric set does not apply to this financial lens.{" "}
              <button onClick={() => update({ metrics: [] })}>
                Use lens defaults
              </button>
            </p>
          )}
          <div className={styles.viewBar}>
            <nav aria-label="Comparison views">
              {VIEWS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  aria-current={settings.view === key ? "page" : undefined}
                  onClick={() => update({ view: key })}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </nav>
            <button onClick={exportTable} disabled={!coverage}>
              <Download size={14} /> Export reported table
            </button>
          </div>
        </>
      )}
      {!tickers.length ? (
        <section className={styles.empty}>
          <GitCompareArrows size={38} />
          <h2>Start with the right peers.</h2>
          <p>
            Choose a group above or add up to 12 companies. Your comparison will
            include aligned financials, peer benchmarks, historical trends, and
            the evidence behind every value.
          </p>
          <div className={styles.actions}>
            <button onClick={() => preset(PEER_GROUPS[0])}>
              Compare large banks
            </button>
            <button onClick={() => preset(PEER_GROUPS[2])}>
              Compare technology leaders
            </button>
          </div>
        </section>
      ) : (
        <div
          className={`${styles.workspace} ${evidence ? styles.withInspector : ""}`}
        >
          <div className={styles.results}>
            {settings.view === "table" && (
              <>
                <nav className={styles.subviews} aria-label="Comparison format">
                  {[
                    ["reported", "Reported metrics"],
                    ["common-size", "Common size"],
                    ["formula", "Custom metric"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      aria-current={
                        settings.tableMode === key ? "page" : undefined
                      }
                      onClick={() => update({ tableMode: key })}
                    >
                      {label}
                    </button>
                  ))}
                </nav>
                {settings.tableMode === "reported" && (
                  <CompareTable
                    entries={entries}
                    metrics={metrics}
                    settings={settings}
                    inspect={inspectEvidence}
                  />
                )}
                {settings.tableMode === "common-size" && (
                  <CompareCommonSize
                    entries={entries}
                    metrics={optionsWithSelected}
                    settings={settings}
                    update={update}
                    inspect={inspectEvidence}
                  />
                )}
                {settings.tableMode === "formula" && (
                  <CompareFormula
                    entries={entries}
                    settings={settings}
                    update={update}
                    inspect={inspectEvidence}
                  />
                )}
              </>
            )}
            {settings.view === "quality" && (
              <CompareQualityDesk
                entries={entries}
                metrics={metrics}
                settings={settings}
                inspect={inspectEvidence}
              />
            )}
            {settings.view === "benchmarks" && (
              <CompareBenchmarks
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={inspectEvidence}
              />
            )}
            {settings.view === "changes" && (
              <CompareMovements
                companies={companies}
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={inspectEvidence}
              />
            )}
            {settings.view === "trends" && (
              <CompareTrends
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={inspectEvidence}
              />
            )}
            {settings.view === "map" && (
              <CompareMap
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={inspectEvidence}
              />
            )}
          </div>
          {evidence && (
            <CompareInspector
              evidence={evidence}
              close={() => {
                setEvidence(null);
                setPointer(null);
              }}
              tickers={tickers}
            />
          )}
        </div>
      )}
      <details className={styles.methodology}>
        <summary>Coverage, comparability, and methodology</summary>
        <p>
          Data is drawn from SEC company facts in USD. Unsupported custom tags,
          other reporting currencies, failed fetches, and missing periods remain
          visibly distinct from numeric zero. SEC data can be incomplete for
          foreign issuers. A company's fiscal year may differ from the calendar
          year shown in a reporting-end bucket.
        </p>
        <p>
          Returns use average beginning and ending balances. Quarter income is
          annualized for ROE, ROA, and provision rates. Percent changes require
          a positive year-earlier base; ratio changes use percentage points or
          multiples. CAGR requires positive endpoints about three years apart.
          These are accounting comparisons, not valuation or investment
          rankings.
        </p>
        <p>
          Bank income is net interest before provision plus noninterest income;
          both inputs are required. Loan ratios use reported net loans. Cash
          definitions can vary by issuer. Reported debt ratios require both
          current and noncurrent components and may omit debt categories outside
          the selected standard tags. Free cash flow is operating cash flow less
          reported PP&E purchases.
        </p>
        <p>
          A common end bucket does not guarantee identical business models or
          reporting durations. The selected-issuer median includes compatible
          available values. The other-peer benchmark excludes the focus company
          and requires two other issuers. The Comparability desk shows
          source-level coverage. Statistics pause for date spreads greater than
          45 days or duration differences greater than 14 days. Original source
          tags and dates remain reviewable.
        </p>
        <p>
          “Latest” uses the most recently filed compatible observation, which
          may revise prior results. The filing cutoff limits observations to
          filings available by that date. SEC data is cached for up to five
          minutes; refreshing the comparison can retrieve updated observations.
          Share links preserve your settings and verify original source inputs.
        </p>
      </details>
      <CompareGuide tickers={tickers} />
    </div>
  );
}
