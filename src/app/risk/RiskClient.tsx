'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, Check, CircleAlert, Compass, Loader2, Network, Search, ShieldCheck } from 'lucide-react';
import { RISK_VERSION, riskPeriodLabel } from '../../utils/riskWorkspace.js';
import RiskProfileOverview from './RiskProfileOverview';
import RiskWorkbench from './RiskWorkbench';
import RiskStart from './RiskStart';
import { riskResearchBrief } from './riskResearchModel.js';
import type { RiskEvidenceId } from './RiskEvidenceWorkspace';
import { riskProfileBrief } from './riskProfilePresentation.js';
import type { RiskData } from './riskTypes';
import s from './risk.module.css';
import { downloadRiskFile } from './riskDownload';
import { normalizeRiskView, parseRiskLocation, riskViewPath } from './riskNavigation.js';

const MetricExplorer = dynamic(() => import('./RiskPanels').then(m => m.MetricExplorer), { loading: () => <p className={s.inlineLoading} role="status">Opening metric evidence…</p> });
const FcmCapitalPanel = dynamic(() => import('./FcmCapitalPanel'), { loading: () => <p className={s.inlineLoading} role="status">Loading futures broker capital…</p> });
const CompanyExposureMap = dynamic(() => import('./CompanyExposureMap'), { loading: () => <p className={s.inlineLoading} role="status">Loading company exposures…</p> });
const TABS = [['overview', 'Risk Profile', ShieldCheck], ['exposures', 'Business Exposures', Network]] as const;

