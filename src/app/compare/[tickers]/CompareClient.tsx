"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GitCompareArrows,
  Plus,
  X,
  RefreshCw,
  Download,
  Link as LinkIcon,
  BookmarkPlus,
  SlidersHorizontal,
  Table2,
  TrendingUp,
  ScatterChart,
  NotebookPen,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import { TickerContext } from "../../../contexts/TickerContext";
import { secFilesUrl } from "../../../utils/secApi.js";
import { PEER_GROUPS } from "../../../utils/peerGroups.js";
import {
  COMPARE_METRICS,
  METRIC_BY_KEY,
  COMPARE_VERSION,
  inferLens,
  defaultMetrics,
  comparisonSelection,
  metricComparison,
  uniqueIssuerCompanies,
} from "../../../utils/compareResearch.js";
import {
  COMPARE_STORAGE_KEY,
  DEFAULT_COMPARE_SETTINGS,
  normalizeCompareTickers,
  normalizeCompareSettings,
  readCompareUrl,
  comparePath,
  emptyCompareNotebook,
  parseCompareNotebook,
  writeCompareNotebook,
  comparisonPin,
  exportCompareCsv,
} from "../../../utils/compareNotebook.js";
import CompareTable from "../components/CompareTable";
import { CompareTrends, CompareMap } from "../components/CompareCharts";
import CompareInspector from "../components/CompareInspector";
import CompareNotebook from "../components/CompareNotebook";
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
  banking: "Banks & brokers",
  corporate: "Corporate financials",
  insurance: "Insurance",
};
const VIEWS = [
  { key: "table", label: "Comparison", icon: Table2 },
  { key: "trends", label: "Trends & growth", icon: TrendingUp },
  { key: "map", label: "Peer map", icon: ScatterChart },
  { key: "notebook", label: "Research notebook", icon: NotebookPen },
];
const noop = (_value: any) => {};

