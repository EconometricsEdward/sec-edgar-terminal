'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { readRiskEvidence } from './riskEvidenceClient.js';
import { compactNumber, snapshotAge } from '../../utils/marketPlumbing/model.js';
import { DTCC_LINKS, NYFED_TERMS } from '../../utils/marketPlumbing/catalog.js';
import ChartPeriodOverlay from '../../components/charts/ChartPeriodOverlay';
import s from './RiskIntelligence.module.css';

type Point = { date: string; value: number | null };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function TrendPlot({ points, title, format, maxGapDays }: { points: Point[]; title: string; format: (value: number | null) => string; maxGapDays: number }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const active = points.find(point => point.date === inspected) || points.at(-1);
  const values = points.map(point => point.value).filter(finite);
  if (!values.length) return <div className={s.plot}><h4>{title}</h4><p className={s.state}>No compatible observations.</p></div>;
  const low = Math.min(...values), high = Math.max(...values), range = high - low || Math.max(Math.abs(high) * .05, 1);
  const first = Date.parse(points[0].date), last = Date.parse(points.at(-1)!.date);
  const x = (date: string) => last > first ? 12 + (Date.parse(date) - first) / (last - first) * 436 : 230;
  const y = (value: number) => high === low ? 84 : 146 - (value - low) / range * 126;
  const segments: string[] = []; let segment: string[] = [];
  points.forEach((point, index) => {
    if (index > 0 && (Date.parse(point.date) - Date.parse(points[index - 1].date)) / 86400000 > maxGapDays && segment.length) { segments.push(segment.join(' ')); segment = []; }
    if (finite(point.value)) segment.push(`${x(point.date)},${y(point.value)}`);
    else if (segment.length) { segments.push(segment.join(' ')); segment = []; }
  });
  if (segment.length) segments.push(segment.join(' '));
  return <div className={s.plot}><div className={s.plotHeading}><div><h4>{title}</h4><strong>{format(active?.value ?? null)}</strong><span>{active?.date} · {inspected ? 'Selected observation' : 'Latest observation'}</span></div><span>{format(low)}–{format(high)}<br/>Shown range</span></div>
    <svg viewBox="0 0 460 166" role="group" aria-label={`${title} history`}><path d="M12 150H448" className={s.plotGuide}/>{segments.map((line, index) => <polyline key={index} points={line} className={s.plotLine}/>)}{active && finite(active.value) && <><line x1={x(active.date)} x2={x(active.date)} y1={12} y2={150} className={s.plotGuide}/><circle cx={x(active.date)} cy={y(active.value)} r={4} className={s.plotDot}/></>}
      <ChartPeriodOverlay points={points.map(point => ({ id: point.date, label: point.date, x: x(point.date) }))} activeId={active?.date || ''} onInspect={setInspected} left={0} right={460} top={0} bottom={166} label={title} describePoint={id => `${id}: ${format(points.find(point => point.date === id)?.value ?? null)}`}/>
    </svg><div className={s.plotAxis}><span>{points[0]?.date}</span><span>{points.at(-1)?.date}</span></div>
  </div>;
}

