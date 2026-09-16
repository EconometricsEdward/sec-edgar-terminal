"use client";

import { useState, useEffect, useRef, useContext, useCallback, useId, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Search, X, FileSearch, Building2, Wallet, ArrowRight, Clock, RefreshCw, ChartNoAxesCombined, GitCompareArrows, Compass, Shield, CornerDownLeft } from "lucide-react";
import { TickerContext } from "../contexts/TickerContext";
import { loadRecentSearches, pushRecentSearch, clearRecentSearches } from "../utils/searchRouter.js";
import { buildGlobalSearch, describeSearchPath, prepareGlobalSearchIndex } from "../utils/globalSearchEngine.js";
import { rankGlobalFilerMatches } from "../utils/globalFilerMatches.js";
import { safeInternalPath } from "../utils/siteRoutes.js";
import { isCftcPositioningPath } from "../utils/marketResearch.js";
import { useSecFilerSearch } from "../utils/useSecFilerSearch.js";
import styles from "./site/GlobalSearch.module.css";

const EXAMPLES = [
  { query: "Apple revenue", description: "Go straight to financial statements", type: "analysis" },
  { query: "Microsoft cybersecurity risks", description: "Find disclosure evidence", type: "disclosures" },
  { query: "Compare Apple and Microsoft", description: "Research companies side by side", type: "compare" },
  { query: "D1 Capital", description: "Find a manager and its reported holdings", type: "manager" },
];
const ICONS = { recent: Clock, company: Building2, analysis: ChartNoAxesCombined, financials: ChartNoAxesCombined, fund: Wallet, manager: Wallet, filer: Building2, filings: FileSearch, disclosures: FileSearch, topic: FileSearch, risk: Shield, compare: GitCompareArrows, market: ChartNoAxesCombined, positioning: ChartNoAxesCombined, tool: Compass };
const requiresCftc = path => isCftcPositioningPath(path)
  || /^\/(?:risk|analysis(?:\/[^?]+)?)\?/.test(path) && ["cftc", "exposures", "fcm"].includes(new URLSearchParams(path.split("?")[1]).get("view"));

