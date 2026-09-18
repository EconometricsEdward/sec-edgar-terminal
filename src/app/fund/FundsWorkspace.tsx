"use client";
import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, ArrowUpRight, Layers3, Plus, RefreshCw, Share2, X } from "lucide-react";
import { normalizeFundWorkspaceSettings, readFundWorkspaceSettings, fundWorkspacePath, validFundTicker } from "../../utils/fundWorkspaceSettings.js";
import { fundUniverse, screenFunds } from "../../utils/fundScreener.js";
import { useFundShelf } from "./fundUi";
import useFundSnapshots from "./useFundSnapshots";
import FundScreener from "./FundScreener";
import base from "./fund.module.css";
import s from "./FundWorkspace.module.css";

const loading = () => <p role="status" className={s.notice}>Opening this fund tool…</p>;
const FundComparison = dynamic(() => import("./FundComparison"), { loading });
const FundSecurityFinder = dynamic(() => import("./FundSecurityFinder"), { loading });
const GlobalSecurityFinder = dynamic(() => import("./GlobalSecurityFinder"), { loading });
const FundAllocationLab = dynamic(() => import("./FundAllocationLab"), { loading });
const FundChanges = dynamic(() => import("./FundChanges"), { loading });
const ThirteenFWorkspace = dynamic(() => import("./ThirteenFWorkspace"), { loading });
const views = [["discover", "Explore funds"], ["security", "Find a holding"], ["compare", "Compare"], ["allocation", "Build a mix"], ["changes", "Report changes"]];

