'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, Building2, CalendarRange, CircleHelp, FileText, ShieldCheck } from 'lucide-react';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import { comparableRiskChanges, maturityView } from './riskEvidenceModel.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskIntelligence.module.css';

const BankEvidence = dynamic(() => import('./RiskBankEvidence'), { loading: () => <p className={s.state} role="status">Opening bank reports…</p> });
const MarketEvidence = dynamic(() => import('./RiskMarketEvidence'), { loading: () => <p className={s.state} role="status">Opening market conditions…</p> });

export default function RiskIntelligence({ data, profile, onInspect, cftcEnabled = true }: { data: RiskData; profile: RiskProfile; onInspect: (id: string) => void; cftcEnabled?: boolean }) {
  const view = useMemo(() => buildRiskProfilePresentation(profile, data), [data, profile]);
  const [lens, setLens] = useState('maturities');
  const [group, setGroup] = useState('all');
  const changes = useMemo(() => comparableRiskChanges(profile), [profile]);
  const visible = changes.filter(row => group === 'all' || row.pillar === group);
  const bank = view.lens.id === 'bank';
  const tabs = [{ id: 'maturities', label: 'Debt maturities', Icon: CalendarRange }, ...(bank ? [{ id: 'bank', label: 'Bank regulatory reports', Icon: Building2 }] : []), { id: 'markets', label: cftcEnabled ? 'Funding & derivatives' : 'Funding conditions', Icon: Activity }];
  return <section className={s.intelligence} aria-label="Risk research briefing">
    <div className={s.briefHeading}><div><span className={s.kicker}>THE RISK BRIEFING</span><h2>Capacity, obligations, and the market around them.</h2></div><span className={s.period}><ShieldCheck size={15}/>{profile.periods[0]?.end || 'Period unavailable'}</span></div>
    <div className={s.briefGrid}>
      <div className={s.observations}><h3>What the financials support</h3>{view.strengths.length ? view.strengths.slice(0, 2).map(item => <button key={item.id} onClick={() => onInspect(item.metricId)}><span className={s.observationLine}/><span>{item.text}<small>Inspect {item.label.toLowerCase()}</small></span></button>) : <p>Read the reported measures below. The available inputs do not support a concise positive conclusion for this reporting basis.</p>}</div>
      <div className={s.researchFocus}><h3>Where to go next</h3><p>{bank ? 'Compare the consolidated company with the relevant bank’s capital, loan quality and funding. Each legal entity keeps its own reporting scope.' : view.lens.id === 'broker' ? 'Connect firm liquidity and secured funding to repo conditions. Keep client assets, collateral and regulatory capital separate.' : view.lens.id === 'insurance' ? 'Compare consolidated capital and claims experience with funding conditions. Statutory insurance capital requires separate disclosures.' : 'Place the debt schedule beside cash and earnings, then examine the funding and hedging markets that may affect future financing.'}</p><div className={s.sourcePills}><span>SEC</span>{bank && <span>FFIEC</span>}<span>New York Fed</span>{cftcEnabled && <span>CFTC</span>}<span>DTCC references</span></div></div>
    </div>
    <details className={s.changes}>
      <summary><Activity size={16}/><strong>What changed in the financials?</strong><span>{changes.length} comparable measures</span></summary>
      <div className={s.changeTools}><p>{profile.basis === 'ttm' ? 'Quarter-end comparison; TTM earnings windows overlap.' : 'Comparison with the prior fiscal year.'} Changes describe direction, not a credit rating.</p><label>Focus<select value={group} onChange={e => setGroup(e.target.value)}><option value="all">All measures</option><option value="credit">Credit</option><option value="capital">Capital</option><option value="liquidity">Liquidity</option><option value="profitability">Earnings</option><option value="quality">Earnings quality</option></select></label></div>
      {visible.length ? <div className={s.tableScroll}><table><thead><tr><th>Measure</th><th>{visible[0].priorEnd}</th><th>{visible[0].end}</th><th>Change</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><th scope="row"><button onClick={() => onInspect(row.id)}>{row.label}</button></th><td>{formatRiskValue(row.prior, row.format)}</td><td>{formatRiskValue(row.value, row.format)}</td><td>{formatRiskValue(row.delta, row.deltaFormat, true)}</td></tr>)}</tbody></table></div> : <p className={s.state}>No compatible adjacent observations for this selection. Missing or nonconsecutive periods are excluded.</p>}
    </details>
    <div className={s.evidenceHeading}><div><span className={s.kicker}>CONNECT THE EVIDENCE</span><h2>A wider view of financial risk.</h2></div><p>Company disclosures and market reports retain their own dates and scope.</p></div>
    <div className={s.lensTabs} role="tablist" aria-label="Risk evidence lenses">{tabs.map(({ id, label, Icon }) => <button key={id} type="button" role="tab" id={`risk-lens-${id}`} aria-selected={lens === id} aria-controls="risk-evidence-panel" tabIndex={lens === id ? 0 : -1} onClick={() => setLens(id)} onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const index = tabs.findIndex(tab => tab.id === lens);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      setLens(tabs[next].id); document.getElementById(`risk-lens-${tabs[next].id}`)?.focus();
    }}><Icon size={17}/>{label}</button>)}</div>
    <div id="risk-evidence-panel" role="tabpanel" aria-labelledby={`risk-lens-${lens}`} className={s.evidencePanel}>
      {lens === 'maturities' && <MaturityEvidence key={data.ticker} data={data} financial={view.lens.id !== 'corporate'} />}
      {lens === 'bank' && <BankEvidence companyName={data.companyName} ticker={data.ticker} companyPeriod={profile.periods[0]?.end || ''} />}
      {lens === 'markets' && <MarketEvidence ticker={data.ticker} companyType={view.lens.id} cftcEnabled={cftcEnabled} />}
    </div>
  </section>;
}