export default function GlobalSearchBar({ cftcEnabled = true }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const { tickerMap, directoryStatus = "idle", refreshTickerMap } = useContext(TickerContext) || {};
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  // Keep a late SEC response from changing the selected destination.
  const [highlightId, setHighlightId] = useState(null);
  const [pendingQuery, setPendingQuery] = useState(null);
  const [notice, setNotice] = useState("");
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const suppressFocus = useRef(false);
  const prefetched = useRef(new Set());
  const id = useId();
  const listId = `${id}-results`;
  const hintId = `${id}-hint`;
  const query = input.trim();
  const plan = useMemo(() => buildGlobalSearch(input, tickerMap, { cftcEnabled }), [input, tickerMap, cftcEnabled]);
  const planNotice = /^(?:Searching|Checking)\b/.test(plan.message || "") ? "" : plan.message;
  const filers = useSecFilerSearch(plan.lookupQuery, open && !!plan.lookupQuery && !plan.needsDirectory);
  const filerMatches = useMemo(() => rankGlobalFilerMatches(plan.lookupQuery, filers.results, { truncated: filers.truncated, warning: filers.warning }), [plan.lookupQuery, filers.results, filers.truncated, filers.warning]);
  const visibleRecent = useCallback(() => loadRecentSearches().filter(item => cftcEnabled || !requiresCftc(item.path)), [cftcEnabled]);
  const items = useMemo(() => {
    if (!query) return [
      ...recent.slice(0, 4).map(item => ({ ...item, id: `recent:${item.path}`, label: item.query, description: describeSearchPath(item.path), type: "recent", group: "Recent searches" })),
      ...EXAMPLES.map(item => ({ ...item, id: `example:${item.query}`, label: item.query, group: "Try a search", example: true })),
      { id: "tool:workspace", label: "Portfolio", description: "Upload a portfolio or explore the demo", path: "/workspace", type: "tool", group: "Explore" },
      { id: "tool:screener", label: "Stock screener", description: "Find companies by SEC fundamentals", path: "/market?tab=fundamentals", type: "tool", group: "Explore" },
    ];
    const local = plan.items || [];
    const primary = local.filter(item => item.group !== "Search disclosures");
    const fallback = local.filter(item => item.group === "Search disclosures");
    const paths = new Set(primary.map(item => item.path));
    return [...primary, ...filerMatches.items.filter(item => !paths.has(item.path)), ...fallback];
  }, [query, recent, plan.items, filerMatches.items]);
  const highlight = items.findIndex(item => item.id === highlightId);
  const groups = useMemo(() => {
    const grouped = new Map();
    items.forEach((item, index) => {
      const group = item.group || "Suggestions";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push({ item, index });
    });
    return [...grouped.entries()];
  }, [items]);

  const ensureDirectory = useCallback(() => {
    if (directoryStatus === "idle") void refreshTickerMap?.();
  }, [directoryStatus, refreshTickerMap]);
  const close = useCallback(() => {
    setOpen(false);
    setPendingQuery(null);
    setHighlightId(null);
    setNotice("");
  }, []);
  const closeAndFocus = () => {
    close();
    if (document.activeElement !== inputRef.current) {
      suppressFocus.current = true;
      inputRef.current?.focus();
    }
  };
  const navigate = useCallback((path, originalQuery) => {
    const target = safeInternalPath(path);
    if (!target || !cftcEnabled && requiresCftc(target)) {
      setNotice("This destination is unavailable. Choose another result.");
      return;
    }
    pushRecentSearch({ query: originalQuery, path: target });
    setRecent(visibleRecent());
    close();
    setInput("");
    router.push(target);
  }, [router, cftcEnabled, visibleRecent, close]);

  useEffect(() => { setRecent(visibleRecent()); }, [visibleRecent]);
  useEffect(() => {
    if (!tickerMap) return;
    // Prepare the shared index during idle time if the user hasn't typed yet.
    if (typeof window.requestIdleCallback === "function") {
      const task = window.requestIdleCallback(() => prepareGlobalSearchIndex(tickerMap), { timeout: 1000 });
      return () => window.cancelIdleCallback(task);
    }
    const task = setTimeout(() => prepareGlobalSearchIndex(tickerMap), 0);
    return () => clearTimeout(task);
  }, [tickerMap]);
  useEffect(() => { setInput(""); close(); }, [pathname, close]);
  useEffect(() => {
    const keyboard = event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        ensureDirectory();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [ensureDirectory]);
  useEffect(() => {
    const outside = event => { if (!containerRef.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close]);

  // Enter continues after lookup; editing, leaving the search, and Escape cancel it.
  useEffect(() => {
    if (!open || !pendingQuery || pendingQuery !== input) return;
    if (plan.needsDirectory && (directoryStatus === "idle" || directoryStatus === "loading")) return;
    if (plan.needsDirectory) {
      setPendingQuery(null);
      setNotice("Company lookup is unavailable. Retry it or choose a disclosure search below.");
      return;
    }
    if (plan.directPath) { navigate(plan.directPath, pendingQuery); return; }
    if (plan.lookupQuery && filers.status === "loading") return;
    setPendingQuery(null);
    if (filerMatches.exactPath) { navigate(filerMatches.exactPath, pendingQuery); return; }
    setNotice(planNotice || (filerMatches.items.length
      ? "Choose the matching SEC entity below."
      : plan.lookupQuery && filers.status === "ready"
        ? "No exact filer match. Try a fuller name or CIK, or search disclosures."
        : "Choose a result below to continue."));
  }, [open, pendingQuery, input, plan, planNotice, directoryStatus, filers.status, filerMatches, navigate]);

  const startQuery = value => {
    ensureDirectory(); setInput(value); setHighlightId(null); setNotice("");
    setOpen(true); setPendingQuery(value); inputRef.current?.focus();
  };
  const choose = item => {
    if (item.input) {
      setInput(item.input); setPendingQuery(null); setHighlightId(null); setNotice(""); setOpen(true); inputRef.current?.focus();
    } else if (item.example) startQuery(item.query);
    else navigate(item.path, item.query || query || item.label);
  };
  const submit = () => {
    if (highlight >= 0 && open) { choose(items[highlight]); return; }
    if (!query) { setOpen(true); inputRef.current?.focus(); return; }
    ensureDirectory(); setOpen(true); setNotice(""); setPendingQuery(input);
  };
  const select = item => {
    setPendingQuery(null);
    setHighlightId(item.id);
    // Warm only a destination the user selects, never every search result.
    if (!item.input && item.path && safeInternalPath(item.path) && !prefetched.current.has(item.path) && prefetched.current.size < 30) {
      prefetched.current.add(item.path); router.prefetch(item.path);
    }
  };
  const handleKey = event => {
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); return; }
    if (event.target !== inputRef.current) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); setOpen(true);
      if (items.length) select(items[event.key === "ArrowDown" ? (highlight + 1) % items.length : highlight <= 0 ? items.length - 1 : highlight - 1]);
    } else if (event.key === "Enter") { event.preventDefault(); submit(); }
  };
  useEffect(() => {
    if (open && highlight >= 0) document.getElementById(`${listId}-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, listId]);

  const waiting = !!pendingQuery || filers.status === "loading";
  return (
    <div className={styles.search} ref={containerRef} onKeyDown={handleKey} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
      <div className={styles.field} onPointerEnter={ensureDirectory}>
        <Search size={18} aria-hidden="true" />
        <label className={styles.srOnly} htmlFor={`${id}-input`}>Search EDGAR Terminal</label>
        <input id={`${id}-input`} ref={inputRef} value={input} role="combobox" aria-keyshortcuts="Control+k Meta+k" maxLength={500} aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && highlight >= 0 ? `${listId}-${highlight}` : undefined} aria-describedby={open ? hintId : undefined} aria-haspopup="listbox" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} enterKeyHint="search" placeholder="Search companies, filings, or ask a question…"
          onChange={event => { ensureDirectory(); setInput(event.target.value); setHighlightId(null); setPendingQuery(null); setNotice(""); setOpen(true); }}
          onClick={() => { setOpen(true); setHighlightId(null); setPendingQuery(null); setRecent(visibleRecent()); }}
          onFocus={() => { ensureDirectory(); if (suppressFocus.current) { suppressFocus.current = false; return; } setOpen(true); setRecent(visibleRecent()); }} />
        {!input && <kbd className={styles.shortcut} aria-hidden="true">⌘ / Ctrl K</kbd>}
        {input && <button type="button" className={styles.iconButton} aria-label="Clear global search" onClick={() => { setInput(""); setPendingQuery(null); setHighlightId(null); setNotice(""); setOpen(true); inputRef.current?.focus(); }}><X size={16} /></button>}
        <button type="button" className={styles.go} disabled={!query} onClick={submit} aria-label="Run global search"><ArrowRight size={18} /></button>
      </div>
      {open && <div className={styles.popup}>
        <div className={styles.popupHeader}>
          <div><strong>{query ? "Search results" : "Where would you like to go?"}</strong><span>{query ? "Find the right company, evidence, or research tool" : "Companies, managers, filings, and research questions"}</span></div>
          {!query && recent.length > 0 && <button type="button" className={styles.textButton} onClick={() => { clearRecentSearches(); setRecent([]); }}>Clear recent</button>}
          <button type="button" className={styles.iconButton} aria-label="Close global search" onClick={closeAndFocus}><X size={16} /></button>
        </div>
        {(notice || planNotice) && query && <p className={styles.notice} role="status">{notice || planNotice}</p>}
        <div className={styles.results}>
          <div id={listId} role="listbox" aria-label="Search suggestions" className={styles.list}>
            {groups.map(([group, entries], groupIndex) => <div role="group" aria-labelledby={`${id}-group-${groupIndex}`} key={group}>
              <div id={`${id}-group-${groupIndex}`} className={styles.groupLabel}>{group}</div>
              {entries.map(({ item, index }) => {
                const Icon = ICONS[item.type] || Search;
                const isBest = item.path === plan.directPath && !!query;
                return <button id={`${listId}-${index}`} key={item.id} role="option" aria-selected={highlight === index} tabIndex={-1} type="button" className={`${styles.option} ${highlight === index ? styles.active : ""} ${isBest ? styles.best : ""}`} onPointerDown={event => event.preventDefault()} onClick={() => choose(item)} onMouseMove={() => { if (highlight !== index) select(item); }}>
                  <span className={styles.resultIcon}><Icon size={18} aria-hidden="true" /></span>
                  <span className={styles.resultText}><strong>{item.label}</strong><small>{item.description}</small></span>
                  {isBest ? <span className={styles.bestBadge}>Best match</span> : null}
                  <ArrowRight size={15} className={styles.resultArrow} aria-hidden="true" />
                </button>;
              })}
            </div>)}
          </div>
          {query && (filers.status === "loading" || plan.needsDirectory && directoryStatus !== "error") && <p className={styles.lookup} role="status"><RefreshCw size={14} className={styles.spinner} aria-hidden="true" />{plan.needsDirectory ? "Finding companies and funds…" : pendingQuery ? "Finding the matching SEC filer…" : "Checking SEC managers and other filers…"}</p>}
          {query && plan.needsDirectory && directoryStatus === "error" && <div className={styles.lookup} role="status"><span>Company lookup is temporarily unavailable.</span><button type="button" className={styles.textButton} onClick={() => void refreshTickerMap?.(true)}>Retry company lookup</button></div>}
          {query && (filers.error || filers.warning) && <div className={styles.lookup} role="status"><span>{filers.error ? "SEC filer lookup is temporarily unavailable." : "Some SEC filer results could not be checked. Refine the name or retry."}</span><button type="button" className={styles.textButton} onClick={filers.retry}>Retry filer lookup</button></div>}
          {filers.truncated && <p className={styles.lookup}>More SEC entities match this name. Add detail or use a CIK to narrow the results.</p>}
        </div>
        <div id={hintId} className={styles.hint}><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd><CornerDownLeft size={11} /></kbd> open <kbd>esc</kbd> close</span><span>{waiting ? "Looking up your search…" : "Search across EDGAR Terminal"}</span></div>
        <span className={styles.srOnly} role="status" aria-live="polite">{query && !waiting ? `${items.length} suggestions available. Use arrow keys to choose.` : ""}</span>
      </div>}
    </div>
  );
}