export default function RiskClient({ initialTicker = '', initialView = 'overview', initialBasis = 'ttm', initialEntity = '', initialAsOf = '', cftcEnabled = true }: { initialTicker?: string; initialView?: string; initialBasis?: string; initialEntity?: string; initialAsOf?: string; cftcEnabled?: boolean }) {
  const [input, setInput] = useState(initialTicker), [query, setQuery] = useState(initialTicker);
  const [retry, setRetry] = useState(0), [data, setData] = useState<RiskData | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(Boolean(initialTicker));
  const [basis, setBasis] = useState(initialBasis === 'annual' ? 'annual' : 'ttm');
  const [tab, setTab] = useState(() => normalizeRiskView(initialView, cftcEnabled));
  const [exposureAsOf, setExposureAsOf] = useState(initialAsOf);
  const [pillar, setPillar] = useState('all'), [selected, setSelected] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false), [explorerOpen, setExplorerOpen] = useState(false);
  const [exported, setExported] = useState(false);
  const [inspectVersion, setInspectVersion] = useState(0);
  const [evidenceSelection,setEvidenceSelection] = useState<RiskEvidenceId>('maturities');
  const explorerRef = useRef<HTMLDivElement>(null), loadedRequest = useRef('');
  const isFcm = cftcEnabled && tab === 'fcm', isExposures = tab === 'exposures';
  const independent = isFcm || isExposures;

  useEffect(() => {
    if (independent) { setLoading(false); setError(''); return; }
    if (!query) { loadedRequest.current = ''; setData(null); setError(''); setLoading(false); return; }
    const requestKey = `${query}:${retry}`;
    if (loadedRequest.current === requestKey) { setLoading(false); setError(''); return; }
    loadedRequest.current = '';
    if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(query)) {
      setData(null); setLoading(false); setError('Enter a company ticker such as JPM, AAPL, or BRK-B.'); return;
    }
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setExported(false); setExplorerOpen(false);
    fetch(`/api/risk?ticker=${encodeURIComponent(query)}&v=${RISK_VERSION}&evidence=1`, { signal: controller.signal })
      .then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Could not load the risk profile.'); return body; })
      .then((body: RiskData) => {
        if (controller.signal.aborted) return;
        loadedRequest.current = requestKey; setData(body); setSelected(''); setPillar('all'); setOnlyMissing(false);
      }).catch(err => { if (!controller.signal.aborted) setError(err.message === 'Failed to fetch' ? 'The risk service could not be reached. Please retry.' : err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, retry, independent]);

  useEffect(() => {
    const onPop = () => { const restored = parseRiskLocation(location.search, cftcEnabled); setInput(restored.ticker); setQuery(restored.ticker); setTab(restored.view); setBasis(restored.basis); setExposureAsOf(restored.asOf); setExported(false); if (!restored.ticker) { loadedRequest.current = ''; setData(null); setLoading(false); } };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, [cftcEnabled]);

  useEffect(() => {
    const restore = () => {
      const hash = window.location.hash;
      const choices: Record<string,RiskEvidenceId> = { '#risk-maturities':'maturities', '#risk-bank':'bank', '#risk-notes':'notes', '#risk-markets':'markets', '#risk-connections':'connections' };
      if (choices[hash]) setEvidenceSelection(choices[hash]);
    };
    restore(); window.addEventListener('hashchange',restore);
    return () => window.removeEventListener('hashchange',restore);
  },[]);
  function openEvidence(id: RiskEvidenceId) {
    setEvidenceSelection(id);
    const url = new URL(window.location.href); url.hash = 'risk-' + id; window.history.replaceState({},'',url);
    requestAnimationFrame(() => document.getElementById('risk-connected-evidence')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',block:'start'}));
  }
  function changeTab(view: string) {
    const next = normalizeRiskView(view, cftcEnabled); setTab(next);
    const path = riskViewPath(window.location.search, next, cftcEnabled);
    if (path !== `${window.location.pathname}${window.location.search}`) window.history.pushState({}, '', path);
  }
  function search(ticker: string) {
    const next = ticker.trim().toUpperCase(); if (!next) return;
    setInput(next); setExported(false); setExplorerOpen(false);
    if (next === query) setRetry(n => n + 1); else { setQuery(next); setData(null); }
    setEvidenceSelection('maturities');
    const url = new URL(location.href); url.hash = ''; url.searchParams.set('ticker', next); url.searchParams.delete('symbol'); window.history.pushState({}, '', url);
  }
  function changeBasis(next: string) {
    setBasis(next); setExported(false);
    const url = new URL(location.href); if (next === 'annual') url.searchParams.set('basis', next); else url.searchParams.delete('basis'); window.history.pushState({}, '', url);
  }
  function changeExposureAsOf(asOf: string) {
    setExposureAsOf(asOf); const url = new URL(location.href);
    if (asOf) url.searchParams.set('asOf', asOf); else url.searchParams.delete('asOf'); window.history.pushState({}, '', url);
  }
  function inspect(id: string, missing = false) {
    setPillar('all'); setOnlyMissing(missing); setSelected(id); setInspectVersion(n => n + 1); setExplorerOpen(true);
    requestAnimationFrame(() => explorerRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  }
  const visibleData = data?.ticker === query ? data : null;
  const profile = visibleData ? basis === 'annual' ? visibleData.annual : visibleData.current : null;
  const period = profile?.periods[0];
  const age = period && visibleData ? Math.floor((Date.parse(visibleData.generatedAt) - Date.parse(period.end)) / 86400000) : null;

  const readyTicker = visibleData?.ticker || '';
  useEffect(() => {
    if (!readyTicker || !/^#risk-(maturities|bank|notes|markets|connections)$/.test(window.location.hash)) return;
    const frame = requestAnimationFrame(() => document.getElementById('risk-connected-evidence')?.scrollIntoView({block:'start'}));
    return () => cancelAnimationFrame(frame);
  },[readyTicker]);


  return <div className={s.page} data-exposures={isExposures || undefined}>
    <header className={s.pageHeader}>
      <div><div className={s.eyebrow}><ShieldCheck size={15} /> Company risk research</div><h1>{isFcm ? 'Futures broker capital.' : isExposures ? 'Business exposures.' : 'Company risk.'}</h1><p>{isFcm ? 'Capital and customer funds, at the legal entity level.' : isExposures ? 'Revenue, funding, counterparties and the markets that connect them.' : 'Follow the business model, financial evidence and sources of pressure.'}</p></div>
      {!isFcm && <form className={s.search} onSubmit={e => { e.preventDefault(); search(input); }}>
        <label htmlFor="risk-ticker">Explore a company</label><div><Search size={17} /><input id="risk-ticker" value={input} onChange={e => setInput(e.target.value)} placeholder="Enter ticker, e.g. BAC" maxLength={12} autoComplete="off" spellCheck={false} /><button type="submit" disabled={!input.trim()} aria-label="Load risk profile"><ArrowRight size={18} /></button></div>
      </form>}
    </header>
    <div className={s.workflowBar}>
      {!isFcm && query ? <nav className={s.tabs} aria-label="Risk workspace sections">{TABS.map(([id,label,Icon], index) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => changeTab(id)}><span className={s.tabNumber}>0{index + 1}</span><Icon size={16}/>{label}</button>)}</nav> : <span className={s.toolLabel}>SEC · FFIEC · New York Fed{cftcEnabled && ' · CFTC'} · Traceable public data</span>}
      {cftcEnabled && <button className={s.textButton} onClick={() => changeTab(isFcm ? 'overview' : 'fcm')}><Building2 size={14}/>{isFcm ? 'Back to company risk' : 'Futures broker capital'}<ArrowUpRight size={13}/></button>}
    </div>
    {isFcm && <FcmCapitalPanel initialEntity={initialEntity} />}
    {isExposures && query && <CompanyExposureMap key={`${query}:${retry}:${basis}`} ticker={query} basis={basis} asOf={exposureAsOf} onAsOfChange={changeExposureAsOf} onBasisChange={changeBasis} cftcEnabled={cftcEnabled} />}
    {!independent && loading && <div className={s.loading} role="status"><Loader2 className={s.spin} size={24} /><h2>Reading {query}’s financial position</h2><p>Matching reporting periods and tracing SEC source inputs.</p><div className={s.skeletons}>{[1,2,3,4].map(n => <span key={n} />)}</div></div>}
    {!independent && error && <div className={s.empty} role="alert"><CircleAlert /><h2>We couldn’t load this company</h2><p>{error}</p><button className={s.button} onClick={() => setRetry(n => n + 1)}>Try again</button></div>}
    {!isFcm && !query && <RiskStart onExplore={search} cftcEnabled={cftcEnabled}/> }
    {!independent && visibleData && profile && <>
      <section className={s.company} aria-label="Company and reporting basis">
        <div className={s.companyIdentity}><span className={s.ticker}>{visibleData.ticker}</span><div><h2>{visibleData.companyName}</h2><p>{visibleData.sicDescription || profile.industry.label} · CIK {visibleData.cik}</p></div></div>
        <div className={s.actions}><div className={s.segmented} aria-label="Reporting basis">{[['ttm','Latest + TTM'],['annual','Annual']].map(([key,label]) => <button key={key} aria-pressed={basis === key} onClick={() => changeBasis(key)}>{label}</button>)}</div><button className={s.textButton} onClick={() => { downloadRiskFile(`${visibleData.ticker}-risk-profile-${period?.end || 'undated'}.md`, riskProfileBrief(visibleData, profile) + '\n\n' + riskResearchBrief(visibleData, profile)); setExported(true); }}>{exported ? <Check size={15}/> : <ArrowDownToLine size={15}/>} {exported ? 'Exported' : 'Export profile'}</button></div>
      </section>
      <div className={s.freshness}><span>{period ? `${riskPeriodLabel(period)} · Period ended ${period.end} · Filed ${period.filed || 'date unavailable'}` : 'No compatible reporting periods'}</span><span>{basis === 'ttm' ? 'Quarter-end balances · Trailing 12-month flows' : 'Fiscal-year-end balances · Annual flows'}</span><span>Retrieved {new Date(visibleData.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span></div>
      {basis === 'ttm' && period && visibleData.sourceCoverage?.latestFilingReportDate && visibleData.sourceCoverage.latestFilingReportDate > period.end && <div className={s.notice}><CircleAlert size={17}/><span>A newer filing reports through {visibleData.sourceCoverage.latestFilingReportDate}. This profile still uses {period.end} because compatible inputs from the newer filing could not be verified.</span></div>}
      {!!visibleData.sourceCoverage?.notices?.length && <details className={s.disclosure}><summary>Reporting sources & coverage</summary>{visibleData.sourceCoverage.notices.map((notice, index) => <p key={index}>{notice}</p>)}<div className={s.sourceLinks}>{visibleData.sourceCoverage.continuity?.sourceUrl && <a href={visibleData.sourceCoverage.continuity.sourceUrl} target="_blank" rel="noreferrer">Company history source <ArrowUpRight size={13}/></a>}{visibleData.sourceCoverage.filingFallback?.documentUrl && <a href={visibleData.sourceCoverage.filingFallback.documentUrl} target="_blank" rel="noreferrer">Reviewed filing <ArrowUpRight size={13}/></a>}</div></details>}
      {age != null && age > (basis === 'ttm' ? 180 : 550) && <div className={s.notice}><CircleAlert size={17} /> The latest available period ended {age} days before retrieval. Check for newer or untagged filings.</div>}
      <RiskWorkbench key={`briefing:${visibleData.ticker}:${basis}`} data={visibleData} profile={profile} onInspect={inspect} onEvidence={openEvidence} onExposures={() => changeTab('exposures')} onFcm={() => changeTab('fcm')} cftcEnabled={cftcEnabled}/>
      <RiskProfileOverview data={visibleData} profile={profile} onInspect={inspect} evidenceSelection={evidenceSelection} onEvidence={openEvidence} cftcEnabled={cftcEnabled} asOf={exposureAsOf} onExposures={() => changeTab('exposures')} metricExplorer={
        <div ref={explorerRef} className={s.workspace}>
          <div className={s.explorerHeading}><div><div className={s.eyebrow}>Inspect the numbers</div><h2>Inspect a metric, period by period.</h2></div><button className={s.button} aria-expanded={explorerOpen} aria-controls="risk-metric-evidence" onClick={() => setExplorerOpen(!explorerOpen)}>{explorerOpen ? 'Close metric explorer' : 'Explore all metrics'}<Compass size={16}/></button></div>
          {explorerOpen && <div id="risk-metric-evidence"><MetricExplorer key={`${visibleData.ticker}:${basis}:${inspectVersion}`} data={visibleData} profile={profile} selected={selected} onSelect={setSelected} pillar={pillar} onPillar={setPillar} onlyMissing={onlyMissing} onOnlyMissing={setOnlyMissing} /></div>}
        </div>
      } />
      <footer className={s.footer}><ShieldCheck size={16}/><p>Sources retain their own reporting dates and entity scopes. Screens are research prompts, not credit ratings or default probabilities. Missing figures are not treated as zero. The profile export covers SEC financial measures; supplementary sources link to their own evidence. The export includes the business-model research questions and source gaps. <a href={`/api/risk?ticker=${encodeURIComponent(visibleData.ticker)}&v=${RISK_VERSION}&evidence=1`} target="_blank" rel="noreferrer">View SEC profile data</a></p></footer>
    </>}
  </div>;
}
