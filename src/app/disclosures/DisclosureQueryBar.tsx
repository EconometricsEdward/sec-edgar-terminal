"use client";

import { useContext, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Building2, Check, ChevronDown, Search, SlidersHorizontal, Square, X } from "lucide-react";
import { buildAdvancedQuery, parseDisclosureQuery } from "../../utils/disclosureQuery.js";
import { SECTION_OPTIONS } from "../../utils/disclosureResearch.js";
import { disclosureCompanySuggestions, disclosureSearchSuggestions } from "../../utils/disclosureSearchIntent.js";
import { TickerContext } from "../../contexts/TickerContext";
import { inspectDisclosureQuery } from "../../utils/disclosureQueryCoach.js";
import type { SearchSettings } from "./disclosureTypes";
import s from "./DisclosureQueryBar.module.css";

type Suggestion = { label: string; query: string; kind: string; ticker?: string; remainingQuery?: string };
type Interpretation = {
  originalQuery: string;
  query: string;
  settings: Partial<SearchSettings>;
  chips: { key: string; label: string; value: string }[];
  expansions: { term: string; alternatives: string[] }[];
  suggestions: Suggestion[];
  warnings: string[];
};
type Props = {
  settings: SearchSettings;
  setSettings: (value: SearchSettings) => void;
  onSearch: (settings: SearchSettings) => void;
  busy: boolean;
  stop: () => void;
  interpretation?: Interpretation | null;
  interpreting?: boolean;
  onApplySuggestion?: (query: string) => void;
};

const DEFAULT_FORMS = "10-K,10-Q,8-K";
const BROAD_FORMS = "10-K,10-Q,8-K,S-1,S-3,S-4,DEF 14A,DEFM14A,20-F,40-F,6-K,N-CSR,NPORT-P";
const FORM_OPTIONS = [
  [DEFAULT_FORMS, "Annual, quarterly & current reports"],
  ["10-K", "Annual reports · 10-K"],
  ["10-K,10-Q", "Annual & quarterly · 10-K / 10-Q"],
  ["10-Q", "Quarterly reports · 10-Q"],
  ["8-K", "Current reports · 8-K"],
  ["20-F,40-F,6-K", "Foreign issuers · 20-F / 40-F / 6-K"],
  ["DEF 14A,DEFM14A", "Proxy statements"],
  [BROAD_FORMS, "All supported filing forms"],
];