export default function RiskMarketEvidence({ ticker, companyType, cftcEnabled }: { ticker: string; companyType: string; cftcEnabled: boolean }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [fundingMeasure, setFundingMeasure] = useState('sofr'), [asset, setAsset] = useState('rates');
  useEffect(() => {
    let active = true; setError('');
    readRiskEvidence('/api/risk/market-context').then(result => {
      if (result.version !== 'risk-market-context-v1') throw new Error('The market context version could not be verified.');
      if (active) setData(result);
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [retry]);
  const funding = data?.funding, derivatives = cftcEnabled ? data?.derivatives : null;
  const swap = derivatives?.swaps?.find((row: any) => row.asset === asset);
  const fundingPoints = (funding?.rates || []).map((row: any) => ({ date: row.date, value: fundingMeasure === 'spread' ? row.spread ?? null : row.SOFR ?? null }));
  const financial = ['bank', 'broker', 'financial', 'insurance'].includes(companyType);
  return <>
    <div className={s.panelHeading}><div><h3>Funding markets around {ticker}</h3><p>Shared market conditions · Company sensitivity depends on its contracts and exposures</p></div></div>
    {!data && !error && <p className={s.state} role="status">Reading funding and derivatives snapshots…</p>}
    {error && <div className={s.state} role="alert"><p>{error}</p><button className={s.button} onClick={() => setRetry(n => n + 1)}>Retry market context</button></div>}
    {data && <>
      <div className={s.transmission}><div><h4>Funding cost</h4><p>{financial ? 'Repo and wholesale funding can reprice quickly. Compare secured rates with the institution’s funding mix and asset repricing.' : 'Floating-rate debt and future refinancing can transmit market rates to interest expense. Fixed coupons and hedges change the timing.'}</p></div><div><h4>Collateral & settlement</h4><p>Treasury settlement fails describe market delivery frictions. They do not identify this company’s failed trades, liquidity gap, or credit losses.</p></div><div><h4>Hedging & counterparties</h4><p>Swaps activity describes the broader hedging market. Notional and clearing shares do not measure this company’s exposure or counterparty quality.</p></div></div>
      {funding ? <>
        {(funding.availability === 'retained' || snapshotAge(funding)) && <p className={s.notice}>Funding data use a retained snapshot. Last successful source check: {funding.generatedAt?.slice(0, 10)}. Observation dates below remain authoritative.</p>}
        <div className={s.statGrid}>{[
          ['SOFR', finite(funding.latest.sofr) ? `${funding.latest.sofr.toFixed(2)}%` : 'Unavailable', 'Overnight Treasury-secured financing'],
          ['SOFR − TGCR', finite(funding.latest.spreadBps) ? `${funding.latest.spreadBps.toFixed(1)} bp` : 'Unavailable', 'Same-date spread; different transaction populations'],
          ['SOFR 1st–99th percentile', finite(funding.latest.dispersionBps) ? `${funding.latest.dispersionBps.toFixed(1)} bp` : 'Unavailable', 'Reported transaction-rate dispersion'],
        ].map(([label, value, note]) => <div className={s.stat} key={label}><span>{label}</span><strong>{value}</strong><small>{note} · {funding.latestDate}</small></div>)}</div>
        <div className={s.segmented} aria-label="Funding chart measure"><button aria-pressed={fundingMeasure === 'sofr'} onClick={() => setFundingMeasure('sofr')}>SOFR rate</button><button aria-pressed={fundingMeasure === 'spread'} onClick={() => setFundingMeasure('spread')}>SOFR − TGCR spread</button></div>
        <div className={s.chartGrid}><TrendPlot key={fundingMeasure} points={fundingPoints} title={fundingMeasure === 'spread' ? 'Secured-rate spread' : 'Treasury-secured funding rate'} format={value => value == null ? 'Unavailable' : fundingMeasure === 'spread' ? `${value.toFixed(1)} bp` : `${value.toFixed(2)}%`} maxGapDays={5}/><TrendPlot points={funding.fails.map((row: any) => ({ date: row.date, value: row.deliver }))} title="Primary-dealer Treasury fails to deliver" format={value => compactNumber(value)} maxGapDays={10}/></div>
        <p className={s.caption}>New York Fed observations. Fails are weekly cumulative amounts and can include the same obligation on multiple days; they are not credit losses. Hover, tap or use arrow keys to inspect chart dates.</p>
        <details className={s.method}><summary>Funding sources & attribution</summary><p>Source checked {funding.generatedAt}. SOFR, TGCR and BGCR describe different secured-funding transaction populations. The spread is a market comparison, not a company-specific credit spread.</p>{funding.sources?.map((source: any) => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.url.includes('/pd/') ? 'Primary-dealer statistics' : 'Secured reference rates'}</a> · Retrieved {source.retrievedAt?.slice(0, 10)}</p>)}<p>{funding.notice} <a href={NYFED_TERMS} target="_blank" rel="noreferrer">New York Fed Terms of Use</a></p></details>
      </> : <p className={s.state}>The funding snapshot is unavailable. Company financials and other sources remain separate.</p>}
      {derivatives && <>
        <div className={s.panelHeading} style={{ marginTop: 30 }}><div><h3>The derivatives market</h3><p>CFTC swaps reports · All reporting entities · Notional outstanding</p></div><span className={s.badge}>Market context</span></div>
        {(derivatives.availability === 'retained' || snapshotAge(derivatives)) && <p className={s.notice}>Retained derivatives snapshot · Source checked {derivatives.generatedAt?.slice(0, 10)}.</p>}
        <div className={s.segmented} aria-label="Derivatives asset class">{derivatives.swaps.map((row: any) => <button key={row.asset} aria-pressed={asset === row.asset} onClick={() => setAsset(row.asset)}>{row.label}</button>)}</div>
        {swap && <div className={s.chartGrid}><TrendPlot key={asset} points={swap.trend} title={swap.label} format={value => compactNumber(value)} maxGapDays={10}/><div className={s.plot}><div className={s.plotHeading}><div><h4>Reported clearing structure</h4><strong>{finite(swap.clearedShare) ? `${swap.clearedShare.toFixed(1)}% cleared` : 'Share unavailable'}</strong><span>{swap.date || 'Date unavailable'}</span></div></div>{finite(swap.clearedShare) && <div className={s.clearingTrack} role="img" aria-label={`${swap.clearedShare.toFixed(1)} percent cleared`}><span style={{ width: `${swap.clearedShare}%` }}/></div>}<div className={s.chartReadout}><span>Cleared {compactNumber(swap.cleared)}</span><span>Uncleared {compactNumber(swap.uncleared)}</span></div><p className={s.caption}>Clearing changes counterparty and margin arrangements. It does not eliminate risk, and notional is not fair value or potential loss. Reporting dates lag current market conditions.</p><div className={s.links}><a href={swap.sourceUrl} target="_blank" rel="noreferrer">CFTC source</a><a href={swap.notesUrl} target="_blank" rel="noreferrer">Definitions</a></div></div></div>}
      </>}
      {cftcEnabled && !derivatives && <p className={s.state}>The derivatives snapshot is unavailable.</p>}
      <div className={s.links}><Link prefetch={false} href="/market/funding">Full funding & settlement view</Link>{cftcEnabled && <><Link prefetch={false} href={`/market/derivatives?asset=${asset}&measure=outstanding`}>Explore swaps markets</Link><Link prefetch={false} href={`/risk?ticker=${encodeURIComponent(ticker)}&view=exposures`}>Company exposures & CFTC positioning</Link></>}</div>
    </>}
    <div className={s.dtcc}><h4>DTCC clearing & settlement references</h4><p>Open the provider’s own charts for GCF repo, clearing volume, and Treasury fails. These are external references, separate from the New York Fed and CFTC figures above.</p><div className={s.links}>{DTCC_LINKS.map(link => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}<ExternalLink size={13}/></a>)}</div></div>
  </>;
}
