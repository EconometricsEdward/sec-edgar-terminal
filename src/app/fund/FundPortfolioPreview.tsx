"use client";
import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowUpRight, Bookmark, Check, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { ASSET_LABELS } from "../../utils/fundResearch.js";
import { fundSnapshotFacts } from "../../utils/fundScreener.js";
import { fundSnapshotIsStale } from "../../utils/fundSnapshotClient.js";
import { money, pct, number } from "./fundUi";
import s from "./FundWorkspace.module.css";

export function portfolioHref(fund: any, reportMap: Record<string, string> = {}) {
  const accession = fund.state?.data?.accession || reportMap[fund.ticker];
  return `/fund/${fund.ticker}${accession ? `?accession=${encodeURIComponent(accession)}` : ""}`;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const tones: Record<string, string> = { "US equity": "equity", International: "international", "Fixed income": "bonds" };
export function fundTone(category: string) { return tones[category] || "other"; }

export default function FundPortfolioPreview({ fund, selected, onSelect, snapshots, reportMap, shelf }: any) {
  const facts = fundSnapshotFacts(fund.state);
  const data = fund.state.data;
  const pending = ["idle", "loading"].includes(fund.state.status);
  const refreshing = Boolean(fund.state.refreshing);
  const holdings = (data?.topHoldings || []).slice(0, 5);
  const assets = (data?.summary?.assets || []).slice(0, 4);
  const concentration = facts?.concentration;
  const canDrawRing = finite(concentration) && concentration >= 0 && concentration <= 100;
  const navScale = Math.max(100, ...assets.map((row: any) => finite(row.pctOfNav) ? Math.abs(row.pctOfNav) : 0));
  const largestWeight = Math.max(1, ...holdings.map((row: any) => finite(row.pctOfNav) ? Math.abs(row.pctOfNav) : 0));
  const selectedFund = selected.includes(fund.ticker);
  const weightLabel = facts && facts.knownWeights === facts.positions ? "Top 10 / NAV" : "Known top 10 / NAV";
  return <article className={s.spotlight} data-tone={fundTone(fund.category)} aria-label={`${fund.ticker} portfolio preview`} aria-busy={pending || refreshing}>
    <div className={s.spotlightHeading}>
      <div><span className={s.eyebrow}>{fund.family} <span className={s.separator}>/</span> {fund.focus}</span><h2><span>{fund.ticker}</span>{fund.name}</h2></div>
      <button type="button" className={s.iconButton} aria-label={`${shelf.saved.includes(fund.ticker) ? "Unsave" : "Save"} ${fund.ticker}`} aria-pressed={shelf.saved.includes(fund.ticker)} disabled={!shelf.ready} onClick={() => shelf.toggle(fund.ticker)}><Bookmark size={17} fill={shelf.saved.includes(fund.ticker) ? "currentColor" : "none"} /></button>
    </div>
    {facts ? <>
      <div className={s.snapshotDate}><span><i /> Portfolio {facts.asOf}</span><span>Filed {facts.filingDate}</span>{data.cache?.checkedAt && <span>Checked {data.cache.checkedAt.slice(0, 10)}</span>}{fundSnapshotIsStale(data) && <strong>Source check due</strong>}</div>
      {(refreshing || fund.state.error || data.sourceCheckNotice) && <p className={s.refreshNote} role="status">{refreshing ? "Checking SEC sources. The last verified portfolio remains visible." : fund.state.error || data.sourceCheckNotice}</p>}
      <div className={s.portfolioAnatomy}>
        <div className={s.fundSize}><span>Portfolio net assets</span><strong>{money(facts.netAssets)}</strong><small>SEC fund series · may include multiple share classes</small><div className={s.positionCount}><b>{number(facts.positions)}</b><span>reported positions</span><span className={s.coverageDot}>·</span><span>{number(facts.knownWeights)} with weights</span></div></div>
        <div className={s.concentration}>
          <div className={s.concentrationRing} data-empty={!canDrawRing} style={{ "--concentration": `${canDrawRing ? concentration : 0}%` } as CSSProperties} role="img" aria-label={`${weightLabel}: ${pct(concentration)}. Ring uses a 100 percent net asset value reference.`}><div><strong>{pct(concentration)}</strong><span>{weightLabel}</span></div></div>
          {!canDrawRing && <small>{finite(concentration) ? "Above 100% of NAV" : "Weight unavailable"}</small>}
        </div>
      </div>
      <div className={s.portfolioDetails}>
        <section className={s.assetMix} aria-label="Reported asset mix"><div className={s.miniHeading}><h3>Asset mix</h3><span>% of NAV</span></div>{assets.length ? assets.map((asset: any, index: number) => <div className={s.assetRow} key={asset.key}><div><span>{(ASSET_LABELS as Record<string, string>)[asset.key] || asset.key || "Unclassified"}</span><strong>{pct(asset.pctOfNav)}</strong></div><div className={s.assetTrack} aria-hidden="true"><i data-negative={asset.pctOfNav < 0} style={{ width: `${finite(asset.pctOfNav) ? Math.abs(asset.pctOfNav) / navScale * 100 : 0}%`, opacity: 1 - index * .15 }} /></div></div>) : <p className={s.muted}>Asset categories were not supplied.</p>}<p className={s.chartNote}>Signed reported weights. {navScale > 100 ? `Bar scale: 0–${Math.ceil(navScale)}% of NAV.` : "Bar scale: 0–100% of NAV."} Categories may not sum to 100%.</p></section>
        <section className={s.topPositions} aria-label="Leading reported positions"><div className={s.miniHeading}><h3>Leading positions</h3><span>% of NAV</span></div>{holdings.length ? <ol>{holdings.map((holding: any, index: number) => <li key={holding.id ?? index}><span className={s.positionRank}>{String(index + 1).padStart(2, "0")}</span><div className={s.positionName}><span title={`${holding.name}${holding.title ? ` · ${holding.title}` : ""}`}>{holding.name}</span><i aria-hidden="true" style={{ width: `${finite(holding.pctOfNav) ? Math.abs(holding.pctOfNav) / largestWeight * 100 : 0}%` }} /></div><strong>{pct(holding.pctOfNav)}</strong></li>)}</ol> : <p className={s.muted}>Open the report to inspect positions.</p>}<p className={s.chartNote}>Largest reported values. Bars compare position weights; derivatives show fair value.</p></section>
      </div>
      <div className={s.spotlightFooter}><Link prefetch={false} className={s.openPortfolio} href={portfolioHref(fund, reportMap)}>Explore full portfolio <ArrowUpRight size={16} /></Link><div><a href={data.sourceUrl} target="_blank" rel="noreferrer">SEC filing <ExternalLink size={12} /></a><button type="button" className={s.iconButton} aria-label={`Refresh ${fund.ticker} summary`} disabled={pending || refreshing} onClick={() => snapshots.load([fund.ticker], reportMap, true)}><RefreshCw size={14} /></button></div></div>
    </> : <div className={s.previewEmpty}>
      {pending ? <><div className={s.skeletonMetrics} aria-hidden="true"><i /><i /><i /></div><span className={s.loadingLine}><RefreshCw size={15} />Reading {fund.ticker}’s SEC portfolio…</span><p>Portfolio size, concentration, and leading holdings will appear here.</p></> : <><h3>Portfolio snapshot unavailable</h3><p>{fund.state.error || data?.reason || "This fund’s public N-PORT coverage could not be verified."}</p><div className={s.actions}><button type="button" onClick={() => snapshots.load([fund.ticker], reportMap, true)}><RefreshCw size={14} />Retry {fund.ticker}</button><Link prefetch={false} href={portfolioHref(fund, reportMap)}>Open fund report <ArrowUpRight size={14} /></Link></div></>}
    </div>}
    <button className={s.addComparison} type="button" aria-pressed={selectedFund} disabled={!selectedFund && selected.length >= 4} onClick={() => onSelect(fund.ticker)}>{selectedFund ? <Check size={15} /> : <Plus size={15} />}{selectedFund ? "Added to comparison" : "Add to comparison"}</button>
  </article>;
}
