'use client';

import { ArrowUpRight, CircleHelp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskProfileOverview.module.css';
import RiskFundingStory from './RiskFundingStory';
import ChartPeriodOverlay from '../../components/charts/ChartPeriodOverlay';
import RiskEvidenceWorkspace, { type RiskEvidenceId } from './RiskEvidenceWorkspace';

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

function MiniTrend({ points, label, format, basis, activeId, onInspect, lossFlag = false }: { points: Point[]; label: string; format: string; basis: string; activeId: string; onInspect: (id: string | null) => void; lossFlag?: boolean }) {
  const values = points.map(p => p.value).filter(isNumber);
  if (!points.length) return <span className={s.noTrend}>History unavailable</span>;
  const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 1, range = high - low || Math.max(Math.abs(high) * .1, 1);
  const x = (i: number) => points.length === 1 ? 74 : 4 + datePosition(points, i) * 138;
  const y = (v: number) => high === low ? 24 : 42 - (v - low) / range * 36;
  const activeIndex = points.findIndex(point => point.end === activeId);
  const describeValue = (value: number | null | undefined) => lossFlag ? value === 1 ? '1 (loss)' : value === 0 ? '0 (no loss)' : 'Unavailable' : formatRiskValue(value, format);
  return <svg viewBox="0 0 148 48" className={s.sparkline} role="group" aria-label={`${label}, company history from ${points[0]?.end} to ${points.at(-1)?.end}`}>
    <path d="M4 44 H144" className={s.guide}/>{lineSegments(points, x, y, basis === 'ttm' ? 145 : 460).map((d,i) => <polyline key={i} points={d} fill="none" className={s.trendLine}/>)}
    {activeIndex >= 0 && <line x1={x(activeIndex)} x2={x(activeIndex)} y1={2} y2={44} className={s.inspectionLine}/>}
    {points.map((p,i) => isNumber(p.value) && <circle key={p.end} cx={x(i)} cy={y(p.value)} r={p.end === activeId ? 3.5 : 1.6} className={s.trendDot}><title>{p.end}: {describeValue(p.value)}</title></circle>)}
    {!values.length && <text x={74} y={24} textAnchor="middle" className={s.noValues}>No reported values</text>}
    <ChartPeriodOverlay points={points.map((point, index) => ({ id: point.end, label: point.end, x: x(index) }))} activeId={activeId} onInspect={onInspect} left={0} right={148} top={0} bottom={48} label={label} describePoint={id => `${id}: ${describeValue(points.find(point => point.end === id)?.value)}`}/>
  </svg>;
}

type Dimension = ReturnType<typeof buildRiskProfilePresentation>['dimensions'][number];

function DimensionRow({ dimension: d, number, basis, reportingEnd, ticker, onInspect }: { dimension: Dimension; number: string; basis: string; reportingEnd: string; ticker: string; onInspect: (id: string) => void }) {
  const [inspectedEnd, setInspectedEnd] = useState<string | null>(null);
  const activeIndex = inspectedEnd ? d.history.findIndex((point: Point) => point.end === inspectedEnd) : -1;
  const activePoint: Point | undefined = activeIndex >= 0 ? d.history[activeIndex] : undefined;
  const latestEnd = reportingEnd || d.history.at(-1)?.end || '';
  const activeEnd = activePoint?.end || latestEnd;
  const historical = Boolean(activePoint && activePoint.end !== latestEnd);
  const activeValue = activePoint ? activePoint.value : d.metric?.value;
  const lossFlag = d.metric?.id === 'loss_years';
  const inspectingLossFlag = lossFlag && Boolean(activePoint);
  const status = inspectingLossFlag ? activeValue === 1 ? 'Loss reported' : activeValue === 0 ? 'No loss reported' : 'Unavailable' : historical ? isNumber(activeValue) ? 'Historical observation' : 'Unavailable' : d.metric?.zone.label || (d.id === 'management' ? 'Qualitative' : 'Unavailable');
  // Compare only adjacent observations; never carry an older available value
  // across a missing period or a gap in the reported history.
  const previousPoint: Point | undefined = historical && activeIndex > 0 ? d.history[activeIndex - 1] : undefined;
  const gapDays = previousPoint ? (Date.parse(activeEnd) - Date.parse(previousPoint.end)) / 86400000 : Infinity;
  const previousValue = historical ? previousPoint && gapDays > 0 && gapDays <= (basis === 'ttm' ? 145 : 460) ? previousPoint.value : null : d.comparison.prior;
  const delta = isNumber(activeValue) && isNumber(previousValue) ? activeValue - previousValue : null;
  const management = d.id === 'management';
  const inspectLabel = `Inspect ${d.label}: ${d.metric?.label || 'unavailable'}`;
  return <div className={s.dimension}>
    <div className={s.dimensionMain}>
      <button className={s.dimensionTitle} disabled={!d.metric} onClick={() => d.metric && onInspect(d.metric.id)} aria-label={inspectLabel}><span className={s.number}>{number}</span><span><strong>{d.label}</strong><small>{inspectingLossFlag ? 'Loss flag for this period' : d.metric?.label || (management ? 'Governance and control disclosures' : 'Required evidence unavailable')}</small></span></button>
      {management ? <span className={s.noTrend}>Filing review</span> : <MiniTrend basis={basis} points={d.history} label={lossFlag ? 'Loss flag for this period' : d.metric?.label || d.label} format={d.metric?.format || 'usd'} activeId={activeEnd} onInspect={setInspectedEnd} lossFlag={lossFlag}/>}
      <button className={s.dimensionValue} disabled={!d.metric} onClick={() => d.metric && onInspect(d.metric.id)} aria-label={`${inspectLabel}, calculation and history`}><strong>{formatRiskValue(activeValue, d.metric?.format)}</strong><small data-level={historical || inspectingLossFlag ? undefined : d.metric?.zone.level}>{status}<ArrowUpRight size={12}/></small>{!management && activeEnd && <time className={s.observationDate} dateTime={activeEnd}>{activeEnd}</time>}</button>
    </div>
    {management ? <a className={s.dimensionContext} href={`/disclosures?ticker=${encodeURIComponent(ticker)}`}>Governance & controls <ArrowUpRight size={11}/></a> : inspectingLossFlag ? <span className={s.dimensionContext}>1 = loss · 0 = no loss</span> : <div className={s.comparison}><span title={d.comparison.priorLabel}>{basis === 'ttm' ? 'Prior quarter' : 'Prior year'} <b>{formatRiskValue(previousValue,d.metric?.format)}</b>{historical && previousPoint && gapDays > 0 && gapDays <= (basis === 'ttm' ? 145 : 460) && <time dateTime={previousPoint.end}> · {previousPoint.end}</time>}</span><span>{delta == null ? '—' : formatRiskValue(delta,d.comparison.deltaFormat,true)}</span></div>}
  </div>;
}

export default function RiskProfileOverview({ data, profile, onInspect, onExposures, metricExplorer, evidenceSelection = 'maturities', onEvidence = () => {}, cftcEnabled = true, asOf = '' }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; onExposures?: () => void; metricExplorer?: ReactNode; evidenceSelection?: RiskEvidenceId; onEvidence?: (id: RiskEvidenceId) => void; cftcEnabled?: boolean; asOf?: string }) {
  const view = buildRiskProfilePresentation(profile, data);
  const { balance } = view;
  const bank = view.lens.id === 'bank';
  const comparisons = bank ? [{ label:'Net loans', item:balance.loans }, { label:'Deposits', item:balance.deposits }] : view.lens.id === 'corporate' ? [{ label:balance.cash.label, item:balance.cash }, { label:'Current investments', item:balance.currentSecurities }, { label:'Noncurrent investments', item:balance.noncurrentSecurities }, { label:balance.debt.label, item:balance.debt }] : [{ label:balance.cash.label, item:balance.cash }, { label:'Total liabilities', item:balance.liabilities }];
  const comparisonTitle = bank ? 'Net loans and deposits' : view.lens.id === 'corporate' ? 'Liquidity and borrowing' : 'Cash and total liabilities';
  const maxBalance = Math.max(...comparisons.map(row => isNumber(row.item.value) ? Math.max(0,row.item.value) : 0), 1);
  return <div className={s.profile}>
    <section id="risk-financial-position" className={s.overview} aria-labelledby="risk-profile-title">
      <div className={s.dimensions}>
        <div className={s.sectionTop}><h2 id="risk-profile-title">Balance & ratios</h2><span>{profile.basis === 'ttm' ? 'TTM · quarter end' : 'Annual'}</span></div>
        <div className={s.columnLabels}><span>Measure</span><span>History</span><span>Value</span></div>
        {view.dimensions.map((d, i) => <DimensionRow key={`${data.ticker}:${profile.basis}:${profile.periods[0]?.end}:${d.id}`} dimension={d} number={bank ? ['C','A','M','E','L','S'][i] : `0${i + 1}`} basis={profile.basis} reportingEnd={profile.periods[0]?.end || ''} ticker={data.ticker} onInspect={onInspect}/>)}
        <details className={s.chartNotes}><summary>Chart basis & scope</summary><p>{view.lens.description}</p><p>Hover, tap or use arrow keys to inspect a period. Each trend uses its own scale. Comparisons use adjacent observations; TTM windows overlap. Screening labels are research prompts, not ratings. Loss history plots 1 for a negative-income window and 0 otherwise; its latest count covers the displayed history.</p>{bank && <p>Management requires qualitative filing review; no management score is inferred.</p>}</details>
      </div>
      <aside className={s.balance} aria-labelledby="balance-structure-title">
        <div className={s.balanceHeading}><h3 id="balance-structure-title">Asset financing</h3><span>{profile.periods[0]?.end || 'Date unavailable'}</span></div>
        <div className={s.assetTotal}><span>Total assets</span><strong>{formatRiskValue(balance.assets.value)}</strong></div>
        {balance.segments.length > 0 ? <><div className={s.composition} role="img" aria-label={balance.segments.map(part => `${part.label}: ${formatRiskValue(part.value)}, ${formatRiskValue(part.share,'pct')}`).join('; ')}>{balance.segments.map(part => <span key={part.id} data-kind={part.id} style={{width:`${part.share * 100}%`}} />)}</div><dl className={s.balanceLegend}>{balance.segments.map(part => <div key={part.id}><dt><i data-kind={part.id}/>{part.label}</dt><dd>{formatRiskValue(part.value)}<small>{formatRiskValue(part.share,'pct')}</small></dd></div>)}</dl></> : <dl className={s.balanceLegend}><div><dt>Liabilities</dt><dd>{formatRiskValue(balance.liabilities.value)}</dd></div><div><dt>Book equity</dt><dd>{formatRiskValue(balance.equity.value)}</dd></div></dl>}
        <div className={s.fundingComparison}><div className={s.balanceHeading}><h3>{comparisonTitle}</h3><span>USD · same scale</span></div>{comparisons.map(row => <div key={row.label} className={s.fundingRow}><div><span>{row.label}</span><strong>{formatRiskValue(row.item.value)}</strong></div><div className={s.fundingTrack}>{isNumber(row.item.value) && row.item.value >= 0 && <span style={{width:`${row.item.value/maxBalance*100}%`}}/>}</div></div>)}</div>
        <details className={s.sourceNotes}><summary>Definitions & SEC inputs</summary>{balance.notes.map(note => <p key={note}>{note}</p>)}{view.lens.id === 'corporate' && <p>Investments may include nonmarketable assets and remain separate from cash. {isNumber(balance.cashAndMarketableSecurities.value) && <>Reported cash and investments total {formatRiskValue(balance.cashAndMarketableSecurities.value)}.</>}</p>}{[balance.assets,balance.liabilities,balance.equity,...comparisons.map(row => row.item)].map((item,i) => <div className={s.sourceRow} key={i}><strong>{item.label}: {formatRiskValue(item.value)}</strong><p>{item.formula}</p>{item.sources.slice(0,3).map((source: {documentUrl?:string;url?:string;tag:string;end:string}, j:number) => (source.documentUrl || source.url) && <a key={j} href={source.documentUrl || source.url} target="_blank" rel="noreferrer">{source.tag} · {source.end} <ArrowUpRight size={11}/></a>)}</div>)}</details>
      </aside>
    </section>

    {metricExplorer}
    <RiskFundingStory key={`funding:${data.ticker}:${profile.basis}`} profile={profile} company={{ sic: data.sic, ticker: data.ticker }} onInspect={onInspect} />
    <RiskEvidenceWorkspace key={`evidence:${data.cik}`} data={data} profile={profile} selection={evidenceSelection} onSelect={onEvidence} cftcEnabled={cftcEnabled} asOf={asOf}/>
    <div className={s.profileFooter}>{onExposures && <button className={s.moreExposures} onClick={onExposures}>Business exposure map <ArrowUpRight size={15}/></button>}<details className={s.coverage}><summary><CircleHelp size={14}/>{profile.coverage.available}/{profile.coverage.total} metrics · Scope</summary><button onClick={() => onInspect(profile.coverage.missing[0] || '', profile.coverage.missing.length > 0)}>{profile.coverage.missing.length} missing measures<ArrowUpRight size={13}/></button>{view.limitations.map(note => <p key={note}>{note}</p>)}</details></div>
  </div>;
}
