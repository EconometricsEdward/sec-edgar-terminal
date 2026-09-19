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
  ShieldCheck,
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
import CompareOverview from "../components/CompareOverview";
import CompareGuide from "../CompareGuide";
const loadingView = () => <p role="status">Loading comparison view…</p>;
const CompareQualityDesk = dynamic(() => import("../components/CompareQualityDesk"), { loading: loadingView });
const CompareMovements = dynamic(() => import("../components/CompareMovements"), { loading: loadingView });
const CompareCommonSize = dynamic(() => import("../components/CompareCommonSize"), { loading: loadingView });
const CompareFormula = dynamic(() => import("../components/CompareFormula"), { loading: loadingView });
const CompareTrends = dynamic(() => import("../components/CompareCharts").then((module) => module.CompareTrends), { loading: loadingView });
const CompareMap = dynamic(() => import("../components/CompareCharts").then((module) => module.CompareMap), { loading: loadingView });
const CompareMarketContext = dynamic(() => import("../components/CompareMarketContext"), { loading: loadingView });
const CompareInspector = dynamic(() => import("../components/CompareInspector"), { loading: loadingView });
import {
  COLORS,
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
  { key: "table", label: "Compare", icon: Table2 },
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [pointer, setPointer] = useState<any>(null);
  const [pointerResolved, setPointerResolved] = useState(false);
  const colorMap = useRef(new Map<string, string>());
  const pageRef = useRef<HTMLDivElement>(null);
  const cache = useRef(createCompareClientCache());
  const peerKey = tickers.join(",");
  const hasPeers = tickers.length > 0;
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
    setChecksOpen(new URLSearchParams(window.location.search).get("view") === "quality");
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
      setChecksOpen(new URLSearchParams(window.location.search).get("view") === "quality");
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
  }, [hasPeers]);
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
    else if (/\s/.test(input.trim()) && !/[,;]/.test(input)
      && !input.trim().split(/\s+/).every(ticker => companyIndex.resolveTicker(ticker))) {
      setError(ctx?.directoryStatus === "ready"
        ? "No matching company. Try a shorter company name, or separate ticker symbols with commas."
        : "Company search is still loading or unavailable. Try again in a moment, or enter a ticker symbol.");
    }
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
  const marketCompanies = useMemo(() => entries.filter(entry => entry.data && !entry.loading && !entry.error).map(entry => ({
    ticker: entry.ticker, cik: entry.data.cik, companyName: entry.data.name,
    companyType: entry.data.lens, sic: entry.data.sic, businessModel: entry.data.businessModel,
    secIdentity: companyIndex.resolveTicker(entry.ticker),
  })), [entries, companyIndex]);
  const loadingCount = companies.filter(company => company.loading).length;
  const removeCompany = (ticker: string) => {
    setTickers(previous => previous.filter(value => value !== ticker));
    update({ excluded: settings.excluded.filter(value => value !== ticker),
      benchmark: settings.benchmark === ticker ? "median" : settings.benchmark });
  };

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
      <header className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>Company comparisons</span>
          <h1>{tickers.length ? `Compare ${tickers.join(", ")}` : "See what sets companies apart."}</h1>
          <p>Performance, financial strength, and growth. Side by side.</p>
        </div>
        <div className={styles.actions}>
          <button onClick={copyLink} aria-label="Copy comparison link"><LinkIcon size={15} /> Share</button>
          <button aria-label="Refresh SEC comparison data" title="Refresh SEC data"
            disabled={!tickers.length || loadingCount > 0}
            onClick={() => { cache.current.clear(); setRetry(value => value + 1); setEvidence(null); }}>
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <section className={styles.selectionArea} aria-label="Choose companies">
        <div className={styles.searchRow}>
          <form className={styles.searchForm} onSubmit={event => { event.preventDefault(); submitInput(); }}>
            <label className={styles.srOnly} htmlFor="compare-company-input">Add ticker or company</label>
            <GitCompareArrows size={18} />
            <input id="compare-company-input" role="combobox" autoComplete="off" aria-autocomplete="list"
              aria-expanded={focused && suggestions.length > 0} aria-controls="compare-suggestions"
              aria-activedescendant={focused && suggestions.length ? `compare-suggestion-${Math.min(suggestionIndex, suggestions.length - 1)}` : undefined}
              value={input} placeholder="Add companies by name or ticker…"
              onFocus={() => { if (["idle", "error"].includes(ctx?.directoryStatus || "")) void ctx?.refreshTickerMap(ctx.directoryStatus === "error"); setFocused(true); }}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onChange={event => { setInput(event.target.value); setSuggestionIndex(0); setFocused(true); }}
              onKeyDown={event => {
                if (event.key === "ArrowDown" && suggestions.length) { event.preventDefault(); setSuggestionIndex(value => Math.min(value + 1, suggestions.length - 1)); }
                if (event.key === "ArrowUp" && suggestions.length) { event.preventDefault(); setSuggestionIndex(value => Math.max(0, value - 1)); }
                if (event.key === "Escape") setFocused(false);
              }} />
            <button className={styles.primary} type="submit" disabled={!input.trim() || tickers.length >= MAX_COMPARE_COMPANIES}><Plus size={15} /> Add</button>
            {focused && suggestions.length > 0 && <ul id="compare-suggestions" role="listbox" className={styles.suggestions}>
              {suggestions.map((suggestion, index) => <li id={`compare-suggestion-${index}`} key={suggestion.ticker} role="option" aria-selected={suggestionIndex === index}>
                <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => addTickers(suggestion.ticker)}>
                  <strong>{suggestion.ticker}</strong><span>{suggestion.name}</span><small>CIK {suggestion.cik}</small>
                </button>
              </li>)}
            </ul>}
          </form>
          <details className={styles.groupPicker}>
            <summary>Choose a peer group</summary>
            <div className={styles.groupMenu}>
              {!!tickers.length && <label>Apply group<select value={groupMode} onChange={event => setGroupMode(event.target.value)}>
                <option value="replace">Replace companies</option><option value="append">Add to companies</option>
              </select></label>}
              {PEER_GROUPS.map(group => <button key={group.id} onClick={event => { preset(group); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
                <strong>{group.label}</strong><small>{group.tickers.join(" · ")}</small><ArrowRight size={14} />
              </button>)}
            </div>
          </details>
        </div>
        {!!tickers.length && <div className={styles.companyStrip} aria-label="Selected companies">
          {tickers.map((ticker, index) => {
            const company = issuerCompanies.find(value => value.ticker === ticker);
            const data = company?.data;
            const excluded = settings.excluded.includes(ticker);
            const name = data?.name || preloadedCompanies.find(value => value.ticker === ticker)?.name || tickerMap?.[ticker]?.name || ticker;
            const model = data?.businessModel === "broker-dealer" ? "Broker-dealer financials" : LENSES[data?.lens] || "SEC financials";
            return <details key={ticker} className={`${styles.companyChip} ${excluded || company?.duplicate ? styles.excluded : ""}`} name="compare-company-details">
              <summary title={`${name}${excluded ? " · Excluded" : ""}`}>
                <span className={styles.dot} style={{ background: company?.color || COLORS[index % COLORS.length] }} />
                <strong>{ticker}</strong><span className={styles.chipName}>{name === ticker ? "" : name}</span>
                {company?.loading ? <Loader2 size={12} className={styles.spin} /> : company?.error ? <span className={styles.warning}>Retry</span> : excluded ? <small>Excluded</small> : company?.duplicate ? <small>Same issuer</small> : null}
              </summary>
              <div className={styles.companyPopover}>
                <div className={styles.companyPopoverHeading}><strong>{ticker}</strong><button aria-label={`Remove ${ticker}`} onClick={() => removeCompany(ticker)}><X size={14} /></button></div>
                <p>{name}</p>
                {company?.loading ? <p role="status">Loading SEC financials…</p> : company?.error ? <>
                  <p className={styles.warning}>{company.error}</p>
                  <button onClick={() => { cache.current.delete(`${ticker}:${basis}:${asOf}`); setRetry(value => value + 1); }}><RefreshCw size={13} /> Retry {ticker}</button>
                </> : data ? <>
                  <small>{model} · {data.periods.length} periods</small>
                  <small>CIK {data.cik} · Retrieved {new Date(data.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                  {company?.duplicate ? <p className={styles.warning}>This share class has the same SEC issuer as an earlier company and is excluded from peer statistics.</p> : <label className={styles.include}>
                    <input type="checkbox" checked={!excluded} onChange={() => update({ excluded: excluded ? settings.excluded.filter(value => value !== ticker) : [...settings.excluded, ticker] })} />Include {ticker} in comparison
                  </label>}
                </> : null}
                <div className={styles.peerOrder}>
                  <button aria-label={`Move ${ticker} earlier`} disabled={index === 0} onClick={() => reorderPeer(index, -1)}><ArrowLeft size={13} /></button>
                  <span>Position {index + 1}</span>
                  <button aria-label={`Move ${ticker} later`} disabled={index === tickers.length - 1} onClick={() => reorderPeer(index, 1)}><ArrowRight size={13} /></button>
                </div>
              </div>
            </details>;
          })}
          <small className={styles.companyCount}>{tickers.length} / {MAX_COMPARE_COMPANIES}</small>
        </div>}
      </section>

      <div aria-live="polite" role="status">{message && <div className={styles.status}>{message}<button aria-label="Dismiss status" onClick={() => setMessage("")}><X size={13} /></button></div>}</div>
      {error && <div className={styles.error} role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={13} /></button></div>}

      {!!tickers.length && <>
        <section className={styles.controls} data-compare-controls aria-label="Comparison controls">
          <div className={styles.filterRow}>
            <label>Reporting basis<select value={settings.basis} onChange={event => update({ basis: event.target.value, period: "latest" })}>
              <option value="annual">Annual</option><option value="quarter">Standalone quarter</option><option value="ttm">Trailing 12 months</option>
            </select></label>
            <label>Period ending<select value={settings.period} onChange={event => update({ period: event.target.value })}>
              <option value="latest">{selection.bucket ? `Latest · ${selection.bucket}` : "Latest available"}</option>
              {selection.buckets.map(bucket => <option key={bucket} value={bucket}>{bucket}{selection.shared.includes(bucket) ? " · shared" : " · partial"}</option>)}
              {settings.period !== "latest" && !selection.buckets.includes(settings.period) && <option value={settings.period}>{settings.period} · unavailable</option>}
            </select></label>
            <button className={styles.settingsButton} aria-expanded={optionsOpen} aria-controls="compare-options" onClick={() => setOptionsOpen(value => !value)}><SlidersHorizontal size={15} /> Settings{settings.asOf ? " · cutoff active" : ""}</button>
            <div className={styles.coverageLine}>
              <span>{loadingCount ? `${loadingCount} loading…` : `${selection.ready} of ${selection.requested} companies ready`}</span>
              <button aria-expanded={checksOpen} aria-controls="compare-data-checks" onClick={() => setChecksOpen(value => !value)}><ShieldCheck size={13} /> {coverage}/{totalCells} values · Data checks</button>
            </div>
          </div>
        </section>
        {optionsOpen && <section id="compare-options" className={styles.optionsPanel} aria-label="Comparison settings">
          <div className={styles.optionsHead}><h2>Fine-tune your comparison</h2><button aria-label="Close comparison settings" onClick={() => setOptionsOpen(false)}><X size={15} /></button></div>
          <div className={styles.optionsGrid}>
            <label>Reporting alignment<select value={settings.alignment} onChange={event => update({ alignment: event.target.value, period: "latest" })}><option value="common">Latest shared period</option><option value="latest">Latest for each company</option></select></label>
            <label>Financial lens<select value={settings.lens} onChange={event => update({ lens: event.target.value, metrics: [] })}>{Object.entries(LENSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>Compare values with<select value={settings.benchmark} onChange={event => update({ benchmark: event.target.value })}><option value="median">Selected-company median</option><option value="peers">Other peers, excluding focus</option>{tickers.map(ticker => <option key={ticker} value={ticker}>{ticker}</option>)}</select></label>
            {settings.benchmark === "peers" && <label>Focus company<select value={entries.some(entry => entry.ticker === settings.focus) ? settings.focus : entries[0]?.ticker || ""} onChange={event => update({ focus: event.target.value })}>{entries.map(entry => <option key={entry.ticker} value={entry.ticker}>{entry.ticker}</option>)}</select></label>}
            <label>Order companies by<select value={settings.sort} onChange={event => update({ sort: event.target.value })}><option value="peers">Selected order</option>{metricOptions.map(metric => <option key={metric.key} value={metric.key}>{metric.label}</option>)}</select></label>
            {settings.sort !== "peers" && <label>Sort direction<select value={settings.descending ? "descending" : "ascending"} onChange={event => update({ descending: event.target.value === "descending" })}><option value="descending">Largest first</option><option value="ascending">Smallest first</option></select></label>}
          </div>
          <details className={styles.optionDetails}><summary>Choose table metrics · {metrics.length} selected</summary><div className={styles.metricPicker}>
            {metricOptions.map(metric => <label key={metric.key}><input type="checkbox" checked={selectedKeys.includes(metric.key)} onChange={() => {
              const next = selectedKeys.includes(metric.key) ? selectedKeys.filter(key => key !== metric.key) : [...selectedKeys, metric.key];
              if (!next.length) { setMessage("Keep at least one metric selected."); return; } update({ metrics: next });
            }} />{metric.label}</label>)}
          </div><button onClick={() => update({ metrics: [] })}>Restore defaults</button></details>
          <details className={styles.optionDetails}><summary>Historical filing cutoff{settings.asOf ? ` · ${settings.asOf}` : ""}</summary>
            <form className={styles.cutoffForm} onSubmit={event => { event.preventDefault(); const date = String(new FormData(event.currentTarget).get("asOf") || ""); const normalized = normalizeCompareSettings({ ...settings, asOf: date }); if (date && normalized.asOf !== date) { setError("Choose a valid filing cutoff no later than today."); return; } update({ asOf: date, period: "latest" }); }}>
              <label>Only facts filed by<input key={settings.asOf} name="asOf" type="date" defaultValue={settings.asOf} max={new Date().toISOString().slice(0, 10)} /></label><button type="submit">Apply cutoff</button><button type="button" onClick={() => update({ asOf: "" })}>Use latest filings</button>
            </form><p>Limits each financial input to filings available by this date, including later comparative revisions.</p>
          </details>
        </section>}
        {selection.span != null && selection.span > 45 && <p className={styles.notice}>Reporting dates span {selection.span} days. Benchmarks pause where the selected periods are not comparable.</p>}
        {!metrics.length && <p className={styles.notice}>These metrics do not apply to the selected financial lens. <button onClick={() => update({ metrics: [] })}>Use suggested metrics</button></p>}
        <div className={styles.viewBar}>
          <nav aria-label="Comparison views">{VIEWS.map(({ key, label, icon: Icon }) => <button key={key} aria-current={settings.view === key ? "page" : undefined} onClick={() => update({ view: key, ...(key === "table" ? { tableMode: "reported" } : {}) })}><Icon size={16} />{label}</button>)}</nav>
          <div className={styles.actions}>
            <label className={styles.toolSelect}><span className={styles.srOnly}>More comparison tools</span><select value="" onChange={event => { update({ view: "table", tableMode: event.target.value }); }}><option value="" disabled>More tools</option><option value="common-size">Common-size statements</option><option value="formula">Custom metric</option><option value="changes">Period changes</option></select></label>
            <button onClick={exportTable} disabled={!coverage} aria-label="Export reported table"><Download size={14} /><span className={styles.desktopLabel}>Export</span></button>
          </div>
        </div>
      </>}

      {!tickers.length ? <section className={styles.discovery}>
        <div className={styles.discoveryIntro}><span className={styles.eyebrow}>Start with a question</span><h2>Who is growing?<br />Who has room to move?</h2><p>Choose up to 12 companies to compare financial performance, follow their trajectories, and find the differences that matter.</p></div>
        <div className={styles.starterGroups}>{["mega-tech", "ev-autos", "big-banks", "big-oil"].map(id => { const group = PEER_GROUPS.find(value => value.id === id)!; return <button key={group.id} onClick={() => preset(group)}><div><strong>{group.label}</strong><small>{group.tickers.join(" · ")}</small></div><ArrowRight size={20} /></button>; })}</div>
      </section> : <div className={`${styles.workspace} ${evidence ? styles.withInspector : ""}`}>
        <div className={styles.results}>
          {checksOpen && <section id="compare-data-checks" className={styles.dataChecks} aria-label="Comparison data checks"><div className={styles.optionsHead}><span>Reporting dates, definitions, and coverage</span><button aria-label="Close data checks" onClick={() => setChecksOpen(false)}><X size={15} /></button></div><CompareQualityDesk entries={entries} metrics={metrics} settings={settings} inspect={inspectEvidence} /></section>}
          {settings.view === "table" && <>
            {settings.tableMode !== "reported" && <button className={styles.backButton} onClick={() => update({ tableMode: "reported" })}><ArrowLeft size={14} />Back to comparison</button>}
            {settings.tableMode === "reported" && <CompareOverview entries={entries} metrics={metrics} settings={settings} inspect={inspectEvidence} update={update} />}
            {settings.tableMode === "common-size" && <CompareCommonSize entries={entries} metrics={optionsWithSelected} settings={settings} update={update} inspect={inspectEvidence} />}
            {settings.tableMode === "formula" && <CompareFormula entries={entries} settings={settings} update={update} inspect={inspectEvidence} />}
            {settings.tableMode === "changes" && <CompareMovements companies={companies} entries={entries} metrics={optionsWithSelected} settings={settings} update={update} inspect={inspectEvidence} />}
          </>}
          {settings.view === "trends" && <CompareTrends entries={entries} metrics={optionsWithSelected} settings={settings} update={update} inspect={inspectEvidence} />}
          {settings.view === "map" && <CompareMap entries={entries} metrics={optionsWithSelected} settings={settings} update={update} inspect={inspectEvidence} />}
          {marketCompanies.length > 1 && <div className={styles.marketSection}>
            {marketOpen ? <CompareMarketContext companies={marketCompanies} asOf={asOf} basis={basis} initiallyOpen /> : <button className={styles.marketTrigger} onClick={() => setMarketOpen(true)}><span><strong>Shared market drivers</strong><small>Connect company disclosures with CFTC positioning</small></span><Plus size={18} /></button>}
          </div>}
        </div>
        {evidence && <CompareInspector evidence={evidence} close={() => { setEvidence(null); setPointer(null); }} tickers={tickers} />}
      </div>}
      <CompareGuide tickers={tickers} />
    </div>
  );
}
