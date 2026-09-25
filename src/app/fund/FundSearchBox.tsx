"use client";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, Building2, Layers3, LoaderCircle, Search, X } from "lucide-react";
import { TickerContext } from "../../contexts/TickerContext";
import { fundSearchSuggestions } from "../../utils/fundDiscovery.js";
import s from "./NportResearch.module.css";

export type FundSuggestion = { ticker: string; name: string; kind: string; isFund?: boolean; cik?: string; seriesId?: string };
export default function FundSearchBox({ value, onChange, onChoose, onSubmit, mode = "explore", label = "Search funds or companies", placeholder = "Fund name, ticker, or company…", compact = false }: {
  value: string; onChange: (value: string) => void; onChoose: (item: FundSuggestion) => void;
  onSubmit: (query: string) => void; mode?: "explore" | "fund" | "holding"; label?: string; placeholder?: string; compact?: boolean;
}) {
  const context = useContext(TickerContext);
  const [open, setOpen] = useState(false), [active, setActive] = useState<string | null>(null);
  const [remote, setRemote] = useState<{ query: string; results: any[]; warning?: string } | null>(null);
  const [pending, setPending] = useState("");
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null);
  const id = useId(), q = value.trim();
  const ensureDirectory = () => { if (context?.directoryStatus === "idle") void context.refreshTickerMap(); };
  const items = useMemo(() => fundSearchSuggestions(q, context?.tickerMap || {}, mode, remote?.query === q ? remote.results : []) as FundSuggestion[], [q, context?.tickerMap, mode, remote]);
  const index = items.findIndex(item => item.ticker === active);
  useEffect(() => { if (open && index >= 0) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" }); }, [open, index, id]);
  useEffect(() => {
    if (!open || mode === "holding" || q.length < 2 || context?.tickerMap?.[q.toUpperCase()]?.isFund) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPending(q);
      fetch(`/api/reports/search?${new URLSearchParams({ kind: "nport", q })}`, { signal: controller.signal })
        .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Fund name search is unavailable."); return data; })
        .then(data => { if (!controller.signal.aborted) setRemote({ query: q, results: data.results || [], warning: data.warning }); })
        .catch(error => { if (!controller.signal.aborted) setRemote({ query: q, results: [], warning: error.message }); })
        .finally(() => { if (!controller.signal.aborted) setPending(""); });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, mode, open, context?.tickerMap, attempt]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const choose = (item: FundSuggestion) => { setOpen(false); setActive(null); onChoose(item); };
  const submit = () => {
    if (!q) { input.current?.focus(); return; }
    if (open && index >= 0) { choose(items[index]); return; }
    const exact = items.find(item => item.ticker === q.toUpperCase() || item.name.toLowerCase() === q.toLowerCase());
    if (exact) choose(exact);
    else if (mode !== "holding" && items.length) { setOpen(true); setActive(items[0].ticker); }
    else { onSubmit(q); setOpen(mode !== "holding"); }
  };
  return <div className={s.searchBox} data-compact={compact} ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label className={s.srOnly} htmlFor={id}>{label}</label>
    <div className={s.searchField}><Search size={20} aria-hidden="true" />
      <input ref={input} id={id} value={value} role="combobox" aria-autocomplete="list" aria-expanded={open && !!q} aria-controls={open && q ? `${id}-list` : undefined} aria-activedescendant={open && index >= 0 ? `${id}-${index}` : undefined} autoComplete="off" spellCheck={false} placeholder={placeholder} maxLength={100}
        onFocus={() => { ensureDirectory(); setOpen(true); }} onChange={event => { ensureDirectory(); onChange(event.target.value); setActive(null); setOpen(true); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); setActive(null); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); if (items.length) setActive(items[event.key === "ArrowDown" ? (index + 1) % items.length : index <= 0 ? items.length - 1 : index - 1].ticker); }
          if (event.key === "Enter") { event.preventDefault(); submit(); }
        }} />
      {q && <button type="button" className={s.clearSearch} aria-label={`Clear ${label.toLowerCase()}`} onClick={() => { onChange(""); setActive(null); input.current?.focus(); }}><X size={16} /></button>}
      <button type="button" className={s.searchGo} aria-label={`Submit ${label.toLowerCase()}`} onClick={submit}><ArrowRight size={20} /></button>
    </div>
    {open && q && <div className={s.suggestions}>
      <div className={s.suggestionHeader}><span>{mode === "holding" ? "Companies & securities" : "Funds & companies"}</span>{pending === q && <LoaderCircle size={15} aria-label="Searching fund names" />}</div>
      <div id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`}>{items.map((item, i) => <button type="button" role="option" aria-selected={i === index} id={`${id}-${i}`} key={item.ticker} onPointerMove={() => setActive(item.ticker)} onClick={() => choose(item)} className={s.suggestion}>
        {item.kind === "fund" ? <Layers3 size={18} /> : <Building2 size={18} />}<span><strong>{item.ticker}</strong><span>{item.name}</span></span><small>{mode === "holding" ? "Find holders" : item.kind === "fund" ? "Fund portfolio" : "Find funds holding it"}</small>
      </button>)}</div>
      {!items.length && <p role="status">{context?.directoryStatus === "loading" || pending === q ? "Looking for matching names and tickers…" : "No suggestions yet. Search an exact ticker, a fuller name, CUSIP, or ISIN."}</p>}
      {context?.directoryStatus === "error" && <button type="button" onClick={() => context.refreshTickerMap(true)}>Retry company and fund directory</button>}
      {remote?.query === q && remote.warning && <p className={s.searchWarning}>{remote.warning} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry name search</button></p>}
      <div className={s.searchHint}>↑ ↓ to choose · Enter to open · Esc to close</div>
    </div>}
  </div>;
}
