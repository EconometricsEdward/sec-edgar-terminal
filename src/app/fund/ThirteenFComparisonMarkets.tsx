"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronDown, FileText, Link2, Pause, RefreshCw } from "lucide-react";
import { buildComparisonMarkets, comparisonMarketScope } from "../../utils/thirteenFComparisonMarkets.js";
import { create13FMarketConnectionClient } from "../../utils/thirteenFMarketConnectionsClient.js";
import s from "./ThirteenFComparisonMarkets.module.css";

const Positioning = dynamic(() => import("./ThirteenFMarketPositioning"));
const client = create13FMarketConnectionClient();
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: unknown) => finite(value) ? value > 0 && value < .01 ? "<0.01%" : `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}%` : "—";
const money = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }) : "—";
function secUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null; } catch { return null; }
}
function Source({ href, children }: { href: unknown; children: React.ReactNode }) {
  const url = secUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} aria-hidden="true" /></a> : <span>{children} · source unavailable</span>;
}
function Passage({ passage }: { passage: any }) {
  return <article className={s.passage}>
    <div className={s.passageMeta}><span>{passage.disclosureDirection === "qualifying-or-negative" ? "Qualifying or negative wording" : passage.benchmark?.fit === "named-reference" ? "Named market reference" : passage.benchmark ? "Related market proxy" : "Company disclosure"}</span><span>{passage.form}</span></div>
    <blockquote>{passage.text}</blockquote>
    <div className={s.source}><Source href={passage.url}>Filed {passage.filed}</Source><span>Period ended {passage.reportDate}</span></div>
    {passage.benchmark?.basisLimit && <p className={s.note}>{passage.benchmark.basisLimit}</p>}
  </article>;
}
function Evidence({ member }: { member: any }) {
  const supporting = member.evidence.find((passage: any) => passage.disclosureDirection === "connection" && passage.benchmark) || member.evidence.find((passage: any) => passage.disclosureDirection === "connection") || member.evidence[0];
  const qualifier = member.evidence.find((passage: any) => passage.disclosureDirection === "qualifying-or-negative" && passage !== supporting);
  const visible = [supporting, qualifier].filter(Boolean);
  const additional = member.evidence.filter((passage: any) => !visible.includes(passage));
  return <div className={s.evidence}>
    <div className={s.evidenceHeading}><FileText size={17} aria-hidden="true" /><div><h5>{member.issuer.name}</h5><p>CUSIP {member.cusip} · {member.anchorHolding.classTitle} · Issuer CIK {member.issuer.cik}</p></div></div>
    {member.partial && <p className={s.notice}>This company’s filing review is incomplete. The passages below use verified available sources.</p>}
    {visible.map(passage => <Passage key={`${passage.accession}:${passage.id}`} passage={passage} />)}
    {additional.length > 0 && <details className={s.details}><summary>{additional.length} more filing passage{additional.length === 1 ? "" : "s"}<ChevronDown size={13} /></summary>{additional.map((passage: any) => <Passage key={`${passage.accession}:${passage.id}`} passage={passage} />)}</details>}
    <details className={s.details}><summary>Verify the security-to-company link<ChevronDown size={13} /></summary><p>SEC ownership disclosures connect this exact CUSIP to the company. The same reported security is shared by the managers shown here; company ticker aliases do not identify a security class.</p><div className={s.identitySources}>{member.identityEvidence.map((proof: any, index: number) => <Source key={`${proof.url || proof.sourceUrl}:${index}`} href={proof.sourceUrl || proof.url}>{proof.form || "SEC ownership disclosure"}{proof.filingDate ? ` · ${proof.filingDate}` : ""}</Source>)}</div></details>
  </div>;
}

export default function ThirteenFComparisonMarkets({ comparison }: { comparison: any }) {
  const scope = useMemo(() => comparisonMarketScope(comparison), [comparison]);
  if (!scope.rows.length) return null;
  return <SharedMarkets key={scope.signature} comparison={comparison} scope={scope} />;
}

