"use client";
import { useContext, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, Square, ArrowUpRight, Building2, Sparkles, X, ChevronDown } from "lucide-react";
import { buildAdvancedQuery, parseDisclosureQuery } from "../../utils/disclosureQuery.js";
import { SECTION_OPTIONS } from "../../utils/disclosureResearch.js";
import { DISCLOSURE_UNIVERSES, DISCLOSURE_MARKET_MAP } from "../../utils/disclosureUniverses.js";
import { disclosureSearchSuggestions } from "../../utils/disclosureSearchIntent.js";
import { getSuggestions } from "../../utils/searchRouter.js";
import { TickerContext } from "../../contexts/TickerContext";
import type { SearchSettings } from "./disclosureTypes";
import DisclosureQueryCoach from "./DisclosureQueryCoach";
import { inspectDisclosureQuery } from "../../utils/disclosureQueryCoach.js";
import s from "./disclosures.module.css";

type Suggestion = { label: string; query: string; kind: string; ticker?: string };
type Interpretation = {
  originalQuery: string;
  query: string;
  settings: Partial<SearchSettings>;
  chips: { key: string; label: string; value: string }[];
  expansions: { term: string; alternatives: string[] }[];
  suggestions: Suggestion[];
  warnings: string[];
};

const EXAMPLES = [
  { label: "Microsoft cybersecurity risks", query: "Microsoft cybersecurity risks" },
  { label: "Debt covenant breaches", query: "Companies mentioning debt covenant breaches" },
  { label: "Apple supply chain in 2025", query: "Apple supply chain risks in filings from 2025" },
];
const BROAD_FORMS = "10-K,10-Q,8-K,S-1,S-3,S-4,DEF 14A,DEFM14A,20-F,40-F,N-CSR,NPORT-P";

