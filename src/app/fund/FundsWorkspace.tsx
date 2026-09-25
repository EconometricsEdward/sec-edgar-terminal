"use client";
import { Activity, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, Layers3, Share2, X } from "lucide-react";
import { normalizeFundWorkspaceSettings, readFundWorkspaceSettings, fundWorkspacePath, validFundTicker } from "../../utils/fundWorkspaceSettings.js";
import useFundSnapshots from "./useFundSnapshots";
import FundExplorer from "./FundExplorer";
import FundSearchBox from "./FundSearchBox";
import base from "./fund.module.css";
import s from "./NportResearch.module.css";

const loading = () => <p role="status" className={s.loading}>Opening fund research…</p>;
const FundComparison = dynamic(() => import("./FundComparison"), { loading });
const FundSecurityFinder = dynamic(() => import("./FundSecurityFinder"), { loading });
const GlobalSecurityFinder = dynamic(() => import("./GlobalSecurityFinder"), { loading });
const FundRecentFilings = dynamic(() => import("./FundRecentFilings"), { loading });
const ThirteenFWorkspace = dynamic(() => import("./ThirteenFWorkspace"), { loading });
const views = [["discover", "Explore funds"], ["security", "Find a holding"], ["compare", "Compare funds"], ["filings", "Recent filings"]];

export default function FundsWorkspace() {
  const params = useSearchParams();
  const [settings, setSettings] = useState<any>(() => readFundWorkspaceSettings(params.toString()));
  const [tickerDraft, setTickerDraft] = useState("");
  const [message, setMessage] = useState("");
  const [visited, setVisited] = useState<string[]>([settings.view]);
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
  function toggle(ticker: string) {
    setMessage("");
    if (settings.tickers.includes(ticker)) patch({ tickers: settings.tickers.filter((value: string) => value !== ticker) });
    else if (settings.tickers.length < 4) patch({ tickers: [...settings.tickers, ticker] });
    else setMessage("Choose up to four funds. Remove a selection before adding another.");
  }
  function addTicker(value: string) {
    const ticker = value.trim().toUpperCase();
    if (!validFundTicker(ticker)) { setMessage("Choose a matching fund or enter an exact fund ticker."); return; }
    if (settings.tickers.includes(ticker)) { setMessage(`${ticker} is already selected.`); return; }
    if (settings.tickers.length >= 4) { setMessage("Four funds are selected. Remove one before adding another."); return; }
    patch({ tickers: [...settings.tickers, ticker] });
    setTickerDraft(""); setMessage("");
  }
  function openView(view: string) {
    setVisited(current => current.includes(view) ? current : [...current, view]);
    patch({ view }); setMessage("");
  }
  const common = { tickers: settings.tickers, settings, onPatch: patch, onFunds: snapshots.ingest };
  const sourceSwitch = <nav className={s.sourceSwitch} aria-label="Portfolio reporting source">
    <button type="button" aria-pressed={settings.view !== "13f"} onClick={() => openView("discover")}><Layers3 size={17} /><span>Fund portfolios</span><small>N-PORT</small></button>
    <button type="button" aria-pressed={settings.view === "13f"} onClick={() => openView("13f")}><span>Institutional managers</span><small>13F</small></button>
  </nav>;
  if (settings.view === "13f") return <div className={`${base.page} ${s.workspace}`}>{sourceSwitch}<ThirteenFWorkspace settings={settings} onPatch={patch} /></div>;
  const panels: any = {
    discover: <FundExplorer settings={settings} onPatch={patch} snapshots={snapshots} onSelect={toggle} />,
    security: <><div className={s.filterPills} role="group" aria-label="Security search scope"><button type="button" aria-pressed={settings.securityScope !== "selected"} onClick={() => patch({ securityScope: "all" })}>Across all funds</button><button type="button" aria-pressed={settings.securityScope === "selected"} onClick={() => patch({ securityScope: "selected" })}>Selected funds ({settings.tickers.length})</button></div>{settings.securityScope === "selected" ? <FundSecurityFinder {...common} settings={{ ...settings, securityAsset: settings.securityAsset === "all" ? "" : settings.securityAsset }} /> : <GlobalSecurityFinder settings={settings} onPatch={patch} onAddFund={addTicker} selectedTickers={settings.tickers} />}</>,
    compare: settings.tickers.length >= 2 ? <FundComparison {...common} /> : null,
    filings: <FundRecentFilings settings={settings} onPatch={patch} snapshots={snapshots} />,
  };
  return <div className={`${base.page} ${s.workspace}`}>
    {sourceSwitch}
    <header className={s.workspaceHeader}><div><p className={s.eyebrow}>SEC N-PORT research</p><h1>Inside the fund</h1></div><p>Find portfolios. Compare holdings. Follow the source.</p></header>
    <nav className={s.nav} aria-label="Fund workspace tools">{views.map(([view, label]) => <button type="button" key={view} aria-current={settings.view === view ? "page" : undefined} aria-pressed={settings.view === view} onClick={() => openView(view)}>{label}{view === "compare" && settings.tickers.length > 0 && <small>{settings.tickers.length}</small>}</button>)}</nav>
    {(settings.tickers.length > 0 || settings.view === "compare") && <section className={s.selection} aria-label="Funds selected for comparison"><div className={s.selectionHeading}><strong>Your comparison</strong><span>{settings.tickers.length} / 4 funds</span></div><div className={s.selectedFunds}>{settings.tickers.map((ticker: string, index: number) => <div className={s.selectedFund} key={ticker} data-color={index}><Link prefetch={false} href={`/fund/${ticker}`}>{ticker}</Link><button type="button" aria-label={`Remove ${ticker} from comparison`} onClick={() => toggle(ticker)}><X size={14} /></button></div>)}</div><div className={s.addFundSearch}><FundSearchBox value={tickerDraft} onChange={setTickerDraft} onChoose={item => addTicker(item.ticker)} onSubmit={addTicker} mode="fund" compact label="Add a fund to comparison" placeholder="Add fund…" /></div><button type="button" aria-label="Copy fund comparison link" onClick={async () => { try { await navigator.clipboard.writeText(new URL(fundWorkspacePath({ ...settings, view: "compare", reportMap: {} }), window.location.origin).href); setMessage("Comparison link copied."); } catch { setMessage("Copy failed. Share the address bar URL."); } }}><Share2 size={16} /></button>{settings.view !== "compare" && <button type="button" className={s.primary} disabled={settings.tickers.length < 2} onClick={() => openView("compare")}>Compare <ArrowRight size={15} /></button>}</section>}
    {message && <p role="status" className={s.notice}>{message}</p>}
    {views.map(([view]) => (visited.includes(view) || view === settings.view) && <Activity key={view} mode={settings.view === view ? "visible" : "hidden"}><div className={s.panel}>{panels[view] || <section className={s.empty}><Layers3 size={28} /><h2>Choose funds to compare</h2><p>Add two to four fund tickers above. Every selected fund appears in one comparison with NAV, shared holdings, and position values.</p><button type="button" onClick={() => openView("discover")}>Explore funds <ArrowRight size={15} /></button></section>}</div></Activity>)}
  </div>;
}
