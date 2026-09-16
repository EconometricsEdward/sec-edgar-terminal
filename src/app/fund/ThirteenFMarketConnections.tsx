"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Link2, Pause, Play, RefreshCw, Search } from "lucide-react";
import { THIRTEEN_F_MARKET_CATEGORIES } from "../../utils/thirteenFMarketConnections.js";
import { use13FMarketConnections } from "./use13FMarketConnections";
import s from "./ThirteenFMarketConnections.module.css";

const MarketPositioning = dynamic(() => import("./ThirteenFMarketPositioning"));
type Props = { data: any; active: boolean; onInspectCompany: (holding: any) => void };
const EMPTY_MEMBERS: any[] = [];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—";
const percent = (value: unknown) => finite(value) ? value > 0 && value < .01 ? "<0.01%" : `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: value > 0 && value < 1 ? 2 : 1 })}%` : "—";
const money = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }) : "—";
const fullMoney = (value: unknown) => finite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "Unavailable";
const statusLabel: Record<string, string> = { unchecked: "Not yet checked", unavailable: "Evidence unavailable", unresolved: "Issuer link unverified", no_filing: "No eligible filing", no_matches: "No passage found", linked: "Market connection", disclosure_only: "Disclosure only", partial: "Partial filing review" };
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "Unavailable";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Unavailable";
}
function sourceUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && ["sec.gov", "www.sec.gov", "data.sec.gov"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null; } catch { return null; }
}
function SecLink({ href, children }: { href: unknown; children: React.ReactNode }) {
  const url = sourceUrl(href);
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} aria-hidden="true" /></a> : <span>{children} · source unavailable</span>;
}
function uniqueEvidence(rows: any[]) {
  return rows.filter((row, index) => rows.findIndex(other => other.id === row.id && other.accession === row.accession) === index);
}
function Passage({ evidence }: { evidence: any }) {
  const qualifying = evidence.disclosureDirection === "qualifying-or-negative";
  return <article className={s.passage} data-qualifying={qualifying}>
    <div className={s.passageHeading}><span>{qualifying ? "Qualifying or negative wording" : evidence.role === "quarterly" ? "Quarterly disclosure" : "Annual disclosure"}</span><span>{evidence.form}</span></div>
    <blockquote>{evidence.text}</blockquote>
    <div className={s.passageSource}><SecLink href={evidence.url}>Filed {date(evidence.filed)}</SecLink><span>Period ended {date(evidence.reportDate)}</span></div>
    {evidence.benchmark && <div className={s.passageFit}><span data-fit={evidence.benchmark.fit}>{evidence.benchmark.fit === "named-reference" ? "Named reference" : "Related proxy"}</span><p>{evidence.benchmark.basisLimit}</p></div>}
  </article>;
}

function HoldingEvidence({ member, market, onInspectCompany }: { member: any; market: any; onInspectCompany: Props["onInspectCompany"] }) {
  const evidence = uniqueEvidence(member.evidence || []);
  const proof = evidence.find(row => row.benchmark?.fit === "named-reference") || evidence.find(row => row.benchmark) || evidence.find(row => row.disclosureDirection === "connection") || evidence[0];
  // Keep the latest qualifier beside the supporting passage, including newer
  // disclosures that narrow or negate the earlier connection.
  const qualifier = evidence.find(row => row.disclosureDirection === "qualifying-or-negative" && row !== proof);
  const visible = [proof, qualifier].filter(Boolean);
  const additional = evidence.filter(row => !visible.includes(row));
  return <section className={s.evidence} aria-label={`${member.name} SEC connection evidence`}>
    <div className={s.evidenceHeading}><div><span className={s.eyebrow}>Follow the SEC evidence</span><h5>{member.issuer?.name || member.name}</h5><span className={s.issuerMeta}>Issuer CIK {member.issuer?.cik}{member.issuer?.tickers?.length ? ` · ${member.issuer.tickers.slice(0, 4).join(" / ")}` : ""}</span></div><button type="button" onClick={() => onInspectCompany(member.holding)} aria-label={`Company research for ${member.name}`} title="Open company financials and filings"><ArrowUpRight size={17} /></button></div>
    <div className={s.connectionFit}><Link2 size={13} aria-hidden="true" /><span>{market.family ? proof?.benchmark?.fit === "named-reference" ? "The SEC passage names this market reference." : "A related CFTC benchmark provides market context." : "The business driver is disclosed; no supported CFTC benchmark is assigned."}</span></div>
    {qualifier && <p className={s.qualifierNotice}>Read the qualifying wording alongside the connection. These passages do not establish the size or direction of economic exposure.</p>}
    <div className={s.passages}>{visible.map(row => <Passage key={`${row.accession}:${row.id}`} evidence={row} />)}</div>
    {additional.length > 0 && <details className={s.moreEvidence}><summary>{additional.length} more SEC passage{additional.length === 1 ? "" : "s"}<ChevronDown size={14} /></summary><div className={s.passages}>{additional.map(row => <Passage key={`${row.accession}:${row.id}`} evidence={row} />)}</div></details>}
    <details className={s.identity}><summary>How this holding was matched<ChevronDown size={13} /></summary><div><p>The reported CUSIP <strong>{member.cusip}</strong> is connected to issuer CIK <strong>{member.issuer?.cik}</strong> by SEC ownership disclosures. Company ticker aliases identify the issuer, not necessarily this security class.</p>{(member.identityEvidence || []).map((row: any, index: number) => <SecLink key={`${row.url}:${index}`} href={row.sourceUrl || row.url}>{row.form || "SEC ownership disclosure"}{row.filingDate ? ` · ${date(row.filingDate)}` : ""}</SecLink>)}</div></details>
  </section>;
}