export default function CompareClient({
  initialTickers,
  preloadedCompanies,
}: {
  initialTickers: string[];
  preloadedCompanies: PreloadedCompany[];
}) {
  const ctx = useContext(TickerContext);
  const tickerMap = ctx?.tickerMap;
  const setTickerMap = ctx?.setTickerMap || noop;
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
  const [notebook, setNotebook] = useState<any>(emptyCompareNotebook);
  const [saveName, setSaveName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [retry, setRetry] = useState(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, any>());
  const peerKey = tickers.join(",");
  const { basis, asOf } = settings;

  useEffect(() => {
    setSettings(readCompareUrl(window.location.search));
    try {
      setNotebook(
        parseCompareNotebook(localStorage.getItem(COMPARE_STORAGE_KEY)),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Saved data could not be loaded.",
      );
    }
    setReady(true);
    const pop = () => {
      setTickers(
        normalizeCompareTickers(
          decodeURIComponent(window.location.pathname.split("/")[2] || ""),
        ),
      );
      setSettings(readCompareUrl(window.location.search));
      setEvidence(null);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === COMPARE_STORAGE_KEY)
        try {
          setNotebook(parseCompareNotebook(event.newValue));
        } catch {
          setError(
            "Another tab saved unreadable comparison data. Existing data is preserved.",
          );
        }
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    if (ready)
      window.history.replaceState(null, "", comparePath(tickers, settings));
  }, [ready, tickers, settings]);
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
    if (tickerMap) return;
    const controller = new AbortController();
    fetch(secFilesUrl("company_tickers.json"), { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            "Ticker suggestions are unavailable. You can still enter exact tickers.",
          );
        const map: any = {};
        Object.values(await r.json()).forEach((entry: any) => {
          map[entry.ticker.toUpperCase()] = {
            ticker: entry.ticker.toUpperCase(),
            cik: String(entry.cik_str).padStart(10, "0"),
            name: entry.title,
          };
        });
        setTickerMap(map);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setMessage(e.message);
      });
    return () => controller.abort();
  }, [tickerMap, setTickerMap]);
  useEffect(() => {
    if (!ready) return;
    const peers = normalizeCompareTickers(peerKey),
      controller = new AbortController();
    const cacheKey = (ticker: string) => `${ticker}:${basis}:${asOf}`;
    for (const ticker of peers) {
      const old = cache.current.get(cacheKey(ticker));
      if (old && Date.now() - Date.parse(old.observedAt) > 300000)
        cache.current.delete(cacheKey(ticker));
    }
    setCompanies(
      peers.map((ticker, index) => ({
        ticker,
        color: COLORS[index % COLORS.length],
        data: cache.current.get(cacheKey(ticker)) || null,
        error: null,
        loading: !cache.current.has(cacheKey(ticker)),
      })),
    );
    const queue = peers.filter(
      (ticker) => !cache.current.has(cacheKey(ticker)),
    );
    const run = async () => {
      while (queue.length && !controller.signal.aborted) {
        const ticker = queue.shift()!;
        try {
          const response = await fetch(
            `/api/compare-research?${new URLSearchParams({ ticker, basis, asOf })}`,
            { signal: controller.signal },
          );
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error || `SEC request failed (${response.status}).`,
            );
          if (result.version !== COMPARE_VERSION || result.ticker !== ticker)
            throw new Error(
              "An incompatible company response was returned. Retry this issuer.",
            );
          if (controller.signal.aborted) return;
          cache.current.set(cacheKey(ticker), result);
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
  }, []);
  const mutate = useCallback((change: (n: any) => any) => {
    try {
      setNotebook(writeCompareNotebook(localStorage, change));
      return true;
    } catch (e) {
      setError(
        `Could not save: ${e instanceof Error ? e.message : "Browser storage is unavailable."}`,
      );
      return false;
    }
  }, []);
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
  const selectedKeys = settings.metrics.length
    ? settings.metrics
    : defaultMetrics(lens);
  const metrics = metricOptions.filter((m) => selectedKeys.includes(m.key));
  const selection = useMemo(
    () => comparisonSelection(companies, settings),
    [companies, settings],
  );
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
  const suggestions = useMemo(() => {
    const query = input.trim().toUpperCase();
    if (
      !query ||
      (/[,;\s]/.test(query) &&
        normalizeCompareTickers(query).length > 1 &&
        query.split(/[ ,;]+/).every((t) => tickerMap?.[t]))
    )
      return [];
    return Object.values(tickerMap || {})
      .filter(
        (c: any) =>
          !tickers.includes(c.ticker) &&
          (c.ticker.includes(query) || c.name?.toUpperCase().includes(query)),
      )
      .sort(
        (a: any, b: any) =>
          Number(b.ticker === query) - Number(a.ticker === query) ||
          Number(b.ticker.startsWith(query)) -
            Number(a.ticker.startsWith(query)) ||
          a.ticker.localeCompare(b.ticker),
      )
      .slice(0, 6) as any[];
  }, [input, tickerMap, tickers]);
  const addTickers = (value: string | string[]) => {
    const additions = normalizeCompareTickers(value);
    if (!additions.length) {
      setError("Enter a ticker or choose a company suggestion.");
      return;
    }
    if ([...new Set([...tickers, ...additions])].length > 5) {
      setError(
        "This workspace supports five issuers. Remove an issuer before adding another.",
      );
      return;
    }
    setTickers((old) => normalizeCompareTickers([...old, ...additions]));
    setInput("");
    setFocused(false);
    setError("");
    setEvidence(null);
  };
  const submitInput = () => {
    if (suggestions.length && !input.includes(",") && !input.includes(";"))
      addTickers(
        suggestions[Math.min(suggestionIndex, suggestions.length - 1)].ticker,
      );
    else addTickers(input);
  };
  const preset = (group: any) => {
    setTickers(normalizeCompareTickers(group.tickers));
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
    setSaveName(group.label);
  };
  const saveSearch = () => {
    if (!saveName.trim()) {
      setError("Give this comparison a name.");
      return;
    }
    const saved = mutate((n) => ({
      ...n,
      searches: [
        {
          id: crypto.randomUUID(),
          name: saveName.trim(),
          tickers,
          settings,
          savedAt: new Date().toISOString(),
        },
        ...n.searches,
      ].slice(0, 50),
    }));
    if (saved) {
      setShowSave(false);
      setMessage("Comparison saved in this browser.");
    }
  };
  const saveEvidence = () => {
    if (!evidence?.cell.point || !evidence.cell.period) return;
    const pin = comparisonPin(evidence.cell, evidence.metric, settings);
    const saved = mutate((n) => {
      if (n.pins.some((p: any) => p.id === pin.id)) return n;
      if (n.pins.length >= 100)
        throw new Error(
          "The collection holds 100 observations. Export it and remove an observation to save more.",
        );
      return { ...n, pins: [pin, ...n.pins] };
    });
    if (saved)
      setMessage(
        "Evidence saved. Add notes and export it from the Research notebook.",
      );
  };
  const exportTable = () => {
    const pins = metrics.flatMap((metric) =>
      metricComparison(entries, metric.key, settings.benchmark).cells.map(
        (cell) => ({
          ...comparisonPin(
            {
              ...cell,
              period: cell.period || { end: "", kind: settings.basis },
              point: cell.point || {
                period: cell.period || { kind: settings.basis },
                value: null,
                reason: cell.status,
              },
            },
            metric,
            settings,
          ),
          notes:
            cell.delta == null
              ? "Peer benchmark unavailable."
              : `${cell.delta} ${metric.format === "percent" ? "percentage points" : metric.format === "currency" ? "USD" : "times"} versus ${settings.benchmark}; numeric rank ${cell.rank}.`,
        }),
      ),
    );
    downloadFile(
      "peer-comparison-table.csv",
      exportCompareCsv(pins, {
        collectionName: saveName || "Current peer comparison",
        notes: `Requested peers: ${tickers.join(", ")}. Excluded peers: ${settings.excluded.join(", ") || "None"}. One row per original input; metric values repeat for multi-input calculations.`,
      }),
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
  const coverage = metrics.reduce(
    (sum, m) => sum + metricComparison(entries, m.key).count,
    0,
  );
  const totalCells = entries.length * metrics.length;
  const roe = metricComparison(entries, "roe");

  return (
    <div ref={pageRef} className={styles.page}>
      <div className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>
            <GitCompareArrows size={15} /> Research workspace / Peer comparison
          </span>
          <h1>Put performance in perspective.</h1>
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
                  ? `compare-suggestion-${suggestionIndex}`
                  : undefined
              }
              value={input}
              placeholder="Add company or paste tickers: JPM, BAC…"
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onChange={(e) => {
                setInput(e.target.value);
                setSuggestionIndex(0);
                setFocused(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggestionIndex((i) =>
                    Math.min(i + 1, suggestions.length - 1),
                  );
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggestionIndex((i) => Math.max(0, i - 1));
                }
                if (e.key === "Escape") setFocused(false);
              }}
            />
            <button
              className={styles.primary}
              type="submit"
              disabled={!input.trim() || tickers.length >= 5}
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
            <button
              onClick={() => setShowSave((v) => !v)}
              disabled={!tickers.length}
            >
              <BookmarkPlus size={15} /> Save comparison
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
              {tickers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {showSave && (
        <form
          className={styles.saveForm}
          onSubmit={(e) => {
            e.preventDefault();
            saveSearch();
          }}
        >
          <label>
            Comparison name
            <input
              autoFocus
              value={saveName}
              maxLength={100}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Bank funding review"
            />
          </label>
          <button className={styles.primary} type="submit">
            Save setup
          </button>
          <button type="button" onClick={() => setShowSave(false)}>
            Cancel
          </button>
          <small>
            Stored in this browser. Share links preserve settings; private notes
            stay here.
          </small>
        </form>
      )}
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
            <label>
              Only facts filed by
              <input
                type="date"
                value={settings.asOf}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) =>
                  update({ asOf: e.target.value, period: "latest" })
                }
              />
            </label>
            <button onClick={() => update({ asOf: "" })}>
              Use latest filings
            </button>
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
          <div className={styles.companyGrid}>
            {tickers.map((ticker, i) => {
              const company = issuerCompanies.find((c) => c.ticker === ticker);
              const data = company?.data;
              const excluded = settings.excluded.includes(ticker);
              const name =
                data?.name ||
                preloadedCompanies.find((c) => c.ticker === ticker)?.name ||
                "Resolving SEC issuer…";
              return (
                <article
                  key={ticker}
                  className={`${styles.companyCard} ${excluded || company?.duplicate ? styles.excluded : ""}`}
                  style={{ borderTopColor: COLORS[i % COLORS.length] }}
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
                  <p>{name}</p>
                  {company?.loading ? (
                    <small>
                      <Loader2 size={12} className={styles.spin} /> Loading SEC
                      data…
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
              <small>Peer median ROE</small>
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
              The saved metric selection does not apply to this financial lens.{" "}
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
                  {key === "notebook" && notebook.pins.length > 0 && (
                    <span>{notebook.pins.length}</span>
                  )}
                </button>
              ))}
            </nav>
            <button onClick={exportTable} disabled={!coverage}>
              <Download size={14} /> Export table
            </button>
          </div>
        </>
      )}
      {!tickers.length && settings.view !== "notebook" ? (
        <section className={styles.empty}>
          <GitCompareArrows size={38} />
          <h2>Start with the right peers.</h2>
          <p>
            Choose a group above or add up to five companies. Your comparison
            will include aligned financials, peer benchmarks, historical trends,
            and the evidence behind every value.
          </p>
          <div className={styles.actions}>
            <button onClick={() => preset(PEER_GROUPS[0])}>
              Compare large banks
            </button>
            <button onClick={() => preset(PEER_GROUPS[2])}>
              Compare technology leaders
            </button>
            {notebook.searches.length > 0 && (
              <button onClick={() => update({ view: "notebook" })}>
                Open saved comparisons
              </button>
            )}
          </div>
        </section>
      ) : (
        <div
          className={`${styles.workspace} ${evidence ? styles.withInspector : ""}`}
        >
          <div className={styles.results}>
            {settings.view === "table" && (
              <CompareTable
                entries={entries}
                metrics={metrics}
                settings={settings}
                inspect={setEvidence}
              />
            )}
            {settings.view === "trends" && (
              <CompareTrends
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={setEvidence}
              />
            )}
            {settings.view === "map" && (
              <CompareMap
                entries={entries}
                metrics={optionsWithSelected}
                settings={settings}
                update={update}
                inspect={setEvidence}
              />
            )}
            {settings.view === "notebook" && (
              <CompareNotebook
                notebook={notebook}
                mutate={mutate}
                load={(item) => {
                  cache.current.clear();
                  setRetry((v) => v + 1);
                  setTickers(normalizeCompareTickers(item.tickers));
                  update({
                    ...normalizeCompareSettings(item.settings),
                    view: "table",
                  });
                  setSaveName(item.name);
                  setMessage(
                    `Loaded ${item.name}; SEC data will refresh as needed.`,
                  );
                }}
                inspect={setEvidence}
                notice={setMessage}
              />
            )}
          </div>
          {evidence && (
            <CompareInspector
              evidence={evidence}
              close={() => setEvidence(null)}
              save={saveEvidence}
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
          reporting durations. Peer medians include all selected issuers with
          compatible available values, with coverage shown for every row.
          Statistics pause for date spreads greater than 45 days or duration
          differences greater than 14 days. Original source tags and dates
          remain reviewable.
        </p>
        <p>
          “Latest” uses the most recently filed compatible observation, which
          may revise prior results. The filing cutoff limits observations to
          filings available by that date. SEC data is cached for up to five
          minutes; changing a saved setup can retrieve updated observations.
          Saved evidence retains its captured values until removed.
        </p>
      </details>
    </div>
  );
}
