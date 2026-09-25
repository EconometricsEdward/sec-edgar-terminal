"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Download, RefreshCw } from "lucide-react";
import { money, number, pct } from "./fundUi";
import { securityWeight } from "../../utils/fundSecuritySearch.js";
import s from "./NportResearch.module.css";

export default function FundComparison({ tickers, settings = {}, onPatch = () => {}, onFunds }: {
  tickers: string[]; settings?: any; onPatch?: (patch: Record<string, unknown>) => void; onFunds?: (funds: any[]) => void;
}) {
  const [payload, setPayload] = useState<{ key: string; data: any } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0), [pageState, setPage] = useState({ key: "", page: 1 });
  const [draft, setDraft] = useState(settings.comparisonQuery || "");
  const callbacks = useRef({ onFunds, onPatch });
  useEffect(() => { callbacks.current = { onFunds, onPatch }; }, [onFunds, onPatch]);
  useEffect(() => { setDraft(settings.comparisonQuery || ""); }, [settings.comparisonQuery]);
  useEffect(() => { if (draft === (settings.comparisonQuery || "")) return; const timer = setTimeout(() => callbacks.current.onPatch({ comparisonQuery: draft }), 350); return () => clearTimeout(timer); }, [draft, settings.comparisonQuery]);
  // Always start from each fund's latest public report. Old shared date selections
  // remain navigable on individual fund pages, but do not pin this comparison.
  const base = new URLSearchParams({ mode: "compare-all", tickers: tickers.join(","), scope: settings.comparisonScope || "all", q: settings.comparisonQuery || "", sort: settings.comparisonSort || "shared", fund: settings.comparisonFund || "" }).toString();
  const page = pageState.key === base ? pageState.page : 1;
  const key = `${base}&page=${page}&attempt=${attempt}`;
  const data = payload?.key === key ? payload.data : null;
  const meta = payload?.data.funds?.filter((fund: any) => tickers.includes(fund.ticker)) || [];
  const currentError = error?.key === key ? error.message : "";
  useEffect(() => {
    if (tickers.length < 2) return;
    const controller = new AbortController();
    fetch(`/api/fund-workspace?${base}&page=${page}`, { signal: controller.signal })
      .then(async res => { const json = await res.json(); if (!res.ok) throw new Error(json.error || "Comparison could not be loaded."); return json; })
      .then(json => { if (!controller.signal.aborted) { setPayload({ key, data: json }); callbacks.current.onFunds?.(json.funds); } })
      .catch(error => { if (!controller.signal.aborted) setError({ key, message: error.message }); });
    return () => controller.abort();
  }, [base, page, key, tickers.length]);
  const result = data?.result;
  const funds = data?.funds || meta;
  const maxNav = Math.max(1, ...funds.map((f: any) => f.fundInfo?.netAssets || 0));
  const counts = result?.counts;
  const scopes = [["all", "All holdings", counts?.total], ["every", "In every fund", counts?.every], ["shared", "In 2+ funds", counts?.shared], ["unique", "In one fund", counts?.unique], ["unmatched", "Unmatched IDs", counts?.unmatched]];
  return <section className={s.comparison} aria-label="Compare all selected funds">
    <header className={s.sectionHeader}><div><p className={s.eyebrow}>All {tickers.length} selected funds</p><h2>What do they hold in common?</h2><p>Compare portfolio size and every holding across the latest available reports.</p></div><div className={s.actions}><button type="button" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={15} /> Retry reports</button><a href={`/api/fund-workspace?${base}&format=csv`} className={s.actionLink}><Download size={15} /> Export comparison</a></div></header>
    <div className={s.fundCards} style={{ "--fund-count": tickers.length } as React.CSSProperties}>
      {tickers.map((ticker, index) => {
        const fund = funds.find((f: any) => f.ticker === ticker), failure = data?.errors?.find((f: any) => f.ticker === ticker);
        return <article key={ticker} className={s.navCard} data-color={index}>
          <div className={s.cardHeading}><Link prefetch={false} href={`/fund/${ticker}`}>{ticker} <ArrowUpRight size={16} /></Link><span>{fund ? `${number(fund.summary?.count)} positions` : failure ? "Report unavailable" : "Loading report…"}</span></div>
          <p className={s.fundName}>{fund?.name || ticker}</p><span className={s.metricLabel}>Net asset value · NAV</span><strong className={s.navValue}>{fund ? money(fund.fundInfo?.netAssets) : "—"}</strong>
          <div className={s.navTrack} aria-hidden="true"><i style={{ width: `${Math.max(0, (fund?.fundInfo?.netAssets || 0) / maxNav * 100)}%` }} /></div>
          {fund && <div className={s.cardFacts}><span>Top 10 <b>{pct(fund.summary?.top10Weight)}</b></span><span>Holdings value <b>{money(fund.summary?.value)}</b></span></div>}
          {fund && <div className={s.sourceLine}><span>Portfolio {fund.asOf}</span><a href={fund.sourceUrl} target="_blank" rel="noreferrer">SEC source ↗</a></div>}
          {failure && <p className={s.error}>{failure.message}</p>}
        </article>;
      })}
    </div>
    <p className={s.caption}>NAV is the fund series’ total net assets, which may cover multiple share classes; it is not a price per share. Portfolio dates can differ.</p>
    {result?.sharedSeries?.map((group: string[]) => <p role="status" className={s.notice} key={group.join(",")}>{group.join(" and ")} share one SEC fund portfolio. Their NAV and holdings are not independent assets.</p>)}
    {data?.errors?.length > 0 && <p role="status" className={s.notice}>Showing {data.funds.length} of {tickers.length} reports. Unavailable funds remain visible; “in every fund” and “in one fund” cannot be confirmed until every report loads.</p>}
    <div className={s.comparisonSummary}>
      <div><strong>{counts ? number(counts.every) : "—"}</strong><span>holdings in every fund</span></div><div><strong>{counts ? number(counts.shared) : "—"}</strong><span>holdings in at least two</span></div><div><strong>{counts ? number(counts.unique) : "—"}</strong><span>holdings found in one fund</span></div>
    </div>
    <div className={s.holdingsHeader}><div><h3>Holdings side by side</h3><p>Each column is a selected fund. Each cell shows its NAV weight and holding value.</p></div></div>
    <div className={s.filterPills} role="group" aria-label="Holdings present in selected funds">{scopes.map(([scope, label, count]) => <button type="button" key={scope} aria-pressed={(settings.comparisonScope || "all") === scope} onClick={() => onPatch({ comparisonScope: scope })}>{label}{count != null && <span>{number(count)}</span>}</button>)}</div>
    <div className={s.tableControls}><label className={s.holdingFilter}>Search holdings<input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Name, ticker, CUSIP or ISIN" /></label><label>Held by<select value={settings.comparisonFund || ""} onChange={event => onPatch({ comparisonFund: event.target.value })}><option value="">Any selected fund</option>{tickers.map(t => <option key={t}>{t}</option>)}</select></label><label>Sort holdings<select value={settings.comparisonSort || "shared"} onChange={event => onPatch({ comparisonSort: event.target.value })}><option value="shared">Most funds in common</option><option value="weight">Largest NAV weight</option><option value="value">Largest holding value</option><option value="name">Holding name</option></select></label></div>
    {currentError && <p role="alert" className={s.notice}>{currentError} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry comparison</button></p>}
    {!data && !currentError && <p role="status" className={s.loading}>Loading the latest portfolios and matching holdings across all selected funds…</p>}
    {data && <><div className={s.matrixScroll} tabIndex={0} role="region" aria-label="All-fund holdings comparison table"><table className={s.holdingsMatrix}>
      <thead><tr><th scope="col">Holding <small>Reported security</small></th><th scope="col">Held by</th>{tickers.map((ticker, index) => <th scope="col" key={ticker} data-color={index}><span>{ticker}</span><small>% of NAV / USD value</small></th>)}</tr></thead>
      <tbody>{result.rows.map((row: any) => <tr key={row.key}><th scope="row"><strong>{row.name}</strong><small>{row.ids.join(" · ") || "No matching identifier"}</small>{row.kind === "unmatched" && <small className={s.warning}>{row.matchNote || "Identity cannot be matched across funds"}</small>}</th><td><span className={s.presence} data-shared={row.fundCount > 1}>{row.fundCount} / {tickers.length}</span><small>{row.kind === "every" ? "Every fund" : row.kind === "unique" ? "One fund" : row.kind === "shared" ? "Shared" : "Unconfirmed"}</small></td>{tickers.map((ticker, index) => {
        const position = row.funds.find((f: any) => f.ticker === ticker), available = data.funds.some((f: any) => f.ticker === ticker);
        return <td key={ticker} data-color={index} data-held={!!position}>{position ? <><strong title={position.pctOfNav == null ? undefined : `${position.pctOfNav}% of NAV`}>{securityWeight(position.pctOfNav)}</strong><span title={position.value == null ? undefined : position.value.toLocaleString("en-US", { style: "currency", currency: "USD" })}>{money(position.value)}</span>{position.missingWeightCount > 0 && <small>Known weight: {securityWeight(position.knownWeight)}</small>}{position.missingValueCount > 0 && <small>Known value: {money(position.knownValue)}</small>}<div className={s.cellTrack} aria-hidden="true"><i style={{ width: `${Math.min(100, Math.abs(position.pctOfNav || 0))}%` }} /></div></> : <span className={s.noPosition}>{available ? "—" : "Unavailable"}<small>{available ? "No matched position" : "Report not loaded"}</small></span>}</td>;
      })}</tr>)}</tbody>
    </table>{!result.rows.length && <div className={s.empty}>No holdings match these filters. <button type="button" onClick={() => onPatch({ comparisonQuery: "", comparisonScope: "all", comparisonFund: "" })}>Show all holdings</button></div>}</div>
    <div className={s.pagination}><span>{number(data.pagination.total)} holdings · Page {data.pagination.page} of {data.pagination.pageCount}</span><div><button type="button" disabled={data.pagination.page <= 1} onClick={() => setPage({ key: base, page: data.pagination.page - 1 })}>Previous</button><button type="button" disabled={data.pagination.page >= data.pagination.pageCount} onClick={() => setPage({ key: base, page: data.pagination.page + 1 })}>Next</button></div></div>
    <details className={s.overlap}><summary>Weighted overlap between funds</summary><p>For each shared eligible security, the smaller NAV weight is counted. Higher overlap indicates more similar reported long holdings.</p><div className={s.overlapGrid}>{result.pairs.map((pair: any) => <div key={`${pair.left}-${pair.right}`}><span>{pair.left} <b> / </b> {pair.right}</span><strong>{pct(pair.overlap)}</strong><small>{number(pair.count)} shared eligible securities{pair.samePortfolio ? " · Same fund series" : ""}</small></div>)}</div></details>
    <details className={s.method}><summary>Matching, values & source coverage</summary><p>{result.methodology}</p><p>A dash means no matching reported security was found in a loaded portfolio. It does not prove zero economic exposure.</p></details></>}
  </section>;
}
