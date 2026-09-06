"use client";
import { useContext, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";
import { TickerContext } from "../../contexts/TickerContext";
import { validTicker } from "../../utils/researchWorkspace.js";
import styles from "./filings.module.css";
export default function CompanySearch({
  compact = false,
}: {
  compact?: boolean;
}) {
  const router = useRouter();
  const context = useContext(TickerContext);
  const tickerMap = context?.tickerMap;
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const id = useId();
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q || !tickerMap) return [];
    return Object.values(tickerMap)
      .filter((c) => c.ticker.startsWith(q) || c.name.toUpperCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.ticker === q) - Number(a.ticker === q) ||
          a.ticker.localeCompare(b.ticker),
      )
      .slice(0, 6);
  }, [query, tickerMap]);
  function open(ticker: string, isFund = false) {
    setQuery("");
    setError("");
    router.push(
      `/${isFund ? "fund" : "filings"}/${encodeURIComponent(ticker)}`,
    );
  }
  return (
    <div className={styles.searchBox}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ticker = query.trim().toUpperCase();
          const exact = context?.tickerMap?.[ticker];
          if (exact) open(exact.ticker, exact.isFund);
          else if (validTicker(ticker)) open(ticker);
          else if (matches.length === 1)
            open(matches[0].ticker, matches[0].isFund);
          else setError("Select a matching company or enter its ticker.");
        }}
      >
        <label htmlFor={id}>
          {compact ? "Switch company" : "Find company filings"}
        </label>
        <div className={styles.searchField}>
          <Search size={19} aria-hidden="true" />
          <input
            id={id}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setError("");
            }}
            placeholder="Ticker or company name"
          />
          <button type="submit" aria-label="Open company filings">
            <ArrowRight size={20} />
          </button>
        </div>
      </form>
      {query && matches.length > 0 && (
        <ul className={styles.suggestions}>
          {matches.map((m) => (
            <li key={m.ticker}>
              <button type="button" onClick={() => open(m.ticker, m.isFund)}>
                <strong>{m.ticker}</strong>
                <span>{m.name}</span>
                {m.isFund && <small>Fund</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