export default function DisclosureQueryBar({ settings, setSettings, onSearch, busy, stop, interpretation, interpreting = false, onApplySuggestion }: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [builder, setBuilder] = useState({ any: "", required: "", exclude: "" });
  const [builderError, setBuilderError] = useState("");
  const [previousQuery, setPreviousQuery] = useState<string | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestionKey, setActiveSuggestionKey] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtersId = useId();
  const context = useContext(TickerContext);
  const tickerMap = context?.tickerMap;
  const smart = settings.searchStyle !== "exact";
  const deferredQuery = useDeferredValue(settings.query);
  const currentInterpretation = interpretation?.originalQuery === settings.query.trim() ? interpretation : null;
  const expression = currentInterpretation?.query || settings.query;
  const queryInspection = useMemo(() => inspectDisclosureQuery(expression), [expression]);
  const builderQuery = useMemo(() => buildAdvancedQuery(builder), [builder]);
  const displayedSettings = currentInterpretation ? { ...settings, ...currentInterpretation.settings, mode: settings.mode } : settings;
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = `${Number(today.slice(0, 4)) - 1}-01-01`;
  const canSearch = Boolean(settings.query.trim()) && (smart || queryInspection.valid);
  const suggestions = useMemo(() => smart ? [
    ...disclosureCompanySuggestions(deferredQuery, { companies: tickerMap, limit: 3 }),
    ...disclosureSearchSuggestions(deferredQuery),
  ].slice(0, 6) as Suggestion[] : [], [deferredQuery, smart, tickerMap]);
  const suggestionKey = (item: Suggestion) => `${item.kind}:${item.query}:${item.label}`;
  const activeSuggestion = suggestions.findIndex(item => suggestionKey(item) === activeSuggestionKey);
  // Never let an Enter key select an item belonging to the previous input value.
  const showSuggestions = suggestionsOpen && deferredQuery === settings.query && suggestions.length > 0;
  const companyIds = displayedSettings.tickers.split(",").map(value => value.trim()).filter(Boolean);
  const companyLabels = useMemo(() => {
    const labels = new Map<string, { short: string; name: string }>();
    const ids = displayedSettings.tickers.split(",").map(value => value.trim()).filter(Boolean);
    const entries = ids.some(id => /^\d+$/.test(id)) ? Object.values(tickerMap || {}) : [];
    for (const id of ids) {
      const company = tickerMap?.[id.toUpperCase()] || entries.find(entry => /^\d+$/.test(id) && Number(entry.cik) === Number(id));
      if (company) labels.set(id, { short: company.ticker, name: company.name });
    }
    return labels;
  }, [displayedSettings.tickers, tickerMap]);
  const sectionName = SECTION_OPTIONS.find(([id]) => id === displayedSettings.section)?.[1] || displayedSettings.section;
  const formLabel = displayedSettings.forms === BROAD_FORMS ? "All supported forms" : displayedSettings.forms.replaceAll(",", " · ");
  const activeFilterCount = [
    companyIds.length > 0, displayedSettings.forms !== DEFAULT_FORMS,
    displayedSettings.start !== defaultStart || displayedSettings.end !== today,
    displayedSettings.section !== "all", displayedSettings.scope !== "paragraph",
    displayedSettings.amendments, displayedSettings.mode !== "index",
    displayedSettings.comparison !== "none",
  ].filter(Boolean).length;

  function materialized(): SearchSettings {
    return currentInterpretation ? { ...displayedSettings, query: currentInterpretation.query, searchStyle: "exact" } : settings;
  }
  function update(key: keyof SearchSettings, value: string | number | boolean) {
    setSettings({ ...(key === "query" || key === "searchStyle" ? settings : materialized()), [key]: value });
  }
  function chooseSuggestion(item: Suggestion) {
    if (item.ticker && typeof item.remainingQuery === "string") {
      // Company autocomplete owns a verified prefix; only that prefix is removed.
      // Ambiguous-company suggestions returned by interpretation keep a full query.
      setSettings({ ...settings, query: item.remainingQuery, tickers: item.ticker, mode: "index", searchStyle: "smart" });
    } else if (onApplySuggestion) onApplySuggestion(item.query);
    else update("query", item.query);
    inputRef.current?.focus();
    setSuggestionsOpen(false);
    setActiveSuggestionKey("");
  }
  function showFilters(field?: string) {
    setFiltersOpen(true);
    setSuggestionsOpen(false);
    if (field) requestAnimationFrame(() => {
      const input = filtersRef.current?.querySelector<HTMLElement>(`[data-setting="${field}"]`);
      const parent = input?.closest("details");
      if (parent) parent.open = true;
      input?.focus();
    });
  }
  function removeCompany(identifier: string) {
    setSettings({ ...materialized(), tickers: companyIds.filter(value => value !== identifier).join(",") });
  }
  function applyBuilder(combine: boolean) {
    const query = combine ? `(${expression}) AND (${builderQuery})` : builderQuery;
    try {
      parseDisclosureQuery(query);
      setPreviousQuery(expression);
      setSettings({ ...materialized(), query, searchStyle: "exact" });
      setBuilderError("");
    } catch (error) {
      setBuilderError(error instanceof Error ? error.message : "Check the search expression.");
    }
  }
  function resetFilters() {
    setSettings({ ...materialized(), tickers: "", forms: DEFAULT_FORMS, start: defaultStart, end: today, section: "all", scope: "paragraph", amendments: false, mode: "index", depth: 4, comparison: "none" });
  }

  return (
    <form className={s.searchShell} role="search" aria-label="Search SEC disclosures" onSubmit={event => { event.preventDefault(); setSuggestionsOpen(false); if (canSearch) onSearch(settings); }}>
      <label className={s.visuallyHidden} htmlFor="disclosure-search-query">Search SEC disclosures</label>
      <div className={s.searchLine}>
        <div className={s.queryField} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setSuggestionsOpen(false); }}>
          <div className={s.queryInput}>
            <Search size={23} aria-hidden="true" />
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
              placeholder={smart ? "Company, topic, or question about a filing…" : '"material weakness" AND remediation'}
              onChange={event => { update("query", event.target.value); setSuggestionsOpen(true); setActiveSuggestionKey(""); }}
              onFocus={() => { setSuggestionsOpen(true); if (smart && context?.directoryStatus === "idle") void context.refreshTickerMap(); }}
              onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); setSuggestionsOpen(false); setActiveSuggestionKey(""); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (!suggestions.length || deferredQuery !== settings.query) return;
                  event.preventDefault();
                  setSuggestionsOpen(true);
                  const nextIndex = event.key === "ArrowDown" ? (activeSuggestion + 1) % suggestions.length : (activeSuggestion <= 0 ? suggestions.length - 1 : activeSuggestion - 1);
                  setActiveSuggestionKey(suggestionKey(suggestions[nextIndex]));
                }
                if (event.key === "Enter" && showSuggestions && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
                  event.preventDefault(); chooseSuggestion(suggestions[activeSuggestion]);
                }
              }}
            />
            {settings.query && <button className={s.clearQuery} type="button" aria-label="Clear search query" onClick={() => { update("query", ""); setActiveSuggestionKey(""); inputRef.current?.focus(); }}><X size={18} /></button>}
          </div>
          {showSuggestions && <div className={s.suggestions}>
            <ul role="listbox" id={listId} aria-label="Disclosure search suggestions">
              {suggestions.map((item, index) => <li key={`${item.kind}:${item.label}`} role="option" id={`${listId}-${index}`} aria-selected={activeSuggestion === index} onMouseDown={event => event.preventDefault()}>
                <button type="button" tabIndex={-1} onClick={() => chooseSuggestion(item)}>
                  {item.ticker ? <Building2 size={17} /> : <Search size={17} />}
                  <span>{item.label}<small>{item.ticker ? "SEC company" : item.kind === "spelling" ? "Suggested spelling · select to use" : "Disclosure topic"}</small></span>
                  <ArrowUpRight size={15} />
                </button>
              </li>)}
            </ul>
          </div>}
        </div>
        <button className={s.searchButton} type="submit" disabled={!canSearch}><Search size={17} />Search disclosures</button>
        {busy && <button className={s.stopButton} type="button" onClick={stop} aria-label="Stop disclosure search"><Square size={13} />Stop</button>}
      </div>
      <div className={s.toolbar}>
        <div className={s.modes} role="group" aria-label="Search style">
          <button type="button" aria-pressed={smart} onClick={() => update("searchStyle", "smart")}>{smart && <Check size={12} />}Smart search</button>
          <button type="button" aria-pressed={!smart} onClick={() => { setSettings({ ...materialized(), searchStyle: "exact" }); setSuggestionsOpen(false); }}>{!smart && <Check size={12} />}Exact search</button>
        </div>
        <p id="disclosure-search-help" className={s.help}>{smart ? "Use company names, topics, and filing dates." : 'Use AND, OR, NOT, or "exact phrases".'}</p>
        <button className={s.filtersButton} type="button" aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => { setFiltersOpen(value => !value); setSuggestionsOpen(false); }}><SlidersHorizontal size={14} />Filters{activeFilterCount > 0 && <span>{activeFilterCount}</span>}<ChevronDown size={13} /></button>
      </div>
      {!smart && settings.query && !queryInspection.valid && <p role="alert" className={s.error}>{queryInspection.error}</p>}
      <div className={s.scopeRow} aria-label="Current search scope">
        {companyIds.length ? companyIds.map(identifier => <span className={s.scopeChip} key={identifier}>
          <button type="button" onClick={() => showFilters("tickers")} title={`Edit company filter: ${companyLabels.get(identifier)?.name || identifier}`}><Building2 size={12} />{companyLabels.get(identifier)?.short || identifier}</button>
          <button type="button" aria-label={`Remove ${companyLabels.get(identifier)?.short || identifier} company filter`} onClick={() => removeCompany(identifier)}><X size={11} /></button>
        </span>) : <button className={s.scopeLink} type="button" onClick={() => showFilters("tickers")}><Building2 size={12} />All companies</button>}
        <button className={s.scopeLink} type="button" onClick={() => showFilters("forms")} title="Edit filing forms">{formLabel}</button>
        <button className={s.scopeLink} type="button" onClick={() => showFilters("start")} title="Edit filing dates">Filed {displayedSettings.start} – {displayedSettings.end === today ? "today" : displayedSettings.end}</button>
        {displayedSettings.section !== "all" && <button className={s.scopeLink} type="button" onClick={() => showFilters("section")}>{sectionName}</button>}
        {displayedSettings.scope !== "paragraph" && <button className={s.scopeLink} type="button" onClick={() => showFilters("scope")}>Across document text</button>}
        {displayedSettings.amendments && <button className={s.scopeLink} type="button" onClick={() => showFilters("amendments")}>Amendments included</button>}
        {displayedSettings.mode === "companies" && <button className={s.scopeLink} type="button" onClick={() => showFilters("mode")}>{displayedSettings.depth} filings / company</button>}
        {displayedSettings.comparison !== "none" && <button className={s.scopeLink} type="button" onClick={() => showFilters("comparison")}>{displayedSettings.comparison === "annual-season" ? "Annual comparison" : "Previous-report comparison"}</button>}
      </div>
      {interpreting && <p className={s.status} role="status">Understanding your search…</p>}
      {currentInterpretation?.warnings?.[0] && <p className={s.warning} role="status">{currentInterpretation.warnings[0]}</p>}
      {currentInterpretation?.suggestions?.some(item => item.kind === "spelling" || item.kind === "company") && <div className={s.corrections}>
        {currentInterpretation.suggestions.filter(item => item.kind === "spelling" || item.kind === "company").slice(0, 3).map(item => <button type="button" key={`${item.kind}:${item.query}`} onClick={() => chooseSuggestion(item)}>{item.label}<ArrowUpRight size={12} /></button>)}
      </div>}
      <div className={s.filterPanel} ref={filtersRef} id={filtersId} hidden={!filtersOpen}>
        <div className={s.panelHeading}><span>Refine your search</span><button type="button" onClick={resetFilters}>Reset filters</button></div>
        <div className={s.filterGrid}>
          <label className={s.companyFilter}>Companies<input data-setting="tickers" aria-label="Companies" placeholder="Tickers or SEC CIKs, separated by commas" maxLength={500} value={displayedSettings.tickers} onChange={event => update("tickers", event.target.value)} /><small>Up to 5 companies. Company names also work in the main search.</small></label>
          <label>Filing forms<select data-setting="forms" value={displayedSettings.forms} onChange={event => update("forms", event.target.value)}>
            {FORM_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {!FORM_OPTIONS.some(([value]) => value === displayedSettings.forms) && <option value={displayedSettings.forms}>{displayedSettings.forms}</option>}
          </select></label>
          <label>Filed from<input data-setting="start" aria-label="Filed from" type="date" min="2001-01-01" max={displayedSettings.end || today} value={displayedSettings.start} onChange={event => update("start", event.target.value)} /></label>
          <label>Filed through<input data-setting="end" aria-label="Filed through" type="date" min={displayedSettings.start} max={today} value={displayedSettings.end} onChange={event => update("end", event.target.value)} /></label>
          <label>Search section<select data-setting="section" value={displayedSettings.section} onChange={event => update("section", event.target.value)}>{SECTION_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <label>Term scope<select data-setting="scope" value={displayedSettings.scope} onChange={event => update("scope", event.target.value)}><option value="paragraph">Same paragraph</option><option value="document">Across selected document text</option></select></label>
        </div>
        <label className={s.checkbox}><input data-setting="amendments" type="checkbox" checked={displayedSettings.amendments} onChange={event => update("amendments", event.target.checked)} />Include amended filings</label>
        <details className={s.advanced}>
          <summary>Search method & query tools<ChevronDown size={12} /></summary>
          <div className={s.methodGrid}>
            <label>Search method<select data-setting="mode" value={displayedSettings.mode} onChange={event => update("mode", event.target.value)}><option value="index">Search SEC filing index</option><option value="companies">Detailed company review</option></select></label>
            <label>Filings per company<select data-setting="depth" value={displayedSettings.depth} onChange={event => update("depth", Number(event.target.value))}>{[1, 2, 4, 6, 8, 12].map(value => <option key={value} value={value}>{value} latest in date window</option>)}</select></label>
            <label>Compare language with<select data-setting="comparison" value={displayedSettings.comparison || "none"} onChange={event => update("comparison", event.target.value)}><option value="none">No comparison · search only</option><option value="annual-season">Comparable annual season</option><option value="previous-report">Previous reporting period</option></select></label>
          </div>
          <p className={s.detailNote}>Detailed review reads the selected companies’ filings. Comparisons use the same filing form and reporting season; unavailable sections or reports stay visibly unavailable.</p>
          <div className={s.builder}>
            <h3>Build an exact search</h3>
            <div className={s.methodGrid}>
              <label>Any of these<input value={builder.any} placeholder="liquidity, covenant" onChange={event => setBuilder({ ...builder, any: event.target.value })} /></label>
              <label>Also require<input value={builder.required} placeholder="waiver" onChange={event => setBuilder({ ...builder, required: event.target.value })} /></label>
              <label>Exclude<input value={builder.exclude} placeholder="hypothetical" onChange={event => setBuilder({ ...builder, exclude: event.target.value })} /></label>
            </div>
            <p className={s.detailNote}>Separate terms with commas. Use quotes for an exact phrase.</p>
            {builderQuery && <code className={s.expression}>{builderQuery}</code>}
            <div className={s.builderActions}>
              <button type="button" disabled={!builderQuery.trim()} onClick={() => applyBuilder(false)}>Use this query<ArrowUpRight size={12} /></button>
              <button type="button" disabled={!builderQuery.trim() || !queryInspection.valid || !expression.trim()} onClick={() => applyBuilder(true)}>Add with AND</button>
              {previousQuery !== null && <button type="button" onClick={() => { update("query", previousQuery); setPreviousQuery(null); }}>Undo query change</button>}
            </div>
            {builderError && <p role="alert" className={s.error}>{builderError}</p>}
          </div>
        </details>
      </div>
      {currentInterpretation && (currentInterpretation.expansions?.length > 0 || currentInterpretation.warnings?.length > 0) && <details className={s.interpretation}>
        <summary>How this search is interpreted<ChevronDown size={11} /></summary>
        <code className={s.expression}>{currentInterpretation.query}</code>
        {currentInterpretation.expansions?.map(item => <p className={s.detailNote} key={item.term}><strong>{item.term}</strong>: {item.alternatives.join(", ")}</p>)}
        {currentInterpretation.warnings?.slice(1).map(warning => <p className={s.warning} key={warning}>{warning}</p>)}
        <button type="button" onClick={() => { setSettings({ ...materialized(), searchStyle: "exact" }); inputRef.current?.focus(); }}>Edit exact search<ArrowUpRight size={12} /></button>
      </details>}
    </form>
  );
}
