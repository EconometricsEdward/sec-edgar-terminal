"use client";

import {
  useState,
  useEffect,
  useRef,
  useContext,
  useCallback,
  useId,
  useMemo,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Search,
  X,
  AlertCircle,
  FileSearch,
  Building2,
  Wallet,
  ArrowRight,
  Clock,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";
import { TickerContext } from "../contexts/TickerContext";
import {
  routeSearch,
  getSuggestions,
  parseActiveSegment,
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  disclosureTopicTerm,
  disclosureSearchPath,
} from "../utils/searchRouter.js";
import { safeInternalPath } from "../utils/siteRoutes.js";
import { isCftcPositioningPath } from "../utils/marketResearch.js";
import { MAX_COMPARE_COMPANIES } from "../utils/compareLimits.js";
import { tickerDirectoryCoverage } from "../utils/tickerMapLoader.js";
import { useSecFilerSearch } from "../utils/useSecFilerSearch.js";
import { filerCik, isTickerComparison, mergeFilerSuggestions, exactFilerMatch, hasThirteenFHoldings, secFilerResearchPath } from "../utils/secFilerSearch.js";
import { DISCLOSURE_TOPIC_SHORTCUTS } from "../utils/searchRouter.js";
import styles from "./site/GlobalSearch.module.css";

export default function GlobalSearchBar({ cftcEnabled = true }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const context = useContext(TickerContext);
  const {
    tickerMap,
    directoryStatus = "idle",
    directoryError = "",
    refreshTickerMap,
  } = context || {};
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState("");
  const [destination, setDestination] = useState(null);
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);
  const suppressFocus = useRef(false);
  const containerRef = useRef(null);
  const id = useId();
  const listId = `${id}-results`;
  const hintId = `${id}-hint`;
  const isCompare = isTickerComparison(input, tickerMap);
  const directoryCoverage = tickerDirectoryCoverage(tickerMap);
  const { suggestions: directorySuggestions, completed } = useMemo(
    () => getSuggestions(input, tickerMap, 7),
    [input, tickerMap],
  );
  const exactTicker = tickerMap?.[input.trim().toUpperCase()];
  const explicitTopic = /^(?:topic|disclosures?):\s*/i.test(input.trim()) || DISCLOSURE_TOPIC_SHORTCUTS.has(input.trim().toUpperCase());
  const filers = useSecFilerSearch(input, open && !destination && !isCompare && !exactTicker && !explicitTopic && !filerCik(input));
  const suggestions = useMemo(() => mergeFilerSuggestions(directorySuggestions, filers.results), [directorySuggestions, filers.results]);
  const suggestionIdentities = suggestions.map(item => `${item.type}:${item.cik || item.ticker}`).join("|");
  const items = destination
    ? destination.options
    : input.trim()
      ? suggestions
      : recent;
  const visibleRecentSearches = useCallback(
    () => loadRecentSearches().filter((item) => cftcEnabled || !isCftcPositioningPath(item.path)),
    [cftcEnabled],
  );

  const ensureDirectory = useCallback(() => {
    if (directoryStatus === "idle" || directoryStatus === "error")
      void refreshTickerMap?.(directoryStatus === "error");
  }, [directoryStatus, refreshTickerMap]);

  const close = useCallback(() => {
    setOpen(false);
    setDestination(null);
    setHighlight(-1);
    setError("");
  }, []);
  const closeAndFocus = () => {
    close();
    if (document.activeElement !== inputRef.current) {
      suppressFocus.current = true;
      inputRef.current?.focus();
    }
  };
  useEffect(() => {
    setRecent(visibleRecentSearches());
  }, [visibleRecentSearches]);
  useEffect(() => {
    setInput("");
    close();
  }, [pathname, close]);
  useEffect(() => {
    const keyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  useEffect(() => {
    const outside = (event) => {
      if (!containerRef.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [close]);
  useEffect(() => {
    setHighlight(-1);
  }, [input, destination, suggestionIdentities]);

  const navigate = (path, query = input) => {
    const target = safeInternalPath(path);
    if (!target) {
      setError("This saved search has an invalid destination.");
      return;
    }
    pushRecentSearch({ query, path: target });
    setRecent(visibleRecentSearches());
    close();
    setInput("");
    router.push(target);
  };
  const decide = (query) => {
    const decision = routeSearch(query, tickerMap);
    if (decision.path) navigate(decision.path, query);
    else if (decision.disambiguate) {
      setDestination(decision.disambiguate);
      setHighlight(-1);
      setError("");
      setOpen(true);
      inputRef.current?.focus();
    } else {
      setError(decision.error);
      setOpen(true);
    }
  };
  const choose = (item) => {
    if (destination) {
      navigate(item.path, destination.ticker);
      return;
    }
    if (!input.trim()) {
      navigate(item.path, item.query);
      return;
    }
    if (isCompare) {
      if (item.isFund || item.type === "topic" || item.type === "filer") {
        setError("Choose a public company for company comparison.");
        return;
      }
      const next = [
        ...new Set([...parseActiveSegment(input).completed, item.ticker]),
      ];
      if (next.length > MAX_COMPARE_COMPANIES) {
        setError(`Compare supports up to ${MAX_COMPARE_COMPANIES} companies.`);
        return;
      }
      setInput(`${next.join(", ")}, `);
      inputRef.current?.focus();
      return;
    }
    if (item.type === "filer") navigate(item.path, item.name);
    else if (item.type === "topic")
      navigate(disclosureSearchPath(disclosureTopicTerm(item.ticker)), input);
    else decide(item.ticker);
  };
  const submit = () => {
    if (destination) {
      if (items[highlight]) choose(items[highlight]);
      return;
    }
    if (!input.trim() && highlight >= 0 && recent[highlight]) {
      choose(recent[highlight]);
      return;
    }
    // A complete ticker list submits immediately; a partial company name still autocompletes.
    const decision = routeSearch(input, tickerMap);
    if (isCompare && decision.path) {
      navigate(decision.path);
      return;
    }
    if (highlight >= 0 && items[highlight]) {
      choose(items[highlight]);
      return;
    }
    if (decision.disambiguate) {
      decide(input);
      return;
    }
    if (!isCompare && !exactTicker && !explicitTopic && !filerCik(input) && !/^\d+$/.test(input.trim())) {
      setOpen(true);
      const exact = exactFilerMatch(input, filers.results, filers);
      if (exact) navigate(secFilerResearchPath(exact), exact.name);
      else if (filers.status === "loading") setError("");
      else if (filers.status === "error") setError("SEC filer-name search is unavailable. Retry it or enter a CIK.");
      else setError(suggestions.some(item => item.type !== "topic")
        ? "Select the company or SEC filer you want to research."
        : "No matching filer is available in these results. Refine the name, enter a CIK, or choose disclosure search.");
      return;
    }
    decide(input);
  };
  const handleKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndFocus();
      return;
    }
    if (event.target !== inputRef.current) return; // Native Tab and button keyboard activation stay intact.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (items.length)
        setHighlight((value) =>
          event.key === "ArrowDown"
            ? (value + 1) % items.length
            : value <= 0
              ? items.length - 1
              : value - 1,
        );
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  useEffect(() => {
    if (open && highlight >= 0)
      document
        .getElementById(`${listId}-${highlight}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, listId]);

  const heading = destination
    ? `${destination.ticker} · Choose a research tool`
    : !input.trim()
      ? "Recent research"
      : isCompare
        ? `Company comparison · ${completed.length}/${MAX_COMPARE_COMPANIES} selected`
        : "Companies, SEC filers and disclosure topics";
  return (
    <div
      className={styles.search}
      ref={containerRef}
      onKeyDown={handleKey}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <div className={styles.field}>
        <Search size={17} aria-hidden="true" />
        <label className={styles.srOnly} htmlFor={`${id}-input`}>
          Search companies, SEC filers, funds, or disclosure topics
        </label>
        <input
          id={`${id}-input`}
          ref={inputRef}
          value={input}
          role="combobox"
          aria-keyshortcuts="Control+k Meta+k"
          maxLength={500}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && highlight >= 0 && items[highlight]
              ? `${listId}-${highlight}`
              : undefined
          }
          aria-describedby={open ? hintId : undefined}
          aria-haspopup="listbox"
          autoComplete="off"
          spellCheck={false}
          placeholder="Company, manager, ticker, CIK or topic"
          onChange={(event) => {
            ensureDirectory();
            setInput(event.target.value);
            setDestination(null);
            setError("");
            setOpen(true);
          }}
          onFocus={() => {
            ensureDirectory();
            if (suppressFocus.current) {
              suppressFocus.current = false;
              return;
            }
            setOpen(true);
            setRecent(visibleRecentSearches());
          }}
        />
        {!input && (
          <kbd className={styles.shortcut} aria-hidden="true">
            Ctrl / ⌘ K
          </kbd>
        )}
        {input && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Clear global search"
            onClick={() => {
              setInput("");
              setDestination(null);
              setError("");
              inputRef.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        )}
        <button
          type="button"
          className={styles.go}
          disabled={!input.trim()}
          onClick={submit}
          aria-label="Run global search"
        >
          <ArrowRight size={17} />
        </button>
      </div>
      {open && (
        <div className={styles.popup}>
          <div className={styles.popupHeader}>
            {destination && (
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Back to search results"
                onClick={() => {
                  setDestination(null);
                  inputRef.current?.focus();
                }}
              >
                <ArrowLeft size={15} />
              </button>
            )}
            <strong>{heading}</strong>
            {!input.trim() && recent.length > 0 && (
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  clearRecentSearches();
                  setRecent([]);
                }}
              >
                Clear recent
              </button>
            )}
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Close global search"
              onClick={closeAndFocus}
            >
              <X size={15} />
            </button>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              {error}
            </p>
          )}
          {directoryStatus !== "ready" && directoryStatus !== "idle" && (
            <div className={styles.directory} role="status">
              <span>
                {directoryStatus === "loading"
                  ? "Loading the SEC company and fund directory…"
                  : `Company directory unavailable. ${directoryError}`}
              </span>
              {directoryStatus === "error" && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void refreshTickerMap?.(true)}
                >
                  <RefreshCw size={13} />
                  Retry directory
                </button>
              )}
            </div>
          )}
          {filers.status === "loading" && <p className={styles.directory} role="status">Searching SEC filer names…</p>}
          {(filers.error || filers.warning) && (
            <div className={styles.directory} role="status">
              <span>{filers.error || filers.warning}</span>
              <button type="button" className={styles.textButton} onClick={filers.retry}>Retry filer search</button>
            </div>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label={heading}
            className={styles.list}
          >
            {items.map((item, index) => {
              const Icon = destination
                ? ArrowRight
                : !input.trim()
                  ? Clock
                  : item.type === "fund" || item.type === "filer" && hasThirteenFHoldings(item)
                    ? Wallet
                    : item.type === "topic"
                      ? FileSearch
                      : Building2;
              const label = destination
                ? item.shortLabel
                : !input.trim()
                  ? item.query
                  : item.type === "filer" ? item.name : item.ticker;
              const description = destination
                ? item.label
                : !input.trim()
                  ? item.path
                  : item.type === "filer" ? `CIK ${item.cik} · ${hasThirteenFHoldings(item) ? "Explore reported holdings in Funds" : "SEC filings"}` : item.name;
              return (
                <button
                  id={`${listId}-${index}`}
                  key={`${item.path || item.ticker}-${index}`}
                  role="option"
                  aria-selected={highlight === index}
                  type="button"
                  className={`${styles.option} ${highlight === index ? styles.active : ""}`}
                  onClick={() => choose(item)}
                  onMouseEnter={() => setHighlight(index)}
                  onFocus={() => setHighlight(index)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                  {!destination && input.trim() && (
                    <em>
                      {item.type === "topic"
                        ? "Topic"
                        : item.type === "filer"
                          ? hasThirteenFHoldings(item) ? "13F holdings" : "SEC filer"
                        : item.type === "fund"
                          ? "Fund"
                          : "Company"}
                    </em>
                  )}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {!items.length && (
            <p className={styles.empty}>
              {input.trim()
                ? "No matching company or filer in these results. Refine the name or enter its CIK."
                : "Start with a company, a fund, or a question. Recent searches stay in this browser."}
            </p>
          )}
          {filers.truncated && <p className={styles.empty}>SEC name results are limited. Refine the legal name or use a CIK.</p>}
          {!destination && input.trim() && !isCompare && (
            <button
              type="button"
              className={styles.topicButton}
              onClick={() =>
                navigate(
                  disclosureSearchPath(disclosureTopicTerm(input)),
                  input,
                )
              }
            >
              <FileSearch size={15} aria-hidden="true" />
              Search disclosures for “{input.trim()}”
            </button>
          )}
          <p id={hintId} className={styles.hint}>
            {destination
              ? "Choose the tool to open for this exact company."
              : "Search a manager by name or CIK to open its filings. Use AAPL, MSFT to compare companies; Topic: liquidity searches disclosure text."}
            <span>↑ ↓ select · Enter open · Esc close · Tab move</span>
            {directoryCoverage?.omittedSymbols > 0 && (
              <span>
                {directoryCoverage.omittedSymbols} SEC fund entries have
                unavailable or unsupported ticker symbols.
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
