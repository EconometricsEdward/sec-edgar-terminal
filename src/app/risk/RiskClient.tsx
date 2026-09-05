'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, Check, CircleAlert, FileText, FlaskConical, Loader2, Search, ShieldCheck } from 'lucide-react';
import { PILLAR_LABELS, RISK_VERSION, formatRiskValue, riskBrief, riskDelta, riskPeriodLabel, runRiskStress } from '../../utils/riskWorkspace.js';
import { MetricExplorer, RiskDisclosures, RiskStress } from './RiskPanels';
import type { RiskData } from './riskTypes';
import s from './risk.module.css';
import { downloadRiskFile } from './riskDownload';

const TABS = [['overview', 'Risk overview', BarChart3], ['stress', 'Stress test', FlaskConical], ['disclosures', 'Filings & models', FileText]] as const;

export default function RiskClient({ initialTicker = '' }: { initialTicker?: string }) {
  const [input, setInput] = useState(initialTicker);
  const [query, setQuery] = useState(initialTicker);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<RiskData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [basis, setBasis] = useState('ttm');
  const [tab, setTab] = useState('overview');
  const [pillar, setPillar] = useState('all');
  const [selected, setSelected] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [controls, setControls] = useState<Record<string, number>>({});
  const [exported, setExported] = useState(false);
  const explorerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query) { setData(null); setError(''); setLoading(false); return; }
    if (!/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(query)) {
      setData(null); setLoading(false); setError('Enter a valid company ticker (for example JPM or BRK.B).'); return;
    }
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setControls({}); setExported(false);
    fetch(`/api/risk?ticker=${encodeURIComponent(query)}&v=${RISK_VERSION}`, { signal: controller.signal })
      .then(async (res) => { const body = await res.json(); if (!res.ok) throw new Error(body.error || 'Could not load the risk profile.'); return body; })
      .then((body: RiskData) => {
        if (controller.signal.aborted) return;
        setData(body); setBasis(body.current.periods.length ? 'ttm' : 'annual');
        setSelected(''); setPillar('all'); setOnlyMissing(false); setTab('overview');
      }).catch((err) => { if (!controller.signal.aborted) setError(err.message === 'Failed to fetch' ? 'The risk service could not be reached. Please retry.' : err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, retry]);

  useEffect(() => {
    const onPop = () => { const p = new URLSearchParams(location.search); const ticker = (p.get('ticker') || p.get('symbol') || '').toUpperCase(); setInput(ticker); setQuery(ticker); if (!ticker) { setData(null); setLoading(false); } };
    window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop);
  }, []);

  function search(ticker: string) {
    const next = ticker.trim().toUpperCase();
    if (!next) return;
    setInput(next); if (next === query) setRetry((n) => n + 1); else setQuery(next);
    const url = new URL(location.href); url.searchParams.set('ticker', next); url.searchParams.delete('symbol'); window.history.pushState({}, '', url);
  }
  function inspect(id: string, missing = false) {
    setTab('overview'); setPillar('all'); setOnlyMissing(missing); setSelected(id);
    requestAnimationFrame(() => explorerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  const profile = data ? basis === 'annual' ? data.annual : data.current : null;
  const scenario = profile ? runRiskStress(profile, controls) : null;
  const period = profile?.periods[0];
  const age = period && data ? Math.floor((Date.parse(data.generatedAt) - Date.parse(period.end)) / 86400000) : null;
  const heroIds = profile?.industry.isBank ? ['bank_equity_assets', 'provision_rate', 'loans_deposits', 'reserve_coverage'] : profile?.industry.isFinancial ? ['ins_equity_assets', 'loss_ratio', 'liab_to_assets', 'net_margin'] : ['interest_coverage', 'liab_to_assets', 'current_ratio', 'net_margin'];

  return <div className={s.page}>
    <div className={s.pageHeader}>
      <div><div className={s.eyebrow}><ShieldCheck size={15} /> Company risk research</div><h1>See the pressure points.</h1><p>Understand what changed, inspect the evidence, and test what could happen next.</p></div>
      <form className={s.search} onSubmit={(e) => { e.preventDefault(); search(input); }}>
        <label htmlFor="risk-ticker">Company ticker</label>
        <div><Search size={17} /><input id="risk-ticker" value={input} onChange={(e) => setInput(e.target.value)} placeholder="JPM, AAPL, BAC…" maxLength={12} autoComplete="off" spellCheck={false} /><button type="submit" disabled={!input.trim()} aria-label="Load risk profile"><ArrowRight size={18} /></button></div>
      </form>
    </div>
    {loading && <div className={s.loading} role="status"><Loader2 className={s.spin} size={24} /><h2>Building {query}’s risk profile</h2><p>Matching SEC reporting periods and tracing calculation inputs.</p><div className={s.skeletons}>{[1,2,3,4].map((n) => <span key={n} />)}</div></div>}
    {error && <div className={s.empty} role="alert"><CircleAlert /><h2>We couldn’t load this company</h2><p>{error}</p><button className={s.button} onClick={() => setRetry((n) => n + 1)}>Try again</button></div>}
    {!query && !data && <div className={s.empty}><ShieldCheck size={34} /><h2>Start with a company you follow</h2><p>A source-linked view of credit, capital, liquidity, and earnings. No account required.</p><div className={s.actions}>{['JPM','BAC','AAPL','F'].map((t) => <button className={s.button} onClick={() => search(t)} key={t}>{t}<ArrowUpRight size={14} /></button>)}</div></div>}
    {data && profile && <>
      <section className={s.company} aria-label="Company and reporting basis">
        <div className={s.companyIdentity}><span className={s.ticker}>{data.ticker}</span><div><h2>{data.companyName}</h2><p>{profile.industry.label} · {profile.industry.isBank ? 'Bank credit lens' : profile.industry.isFinancial ? 'Insurance lens' : 'Corporate credit lens'}</p></div></div>
        <div className={s.actions}><div className={s.segmented} aria-label="Reporting basis">{[['ttm','Latest + TTM'],['annual','Annual history']].map(([key,label]) => <button key={key} aria-pressed={basis === key} disabled={key === 'ttm' && !data.current.periods.length} onClick={() => { setBasis(key); setControls({}); setExported(false); }}>{label}</button>)}</div>
          <button className={s.button} disabled={!scenario} onClick={() => { downloadRiskFile(`${data.ticker}-risk-brief-${period?.end || 'undated'}.md`, riskBrief(data, profile, scenario)); setExported(true); }}>{exported ? <Check size={15}/> : <ArrowDownToLine size={15}/>} {exported ? 'Brief exported' : 'Export brief'}</button></div>
      </section>
      <div className={s.freshness}><span><span className={s.dot} /> {period ? `${riskPeriodLabel(period)} · Period ended ${period.end} · Filed ${period.filed}` : 'No compatible reporting periods'}</span><span>{basis === 'ttm' ? 'Quarter-end balances · Trailing 12-month flows' : 'Fiscal-year-end balances · Annual flows'}</span><span>Retrieved {new Date(data.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</span></div>
      {age != null && age > (basis === 'ttm' ? 180 : 550) && <div className={s.notice}><CircleAlert size={17} /> The latest available period ended {age} days before this data retrieval. Check for newer or untagged filings.</div>}
      <div className={s.scorecards}>{heroIds.map((id) => { const m = profile.metrics.find((m) => m.id === id); return m && <button key={id} className={s.scorecard} onClick={() => inspect(id)}><span>{m.label}<ArrowUpRight size={14}/></span><strong>{formatRiskValue(m.value, m.format)}</strong><span className={s.cardBottom}><span className={s.badge} data-level={m.zone.level}>{m.zone.label}</span><small>{m.delta == null ? 'No prior comparison' : riskDelta(m)}</small></span></button>; })}</div>
      <section className={s.briefing} aria-labelledby="review-priorities">
        <div className={s.briefingTitle}><div className={s.eyebrow}>Your review queue</div><h2 id="review-priorities">{profile.watchItems.length ? `${profile.watchItems.length} signals to investigate` : 'No elevated screening signals'}</h2><p>Threshold screens prompt a review. They are not credit ratings.</p><button className={s.textButton} onClick={() => inspect(profile.coverage.missing[0] || '', true)}>{profile.coverage.available}/{profile.coverage.total} metrics available · {profile.coverage.missing.length} gaps <ArrowRight size={14}/></button></div>
        <div className={s.watchList}>{profile.watchItems.slice(0,3).map((w, i) => <button key={w.id} onClick={() => inspect(w.id)}><span className={s.watchNumber}>{String(i + 1).padStart(2,'0')}</span><span><strong>{w.label}</strong><small>{w.reason}</small></span><ArrowUpRight size={17}/></button>)}{!profile.watchItems.length && <p className={s.noSignals}>Review available evidence and missing disclosures before drawing a conclusion.</p>}{profile.watchItems.length > 3 && <button onClick={() => { setPillar('watch'); setOnlyMissing(false); setTab('overview'); explorerRef.current?.scrollIntoView({ behavior: 'smooth' }); }}>View all {profile.watchItems.length} priorities <ArrowRight size={16}/></button>}</div>
      </section>
      <div ref={explorerRef} className={s.workspace}>
        <nav className={s.tabs} aria-label="Risk workspace sections">{TABS.map(([id,label,Icon]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={17}/>{label}</button>)}</nav>
        {tab === 'overview' && <MetricExplorer key={`${data.ticker}:${basis}`} data={data} profile={profile} selected={selected} onSelect={setSelected} pillar={pillar} onPillar={setPillar} onlyMissing={onlyMissing} onOnlyMissing={setOnlyMissing} />}
        {tab === 'stress' && <RiskStress profile={profile} controls={controls} onControls={(next) => { setControls(next); setExported(false); }} />}
        {tab === 'disclosures' && <RiskDisclosures data={data} />}
      </div>
      <footer className={s.footer}><ShieldCheck size={16}/><p>Built from SEC company facts. {Object.values(PILLAR_LABELS).join(' · ')}. Missing or dimensional disclosures remain unavailable. Screening thresholds are product conventions; they are not calibrated default probabilities. <a href={`/api/risk?ticker=${data.ticker}&v=${RISK_VERSION}`} target="_blank" rel="noreferrer">View source data</a></p></footer>
    </>}
  </div>;
}
