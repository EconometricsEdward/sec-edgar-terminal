"use client";
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";
import { TickerContext, type TickerEntry } from "../../contexts/TickerContext";
import {
  analysisCompanyPath,
  analysisCikIdentifier,
  analysisBrokerDealerMatches,
  findAnalysisCompanyMatches,
  resolveAnalysisCompany,
} from "../../utils/analysisCompanySearch.js";
import { useSecFilerSearch } from "../../utils/useSecFilerSearch.js";
import styles from "./analysis.module.css";
import searchStyles from "./CompanySearch.module.css";

export default function CompanySearch({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const context = useContext(TickerContext);
  const tickerMap = context?.tickerMap;
  const status = tickerMap ? "ready" : context?.directoryStatus || "error";
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const listId = `${id}-matches`;
  const statusId = `${id}-status`;
  const directoryMatches = useMemo(() => findAnalysisCompanyMatches(query, tickerMap), [query, tickerMap]);
  const exactTicker = directoryMatches.some((company: TickerEntry) => company.ticker === query.trim().toUpperCase());
  const filerSearch = useSecFilerSearch(query, expanded && !exactTicker);
  const brokerMatches = useMemo(() => analysisBrokerDealerMatches(filerSearch.results), [filerSearch.results]);
  const matches = useMemo(() => [...directoryMatches, ...brokerMatches.filter((filer: TickerEntry) =>
    !directoryMatches.some((company: TickerEntry) => company.cik === filer.cik))], [directoryMatches, brokerMatches]);
  const showMatches = expanded && query.trim().length > 0 && matches.length > 0;

  useEffect(() => {
    if (showMatches && activeIndex >= 0) {
      listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }
  }, [showMatches, activeIndex]);

  const open = useCallback((company: TickerEntry) => {
    setPendingQuery(null);
    setExpanded(false);
    setQuery("");
    setError("");
    router.push(analysisCompanyPath(company));
  }, [router]);

  const resolve = useCallback((submittedQuery: string) => {
    const cik = analysisCikIdentifier(submittedQuery);
    if (cik) { setPendingQuery(null); setExpanded(false); setError(""); router.push(`/analysis/${cik}`); return; }
    const result = resolveAnalysisCompany(submittedQuery, tickerMap);
    if (result.company) open(result.company);
    else if (brokerMatches.length === 1 && filerSearch.status === "ready") open(brokerMatches[0]);
    else {
      setPendingQuery(null);
      setExpanded(true);
      setError(result.kind === "ambiguous"
        ? "More than one company matches. Choose a result below or use its ticker."
        : result.kind === "empty"
          ? "Enter a company or broker-dealer name, ticker or CIK."
          : filerSearch.status === "loading" ? "Searching SEC broker-dealer registrants. Choose a result when it appears."
            : brokerMatches.length > 1 ? "More than one broker-dealer matches. Choose the exact SEC registrant below."
              : "No matching company or broker-dealer found. Try its full registered name or exact SEC CIK.");
    }
  }, [tickerMap, open, brokerMatches, filerSearch.status, router]);

  // The provider returns Promise<void>. Resolve against its next rendered map,
  // rather than the stale map captured when the request first started.
  useEffect(() => {
    if (pendingQuery === null || pendingQuery !== query) return;
    if (status === "ready") resolve(pendingQuery);
    else if (status === "error") setPendingQuery(null);
  }, [pendingQuery, query, status, resolve]);

  function loadDirectory() {
    if (context && ["idle", "error"].includes(status)) {
      void context.refreshTickerMap(status === "error");
    }
  }

  const statusMessage = error || (pendingQuery !== null
    ? "Finding your company…"
    : status === "loading" ? "Loading SEC company search…"
      : status === "error" ? "Company search is temporarily unavailable. Please try again."
        : expanded && query.trim() && !matches.length
          ? filerSearch.status === "loading" ? "Searching SEC broker-dealer names…" : filerSearch.error || "No matches yet. Try a name, ticker or SEC CIK."
          : showMatches ? `${matches.length} suggestions. Use the up and down arrows to choose.` : "");

  return (
    <div
      className={`${styles.searchBox} ${searchStyles.root}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
          setActiveIndex(-1);
          setPendingQuery(null);
        }
      }}
    >
      <form onSubmit={(event) => {
        event.preventDefault();
        if (showMatches && activeIndex >= 0 && matches[activeIndex]) {
          open(matches[activeIndex]);
        } else if (!query.trim() || status === "ready" || analysisCikIdentifier(query) || brokerMatches.length > 0) {
          resolve(query);
        } else {
          setError("");
          setExpanded(true);
          if (context) {
            setPendingQuery(query);
            loadDirectory();
          }
        }
      }}>
        <label htmlFor={id}>
          {compact ? "Switch company" : "Find a company to analyze"}
        </label>
        <div className={styles.searchField}>
          <Search size={19} aria-hidden="true" />
          <input
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showMatches}
            aria-controls={showMatches ? listId : undefined}
            aria-activedescendant={showMatches && activeIndex >= 0 && activeIndex < matches.length ? `${id}-option-${activeIndex}` : undefined}
            aria-describedby={statusId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onFocus={() => { setExpanded(true); loadDirectory(); }}
            onChange={(event) => {
              setQuery(event.target.value);
              setError("");
              setPendingQuery(null);
              setActiveIndex(-1);
              setExpanded(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setExpanded(false);
                setActiveIndex(-1);
                setPendingQuery(null);
                setError("");
              } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
                event.preventDefault();
                setExpanded(true);
                setActiveIndex((current) => event.key === "ArrowDown"
                  ? (current + 1) % matches.length
                  : (current <= 0 ? matches.length - 1 : current - 1));
              }
            }}
            placeholder="Company, broker-dealer, ticker or CIK"
          />
          <button type="submit" aria-label="Open financial analysis" aria-busy={pendingQuery !== null}>
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </div>
      </form>
      {showMatches && (
        <ul ref={listRef} id={listId} role="listbox" aria-label="Matching companies" className={`${styles.suggestions} ${searchStyles.list}`}>
          {matches.map((company, index) => (
            <li key={company.ticker} role="presentation">
              <button
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                tabIndex={-1}
                className={searchStyles.option}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => open(company)}
              >
                <strong>{company.isBrokerDealer ? `CIK ${company.cik}` : company.ticker}</strong>
                <span>{company.name}</span>
                {company.isFund && <small>Fund</small>}
                {company.isBrokerDealer && <small>X-17A-5</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p id={statusId} role="status" aria-live="polite" className={showMatches && !error ? searchStyles.srOnly : searchStyles.status}>
        {statusMessage}
      </p>
      {expanded && filerSearch.warning && <p className={searchStyles.status}>{filerSearch.warning}</p>}
      {expanded && filerSearch.status === "error" && <button type="button" className={searchStyles.retry} onClick={filerSearch.retry}>Retry broker-dealer search</button>}
      {status === "error" && context && (
        <button type="button" className={searchStyles.retry} onClick={() => {
          setError("");
          setPendingQuery(null);
          void context.refreshTickerMap(true);
        }}>Retry company search</button>
      )}
    </div>
  );
}
