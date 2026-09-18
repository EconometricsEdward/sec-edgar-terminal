'use client';

import { ArrowUpRight, CircleHelp } from 'lucide-react';
import type { ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskProfileOverview.module.css';
import RiskNoteEvidence from './RiskNoteEvidence';
import RiskFundingStory from './RiskFundingStory';
const RiskProfileMarketContext = dynamic(() => import('./RiskProfileMarketContext'));

type Point = { end: string; value: number | null };
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function lineSegments(points: Point[], x: (i: number) => number, y: (v: number) => number, maxGapDays: number) {
  const segments: string[] = []; let active: string[] = [];
  points.forEach((p, i) => {
    const gap = i > 0 ? (Date.parse(p.end) - Date.parse(points[i - 1].end)) / 86400000 : 0;
    if (active.length && gap > maxGapDays) { segments.push(active.join(' ')); active = []; }
    if (isNumber(p.value)) active.push(`${x(i)},${y(p.value)}`);
    else if (active.length) { segments.push(active.join(' ')); active = []; }
  });
  if (active.length) segments.push(active.join(' '));
  return segments;
}

function datePosition(points: { end: string }[], index: number) {
  const first = Date.parse(points[0]?.end), last = Date.parse(points.at(-1)?.end || ''), current = Date.parse(points[index]?.end);
  return Number.isFinite(current) && last > first ? (current - first) / (last - first) : index / Math.max(points.length - 1, 1);
}

function MiniTrend({ points, label, format, basis }: { points: Point[]; label: string; format: string; basis: string }) {
  const values = points.map(p => p.value).filter(isNumber);
  if (values.length < 2) return <span className={s.noTrend}>History limited</span>;
  const low = Math.min(...values), high = Math.max(...values), range = high - low || Math.max(Math.abs(high) * .1, 1);
  const x = (i: number) => 4 + datePosition(points, i) * 138;
  const y = (v: number) => high === low ? 24 : 42 - (v - low) / range * 36;
  return <svg viewBox="0 0 148 48" className={s.sparkline} role="img" aria-label={`${label}, company history from ${points[0]?.end} to ${points.at(-1)?.end}. Open metric for values.`}>
    <path d="M4 44 H144" className={s.guide}/>{lineSegments(points, x, y, basis === 'ttm' ? 145 : 460).map((d,i) => <polyline key={i} points={d} fill="none" className={s.trendLine}/>)}
    {points.map((p,i) => isNumber(p.value) && <circle key={p.end} cx={x(i)} cy={y(p.value)} r={i === points.length - 1 ? 3 : 1.6} className={s.trendDot}><title>{p.end}: {formatRiskValue(p.value, format)}</title></circle>)}
  </svg>;
}

export default function RiskProfileOverview({ data, profile, onInspect, onExposures, metricExplorer, cftcEnabled = true, asOf = '' }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; onExposures?: () => void; metricExplorer?: ReactNode; cftcEnabled?: boolean; asOf?: string }) {
  const view = buildRiskProfilePresentation(profile, data);
  const { balance } = view;
  const bank = view.lens.id === 'bank';
  const comparisons = bank ? [{ label:'Net loans', item:balance.loans }, { label:'Deposits', item:balance.deposits }] : view.lens.id === 'corporate' ? [{ label:'Cash & equivalents', item:balance.cash }, { label:'Current marketable securities', item:balance.currentSecurities }, { label:'Noncurrent marketable securities', item:balance.noncurrentSecurities }, { label:'Total debt', item:balance.debt }] : [{ label:'Cash', item:balance.cash }, { label:'Total liabilities', item:balance.liabilities }];
  const comparisonTitle = bank ? 'Net loans and deposits' : view.lens.id === 'corporate' ? 'Liquidity and borrowing' : 'Cash and total liabilities';
  const maxBalance = Math.max(...comparisons.map(row => isNumber(row.item.value) ? Math.max(0,row.item.value) : 0), 1);
  return <div className={s.profile}>
    <section className={s.overview} aria-labelledby="risk-profile-title">
      <div className={s.dimensions}>
        <div className={s.sectionTop}><span className={s.kicker}>01 / {view.lens.label}</span><span>Company history, in view</span></div>
        <h2 id="risk-profile-title">The financial shape of {data.ticker}.</h2><p className={s.description}>{view.lens.description}</p>
        <div className={s.columnLabels}><span>Risk dimension / key measure</span><span>History</span><span>Latest</span></div>
        {view.dimensions.map((d, i) => <div key={d.id} className={s.dimension}>
          <button className={s.dimensionMain} disabled={!d.metric} onClick={() => d.metric && onInspect(d.metric.id)} aria-label={`Inspect ${d.label}: ${d.metric?.label || 'unavailable'}`}>
            <span className={s.dimensionTitle}><span className={s.number}>{bank ? ['C','A','M','E','L','S'][i] : `0${i + 1}`}</span><span><strong>{d.label}</strong><small>{d.metric?.label || (d.id === 'management' ? 'Governance and control disclosures' : 'Required evidence unavailable')}</small></span></span>
            {d.id === 'management' ? <span className={s.noTrend}>Filing review</span> : <MiniTrend basis={profile.basis} points={d.history} label={d.metric?.label || d.label} format={d.metric?.format || 'usd'}/>}
            <span className={s.dimensionValue}><strong>{formatRiskValue(d.metric?.value, d.metric?.format)}</strong><small data-level={d.metric?.zone.level}>{d.metric?.zone.label || (d.id === 'management' ? 'Qualitative' : 'Unavailable')}<ArrowUpRight size={12}/></small></span>
          </button>
          {d.id === 'management' ? <p className={s.dimensionContext}>No management score inferred. <a href={`/disclosures?ticker=${encodeURIComponent(data.ticker)}`}>Read governance & controls <ArrowUpRight size={11}/></a></p> : <div className={s.comparison}><span>{d.comparison.priorLabel}: <b>{formatRiskValue(d.comparison.prior,d.metric?.format)}</b></span><span>{d.comparison.delta == null ? 'Comparison unavailable' : `${formatRiskValue(d.comparison.delta,d.comparison.deltaFormat,true)} change`}</span></div>}
        </div>)}
        <p className={s.caption}>Trends use each metric’s own scale. Screening labels are research prompts, not ratings.</p>
      </div>
      <aside className={s.balance} aria-labelledby="balance-structure-title">
        <div className={s.kicker}>THE BALANCE SHEET</div><h3 id="balance-structure-title">What supports the asset base?</h3>
        <div className={s.assetTotal}><span>Total assets</span><strong>{formatRiskValue(balance.assets.value)}</strong><small>{profile.periods[0]?.end || 'Period unavailable'}</small></div>
        {balance.segments.length > 0 ? <><div className={s.composition} role="img" aria-label={balance.segments.map(part => `${part.label}: ${formatRiskValue(part.value)}, ${formatRiskValue(part.share,'pct')}`).join('; ')}>{balance.segments.map(part => <span key={part.id} data-kind={part.id} style={{width:`${part.share * 100}%`}} />)}</div><dl className={s.balanceLegend}>{balance.segments.map(part => <div key={part.id}><dt><i data-kind={part.id}/>{part.label}</dt><dd>{formatRiskValue(part.value)}<small>{formatRiskValue(part.share,'pct')}</small></dd></div>)}</dl></> : <dl className={s.balanceLegend}><div><dt>Liabilities</dt><dd>{formatRiskValue(balance.liabilities.value)}</dd></div><div><dt>Book equity</dt><dd>{formatRiskValue(balance.equity.value)}</dd></div></dl>}
        <div className={s.fundingComparison}><h3>{comparisonTitle}</h3><p>{bank ? 'Reported balances on a common dollar scale' : 'Separate reported balances on a common dollar scale'}</p>{comparisons.map(row => <div key={row.label} className={s.fundingRow}><div><span>{row.label}</span><strong>{formatRiskValue(row.item.value)}</strong></div><div className={s.fundingTrack}>{isNumber(row.item.value) && row.item.value >= 0 && <span style={{width:`${row.item.value/maxBalance*100}%`}}/>}</div></div>)}{view.lens.id === 'corporate' && <p className={s.caption}>Securities carry credit, rate and liquidity risk. Noncurrent investments are shown separately from cash. {isNumber(balance.cashAndMarketableSecurities.value) && <>Cash and marketable securities total {formatRiskValue(balance.cashAndMarketableSecurities.value)}.</>}</p>}</div>
        <details className={s.sourceNotes}><summary>Balance definitions & sources</summary>{balance.notes.map(note => <p key={note}>{note}</p>)}{[balance.assets,balance.liabilities,balance.equity,...comparisons.map(row => row.item)].map((item,i) => <div className={s.sourceRow} key={i}><strong>{item.label}: {formatRiskValue(item.value)}</strong><p>{item.formula}</p>{item.sources.slice(0,3).map((source: {documentUrl?:string;url?:string;tag:string;end:string}, j:number) => (source.documentUrl || source.url) && <a key={j} href={source.documentUrl || source.url} target="_blank" rel="noreferrer">{source.tag} · {source.end} <ArrowUpRight size={11}/></a>)}</div>)}</details>
      </aside>
    </section>

    {metricExplorer}
    <RiskFundingStory key={`${data.ticker}:${profile.basis}`} profile={profile} company={{ sic: data.sic, ticker: data.ticker }} onInspect={onInspect} />
    <RiskNoteEvidence key={`${data.ticker}:${profile.basis}`} ticker={data.ticker} basis={profile.basis} />
    {cftcEnabled && <RiskProfileMarketContext key={`${data.ticker}:${profile.basis}:${asOf}`} ticker={data.ticker} companyName={data.companyName} basis={profile.basis === 'annual' ? 'annual' : 'ttm'} asOf={asOf} companyType={view.lens.id} />}
    {onExposures && <button className={s.moreExposures} onClick={onExposures}>Open the full business exposure map <ArrowUpRight size={15}/></button>}
    <div className={s.coverage}><CircleHelp size={17}/><div><button onClick={() => onInspect(profile.coverage.missing[0] || '', profile.coverage.missing.length > 0)}>{profile.coverage.available} of {profile.coverage.total} available metrics · {profile.coverage.missing.length} data gaps<ArrowUpRight size={13}/></button>{view.limitations.map(note => <p key={note}>{note}</p>)}</div></div>
  </div>;
}