function MaturityEvidence({ data, financial }: { data: RiskData; financial: boolean }) {
  const profile = data.refinancing;
  const view = maturityView(profile, data.generatedAt.slice(0, 10));
  const [selected, setSelected] = useState<string | null>(null);
  const active = view.buckets.find(bucket => bucket.key === selected) || view.peak;
  if (!profile || profile.status !== 'ready') return <div className={s.unavailable}><CalendarRange size={28}/><h3>No supported maturity schedule in the available tags.</h3><p>Some companies report debt schedules in custom tags or tables. Missing coverage does not mean the company has no debt or refinancing needs.</p>{profile?.warnings?.map(note => <p key={note}>{note}</p>)}<div className={s.links}><a href={`/filings?ticker=${encodeURIComponent(data.ticker)}`}>Review company filings</a><a href="/market/refinancing">Explore the Refinancing Wall</a></div></div>;
  return <>
    <div className={s.panelHeading}><div><h3>When reported principal comes due</h3><p>{profile.form} · Schedule at {profile.asOf} · Filed {profile.filedAt}</p></div><span className={s.badge}>{profile.coverage.reportedBuckets}/6 buckets reported</span></div>
    {view.hasElapsed && <p className={s.notice}><CircleHelp size={16}/>Some buckets have ended since this filing. They remain historical scheduled amounts; subsequent repayments and new issuance are not inferred.</p>}
    <div className={s.maturityLayout}>
      <div><div className={s.maturityChart} aria-label="Reported debt principal by maturity bucket">{view.buckets.map(bucket => <button key={bucket.key} className={s.maturityColumn} aria-pressed={active?.key === bucket.key} onClick={() => setSelected(bucket.key)} onPointerEnter={e => { if (e.pointerType === 'mouse') setSelected(bucket.key); }} onFocus={() => setSelected(bucket.key)} aria-label={`${bucket.shortLabel}, ${bucket.value == null ? 'not reported' : formatRiskValue(bucket.value)}${bucket.elapsed ? ', elapsed period' : ''}`}>
        <strong>{formatRiskValue(bucket.value)}</strong><span className={s.barWell}><span className={s.maturityBar} data-elapsed={bucket.elapsed || undefined} data-missing={bucket.value == null || undefined} style={{ height: bucket.value == null ? '100%' : `${Math.max(bucket.value > 0 ? 1 : 0, bucket.value / view.max * 100)}%` }}/></span><span>{bucket.shortLabel}</span><small>{bucket.elapsed ? 'Period ended' : bucket.calendarYear ? 'Calendar year' : 'Filing basis'}</small>
      </button>)}</div><div className={s.chartReadout} aria-live="polite"><strong>{active?.label}: {formatRiskValue(active?.value)}</strong><span>{active?.startDate} – {active?.endDate || 'onward'}{active?.dateBasis === 'anniversary-estimate' ? ' · indicative fiscal dates' : ''}</span></div><p className={s.caption}>Hover, tap or focus a bar. “Thereafter” combines all later years and is excluded from the largest annual bucket comparison.</p></div>
      <aside className={s.maturityAside}><div><span>{profile.coverage.complete ? 'Total scheduled principal' : 'Reported subtotal'}</span><strong>{formatRiskValue(profile.coverage.complete ? profile.totalScheduled : profile.reportedSubtotal)}</strong><small>{profile.coverage.complete ? 'Across all six buckets' : 'Partial schedule; not total debt'}</small></div><div><span>Largest reported annual bucket</span><strong>{formatRiskValue(view.peak?.value)}</strong><small>{view.peak?.label || 'Unavailable'} · as originally reported</small></div><div><span>First two buckets / schedule</span><strong>{formatRiskValue(view.nearShare, 'pct')}</strong><small>{profile.coverage.complete ? 'At the schedule date' : 'Requires all six buckets'}</small></div></aside>
    </div>
    <div className={s.capacityRow}>{[['Cash at schedule date', profile.metrics.cash, 'usd'], ...(financial ? [] : [['Annual operating cash flow', profile.metrics.operatingCashFlow, 'usd']]), ['Cash / first maturity bucket', profile.metrics.cashToNext12m, 'x']].map(([label, metric, format]: any) => <div key={label}><span>{label}</span><strong>{formatRiskValue(metric?.value, format)}</strong><small>{metric?.startDate ? `${metric.startDate} – ${metric.endDate}` : metric?.endDate || 'Compatible inputs unavailable'}</small></div>)}</div>
    <details className={s.method}><summary>Schedule definitions, exact values & source</summary><p>All comparison amounts use the schedule’s own annual filing, even when the main profile uses a newer quarter. Cash has other uses, and historical cash generation is not a forecast of debt-service capacity.</p>{profile.warnings.map(note => <p key={note}>{note}</p>)}<div className={s.tableScroll}><table><thead><tr><th>Bucket</th><th>Principal, USD</th><th>SEC tag</th></tr></thead><tbody>{view.buckets.map(b => <tr key={b.key}><th>{b.label}</th><td>{b.value == null ? 'Not reported' : b.value.toLocaleString('en-US')}</td><td className={s.tag}>{b.tag}</td></tr>)}</tbody></table></div></details>
    <div className={s.links}><a href={profile.sourceUrl} target="_blank" rel="noreferrer"><FileText size={15}/>Source filing</a><a href="/market/refinancing">Compare across the market</a></div>
  </>;
}
