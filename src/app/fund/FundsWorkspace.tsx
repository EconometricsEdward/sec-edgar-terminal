"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Bookmark,
  Layers3,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { FUND_CATALOG } from "../../utils/fundResearch";
import { money, pct, useFundShelf } from "./fundUi";
import FundComparison from "./FundComparison";
import type { Fund } from "./fundTypes";
import s from "./fund.module.css";
export default function FundsWorkspace() {
  const router = useRouter(),
    params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [category, setCategory] = useState(
    params.get("category") || "All funds",
  );
  const [selected, setSelected] = useState<string[]>(() =>
    [
      ...new Set(
        (params.get("compare") || "")
          .split(",")
          .filter((t) => /^[A-Z0-9.-]{1,15}$/.test(t)),
      ),
    ].slice(0, 3),
  );
  const [compareOpen, setCompareOpen] = useState(
    Boolean(params.get("compare")),
  );
  const [loaded, setLoaded] = useState<Record<string, Fund>>({});
  const [loading, setLoading] = useState(""),
    [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const shelf = useFundShelf();
  useEffect(() => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    if (category !== "All funds") p.set("category", category);
    if (selected.length) p.set("compare", selected.join(","));
    window.history.replaceState(null, "", `/fund${p.size ? `?${p}` : ""}`);
  }, [query, category, selected]);
  const funds = useMemo(
    () =>
      FUND_CATALOG.filter(
        (f) =>
          (category === "All funds" ||
            (category === "Saved funds" && shelf.saved.includes(f.ticker)) ||
            category === f.category) &&
          `${f.ticker} ${f.name} ${f.family} ${f.focus}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [category, query, shelf.saved],
  );
  const toggleCompare = (ticker: string) => {
    if (selected.includes(ticker))
      setSelected(selected.filter((t) => t !== ticker));
    else if (selected.length < 3) setSelected([...selected, ticker]);
    else setMessage("Compare up to three funds. Remove one to add another.");
  };
  async function loadSnapshots() {
    setError("");
    for (const f of funds) {
      if (loaded[f.ticker]) continue;
      setLoading(f.ticker);
      try {
        const response = await fetch(`/api/fund?v=2&ticker=${f.ticker}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setLoaded((current) => ({ ...current, [f.ticker]: data }));
      } catch (err) {
        setError(
          `${f.ticker}: ${err instanceof Error ? err.message : "Unable to load snapshot"}`,
        );
        break;
      }
    }
    setLoading("");
  }
  return (
    <div className={s.page}>
      <header className={s.hero}>
        <div>
          <p className={s.eyebrow}>
            <Layers3 size={15} /> Fund research workspace
          </p>
          <h1>
            Know what’s
            <br />
            <em>inside the fund.</em>
          </h1>
          <p className={s.lead}>
            Follow the holdings. Understand concentration. Compare the
            portfolios behind the tickers, with every number grounded in an SEC
            filing.
          </p>
          <div className={s.trust}>
            <ShieldCheck size={15} /> SEC series verification <span>·</span>{" "}
            Complete reported positions <span>·</span> No account needed
          </div>
        </div>
        <aside className={s.heroNote}>
          <span className={s.eyebrow}>Your research, in three steps</span>
          <ol>
            <li>
              <b>Discover</b>
              <span>Find a strategy or enter a fund ticker.</span>
            </li>
            <li>
              <b>Look inside</b>
              <span>Inspect all positions and their sources.</span>
            </li>
            <li>
              <b>Compare</b>
              <span>See where two portfolios overlap.</span>
            </li>
          </ol>
          <p>
            Public disclosures are historical snapshots. Check the portfolio
            date before comparing.
          </p>
        </aside>
      </header>
      <form
        className={s.searchBar}
        onSubmit={(e) => {
          e.preventDefault();
          const ticker = query.trim().toUpperCase();
          if (/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker))
            router.push(`/fund/${ticker}`);
          else
            setMessage(
              "Enter a fund ticker to open a profile, or use the matching cards below.",
            );
        }}
      >
        <Search size={20} />
        <label className={s.srOnly} htmlFor="fund-search">
          Find a fund by ticker, name, or strategy
        </label>
        <input
          id="fund-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a fund by ticker, name, or strategy…"
          maxLength={100}
        />
        <button className={s.primary} type="submit">
          Open ticker <ArrowRight size={16} />
        </button>
      </form>
      <div className={s.filters} role="group" aria-label="Fund categories">
        {[
          "All funds",
          "US equity",
          "International",
          "Fixed income",
          "Saved funds",
        ].map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            className={category === c ? s.active : ""}
            onClick={() => setCategory(c)}
          >
            {c}
            {c === "Saved funds" ? ` (${shelf.saved.length})` : ""}
          </button>
        ))}
      </div>
      {shelf.saved.length > 0 && (
        <section className={s.shelf} aria-label="Saved fund shelf">
          <Bookmark size={16} />
          <b>Research shelf</b>
          {shelf.saved.map((t) => (
            <span key={t}>
              <Link href={`/fund/${t}`}>{t}</Link>
              <button
                aria-label={`Remove saved ${t}`}
                onClick={() => shelf.toggle(t)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <small>Saved in this browser</small>
        </section>
      )}
      <div className={s.sectionHeading}>
        <div>
          <p className={s.eyebrow}>Explore the portfolio universe</p>
          <h2>
            {category === "All funds" ? "Start with a strategy" : category}
          </h2>
          <p>
            {funds.length} curated funds match. Open any other fund by its
            ticker.
          </p>
        </div>
        <button
          className={s.secondary}
          onClick={loadSnapshots}
          disabled={Boolean(loading) || !funds.length}
        >
          {loading ? `Reading ${loading}…` : "Load SEC snapshots"}
        </button>
      </div>
      <p role="status" className={s.status}>
        {message ||
          shelf.storageError ||
          (loading
            ? "Reading portfolio reports sequentially. Each card shows its own reporting date."
            : "")}
      </p>
      {error && (
        <p role="alert" className={s.notice}>
          {error} You can retry loading snapshots.
        </p>
      )}
      <div className={s.cardGrid}>
        {funds.map((f) => {
          const snapshot = loaded[f.ticker];
          return (
            <article className={s.fundCard} key={f.ticker}>
              <div className={s.cardTop}>
                <span className={s.category}>{f.category}</span>
                <button
                  aria-label={`${shelf.saved.includes(f.ticker) ? "Unsave" : "Save"} ${f.ticker}`}
                  aria-pressed={shelf.saved.includes(f.ticker)}
                  onClick={() => shelf.toggle(f.ticker)}
                  disabled={!shelf.ready}
                >
                  <Bookmark
                    size={17}
                    fill={
                      shelf.saved.includes(f.ticker) ? "currentColor" : "none"
                    }
                  />
                </button>
              </div>
              <Link href={`/fund/${f.ticker}`} className={s.cardLink}>
                <h3>
                  {f.ticker}
                  <ArrowRight size={21} />
                </h3>
                <p>{f.name}</p>
              </Link>
              <span className={s.muted}>
                {f.family} · {f.focus}
              </span>
              {snapshot?.status === "ready" ? (
                <div className={s.cardStats}>
                  <span>
                    Portfolio net assets
                    <b>{money(snapshot.fundInfo.netAssets)}</b>
                  </span>
                  <span>
                    Top 10 positions<b>{pct(snapshot.summary.top10Weight)}</b>
                  </span>
                  <small>
                    As of {snapshot.asOf} ·{" "}
                    {snapshot.summary.count.toLocaleString()} positions
                    <br />
                    Series-level totals, including other share classes where
                    applicable.
                  </small>
                </div>
              ) : (
                <p className={s.cardHint}>
                  {snapshot
                    ? snapshot.reason
                    : "Open for verified holdings, concentration, and source filings."}
                </p>
              )}
              <button
                className={s.compareToggle}
                aria-pressed={selected.includes(f.ticker)}
                onClick={() => toggleCompare(f.ticker)}
              >
                {selected.includes(f.ticker)
                  ? "✓ Added to comparison"
                  : "+ Add to comparison"}
              </button>
            </article>
          );
        })}
      </div>
      {!funds.length && (
        <div className={s.empty}>
          <h3>No curated funds match this view.</h3>
          <p>
            Use “Open ticker” to research another fund, or reset the filters.
          </p>
          <button
            className={s.secondary}
            onClick={() => {
              setQuery("");
              setCategory("All funds");
            }}
          >
            Reset filters
          </button>
        </div>
      )}
      <section className={s.compareTray} aria-label="Fund comparison selection">
        <div>
          <span className={s.eyebrow}>Compare portfolios</span>
          <p>
            {selected.length
              ? selected.join("  /  ")
              : "Choose two or three funds above."}
          </p>
        </div>
        <div className={s.actions}>
          {selected.map((t) => (
            <button
              className={s.secondary}
              key={t}
              onClick={() => toggleCompare(t)}
              aria-label={`Remove ${t} from comparison`}
            >
              {t} <X size={13} />
            </button>
          ))}
          <button
            className={s.primary}
            disabled={selected.length < 2}
            onClick={() => setCompareOpen(true)}
          >
            Compare {selected.length || ""} funds <ArrowRight size={15} />
          </button>
          <button
            className={s.secondary}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setMessage("Fund view link copied.");
              } catch {
                setMessage(
                  "Could not copy. Use the address bar to share this view.",
                );
              }
            }}
          >
            Share view
          </button>
        </div>
      </section>
      {compareOpen && selected.length >= 2 && (
        <FundComparison key={selected.join(",")} tickers={selected} />
      )}
      <details className={s.method}>
        <summary>How to read this workspace</summary>
        <p>
          Snapshots come from public N-PORT filings. The portfolio date and
          filing date are different: holdings can be months old. Not every fund
          structure reports on N-PORT. Net assets belong to the reported
          portfolio or series and may combine multiple share classes. Curated
          strategy labels are navigation aids.
        </p>
        <a
          href="https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets"
          target="_blank"
          rel="noreferrer"
        >
          SEC N-PORT scope and documentation ↗
        </a>
      </details>
    </div>
  );
}
