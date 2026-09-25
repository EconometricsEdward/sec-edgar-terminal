"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { recentFundFilings } from "../../utils/fundRecentFilings.js";
import { validFundTicker } from "../../utils/fundWorkspaceSettings.js";
import FundSearchBox from "./FundSearchBox";
import s from "./NportResearch.module.css";

export default function FundRecentFilings({ settings, onPatch, snapshots }: any) {
  const loadSnapshots = snapshots.load;
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const focused = validFundTicker(settings.query.toUpperCase()) ? settings.query.toUpperCase() : "";
  const tickers: string[] = [...new Set<string>([...(focused ? [focused] : []), ...settings.tickers])];
  if (!tickers.length) tickers.push("VOO");
  const key = tickers.join(",");
  useEffect(() => { void loadSnapshots(key.split(",")); }, [key, loadSnapshots]);
  const rows = tickers.flatMap(ticker => {
    const fund = snapshots.states[`${ticker}:latest`]?.data;
    return recentFundFilings(fund).map((report: any) => ({ ...report, ticker, name: fund.name, cik: fund.cik }));
  }).sort((a, b) => b.filingDate.localeCompare(a.filingDate) || a.ticker.localeCompare(b.ticker));
  return <section className={s.filings} aria-label="N-PORT filings from the past year"><header className={s.sectionHeader}><div><p className={s.eyebrow}>SEC N-PORT · past 12 months</p><h2>Recent filings</h2><p>Newest filings first for {tickers.join(", ")}. Open a portfolio or its original SEC filing.</p></div></header>
    <FundSearchBox value={query} onChange={setQuery} mode="fund" label="Find a fund’s recent filings" placeholder="Search a fund name or ticker…" onChoose={item => { onPatch({ query: item.ticker }); setQuery(""); setNotice(""); }} onSubmit={value => { const ticker = value.toUpperCase(); if (validFundTicker(ticker) && ticker.length <= 6) { onPatch({ query: ticker }); setQuery(""); } else setNotice("Choose a matching fund or enter its exact ticker."); }} />
    {notice && <p role="status">{notice}</p>}
    {tickers.map(ticker => { const state = snapshots.states[`${ticker}:latest`]; return !state || state.status === "loading" ? <p role="status" key={ticker}>Loading {ticker} filings…</p> : state.status !== "ready" ? <p role="status" className={s.notice} key={ticker}>{ticker}: {state.error || "Filings unavailable."} <button type="button" onClick={() => snapshots.load([ticker], {}, true)}>Retry</button></p> : !recentFundFilings(state.data).length ? <p key={ticker}>No N-PORT filings in the past year were returned for {ticker}.</p> : null; })}
    {rows.length > 0 && <div className={s.matrixScroll}><table className={s.filingsTable}><thead><tr><th scope="col">Filed</th><th scope="col">Fund</th><th scope="col">Portfolio date</th><th scope="col">Form</th><th scope="col">Report</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.ticker}:${row.accession}`}><td>{row.filingDate}</td><th scope="row">{row.ticker}<small>{row.name}</small></th><td>{row.reportDate || "Unlisted"}</td><td>{row.form}</td><td><Link prefetch={false} href={`/fund/${row.ticker}?accession=${row.accession}`}>View portfolio ↗</Link><a href={`https://www.sec.gov/Archives/edgar/data/${Number(row.cik)}/${row.accession.replaceAll("-", "")}/${row.accession}-index.html`} target="_blank" rel="noreferrer">SEC filing ↗</a></td></tr>)}</tbody></table></div>}
  </section>;
}