export default function DisclosureQueryBar({ settings, setSettings, onSearch, busy, stop, interpretation, interpreting = false, onApplySuggestion }: {
  settings: SearchSettings;
  setSettings: (value: SearchSettings) => void;
  onSearch: (settings: SearchSettings) => void;
  busy: boolean;
  stop: () => void;
  interpretation?: Interpretation | null;
  interpreting?: boolean;
  onApplySuggestion?: (query: string) => void;
}) {
  const [builder, setBuilder] = useState({ any: "", required: "", exclude: "" });
  const [builderError, setBuilderError] = useState("");
  const [previousQuery, setPreviousQuery] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtersRef = useRef<HTMLDetailsElement>(null);
  const listId = useId();
  const context = useContext(TickerContext);
  const tickerMap = context?.tickerMap;
  const smart = settings.searchStyle !== "exact";
  const deferredQuery = useDeferredValue(settings.query);
  const currentInterpretation = interpretation?.originalQuery === settings.query ? interpretation : null;
  const queryInspection = useMemo(() => inspectDisclosureQuery(settings.query), [settings.query]);
  const builderQuery = useMemo(() => buildAdvancedQuery(builder), [builder]);
  const materialized = () => currentInterpretation ? { ...settings, ...currentInterpretation.settings, query: currentInterpretation.query, searchStyle: "exact" as const } : settings;
  const update = (key: keyof SearchSettings, value: string | number | boolean) => setSettings({ ...(key === "query" || key === "searchStyle" ? settings : materialized()), [key]: value });
  const today = new Date().toISOString().slice(0, 10);
  const canSearch = Boolean(settings.query.trim()) && (smart || queryInspection.valid);
  const suggestions = useMemo((): Suggestion[] => {
    if (!smart) return [];
    const topics = disclosureSearchSuggestions(deferredQuery).slice(0, 4) as Suggestion[];
    const words = deferredQuery.trim().split(/\s+/).filter(Boolean);
    if (!tickerMap || !words.length || /["()]/.test(deferredQuery)) return topics;
    // Reuse the shared directory; autocomplete never starts a filing search.
    for (let length = Math.min(4, words.length); length > 0; length--) {
      const prefix = words.slice(0, length).join(" ");
      if (prefix.length < 2) continue;
      const companies = getSuggestions(prefix, tickerMap, 6).suggestions.filter(item => item.type === "company" || item.type === "fund");
      if (companies.length) return [
        ...companies.slice(0, 3).map(item => ({ label: `${item.ticker} · ${item.name}`, query: words.slice(length).join(" "), kind: "company", ticker: item.ticker })),
        ...topics,
      ].slice(0, 6);
    }
    return topics;
  }, [deferredQuery, tickerMap, smart]);
  const showSuggestions = suggestionsOpen && suggestions.length > 0 && !busy;
  function focusSearch() {
    inputRef.current?.focus();
  }
  function chooseSuggestion(item: Suggestion) {
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    if (item.ticker) {
      setSettings({ ...settings, query: item.query, tickers: item.ticker, mode: "index" });
    } else if (onApplySuggestion) onApplySuggestion(item.query);
    else update("query", item.query);
    focusSearch();
  }
  function showFilters(key?: string) {
    if (currentInterpretation) setSettings(materialized());
    if (key === "query") return focusSearch();
    if (filtersRef.current) filtersRef.current.open = true;
    const field = key === "company" ? "tickers" : key;
    if (field) requestAnimationFrame(() => filtersRef.current?.querySelector<HTMLElement>(`[data-setting="${field}"]`)?.focus());
  }
  function removeChip(key: string, value: string) {
    const resolved = materialized();
    const field = key === "company" ? "tickers" : key;
    const defaults: Record<string, string> = { tickers: "", forms: BROAD_FORMS, start: "2001-01-01", end: today, section: "all", scope: "paragraph" };
    if (!(field in defaults)) return showFilters(field);
    const nextValue = field === "tickers" ? resolved.tickers.split(",").filter(ticker => !value.split(",").includes(ticker)).join(",") : defaults[field];
    setSettings({ ...resolved, [field]: nextValue, ...(field === "tickers" ? { mode: "index" as const } : {}) });
  }
  const chips = currentInterpretation?.chips || [];
  const playbooks = [
    { name: "Bank liquidity", query: "liquidity AND (funding OR deposits)", tickers: "JPM,BAC,WFC", section: "mda", forms: "10-K" },
    { name: "Covenant pressure", query: "(covenant OR liquidity) AND (breach OR waiver)", tickers: "F,CCL,AAL", section: "all", forms: "10-K,10-Q,8-K" },
    { name: "Cyber incidents", query: 'cybersecurity OR "data breach" OR ransomware', tickers: "MSFT,UNH,GOOGL", section: "all", forms: "10-K,10-Q,8-K" },
  ];
  return (
    <form className={s.searchBox} onSubmit={(event) => { event.preventDefault(); setSuggestionsOpen(false); if (canSearch) onSearch(settings); }}>
      <div className={s.searchModeRow}>
        <label htmlFor="disclosure-search-query" className={s.searchPrompt}>What are you researching?</label>
        <div className={s.searchModes} role="group" aria-label="Search style">
          <button type="button" aria-pressed={smart} onClick={() => update("searchStyle", "smart")}><Sparkles size={13} /> Smart search</button>
          <button type="button" aria-pressed={!smart} onClick={() => { update("searchStyle", "exact"); setSuggestionsOpen(false); }}>Exact search</button>
        </div>
      </div>
      <div className={s.searchTop}>
        <div className={s.queryField} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setSuggestionsOpen(false); }}>
          <div className={s.queryInput}>
            <Search size={21} aria-hidden="true" />
            <input
              ref={inputRef}
              id="disclosure-search-query"
              role="combobox"
              aria-label="Disclosure query"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls={showSuggestions ? listId : undefined}
              aria-activedescendant={showSuggestions && activeSuggestion >= 0 && suggestions[activeSuggestion] ? `${listId}-${activeSuggestion}` : undefined}
              aria-describedby="disclosure-search-help"
              aria-invalid={!smart && Boolean(settings.query) && !queryInspection.valid}
              autoComplete="off"
              maxLength={1000}
              value={settings.query}
              onChange={(e) => { update("query", e.target.value); setSuggestionsOpen(true); setActiveSuggestion(-1); }}
              onFocus={() => { setSuggestionsOpen(true); if (context?.directoryStatus === "idle") void context.refreshTickerMap(); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") { setSuggestionsOpen(false); setActiveSuggestion(-1); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (!suggestions.length) return;
                  event.preventDefault(); setSuggestionsOpen(true);
                  setActiveSuggestion(current => event.key === "ArrowDown" ? (current + 1) % suggestions.length : (current <= 0 ? suggestions.length - 1 : current - 1));
                }
                if (event.key === "Enter" && showSuggestions && activeSuggestion >= 0 && suggestions[activeSuggestion]) { event.preventDefault(); chooseSuggestion(suggestions[activeSuggestion]); }
              }}
              placeholder={smart ? "Ask about a company, topic, or disclosure…" : '"material weakness" AND remediation'}
            />
            {settings.query && <button className={s.clearQuery} type="button" aria-label="Clear search query" onClick={() => { update("query", ""); setActiveSuggestion(-1); focusSearch(); }}><X size={16} /></button>}
          </div>
          {showSuggestions && <div className={s.suggestions}>
            <span className={s.suggestionHeading}>Suggested searches</span>
            <ul role="listbox" id={listId} aria-label="Disclosure search suggestions">
              {suggestions.map((item, index) => <li key={`${item.kind}:${item.label}`} role="option" id={`${listId}-${index}`} aria-selected={activeSuggestion === index} onMouseDown={(event) => event.preventDefault()}>
                <button type="button" tabIndex={-1} onClick={() => chooseSuggestion(item)}>{item.ticker ? <Building2 size={16} /> : <Search size={16} />}<span>{item.label}<small>{item.ticker ? "Search this company's disclosures" : item.kind === "spelling" ? "Suggested spelling · select to use" : "Disclosure topic"}</small></span><ArrowUpRight size={14} /></button>
              </li>)}
            </ul>
          </div>}
        </div>
        <button className={s.primary} type="submit" disabled={busy || !canSearch}><Search size={16} />{busy ? "Searching…" : "Search disclosures"}</button>
        {busy && <button type="button" onClick={stop}><Square size={14} /> Stop</button>}
      </div>
      <div className={s.searchHelpRow}>
        <p id="disclosure-search-help" className={s.searchHelp}>{smart ? "Use everyday language, company names, dates, or precise phrases." : "Use AND, OR, NOT, parentheses, and quoted phrases. Terms are matched literally."}</p>
        <span className={s.searchScope}>{settings.tickers ? <><Building2 size={12} /> {settings.tickers}</> : "Across SEC filers"}</span>
      </div>
      {!smart && settings.query && !queryInspection.valid && <p role="alert" className={s.queryError}>{queryInspection.error}</p>}
      {(chips.length > 0 || interpreting) && <div className={s.interpretation} aria-live="polite">
        <span className={s.interpretLabel}>{interpreting ? "Understanding your search…" : "Searching for"}</span>
        {chips.map((chip) => <span className={s.filterChip} key={`${chip.key}:${chip.value}`}>
          <button type="button" onClick={() => showFilters(chip.key)} title={`Edit ${chip.label}`}>{chip.label}<ChevronDown size={11} /></button>
          {chip.value && (["tickers", "company", "forms", "start", "end", "section", "scope"].includes(chip.key)) && <button type="button" aria-label={`Remove ${chip.label} filter`} onClick={() => removeChip(chip.key, chip.value)}><X size={11} /></button>}
        </span>)}
      </div>}
      {currentInterpretation?.warnings?.[0] && <p className={s.searchWarning}>{currentInterpretation.warnings[0]}</p>}
      {currentInterpretation?.suggestions?.some(item => item.kind === "spelling" || item.kind === "company") && <div className={s.searchExamples}>
        <span>Suggestions</span>{currentInterpretation.suggestions.filter(item => item.kind === "spelling" || item.kind === "company").slice(0, 3).map(item => <button type="button" key={`${item.kind}:${item.query}`} onClick={() => chooseSuggestion(item)}>{item.label}<ArrowUpRight size={11} /></button>)}
      </div>}
      {currentInterpretation && (currentInterpretation.expansions?.length > 0 || currentInterpretation.warnings?.length > 0) && <details className={s.searchInterpretationDetail}>
        <summary>How this search is interpreted{currentInterpretation.expansions?.length ? ` · ${currentInterpretation.expansions.length} related term group${currentInterpretation.expansions.length > 1 ? "s" : ""}` : ""}</summary>
        <p className={s.muted}><code>{currentInterpretation.query}</code></p>
        {currentInterpretation.expansions?.map(item => <p className={s.muted} key={item.term}><strong>{item.term}</strong>: {item.alternatives.join(", ")}</p>)}
        {currentInterpretation.warnings?.map(warning => <p className={s.warning} key={warning}>{warning}</p>)}
        <button type="button" onClick={() => setSettings({ ...settings, ...currentInterpretation.settings, query: currentInterpretation.query, searchStyle: "exact" })}>Edit the exact search</button>
      </details>}
      <div className={s.filterRow}>
        <label className={s.companyInput}>Company · optional<input aria-label="Companies" placeholder="Any company, or tickers / CIKs" value={settings.tickers} onChange={(e) => update("tickers", e.target.value)} /></label>
        <label>Filing forms<select value={settings.forms} onChange={(e) => update("forms", e.target.value)}>
          <option value="10-K,10-Q,8-K">Annual, quarterly & current reports</option><option value="10-K">Annual · 10-K</option><option value="10-K,10-Q">Annual & quarterly · 10-K / 10-Q</option><option value="10-Q">Quarterly · 10-Q</option><option value="8-K">Current reports · 8-K</option><option value="20-F,40-F">Foreign annual · 20-F / 40-F</option><option value="20-F,40-F,6-K">Foreign issuers</option><option value={BROAD_FORMS}>Broad filings</option>
          {!["10-K,10-Q,8-K", "10-K", "10-K,10-Q", "10-Q", "8-K", "20-F,40-F", "20-F,40-F,6-K", BROAD_FORMS].includes(settings.forms) && <option value={settings.forms}>{settings.forms}</option>}
        </select></label>
        <details className={s.filters} ref={filtersRef}>
          <summary><SlidersHorizontal size={15} /> Filters & tools</summary>
          <div className={s.advanced}>
            <div className={s.filterRow}>
              <label>Company filter<input data-setting="tickers" aria-label="Advanced company filter" placeholder="Tickers or SEC CIKs" value={settings.tickers} onChange={(e) => update("tickers", e.target.value)} /></label>
              <label>Retrieval mode<select data-setting="mode" value={settings.mode} onChange={(e) => update("mode", e.target.value)}><option value="index">Fast discovery across SEC filings</option><option value="companies">Detailed company review</option></select></label>
              <label>Filing form filter<input data-setting="forms" value={settings.forms} onChange={(e) => update("forms", e.target.value)} /></label>
            </div>
            <div className={s.filterRow}>
              <label>
                Filed from
                <input
                  type="date"
                  data-setting="start" aria-label="Filed from"
                  min="2001-01-01"
                  max={today}
                  value={settings.start}
                  onChange={(e) => update("start", e.target.value)}
                />
              </label>
              <label>
                Filed through
                <input
                  type="date"
                  data-setting="end" aria-label="Filed through"
                  min={settings.start}
                  max={today}
                  value={settings.end}
                  onChange={(e) => update("end", e.target.value)}
                />
              </label>
              <label>
                Search section
                <select
                  data-setting="section" value={settings.section}
                  onChange={(e) => update("section", e.target.value)}
                >
                  {SECTION_OPTIONS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Term scope
                <select
                  data-setting="scope" value={settings.scope}
                  onChange={(e) => update("scope", e.target.value)}
                >
                  <option value="paragraph">Same paragraph</option>
                  <option value="document">
                    Across selected document text
                  </option>
                </select>
              </label>
              <label>
                Compare language against
                <select
                  value={settings.comparison || "none"}
                  onChange={(e) => update("comparison", e.target.value)}
                >
                  <option value="annual-season">
                    Comparable annual season
                  </option>
                  <option value="previous-report">
                    Previous reporting period
                  </option>
                  <option value="none">No comparison · search only</option>
                </select>
              </label>
              <label>
                Filings per company
                <select
                  value={settings.depth}
                  onChange={(e) => update("depth", Number(e.target.value))}
                >
                  {[1, 2, 4, 6, 8, 12].map((n) => (
                    <option key={n} value={n}>
                      {n} latest in date window
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={settings.amendments}
                onChange={(e) => update("amendments", e.target.checked)}
              />{" "}
              Include amendments as separate evidence
            </label>
            <p className={s.muted}>
              Exclusions apply to the selected scope. A section that cannot be
              identified is recorded as unavailable. Index discovery returns
              candidates; the reader verifies these filters.
            </p>
            <p className={s.muted}>
              Comparable annual season pairs quarterly reports with the same
              fiscal season in the prior year. Previous reporting period uses
              the preceding same-form report for a different period. Annual
              reports use the prior annual period; amendments are identified
              separately. An unavailable comparison stays visibly unavailable.
            </p>
            <DisclosureQueryCoach query={settings.query} scope={settings.scope} onQueryChange={(query) => setSettings({ ...settings, query, searchStyle: "exact" })} />
            <div className={s.builder}>
              <h3>Build an expression</h3>
              <div className={s.filterRow}>
                <label>
                  Any of these · comma-separated
                  <input
                    value={builder.any}
                    placeholder="liquidity, covenant"
                    onChange={(e) =>
                      setBuilder({ ...builder, any: e.target.value })
                    }
                  />
                </label>
                <label>
                  Also require · comma-separated
                  <input
                    value={builder.required}
                    placeholder="waiver"
                    onChange={(e) =>
                      setBuilder({ ...builder, required: e.target.value })
                    }
                  />
                </label>
                <label>
                  Exclude · comma-separated
                  <input
                    value={builder.exclude}
                    placeholder="hypothetical"
                    onChange={(e) =>
                      setBuilder({ ...builder, exclude: e.target.value })
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={!builderQuery.trim()}
                  onClick={() => {
                    try {
                      parseDisclosureQuery(builderQuery);
                      setPreviousQuery(settings.query);
                      setSettings({ ...settings, query: builderQuery, searchStyle: "exact" });
                      setBuilderError("");
                    } catch (error) {
                      setBuilderError(error.message);
                    }
                  }}
                >
                  Replace query with builder <ArrowUpRight size={14} />
                </button>
                <button
                  type="button"
                  disabled={!builderQuery.trim() || !queryInspection.valid}
                  onClick={() => {
                    try {
                      const combined = `(${settings.query}) AND (${builderQuery})`;
                      parseDisclosureQuery(combined);
                      setPreviousQuery(settings.query);
                      setSettings({ ...settings, query: combined, searchStyle: "exact" });
                      setBuilderError("");
                    } catch (error) {
                      setBuilderError(error.message);
                    }
                  }}
                >
                  Add builder with AND
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBuilder({ any: "", required: "", exclude: "" });
                    setBuilderError("");
                  }}
                >
                  Clear builder
                </button>
              </div>
              {builderQuery && (
                <p className={s.muted}>
                  Builder preview: <code>{builderQuery}</code>
                </p>
              )}
              {previousQuery !== null && (
                <button
                  type="button"
                  onClick={() => {
                    update("query", previousQuery);
                    setPreviousQuery(null);
                  }}
                >
                  Undo last builder change
                </button>
              )}
              {builderError && (
                <p role="alert" className={s.error}>
                  {builderError}
                </p>
              )}
              <p className={s.muted}>
                Use AND, OR, NOT, parentheses, and &quot;exact phrases&quot;.
                Adjacent words imply AND; commas imply OR. Matching is
                case-insensitive. No wildcards.
              </p>
            </div>
          </div>
        </details>
      </div>
      {smart && !busy && !currentInterpretation && <div className={s.searchExamples}><span>Try</span>{EXAMPLES.map(item => <button type="button" key={item.query} onClick={() => { setSettings({ ...settings, query: item.query, tickers: "", mode: "index", searchStyle: "smart", comparison: "none" }); focusSearch(); }}>{item.label}<ArrowUpRight size={11} /></button>)}</div>}
      <details className={s.playbooks}>
        <summary>Research playbooks & company groups</summary>
        <div className={s.filterRow}>
          {playbooks.map((p) => (
            <button
              type="button"
              key={p.name}
              onClick={() =>
                setSettings({ ...settings, ...p, mode: "companies", searchStyle: "exact" })
              }
            >
              {p.name} <ArrowUpRight size={13} />
            </button>
          ))}
          <label>
            Company group
            <select
              defaultValue=""
              onChange={(e) => {
                const group = DISCLOSURE_UNIVERSES.find(
                  (g) => g.id === e.target.value,
                );
                if (group)
                  setSettings({
                    ...settings,
                    tickers: group.tickers.join(","),
                    mode: "companies",
                    searchStyle: "exact",
                  });
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                Choose a group…
              </option>
              {DISCLOSURE_UNIVERSES.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} · {g.tickers.length}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() =>
              setSettings({
                ...settings,
                tickers: DISCLOSURE_MARKET_MAP.tickers.join(","),
                depth: 2,
                mode: "companies",
                searchStyle: "exact",
              })
            }
          >
            Cross-sector sample · 40 companies
          </button>
        </div>
      </details>
    </form>
  );
}