export default function FundsWorkspace() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<any>(() => readFundWorkspaceSettings(params.toString()));
  const [tickerDraft, setTickerDraft] = useState("");
  const [message, setMessage] = useState("");
  const [visited, setVisited] = useState<string[]>([settings.view]);
  const shelf = useFundShelf();
  const snapshots = useFundSnapshots();
  const queryString = params.toString();
  useEffect(() => {
    const read = () => setSettings(readFundWorkspaceSettings(window.location.search));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    const path = fundWorkspacePath(settings);
    if (window.location.pathname + window.location.search !== path) window.history.replaceState(null, "", path);
  }, [settings]);
  const lastQuery = useRef(queryString);
  useEffect(() => {
    if (lastQuery.current === queryString) return;
    lastQuery.current = queryString;
    const incoming = readFundWorkspaceSettings(queryString);
    setSettings((current: any) => fundWorkspacePath(current) === fundWorkspacePath(incoming) ? current : incoming);
  }, [queryString]);
  const patch = useCallback((next: any) => {
    setSettings((current: any) => normalizeFundWorkspaceSettings({ ...current, ...next }));
    return true;
  }, []);
  const universe = useMemo(() => fundUniverse(shelf.saved, settings.tickers, snapshots.states, settings.reportMap), [shelf.saved, settings.tickers, snapshots.states, settings.reportMap]);
  const screen = useMemo(() => screenFunds(universe, settings, shelf.saved), [universe, settings, shelf.saved]);
  function toggle(ticker: string) {
    if (settings.tickers.includes(ticker)) patch({ tickers: settings.tickers.filter((value: string) => value !== ticker) });
    else if (settings.tickers.length < 4) patch({ tickers: [...settings.tickers, ticker] });
    else setMessage("Choose up to four funds. Remove a selection before adding another.");
  }
  function addTicker() {
    const ticker = tickerDraft.trim().toUpperCase();
    if (!validFundTicker(ticker)) { setMessage("Enter a fund ticker, such as VOO or SCHD. Use Explore funds to search names and strategies."); return; }
    if (settings.tickers.includes(ticker)) { setMessage(`${ticker} is already selected.`); return; }
    if (settings.tickers.length >= 4) { setMessage("Four funds are selected. Remove one before adding another."); return; }
    patch({ tickers: [...settings.tickers, ticker], ...(settings.view === "discover" ? { query: ticker, category: "All funds", family: "", coverage: "all", minAssets: "", maxConcentration: "", maxAge: "" } : {}) });
    setTickerDraft("");
    setMessage(`${ticker} added. Its portfolio identity is checked against SEC records.`);
  }
  function openView(view: string) {
    setVisited(current => current.includes(view) ? current : [...current, view]);
    patch({ view });
    setMessage("");
  }
  const common = { tickers: settings.tickers, settings, onPatch: patch, onFunds: snapshots.ingest };
  function addDiscoveredFund(ticker: string, accession: string) {
    if (settings.tickers.includes(ticker)) { setMessage(`${ticker} is already selected.`); return; }
    if (settings.tickers.length >= 4) { setMessage("Four funds are selected. Remove one before adding another."); return; }
    patch({ tickers: [...settings.tickers, ticker], reportMap: { ...settings.reportMap, [ticker]: accession } });
    setMessage(`${ticker} added with the report shown.`);
  }
  const sourceSwitch = <nav className={s.sourceSwitch} aria-label="Portfolio reporting source">
    <button type="button" aria-pressed={settings.view !== "13f"} onClick={() => openView("discover")}><Layers3 size={16} /><span>Fund portfolios</span><small>N-PORT</small></button>
    <button type="button" aria-pressed={settings.view === "13f"} onClick={() => openView("13f")}><span>Institutional managers</span><small>13F</small></button>
  </nav>;
  if (settings.view === "13f") return <div className={`${base.page} ${s.workspace}`}>{sourceSwitch}<ThirteenFWorkspace settings={settings} onPatch={patch} /></div>;
  const panels: any = {
    discover: <FundScreener screen={screen} settings={settings} onPatch={patch} shelf={shelf} snapshots={snapshots} onSelect={toggle} families={[...new Set(universe.map((fund: any) => fund.family))]} />,
    security: <>
      <div className={s.securityScope} role="group" aria-label="Security search scope">
        <button type="button" aria-pressed={settings.securityScope !== "selected"} onClick={() => patch({ securityScope: "all" })}>All funds</button>
        <button type="button" aria-pressed={settings.securityScope === "selected"} onClick={() => patch({ securityScope: "selected" })}>Selected funds ({settings.tickers.length})</button>
      </div>
      {settings.securityScope === "selected" ? <FundSecurityFinder {...common} settings={{ ...settings, securityAsset: settings.securityAsset === "all" ? "" : settings.securityAsset }} /> : <GlobalSecurityFinder settings={settings} onPatch={patch} onAddFund={addDiscoveredFund} selectedTickers={settings.tickers} />}
    </>,
    compare: settings.tickers.length >= 2 ? <FundComparison {...common} /> : null,
    allocation: settings.tickers.length ? <FundAllocationLab {...common} /> : null,
    changes: settings.tickers.length ? <FundChanges {...common} /> : null,
  };
  return <div className={`${base.page} ${s.workspace}`}>
    {sourceSwitch}
    <header className={s.hero}>
      <div><p className={s.eyebrow}>Inside the portfolio · SEC N-PORT</p><h1>Know what your <em>fund holds.</em></h1><p className={s.lead}>Explore the positions behind the ticker. See concentration, find common holdings, and compare reported portfolios.</p></div>
      <div className={s.heroAside}><span className={s.sourceNote}><i /> Original SEC disclosures</span><p>Portfolio dates. Reported weights.<br />A source behind every snapshot.</p><a href="#fund-report-directory">Browse fund reports <ArrowUpRight size={14} /></a></div>
    </header>
    <div className={s.workspaceBar}>
      <nav className={s.nav} aria-label="Fund workspace tools">{views.map(([view, label]) => <button type="button" key={view} aria-current={settings.view === view ? "page" : undefined} aria-pressed={settings.view === view} onClick={() => openView(view)}>{label}{view === "compare" && settings.tickers.length > 0 && <small>{settings.tickers.length}</small>}</button>)}</nav>
      <form onSubmit={e => { e.preventDefault(); addTicker(); }} className={s.addForm}><label htmlFor="fund-add-ticker" className={s.srOnly}>Add a fund ticker to research</label><input id="fund-add-ticker" value={tickerDraft} onChange={e => setTickerDraft(e.target.value)} placeholder="Add any ticker" maxLength={15} /><button type="submit" aria-label="Add fund ticker"><Plus size={16} /></button></form>
    </div>
    {(message || shelf.storageError) && <p role="status" className={s.notice}>{shelf.storageError || message}</p>}
    {views.map(([view]) => (visited.includes(view) || view === settings.view) && <Activity key={view} mode={settings.view === view ? "visible" : "hidden"}><div className={s.panel}>{panels[view] || <section className={s.empty}><Layers3 size={28} /><h2>{view === "compare" ? "Put two portfolios side by side." : "Start with a fund."}</h2><p>{view === "compare" ? "Choose up to four funds to reveal their shared positions and differences." : "Select a fund from the explorer or add its ticker above."}</p><button type="button" onClick={() => openView("discover")}>Explore funds <ArrowRight size={14} /></button></section>}</div></Activity>)}
    {settings.tickers.length > 0 && <section className={s.selection} aria-label="Funds selected for comparison">
      <div className={s.selectionLabel}><strong>Your comparison</strong><small>{settings.tickers.length} of 4 funds</small></div>
      <div className={s.selectionDetail}>{settings.tickers.map((ticker: string) => <div className={s.selectedFund} key={ticker}><Link prefetch={false} href={`/fund/${ticker}${settings.reportMap[ticker] ? `?accession=${settings.reportMap[ticker]}` : ""}`}>{ticker}</Link><span>{settings.reportMap[ticker] ? "Selected report" : "Latest report"}</span><button type="button" aria-label={`Remove ${ticker} from comparison`} onClick={() => toggle(ticker)}><X size={13} /></button></div>)}</div>
      <div className={s.selectionActions}>{Object.keys(settings.reportMap).length > 0 && <button type="button" onClick={() => { patch({ reportMap: {}, changeAfter: "", changeBefore: "" }); setMessage("Report selections cleared. Using the latest available reports."); }} title="Use latest available reports"><RefreshCw size={14} /><span>Latest reports</span></button>}<button type="button" aria-label="Copy fund comparison link" onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); setMessage("Link copied with your selected funds and report settings."); } catch { setMessage("Copy failed. You can share the address bar URL."); } }}><Share2 size={14} /></button><button className={s.primaryButton} type="button" disabled={settings.tickers.length < 2} onClick={() => openView("compare")}>Compare funds <ArrowRight size={14} /></button></div>
    </section>}
  </div>;
}
