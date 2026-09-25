"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Plus, RefreshCw } from "lucide-react";
import { FUND_CATALOG } from "../../utils/fundResearch.js";
import { validFundTicker } from "../../utils/fundWorkspaceSettings.js";
import { money, number, pct } from "./fundUi";
import FundSearchBox, { type FundSuggestion } from "./FundSearchBox";
import s from "./NportResearch.module.css";

export default function FundExplorer({ settings, onPatch, snapshots, onSelect }: any) {
  const loadSnapshots = snapshots.load;
  const [query, setQuery] = useState(settings.query || "");
  const [category, setCategory] = useState("US equity");
  const [notice, setNotice] = useState("");
  const focus = validFundTicker(settings.query.toUpperCase()) ? settings.query.toUpperCase() : "VOO";
  const state = snapshots.states[`${focus}:latest`];
  const fund = state?.data?.status === "ready" ? state.data : null;
  const selected = settings.tickers.includes(focus);
  useEffect(() => { setQuery(settings.query || ""); }, [settings.query]);
  useEffect(() => { void loadSnapshots([focus]); }, [focus, loadSnapshots]);
  const choose = (item: FundSuggestion) => {
    setNotice("");
    if (item.kind === "company") onPatch({ view: "security", securityScope: "all", securityQuery: item.ticker });
    else { setQuery(item.ticker); onPatch({ query: item.ticker }); }
  };
  const submit = (value: string) => {
    const ticker = value.trim().toUpperCase();
    if (validFundTicker(ticker) && ticker.length <= 6) choose({ ticker, name: ticker, kind: "fund" });
    else setNotice("Choose a matching fund below the search box, or enter its exact ticker. Company results open Find a holding.");
  };
  const suggestions = FUND_CATALOG.filter(f => f.category === category).filter(f => !["SPY", "QQQ"].includes(f.ticker));
  return <section className={s.explore} aria-label="Explore fund portfolios">
    <div className={s.exploreSearch}><div><h2>Find a fund. Look inside.</h2><p>Search the SEC fund directory by ticker or name. Choose a company to find funds that hold it.</p></div><FundSearchBox value={query} onChange={setQuery} onChoose={choose} onSubmit={submit} />{notice && <p role="status" className={s.notice}>{notice}</p>}</div>
    <div className={s.browseRow}><span>Browse funds</span><div className={s.filterPills}>{["US equity", "International", "Fixed income"].map(c => <button type="button" key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</div></div>
    <div className={s.quickFunds}>{suggestions.map(item => <button type="button" key={item.ticker} aria-pressed={focus === item.ticker} onClick={() => choose({ ...item, kind: "fund" })}><strong>{item.ticker}</strong><span>{item.name}</span><small>{item.focus}</small></button>)}</div>
    <article className={s.fundProfile} aria-label={`${focus} fund overview`} aria-busy={!state || state.status === "loading"}>
      <header className={s.profileHeading}><div><span className={s.eyebrow}>Individual fund · latest public portfolio</span><h2><strong>{focus}</strong><span>{fund?.name || FUND_CATALOG.find(f => f.ticker === focus)?.name || "Fund portfolio"}</span></h2>{fund && <p>{fund.registrant}</p>}</div><div className={s.actions}><button type="button" className={s.primary} disabled={!selected && settings.tickers.length >= 4} aria-pressed={selected} onClick={() => onSelect(focus)}>{selected ? <Check size={16} /> : <Plus size={16} />}{selected ? "In comparison" : "Add to comparison"}</button><Link prefetch={false} href={`/fund/${focus}`} className={s.actionLink}>Full portfolio <ArrowUpRight size={15} /></Link></div></header>
      {fund ? <>
        <div className={s.profileMetrics}><div className={s.mainMetric}><span>Net asset value · NAV</span><strong>{money(fund.fundInfo.netAssets)}</strong><small>Total net assets of the fund series</small></div><div><span>Reported holdings</span><strong>{number(fund.summary.count)}</strong><small>{money(fund.summary.value)} in reported value</small></div><div><span>Top 10 / NAV</span><strong>{pct(fund.summary.top10Weight)}</strong><small>Largest positive position weights</small></div><div><span>Portfolio date</span><strong className={s.dateValue}>{fund.asOf}</strong><small>Filed {fund.filingDate}</small></div></div>
        {state?.error && <p role="status" className={s.notice}>{state.error}</p>}
        <div className={s.previewHoldings}><div className={s.holdingsHeader}><div><h3>Largest holdings</h3><p>Position size as a share of NAV and in US dollars.</p></div><Link prefetch={false} href={`/fund/${focus}?tab=holdings`}>View all {number(fund.summary.count)} positions <ArrowUpRight size={15} /></Link></div>
          <div className={s.matrixScroll}><table className={s.previewTable}><thead><tr><th scope="col">Holding</th><th scope="col">% of NAV</th><th scope="col">Value</th></tr></thead><tbody>{(fund.topHoldings || []).map((holding: any, index: number) => <tr key={holding.id}><th scope="row"><span className={s.rank}>{String(index + 1).padStart(2, "0")}</span>{holding.name}</th><td><div className={s.weightCell}><span>{pct(holding.pctOfNav)}</span><div aria-hidden="true"><i style={{ width: `${Math.min(100, Math.abs(holding.pctOfNav || 0))}%` }} /></div></div></td><td title={holding.value?.toLocaleString("en-US", { style: "currency", currency: "USD" })}>{money(holding.value)}</td></tr>)}</tbody></table></div>
        </div>
        <footer className={s.profileFooter}><p>Series NAV can include multiple share classes. Holdings are historical SEC disclosures.</p><div><button type="button" onClick={() => onPatch({ view: "filings", query: focus })}>Filings · past year</button><a href={fund.sourceUrl} target="_blank" rel="noreferrer">Original SEC report ↗</a><button type="button" disabled={state.refreshing} aria-label={`Refresh ${focus} portfolio`} onClick={() => snapshots.load([focus], {}, true)}><RefreshCw size={16} /></button></div></footer>
      </> : <div className={s.loading} role="status">{!state || ["loading", "idle"].includes(state.status) ? `Loading ${focus}’s portfolio, NAV, and largest holdings…` : <><strong>Portfolio unavailable for {focus}</strong><p>{state.error || state.data?.reason || "A public N-PORT portfolio could not be verified."}</p><button type="button" onClick={() => snapshots.load([focus], {}, true)}><RefreshCw size={15} /> Retry report</button></>}</div>}
    </article>
  </section>;
}