function ConnectedHoldings({ market, onInspectCompany }: { market: any; onInspectCompany: Props["onInspectCompany"] }) {
  const [selectedKey, setSelectedKey] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const members: any[] = market.members || EMPTY_MEMBERS;
  const selected = members.find(member => member.key === selectedKey) || members[0];
  const openedKey = selected?.key || "";
  useEffect(() => { if (openedKey && openedKey !== selectedKey) setSelectedKey(openedKey); }, [openedKey, selectedKey]);
  const filtered = useMemo(() => members.filter(member => !query.trim() || `${member.name} ${member.cusip} ${member.classTitle} ${(member.issuer?.tickers || []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())), [members, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 6));
  const currentPage = Math.min(page, pages - 1);
  return <div className={s.holdingSection}>
    <div className={s.holdingSectionHeading}><div><span className={s.eyebrow}>SEC disclosures → market connection</span><h4>Which holdings connect, and why?</h4></div><span>{number(market.count)} holding{market.count === 1 ? "" : "s"}</span></div>
    <div className={s.holdingEvidenceGrid}>
      <div className={s.holdings}><label className={s.search}><Search size={13} aria-hidden="true" /><input type="search" aria-label={`Find holdings connected to ${market.label}`} placeholder="Find a holding" maxLength={120} value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><div className={s.holdingsLegend}><span>Reported security</span><span>13F share</span></div><ul>{filtered.slice(currentPage * 6, currentPage * 6 + 6).map(member => <li key={member.key}><button type="button" aria-pressed={selected?.key === member.key} onClick={() => setSelectedKey(member.key)}><span><strong>{member.name}</strong><small>{member.classTitle}{member.putCall ? ` · ${member.putCall}` : ""}</small><small>{member.cusip}</small></span><span className={s.holdingShare} title={`${fullMoney(member.valueUsd)} reported value`}>{percent(member.sharePct)}<small>{money(member.valueUsd)}</small></span></button></li>)}</ul>{!filtered.length && <p className={s.emptySearch}>No matching holding in this connection. The selected evidence stays open.</p>}{pages > 1 && <div className={s.pagination}><span>{currentPage * 6 + 1}–{Math.min((currentPage + 1) * 6, filtered.length)} of {number(filtered.length)}</span><div><button type="button" onClick={() => setPage(currentPage - 1)} disabled={!currentPage} aria-label="Previous connected holdings"><ChevronLeft size={14} /></button><button type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pages - 1} aria-label="Next connected holdings"><ChevronRight size={14} /></button></div></div>}<p className={s.holdingNote}>Select a holding to inspect its filing passages. Shares use the full disclosed 13F value.</p></div>
      {selected && <HoldingEvidence key={selected.key} member={selected} market={market} onInspectCompany={onInspectCompany} />}
    </div>
  </div>;
}

function Coverage({ model, remote, onInspectCompany }: { model: any; remote: ReturnType<typeof use13FMarketConnections>; onInspectCompany: Props["onInspectCompany"] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const rows = (model.positions || []).filter((row: any) => (status === "all" || row.status === status) && (!query.trim() || `${row.holding.issuer} ${row.holding.cusip} ${row.issuer?.name || ""} ${(row.issuer?.tickers || []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())));
  const pages = Math.max(1, Math.ceil(rows.length / 15));
  const currentPage = Math.min(page, pages - 1);
  return <details className={s.coverage}>
    <summary><span><Search size={14} />Coverage & every disclosed holding</span><span>{number(model.coverage.attempted)} / {number(model.coverage.total)} reviewed<ChevronDown size={15} /></span></summary>
    <div className={s.coverageIntro}><p>The scan starts with the 20 largest reported positions. An unverified issuer, unavailable filing, or missing passage remains a coverage gap. No passage found does not mean no economic exposure.</p><div className={s.coverageCounts}>{[{ key: "checked", label: "filing reviews" }, { key: "unresolved", label: "unverified issuers" }, { key: "unavailable", label: "unavailable" }, { key: "partial", label: "partial reviews" }, { key: "unchecked", label: "not yet checked" }].map(item => <span key={item.key}><strong>{number(model.coverage[item.key])}</strong>{item.label}</span>)}</div></div>
    <div className={s.coverageControls}><label className={s.search}><Search size={14} /><input aria-label="Search all disclosed holdings" type="search" value={query} maxLength={120} placeholder="Company, ticker, or CUSIP" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label><span className={s.srOnly}>Filter coverage status</span><select aria-label="Filter coverage status" value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="all">All coverage statuses</option>{Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
    <div className={s.coverageTable} role="region" tabIndex={0} aria-label="All disclosed holdings and SEC connection coverage"><table><thead><tr><th scope="col">Reported holding</th><th scope="col">Value / 13F share</th><th scope="col">Evidence coverage</th><th scope="col"><span className={s.srOnly}>Actions</span></th></tr></thead><tbody>{rows.slice(currentPage * 15, currentPage * 15 + 15).map((row: any) => <tr key={row.holding.key}><th scope="row"><button type="button" className={s.companyLink} onClick={() => onInspectCompany(row.holding)}>{row.holding.issuer}<ArrowUpRight size={12} /></button><small>{row.holding.cusip} · {row.holding.classTitle}{row.holding.putCall ? ` · ${row.holding.putCall}` : ""}</small></th><td title={fullMoney(row.holding.valueUsd)}>{money(row.holding.valueUsd)}<small>{percent(model.percentagesAvailable && finite(row.holding.valueUsd) ? row.holding.valueUsd / model.denominatorUsd * 100 : null)}</small></td><td><span className={s.status} data-status={row.status}>{statusLabel[row.status] || "Evidence unavailable"}</span><small>{row.message}</small></td><td>{["unavailable", "partial"].includes(row.status) && <button type="button" className={s.retry} disabled={remote.pending || remote.blocked} onClick={() => remote.retry(row.holding.key)} aria-label={`Retry ${row.holding.issuer}`}><RefreshCw size={12} />Retry</button>}</td></tr>)}</tbody></table>{!rows.length && <p className={s.emptySearch}>No holdings match these filters.</p>}</div>
    <div className={s.coverageFooter}><span>{rows.length ? `${currentPage * 15 + 1}–${Math.min((currentPage + 1) * 15, rows.length)} of ${number(rows.length)} holdings` : "0 holdings"}</span><div><button type="button" aria-label="Previous coverage page" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button><button type="button" aria-label="Next coverage page" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button></div></div>
  </details>;
}

export default function ThirteenFMarketConnections({ data, active, onInspectCompany }: Props) {
  const id = useId();
  const remote = use13FMarketConnections(data, active);
  const model: any = remote.model;
  const [chosenMarket, setChosenMarket] = useState("");
  const [chosenDriver, setChosenDriver] = useState("");
  const markets: any[] = model.markets || [];
  const unmapped: any[] = model.unmapped || [];
  const selected = markets.find(market => market.key === chosenMarket) || markets[0];
  const driver = unmapped.find(market => market.key === chosenDriver) || unmapped[0];
  const selectedMarketKey = selected?.key || "";
  const selectedDriverKey = driver?.key || "";
  // Streaming results can reorder the ranked markets. Keep the first opened
  // connection in view instead of replacing its evidence mid-read.
  useEffect(() => { if (selectedMarketKey && selectedMarketKey !== chosenMarket) setChosenMarket(selectedMarketKey); }, [selectedMarketKey, chosenMarket]);
  useEffect(() => { if (selectedDriverKey && selectedDriverKey !== chosenDriver) setChosenDriver(selectedDriverKey); }, [selectedDriverKey, chosenDriver]);
  const coverage = model.coverage;
  const categories = Object.entries(THIRTEEN_F_MARKET_CATEGORIES).map(([key, label]) => ({ key, label, markets: markets.filter(market => market.category === key) })).filter(category => category.markets.length);
  const retryable = coverage.unavailable + coverage.partial;
  return <div className={s.connections}>
    <header className={s.header}><div><span className={s.eyebrow}><Link2 size={14} />Market connections</span><h3>The markets behind the holdings</h3><p>Start with what companies disclose. Follow the passage to its related futures market.</p></div><span className={s.quarter}>13F snapshot<strong>{date(model.quarter)}</strong></span></header>
    <div className={s.overview} aria-label="Market connection coverage"><div><span>Related CFTC markets</span><strong>{number(markets.length)}</strong></div><div><span>Holdings with market links</span><strong>{number(coverage.linked)}<small> / {number(coverage.total)}</small></strong></div><div><span>Associated disclosed value</span><strong>{percent(coverage.linkedSharePct)}</strong></div><p>These percentages describe associated holdings’ share of disclosed value. They do not measure economic exposure.</p></div>
    <div className={s.scan}>
      <div className={s.scanProgress}><div role="status" aria-live="polite">{remote.pending ? <RefreshCw size={13} className={s.spin} /> : remote.paused ? <Pause size={13} /> : <Check size={13} />}<span>{remote.pending ? "Reviewing SEC disclosures" : remote.paused ? "Review paused" : "SEC review"}<strong>{number(remote.completed)} of {number(remote.limit)} selected holdings reviewed · {number(coverage.total)} in report</strong></span></div><progress value={Math.min(100, Math.max(0, remote.progress || 0))} max={100} aria-label="Progress through the selected holdings" /></div>
      <div className={s.scanActions}>{remote.pending ? <button type="button" onClick={remote.pause}><Pause size={12} />Pause</button> : remote.paused && !remote.blocked ? <button type="button" onClick={remote.resume}><Play size={12} />Resume</button> : null}{!remote.pending && !remote.blocked && remote.limit < coverage.total ? <button type="button" className={s.continue} onClick={remote.scanNext}>Check next {Math.min(20, coverage.total - remote.limit)}<ArrowRight size={13} /></button> : null}{!remote.pending && !remote.blocked && remote.limit < coverage.total ? <button type="button" onClick={remote.startAll}>Check all remaining</button> : null}{!remote.pending && !remote.blocked && (retryable > 0 || remote.error) ? <button type="button" onClick={() => remote.retry()}><RefreshCw size={12} />Retry incomplete</button> : null}{!remote.pending && !remote.blocked && coverage.attempted > 0 ? <button type="button" onClick={remote.refresh} aria-label="Refresh selected SEC disclosure reviews"><RefreshCw size={12} />Refresh</button> : null}</div>
    </div>
    <p className={s.scopeDates}>Reviewed in order of reported value{finite(coverage.checkedSharePct) ? ` · Holdings with filing reviews represent ${percent(coverage.checkedSharePct)} of disclosed value` : ""} · Company evidence: latest eligible annual filing and newer 10-Q · CFTC: latest available weekly positions. Company evidence and market observations may postdate the 13F snapshot.</p>
    {remote.error && <p className={s.notice} role="alert">{remote.error}</p>}
    {!model.percentagesAvailable && <p className={s.notice}>Percentage shares require a complete 13F with a positive reconciled reported value. Available holding counts and SEC passages remain visible; portfolio percentages are withheld.</p>}
    {selected ? <div className={s.marketGrid}>
      <aside className={s.markets} aria-labelledby={`${id}-markets`}><div className={s.marketListHeading}><h4 id={`${id}-markets`}>Explore a market</h4><span>Associated 13F value</span></div><div className={s.marketList}>{categories.map(category => <div className={s.category} key={category.key}><h5>{category.label}</h5><ul>{category.markets.map(market => <li key={market.key}><button type="button" onClick={() => setChosenMarket(market.key)} aria-pressed={selected.key === market.key} aria-controls={`${id}-selected`}><span className={s.marketTitle}><strong>{market.label}</strong><ChevronRight size={14} /></span><span className={s.marketMeta}><span>{number(market.count)} holding{market.count === 1 ? "" : "s"}</span><b>{percent(market.sharePct)}</b></span>{finite(market.sharePct) && <span className={s.shareTrack} aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, market.sharePct))}%` }} /></span>}</button></li>)}</ul></div>)}</div><p className={s.overlap}>One holding can connect to several markets. Market percentages overlap and should not be added.</p></aside>
      <section id={`${id}-selected`} className={s.selectedMarket} aria-label={`${selected.label} connections and evidence`}><div className={s.selectedHeading}><div><span>{THIRTEEN_F_MARKET_CATEGORIES[selected.category as keyof typeof THIRTEEN_F_MARKET_CATEGORIES] || "Market context"}</span><h4>{selected.label}</h4></div><div><strong>{percent(selected.sharePct)}</strong><span>of disclosed 13F value</span></div></div><MarketPositioning market={selected} active={active} /><ConnectedHoldings key={selected.key} market={selected} onInspectCompany={onInspectCompany} /></section>
    </div> : <section className={s.empty} aria-label="Market connections status"><div className={s.emptyMark} aria-hidden="true"><FileText size={24} /><span /><Link2 size={24} /></div><h4>{!coverage.total ? "No usable holdings in this snapshot" : remote.pending ? "Following the evidence behind the holdings" : "No verified CFTC connection in the reviewed holdings"}</h4><p>{!coverage.total ? "Choose a quarter with a usable public holdings table to explore company disclosures and related markets. The Filing evidence tab explains what this report contains." : remote.pending ? "Connections appear as issuer identities and filing passages are verified. The largest reported holdings are checked first." : unmapped.length ? "The SEC disclosures below identify business drivers. A futures chart appears when the passages support a benchmark connection." : "Continue reviewing holdings, or inspect the coverage detail below. A missing connection does not establish the absence of exposure."}</p></section>}
    {driver && <details className={s.otherDrivers}><summary><span><FileText size={15} />Other disclosed drivers<strong>{unmapped.length}</strong></span><span>SEC evidence without a supported CFTC chart<ChevronDown size={15} /></span></summary><div className={s.otherIntro}><p>Keep relevant business disclosures visible even when they do not establish a specific futures benchmark.</p><label><span>Select a disclosed driver</span><select value={driver.key} onChange={event => setChosenDriver(event.target.value)}>{unmapped.map(market => <option key={market.key} value={market.key}>{market.label} · {market.count} holding{market.count === 1 ? "" : "s"} · {percent(market.sharePct)}</option>)}</select></label><p>{driver.reason || driver.basisLimit}</p></div><ConnectedHoldings key={driver.key} market={driver} onInspectCompany={onInspectCompany} /></details>}
    <Coverage model={model} remote={remote} onInspectCompany={onInspectCompany} />
    <details className={s.methodology}><summary>How to read these connections<ChevronDown size={14} /></summary><div><p>The link starts with a verified SEC issuer identity for the holding’s exact CUSIP. A relevant business passage in the latest eligible annual filing or a newer 10-Q supports each displayed connection. Named references and related proxies are labeled separately; qualifying or negative passages remain alongside supporting evidence.</p><p>A market’s associated value is the sum of its unique disclosed holdings, divided by the full reconciled 13F value. The overview counts each linked holding once across all markets. Security classes and option types remain distinct. Percentages are not rescaled to the checked holdings.</p><p>13F option values describe the underlying securities, not premiums or delta. Puts are not subtracted from other holdings. Reported values do not measure hedges, revenue at risk, financial sensitivity, or the manager’s complete portfolio.</p><p>The filing scan is bounded and may miss other relevant passages. A proxy does not establish exposure to the exact contract’s grade, geography, currency, or maturity. CFTC reports describe aggregate futures markets; they do not reveal a particular manager’s or company’s positions.</p></div></details>
  </div>;
}
