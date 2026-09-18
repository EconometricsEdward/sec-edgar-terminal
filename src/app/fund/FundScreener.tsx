"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDownWideNarrow, ArrowUpRight, Check, ChevronLeft, ChevronRight, Download, LayoutGrid, Plus, Search, SlidersHorizontal, Table2 } from "lucide-react";
import { fundSnapshotFacts, fundScreenerCsv, fundSnapshotKey } from "../../utils/fundScreener.js";
import { fundSnapshotIsStale } from "../../utils/fundSnapshotClient.js";
import { money, pct, number } from "./fundUi";
import FundPortfolioPreview, { fundTone, portfolioHref } from "./FundPortfolioPreview";
import s from "./FundWorkspace.module.css";

const pageSize = 6;
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stateLabel(fund: any) {
  if (fund.state.status === "ready") return fundSnapshotIsStale(fund.state.data) ? "Source check due" : "SEC portfolio";
  return ({ idle: "Awaiting snapshot", loading: "Reading SEC…", error: "Retry available", unavailable: "Coverage gap", cancelled: "Paused" } as Record<string, string>)[fund.state.status] || "Awaiting snapshot";
}
export default function FundScreener({ screen, settings, onPatch, shelf, snapshots, onSelect, families }: any) {
  const [focusTicker, setFocusTicker] = useState("");
  const [pageChoice, setPageChoice] = useState({ key: "", page: 0 });
  const pageKey = JSON.stringify([settings.query, settings.category, settings.family, settings.coverage, settings.minAssets, settings.maxConcentration, settings.maxAge, settings.sort, settings.direction]);
  const pageCount = Math.max(1, Math.ceil(screen.rows.length / pageSize));
  const page = Math.min(pageChoice.key === pageKey ? pageChoice.page : 0, pageCount - 1);
  const visibleFunds = screen.rows.slice(page * pageSize, (page + 1) * pageSize);
  const focusFund = visibleFunds.find((fund: any) => fund.ticker === focusTicker) || visibleFunds[0];
  const selected = settings.tickers;
  const busy = snapshots.progress.busy;
  const { load, states } = snapshots;
  const preloaded = useRef("");
  const preloadKey = JSON.stringify([pageKey, page, settings.reportMap, selected]);
  useEffect(() => {
    if (preloaded.current === preloadKey) return;
    const timer = setTimeout(() => {
      preloaded.current = preloadKey;
      const initial = visibleFunds.length ? visibleFunds : screen.candidates.slice(0, pageSize);
      const tickers = [...new Set<string>([...selected, ...initial.slice(0, 4).map((fund: any) => fund.ticker)])];
      const missing = tickers.filter(ticker => !states[fundSnapshotKey(ticker, settings.reportMap)] || states[fundSnapshotKey(ticker, settings.reportMap)].status === "idle");
      if (missing.length) void load(missing, settings.reportMap);
    }, 200);
    return () => clearTimeout(timer);
  }, [preloadKey, visibleFunds, screen.candidates, selected, settings.reportMap, states, load]);
  useEffect(() => {
    if (!focusFund || !["idle"].includes(focusFund.state.status)) return;
    const timer = setTimeout(() => { void load([focusFund.ticker], settings.reportMap); }, 200);
    return () => clearTimeout(timer);
  }, [focusFund, settings.reportMap, load]);
  const activeFilters = [settings.family, settings.coverage !== "all", settings.minAssets, settings.maxConcentration, settings.maxAge].filter(Boolean).length;
  function clear() { onPatch({ family: "", coverage: "all", minAssets: "", maxConcentration: "", maxAge: "", query: "", category: "All funds" }); }
  const selectButton = (fund: any) => <button type="button" className={s.selectFund} aria-label={`${selected.includes(fund.ticker) ? "Remove" : "Add"} ${fund.ticker} ${selected.includes(fund.ticker) ? "from" : "to"} comparison`} aria-pressed={selected.includes(fund.ticker)} disabled={!selected.includes(fund.ticker) && selected.length >= 4} onClick={() => onSelect(fund.ticker)}>{selected.includes(fund.ticker) ? <Check size={15} /> : <Plus size={15} />}</button>;
  return <section className={s.screener} aria-label="Explore N-PORT fund portfolios">
    <div className={s.discoveryControls}>
      <label className={s.searchLabel}><Search size={18} /><input aria-label="Search funds by ticker, name, family, or strategy" placeholder="Find a fund, family, or strategy…" value={settings.query} onChange={e => onPatch({ query: e.target.value })} /></label>
      <div className={s.layoutToggle} role="group" aria-label="Fund display"><button type="button" aria-pressed={settings.layout !== "table"} onClick={() => onPatch({ layout: "cards" })}><LayoutGrid size={15} />Visual</button><button type="button" aria-pressed={settings.layout === "table"} onClick={() => onPatch({ layout: "table" })}><Table2 size={15} />Table</button></div>
    </div>
    <div className={s.browseBar}>
      <div className={s.categories} role="group" aria-label="Fund categories">{["All funds", "US equity", "International", "Fixed income", "Saved funds"].map(category => <button type="button" key={category} aria-pressed={settings.category === category} onClick={() => onPatch({ category, family: "" })}>{category === "All funds" ? "All portfolios" : category}{category === "Saved funds" && <small>{shelf.saved.length}</small>}</button>)}</div>
      <details className={s.filters}><summary><SlidersHorizontal size={14} />Filters & sort{activeFilters > 0 && <span>{activeFilters}</span>}</summary><div className={s.filterContent}>
        <div className={s.filterGrid}>
          <label>Fund family<select value={settings.family} onChange={e => onPatch({ family: e.target.value })}><option value="">All families</option>{[...new Set<string>([settings.family, ...families].filter(Boolean))].sort().map(family => <option key={family}>{family}</option>)}</select></label>
          <label>Coverage<select value={settings.coverage} onChange={e => onPatch({ coverage: e.target.value })}><option value="all">All statuses</option><option value="ready">Available portfolios</option><option value="missing">Failed or unavailable</option><option value="unloaded">Not loaded / cancelled</option></select></label>
          <label>Min. net assets ($ billions)<input inputMode="decimal" value={settings.minAssets} onChange={e => onPatch({ minAssets: e.target.value })} placeholder="Any" aria-invalid={!!screen.errors.minAssets} /></label>
          <label>Max. top-10 weight (% NAV)<input inputMode="decimal" value={settings.maxConcentration} onChange={e => onPatch({ maxConcentration: e.target.value })} placeholder="Any" aria-invalid={!!screen.errors.maxConcentration} /></label>
          <label>Max. portfolio age (days)<input inputMode="numeric" value={settings.maxAge} onChange={e => onPatch({ maxAge: e.target.value })} placeholder="Any" aria-invalid={!!screen.errors.maxAge} /></label>
          <label>Sort by<select value={settings.sort} onChange={e => onPatch({ sort: e.target.value })}><option value="ticker">Ticker</option><option value="name">Fund name</option><option value="netAssets">Portfolio net assets</option><option value="concentration">Top-10 concentration</option><option value="positions">Reported positions</option><option value="age">Portfolio age</option></select></label>
          <label>Order<select value={settings.direction} onChange={e => onPatch({ direction: e.target.value })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>
        </div>
        <div className={s.filterFooter}><p>Numeric filters use loaded reports. Missing values stay unavailable.</p><button type="button" onClick={clear}>Clear filters</button></div>
      </div></details>
    </div>
    {Object.keys(screen.errors).length > 0 && <p className={s.notice} role="alert">{Object.values(screen.errors).join(" ")} Invalid filters are not applied.</p>}
    <div className={s.discoveryMeta}><div><strong>{screen.rows.length} portfolios</strong><span>{screen.ready} snapshots ready</span>{busy && <span role="status">Loading {snapshots.progress.completed}/{snapshots.progress.total}</span>}{screen.failed > 0 && <span>{screen.failed} with coverage gaps</span>}</div><div className={s.actions}>{busy ? <button type="button" onClick={snapshots.cancel}>Pause loading</button> : <button type="button" disabled={!screen.candidates.length} onClick={() => snapshots.load(screen.candidates.map((fund: any) => fund.ticker), settings.reportMap)}><ArrowDownWideNarrow size={14} />Load all matches</button>}<button type="button" disabled={!screen.rows.length} onClick={() => download("fund-screen.csv", fundScreenerCsv(screen.rows, settings))}><Download size={14} />Export</button></div></div>
    {visibleFunds.length ? settings.layout === "table" ? <div className={s.tableScroll}><table><caption>Historical SEC portfolios. Series net assets may include multiple share classes; dates differ by fund.</caption><thead><tr><th scope="col">Fund</th><th scope="col">Portfolio net assets</th><th scope="col">Top 10 / NAV</th><th scope="col">Positions</th><th scope="col">Portfolio date</th><th scope="col">Coverage</th><th scope="col">Compare</th></tr></thead><tbody>{visibleFunds.map((fund: any) => { const facts = fundSnapshotFacts(fund.state); return <tr key={fund.ticker} data-selected={selected.includes(fund.ticker)}><th scope="row"><Link prefetch={false} href={portfolioHref(fund, settings.reportMap)}>{fund.ticker}<ArrowUpRight size={12} /></Link><span>{fund.name}</span></th><td>{money(facts?.netAssets)}</td><td>{pct(facts?.concentration)}</td><td>{number(facts?.positions)}</td><td>{facts?.asOf || "—"}{facts && <small>Filed {facts.filingDate}</small>}</td><td><span className={s.statusPill} data-status={fund.state.status}>{stateLabel(fund)}</span>{!facts && <button type="button" className={s.textButton} disabled={fund.state.status === "loading"} onClick={() => snapshots.load([fund.ticker], settings.reportMap, true)}>Load {fund.ticker}</button>}</td><td>{selectButton(fund)}</td></tr>; })}</tbody></table></div> : <div className={s.explorer}>
      <div className={s.fundPicker}><div className={s.pickerHeading}><h2>Choose a portfolio</h2><span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, screen.rows.length)} of {screen.rows.length}</span></div><div className={s.fundGrid}>{visibleFunds.map((fund: any) => { const facts = fundSnapshotFacts(fund.state); return <div className={s.fundOption} key={fund.ticker} data-tone={fundTone(fund.category)} data-active={fund.ticker === focusFund?.ticker}><button type="button" className={s.fundChoice} aria-pressed={fund.ticker === focusFund?.ticker} aria-label={`Explore ${fund.ticker} portfolio`} onClick={() => setFocusTicker(fund.ticker)}><span className={s.fundIdentity}><strong>{fund.ticker}</strong><ArrowUpRight size={15} /></span><span className={s.fundName}>{fund.name}</span><span className={s.fundFocus}>{fund.focus}</span><span className={s.fundMiniMetric}>{facts ? <><b>{money(facts.netAssets)}</b><span>net assets</span></> : <span className={s.loadStatus} data-status={fund.state.status}>{stateLabel(fund)}</span>}</span>{facts && <span className={s.fundMiniDate}>{facts.asOf}</span>}</button>{selectButton(fund)}</div>; })}</div><p className={s.pickerNote}>Select a fund to look inside.<br />Use <Plus size={12} /> to add it to a comparison.</p></div>
      {focusFund && <FundPortfolioPreview fund={focusFund} selected={selected} onSelect={onSelect} snapshots={snapshots} reportMap={settings.reportMap} shelf={shelf} />}
    </div> : <div className={s.empty}><Search size={25} /><h2>No portfolios match this view.</h2><p>{screen.candidates.length ? "Load matching snapshots to apply numeric filters, or broaden your selection." : "Try another name or strategy, or add a fund using its ticker above."}</p><button type="button" onClick={clear}>Reset filters</button></div>}
    <div className={s.explorerFooter}><p>Historical portfolios, not live holdings. Curated strategy labels help you browse.</p><nav className={s.pagination} aria-label="Fund results pages"><button type="button" aria-label="Previous funds" disabled={page === 0} onClick={() => setPageChoice({ key: pageKey, page: page - 1 })}><ChevronLeft size={15} /></button><span>{page + 1} / {pageCount}</span><button type="button" aria-label="Next funds" disabled={page >= pageCount - 1} onClick={() => setPageChoice({ key: pageKey, page: page + 1 })}><ChevronRight size={15} /></button></nav></div>
    <details className={s.method}><summary>How to read these portfolios</summary><p>Net assets belong to the SEC fund series and may combine share classes. Position counts and asset categories come from the complete report, even when only leading positions are shown. Top-10 concentration sums the largest positive reported position weights; incomplete weight coverage remains visible. Weights use net asset value and can exceed 100% or be negative. Derivative fair values do not measure notional exposure. Portfolio dates and filing dates differ, and unavailable values never become zero.</p></details>
  </section>;
}
