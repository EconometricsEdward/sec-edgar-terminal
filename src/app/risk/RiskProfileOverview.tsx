'use client';

import { ArrowRight, ArrowUpRight, CircleHelp, Network } from 'lucide-react';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import { formatRiskValue } from '../../utils/riskWorkspace.js';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskProfileOverview.module.css';
import RiskNoteEvidence from './RiskNoteEvidence';

type Point = { end: string; value: number | null };
type Flow = { end: string; label: string; netIncome: number | null; operatingCashFlow: number | null };
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

function EarningsChart({ series, basis }: { series: Flow[]; basis: string }) {
  const values = series.flatMap(p => [p.netIncome, p.operatingCashFlow]).filter(isNumber);
  if (!values.length) return <p className={s.noData}>Comparable earnings and cash-flow observations are unavailable for this reporting basis.</p>;
  const low = Math.min(0, ...values), high = Math.max(0, ...values), range = high - low || 1;
  const x = (i: number) => 90 + datePosition(series, i) * 650;
  const y = (v: number) => 208 - (v - low) / range * 175;
  const ticks = [low, low + range / 2, high];
  return <svg viewBox="0 0 770 250" className={s.earningsChart} role="img" aria-label="Net income and operating cash flow over the same reporting periods, in US dollars. Exact figures follow in the history table.">
    {ticks.map((v,i) => <g key={i}><line x1={88} x2={750} y1={y(v)} y2={y(v)} className={s.guide}/><text x={78} y={y(v) + 4} textAnchor="end">{formatRiskValue(v)}</text></g>)}
    {low < 0 && high > 0 && <line x1={88} x2={750} y1={y(0)} y2={y(0)} className={s.zeroLine}/>}
    {(['operatingCashFlow','netIncome'] as const).map(key => <g key={key} className={key === 'netIncome' ? s.income : s.cashflow}>
      {lineSegments(series.map(p => ({ end:p.end, value:p[key] })), x, y, basis === 'ttm' ? 145 : 460).map((d,i) => <polyline key={i} points={d} fill="none" stroke="currentColor" strokeWidth="3"/>)}
      {series.map((p,i) => isNumber(p[key]) && <circle key={p.end} cx={x(i)} cy={y(p[key]!)} r="4" fill="currentColor"><title>{p.end} · {key === 'netIncome' ? 'Net income' : 'Operating cash flow'}: {formatRiskValue(p[key])}</title></circle>)}
    </g>)}
    {series.map((p,i) => (i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2)) && <text key={p.end} x={x(i)} y={239} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>{p.end}</text>)}
  </svg>;
}