function SharedMarkets({ comparison, scope }: { comparison: any; scope: any }) {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [retry, setRetry] = useState(0);
  const [selectedKey, setSelectedKey] = useState("");
  const [holdingKey, setHoldingKey] = useState("");
  // One opt-in scan per immutable comparison. Two source requests at most;
  // changing quarter/report or leaving this page cancels outstanding work.
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const alreadyChecked = new Set(results.filter(result => result.status !== "unavailable" && result.discovery?.status !== "partial" && result.discovery?.coverage?.searchComplete !== false).map(result => result.holding?.key || result.key));
    const queue = scope.rows.filter((row: any) => !alreadyChecked.has(row.key));
    let next = 0;
    async function worker() {
      while (!controller.signal.aborted && next < queue.length) {
        const row = queue[next++];
        try {
          const data = await client.load({ cik: row.anchorCik, period: scope.period, holding: row.anchorHolding, signal: controller.signal, force: retry > 0 });
          if (!controller.signal.aborted) setResults(previous => {
            if (data.status === "unavailable" && previous.some(result => result.holding?.key === row.key && result.status === "ready")) return previous;
            return [...previous.filter(result => (result.holding?.key || result.key) !== row.key), data];
          });
        } catch (error: any) {
          if (!controller.signal.aborted) setResults(previous => {
            // A failed refresh does not erase previously sourced passages.
            const retained = previous.find(result => result.holding?.key === row.key && result.status === "ready");
            if (retained) return previous;
            return [...previous.filter(result => (result.holding?.key || result.key) !== row.key), { key: row.key, status: "unavailable", message: error?.name === "TimeoutError" ? "The SEC evidence request timed out. Retry this review." : error?.message || "SEC evidence is temporarily unavailable." }];
          });
        }
      }
    }
    Promise.all([worker(), worker()]).finally(() => { if (!controller.signal.aborted) setRunning(false); });
    return () => controller.abort();
    // Results stream into the display without restarting the current queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, retry, scope.signature]);
  const model: any = useMemo(() => buildComparisonMarkets(comparison, results), [comparison, results]);
  const connections = [...model.markets, ...model.drivers];
  const selected = connections.find(connection => connection.key === selectedKey) || connections[0];
  const member = selected?.members.find((row: any) => row.key === holdingKey) || selected?.members[0];
  const resolvedMarketKey = selected?.key || "";
  const resolvedHoldingKey = member?.key || "";
  // Newly completed sources can change ranking; preserve the open passage.
  useEffect(() => { if (resolvedMarketKey && resolvedMarketKey !== selectedKey) setSelectedKey(resolvedMarketKey); }, [resolvedMarketKey, selectedKey]);
  useEffect(() => { if (resolvedHoldingKey && resolvedHoldingKey !== holdingKey) setHoldingKey(resolvedHoldingKey); }, [resolvedHoldingKey, holdingKey]);
  const retryable = model.coverage.unavailable + model.coverage.partial;
  const start = () => { setOpened(true); setRunning(true); };
  return <section className={s.section} aria-labelledby={`${id}-heading`}>
    <header className={s.heading}><div><span className={s.eyebrow}><Link2 size={14} aria-hidden="true" />Shared business drivers</span><h3 id={`${id}-heading`}>Go beyond the shared ticker.</h3><p>Follow companies’ SEC disclosures to the interest-rate, currency and commodity markets they discuss.</p></div>{!opened && <button type="button" className={s.start} onClick={start}>Explore shared market connections<ArrowRight size={15} /></button>}</header>
    <p className={s.scope}>Across all selected managers: a focused review of up to {scope.rows.length} shared share positions, ranked by combined reported value within this comparison. Options, principal amounts and identified fund securities are excluded. No fund holdings look-through is inferred.</p>
    {opened && <>
      <div className={s.progress}><div role="status" aria-live="polite">{running && <RefreshCw size={13} className={s.spin} />}<span>{running ? "Reading SEC disclosures" : "SEC review"}<strong>{model.coverage.attempted} of {scope.rows.length} holdings checked · {model.markets.length} related CFTC markets</strong></span></div><div>{running ? <button type="button" onClick={() => setRunning(false)}><Pause size={12} />Pause</button> : model.coverage.attempted < scope.rows.length ? <button type="button" onClick={start}>Continue review<ArrowRight size={12} /></button> : null}{!running && retryable > 0 && <button type="button" onClick={() => { setRetry(value => value + 1); setRunning(true); }}><RefreshCw size={12} />Retry incomplete</button>}</div><progress value={model.coverage.attempted} max={scope.rows.length} aria-label="Shared holdings checked" /></div>
      <p className={s.note}>Company evidence uses the latest eligible annual filing and newer 10-Q filings. CFTC charts show the latest available weekly positions. Both may postdate the {scope.period} holdings snapshot.</p>
      {selected ? <div className={s.content}>
        <div className={s.toolbar}><label htmlFor={`${id}-market`}>Explore a shared driver</label><select id={`${id}-market`} value={selected.key} onChange={event => { setSelectedKey(event.target.value); setHoldingKey(""); }}>{model.markets.length > 0 && <optgroup label="SEC evidence + CFTC context">{model.markets.map((market: any) => <option key={market.key} value={market.key}>{market.label} · {market.count} shared holding{market.count === 1 ? "" : "s"}</option>)}</optgroup>}{model.drivers.length > 0 && <optgroup label="SEC disclosure · no supported CFTC benchmark">{model.drivers.map((driver: any) => <option key={driver.key} value={driver.key}>{driver.label} · {driver.count} shared holding{driver.count === 1 ? "" : "s"}</option>)}</optgroup>}</select></div>
        <div className={s.associatedHeading}><h4>{selected.label}</h4><span>Associated holdings · share of each manager’s disclosed value</span></div>
        <div className={s.managerShares}>{selected.managers.map((manager: any, index: number) => <article key={manager.cik}><div><span className={s.managerName}>{manager.name}</span><strong>{percent(manager.sharePct)}</strong></div><div className={s.bar} aria-hidden="true"><i data-color={index} style={{ width: `${finite(manager.sharePct) ? Math.min(100, Math.max(0, manager.sharePct)) : 0}%` }} /></div><small>{manager.unknown ? "Incomplete holding coverage" : `${manager.count} associated holding${manager.count === 1 ? "" : "s"} · ${money(manager.valueUsd)}`}</small></article>)}</div>
        <p className={s.interpretation}>These shares describe the value of associated holdings in the full disclosed 13F. They do not measure economic exposure. A holding may connect to several markets; percentages overlap.</p>
        {selected.family ? <Positioning market={selected} active={opened} /> : <p className={s.notice}>{selected.reason} The SEC evidence remains useful on its own.</p>}
        <div className={s.holdingSelector}><label htmlFor={`${id}-holding`}>Read the company evidence</label><select id={`${id}-holding`} value={member.key} onChange={event => setHoldingKey(event.target.value)}>{selected.members.map((row: any) => <option key={row.key} value={row.key}>{row.issuer.name} · {row.cusip} · shared by {row.managerCount}</option>)}</select></div>
        <div className={s.memberShares}>{member.cells.map((cell: any) => <span key={cell.cik}><strong>{comparison.managers.find((manager: any) => manager.cik === cell.cik)?.name}</strong>{cell.status === "unknown" ? "Coverage unknown" : `${percent(cell.sharePct)} · ${money(cell.valueUsd)}`}</span>)}</div>
        <Evidence key={`${selected.key}:${member.key}`} member={member} />
      </div> : <div className={s.empty}><Link2 size={23} aria-hidden="true" /><h4>{running ? "Following the shared holdings to their filings" : "No verified market connection in this review"}</h4><p>{running ? "Verified passages appear as each company review completes." : "Missing passages or unavailable sources do not establish zero exposure. Review the coverage below or retry incomplete sources."}</p></div>}
      <details className={s.coverage}><summary>Review coverage & interpretation<ChevronDown size={14} /></summary><p>This is a bounded review of shared positions shown in the comparison, not a scan of every manager’s entire portfolio. Each security is checked once using an exact CUSIP-to-issuer link in SEC ownership filings. Shares retain each manager’s complete disclosed-value denominator. Unknown coverage stays unknown.</p><p>CFTC positioning describes a market’s aggregate trader group. It does not reveal these managers’ or companies’ futures positions, hedges, sensitivity, or returns. A related benchmark may differ in maturity, geography or commodity grade from the company’s activity.</p><ul>{model.positions.map((row: any) => <li key={row.key}><strong>{row.name}</strong><span>{row.message}</span></li>)}</ul></details>
    </>}
  </section>;
}
