"use client";
import { useContext, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";
import { TickerContext } from "../../contexts/TickerContext";
import { filerCik, exactFilerMatch, mergeFilerSuggestions, hasBrokerDealerAnnualReports } from "../../utils/secFilerSearch.js";
import { useSecFilerSearch } from "../../utils/useSecFilerSearch.js";
import { filingPath, normalizeFilingsSettings } from "../../utils/filingsResearch.js";
import styles from "./filings.module.css";
export default function CompanySearch({
  compact = false,
  form,
}: {
  compact?: boolean;
  form?: string;
}) {
  const router = useRouter();
  const selectedForm = normalizeFilingsSettings({ form }).form;
  const context = useContext(TickerContext);
  const tickerMap = context?.tickerMap;
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  const exactTicker = tickerMap?.[query.trim().toUpperCase()];
  const filers = useSecFilerSearch(query, !exactTicker && !filerCik(query));
  const directoryMatches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q || !tickerMap) return [];
    return Object.values(tickerMap)
      .filter((c) => c.ticker.startsWith(q) || c.name.toUpperCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.ticker === q) - Number(a.ticker === q) ||
          a.ticker.localeCompare(b.ticker),
      )
      .slice(0, 6).map(c => ({ ...c, type: c.isFund ? "fund" : "company" }));
  }, [query, tickerMap]);
  const matches = useMemo(() => mergeFilerSuggestions(directoryMatches, filers.results), [directoryMatches, filers.results]);
  function open(ticker: string, isFund = false, brokerDealer = false) {
    setQuery("");
    setError("");
    router.push(
      isFund ? `/fund/${encodeURIComponent(ticker)}` : filingPath(ticker, { form: selectedForm !== "all" ? selectedForm : brokerDealer ? "X-17A-5" : "all" }),
    );
  }
  return (
    <div className={styles.searchBox}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ticker = query.trim().toUpperCase();
          const exact = context?.tickerMap?.[ticker];
          const cik = filerCik(query);
          const filer = exactFilerMatch(query, filers.results, filers);
          const exactNames = Object.values(tickerMap || {}).filter(c => c.name.trim().toUpperCase() === ticker);
          if (exact) open(exact.ticker, exact.isFund);
          else if (exactNames.length === 1) open(exactNames[0].ticker, exactNames[0].isFund);
          else if (cik) open(cik);
          else if (/^\d+$/.test(ticker)) setError("Enter a positive SEC CIK with at most 10 digits.");
          else if (filer) open(filer.cik, false, hasBrokerDealerAnnualReports(filer));
          else if (filers.status === "loading") setError("");
          else setError("Select a matching SEC filer, or enter an exact ticker or CIK.");
        }}
      >
        <label htmlFor={id}>
          {compact ? "Switch company or filer" : "Find SEC filings"}
        </label>
        <div className={styles.searchField}>
          <Search size={19} aria-hidden="true" />
          <input
            id={id}
            autoComplete="off"
            maxLength={160}
            value={query}
            onFocus={() => {
              if (["idle", "error"].includes(context?.directoryStatus || ""))
                void context?.refreshTickerMap(context.directoryStatus === "error");
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setError("");
            }}
            placeholder="Company, manager or broker-dealer name, ticker or CIK"
          />
          <button type="submit" aria-label="Open SEC filings">
            <ArrowRight size={20} />
          </button>
        </div>
      </form>
      {query && matches.length > 0 && (
        <ul className={styles.suggestions}>
          {matches.map((m) => (
            <li key={`${m.type}:${m.ticker}`}>
              <button type="button" onClick={() => open(m.ticker, m.isFund, !!m.brokerDealerAnnual)}>
                <strong>{m.type === "filer" ? m.name : m.ticker}</strong>
                <span>{m.type === "filer" ? `CIK ${m.cik}${m.brokerDealerAnnual ? " · X-17A-5 annual reports" : m.formTypes.some((form: string) => /^13F/.test(form)) ? " · 13F reports" : ""}` : m.name}</span>
                <small>{m.brokerDealerAnnual ? "Broker-dealer" : m.type === "filer" ? "SEC filer" : m.isFund ? "Fund" : "Company"}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {filers.status === "loading" && <p role="status">Searching SEC filer names…</p>}
      {(filers.error || filers.warning) && <p role="status">{filers.error || filers.warning} <button type="button" onClick={filers.retry}>Retry filer search</button></p>}
      {filers.truncated && <p>SEC name results are limited. Refine the legal name or enter a CIK.</p>}
      {query.trim().length >= 2 && filers.status === "ready" && !matches.length && <p role="status">No matching filer in these results. Try another part of the legal name or its CIK.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