export default function RiskProfileOverview({ data, profile, onInspect, onExposures }: { data: RiskData; profile: RiskProfile; onInspect: (id: string, missing?: boolean) => void; onExposures?: () => void }) {
  const view = buildRiskProfilePresentation(profile, data);
  const { balance, earnings } = view;
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
            <span className={s.dimensionTitle}><span className={s.number}>0{i + 1}</span><span><strong>{d.label}</strong><small>{d.metric?.label || 'No compatible metric'}</small></span></span>
            <MiniTrend basis={profile.basis} points={d.history} label={d.metric?.label || d.label} format={d.metric?.format || 'usd'}/>
            <span className={s.dimensionValue}><strong>{formatRiskValue(d.metric?.value, d.metric?.format)}</strong><small data-level={d.metric?.zone.level}>{d.metric?.zone.label || 'Unavailable'}<ArrowUpRight size={12}/></small></span>
          </button>
          <div className={s.comparison}><span>{d.comparison.priorLabel}: <b>{formatRiskValue(d.comparison.prior,d.metric?.format)}</b></span><span>{d.comparison.delta == null ? 'Comparison unavailable' : `${formatRiskValue(d.comparison.delta,d.comparison.deltaFormat,true)} change`}</span></div>
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

    <section className={s.earnings} aria-labelledby="earnings-quality-title">
      <div className={s.earningsIntro}><div className={s.kicker}>02 / EARNINGS & CASH GENERATION</div><h2 id="earnings-quality-title">Look beyond the profit number.</h2><p>{bank || view.lens.id !== 'corporate' ? 'Read earnings and cash flows in the context of financial assets, customer balances, and funding activity.' : 'Compare reported earnings with the operating cash that supports investment, debt service, and distributions.'}</p><div className={s.earningsTotals}><div className={s.income}><span>Net income</span><strong>{formatRiskValue(earnings.netIncome.value)}</strong></div><div className={s.cashflow}><span>Operating cash flow</span><strong>{formatRiskValue(earnings.operatingCashFlow.value)}</strong></div></div><p className={s.caption}>{view.historyLabel}. Missing observations remain gaps.</p></div>
      <div className={s.earningsVisual}><EarningsChart series={earnings.series} basis={profile.basis}/><details className={s.historyTable}><summary>Exact history & calculation inputs</summary><div><table><caption>Reported and derived {profile.basis === 'ttm' ? 'TTM' : 'annual'} flows, USD</caption><thead><tr><th>Period end</th><th>Net income</th><th>Operating cash flow</th><th>SEC evidence</th></tr></thead><tbody>{earnings.series.map(point => <tr key={point.end}><th scope="row">{point.end}</th><td>{point.netIncome?.toLocaleString('en-US') ?? 'Unavailable'}</td><td>{point.operatingCashFlow?.toLocaleString('en-US') ?? 'Unavailable'}</td><td>{(['netIncome','operatingCashFlow'] as const).map(key => { const observation = profile.reportedFlows?.[key]?.find(p => p.end === point.end); return observation && observation.sources.length > 0 ? <details key={key}><summary>{key === 'netIncome' ? 'Income' : 'Cash flow'}</summary>{observation.formula && <p>{observation.formula}</p>}{observation.sources.map((source,i) => <p key={i}>{source.label || source.tag}: {source.value?.toLocaleString('en-US')} {source.unit}<br/>{source.start ? `${source.start} → ` : ''}{source.end} · <a href={source.documentUrl || source.url} target="_blank" rel="noreferrer">SEC source</a></p>)}</details> : null; })}</td></tr>)}</tbody></table></div><button onClick={() => onInspect(profile.metrics.some(m=>m.id==='accruals_ratio') ? 'accruals_ratio' : 'net_margin')}>Inspect earnings source inputs<ArrowUpRight size={13}/></button></details></div>
    </section>

    <RiskNoteEvidence key={`${data.ticker}:${profile.basis}`} ticker={data.ticker} basis={profile.basis} />
    <section className={s.observations} aria-label="Supporting observations and review priorities">
      <div><div className={s.kicker}>SUPPORTING OBSERVATIONS</div><h2>What the figures support.</h2>{view.strengths.length ? view.strengths.map(item => <button className={s.observation} key={item.id} onClick={() => onInspect(item.metricId)}><span className={s.supportMarker}/><span><strong>{item.label}<b>{formatRiskValue(item.value,item.format)}</b></strong><small>{item.text}</small></span><ArrowUpRight size={15}/></button>) : <p className={s.noData}>No supporting observation is identified from the available inputs. Review the financial history and source coverage.</p>}</div>
      <div><div className={s.kicker}>QUESTIONS FOR YOUR REVIEW</div><h2>Where to look closer.</h2>{view.watchItems.length ? view.watchItems.map(item => <button className={s.observation} key={item.id} onClick={() => onInspect(item.metricId)}><span className={s.reviewMarker}/><span><strong>{item.label}<b>{formatRiskValue(item.value,item.format)}</b></strong><small>{item.question || item.reason}</small></span><ArrowUpRight size={15}/></button>) : <p className={s.noData}>No elevated screen in these dimensions. Read the disclosure notes and assess missing inputs before drawing a conclusion.</p>}<p className={s.caption}>Observed ratios and fixed thresholds do not establish creditworthiness.</p></div>
    </section>

    {onExposures && <section className={s.exposureBridge}><div className={s.bridgeIcon}><Network size={27}/></div><div><div className={s.kicker}>03 / FOLLOW THE BUSINESS EXPOSURE</div><h2>From company fundamentals to market forces.</h2><p>Trace SEC disclosures through borrowing, input costs, investments, revenue, and currencies. Then inspect the relevant CFTC futures positioning.</p></div><button onClick={onExposures}>Explore {data.ticker}’s exposures<ArrowRight size={17}/></button></section>}
    <div className={s.coverage}><CircleHelp size={17}/><div><button onClick={() => onInspect(profile.coverage.missing[0] || '', profile.coverage.missing.length > 0)}>{profile.coverage.available} of {profile.coverage.total} available metrics · {profile.coverage.missing.length} data gaps<ArrowUpRight size={13}/></button>{view.limitations.map(note => <p key={note}>{note}</p>)}</div></div>
  </div>;
}
