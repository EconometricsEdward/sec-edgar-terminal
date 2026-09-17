'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Globe2, Loader2, RefreshCw } from 'lucide-react';
import { clearPreparedCftc, fetchPreparedCftc } from '../../utils/cftcClient.js';
import { buildMarketMacroPositioning, MARKET_MACRO_FAMILIES } from '../../utils/marketMacroPositioning.js';
import type { MarketView } from './marketTypes';
import s from './marketMacroPositioning.module.css';

type Family = 'tff' | 'disaggregated';
type FamilyState = { pending: boolean; data: any; error: string };
type Props = { onView: (patch: Partial<MarketView>, push?: boolean) => void; cftcEnabled?: boolean };
const pathFor = (family: string) => `/api/v1/cftc/markets?family=${family}`;
const initialState = (): Record<Family, FamilyState> => ({ tff: { pending: true, data: null, error: '' }, disaggregated: { pending: true, data: null, error: '' } });
const format = (value: number | null, digits = 1) => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const signed = (value: number | null, suffix = '') => value === null ? '—' : `${value > 0 ? '+' : ''}${format(value)}${suffix}`;

export default function MarketMacroPositioning({ onView, cftcEnabled = true }: Props) {
  const [state, setState] = useState(initialState);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cftcEnabled) return;
    let active = true;
    const controller = new AbortController();
    // Two independent existing market snapshots. Histories load only on drill-through.
    void Promise.allSettled(MARKET_MACRO_FAMILIES.map(async family => {
      try {
        const data = await fetchPreparedCftc(pathFor(family), { signal: controller.signal, timeoutMs: 20_000 });
        const result = buildMarketMacroPositioning({ [family]: data });
        if (!result.families.find(item => item.family === family)?.valid) throw new Error('The response did not contain a compatible futures-only report.');
        if (active) setState(current => ({ ...current, [family]: { pending: false, data, error: '' } }));
      } catch (reason) {
        if (active) setState(current => ({ ...current, [family]: { pending: false, data: null, error: reason instanceof Error ? reason.message : 'The report is temporarily unavailable.' } }));
      }
    }));
    return () => { active = false; controller.abort(); };
  }, [cftcEnabled, attempt]);
  const summary = useMemo(() => buildMarketMacroPositioning({ tff: state.tff.data, disaggregated: state.disaggregated.data }), [state.tff.data, state.disaggregated.data]);
  function retry(family: Family) {
    clearPreparedCftc(pathFor(family));
    setState(current => ({ ...current, [family]: { ...current[family], pending: true, error: '' } }));
    setAttempt(value => value + 1);
  }
  if (!cftcEnabled) return <section className={s.section} aria-label="CFTC macro positioning"><div className={s.heading}><div><span className={s.eyebrow}><Globe2 size={15} />Futures positioning</span><h2>CFTC positioning is currently unavailable</h2><p>Sector fundamentals remain available below.</p></div></div></section>;
  const pending = state.tff.pending || state.disaggregated.pending;
  const largest = summary.largestMove;
  const openCard = (view: Record<string, string>) => onView(view as Partial<MarketView>, true);

  return <section className={s.section} aria-label="CFTC macro positioning summary">
    <div className={s.heading}>
      <div><span className={s.eyebrow}><Globe2 size={15} />The positioning picture</span><h2>Six windows into the macro market.</h2><p>Rates, currencies, equity indices, and real assets through reported futures positions.</p></div>
      <button className={s.explore} onClick={() => onView({ tab: 'positioning' }, true)}>Explore CFTC positioning <ArrowRight size={15} /></button>
    </div>
    <div className={s.reportLine} aria-live="polite">
      {summary.families.map(family => {
        const status = state[family.family as Family];
        return <div key={family.family} className={s.report} data-warning={family.aged || family.stale || Boolean(status.error)}>
          <span className={s.reportDot} /><b>{family.label}</b>
          {status.pending ? <span className={s.loading}><Loader2 size={13} />Loading report</span> : status.error ? <><span>Temporarily unavailable</span><button onClick={() => retry(family.family as Family)} title={status.error}><RefreshCw size={12} />Retry</button></> : <><time dateTime={family.reportDate || undefined}>{family.reportDate}</time><span>{family.aged ? `Older report · ${family.sourceAgeDays ?? '?'} days` : family.stale ? 'Preserved snapshot' : family.partial ? 'Partial coverage' : 'Futures only'}</span></>}
        </div>;
      })}
      <span className={s.coverage}>{summary.availableCount} / 6 selected observations{pending ? ' · loading' : ''}</span>
    </div>
    {summary.differentReportDates && <p className={s.notice}>The two report families have different dates. Read each observation at its stated date.</p>}
    {summary.families.some(family => family.aged || family.stale) && <p className={s.notice}>Some data comes from an older report or preserved snapshot. Report dates describe the positions; a recent retrieval does not make them current.</p>}
    <div className={s.cards}>
      {summary.cards.map(card => {
        const loading = state[card.family as Family].pending;
        const tone = card.netPctOi === null ? 'unavailable' : card.netPctOi < 0 ? 'short' : card.netPctOi > 0 ? 'long' : 'balanced';
        const width = Math.min(50, Math.abs(card.netPctOi ?? 0) / 2);
        return <article className={s.card} data-tone={tone} key={card.id} aria-label={`${card.category}: ${card.label}`}>
          <div className={s.cardTop}><span>{card.category}</span><small>{card.lens}</small></div>
          <h3><button onClick={() => openCard(card.view)}>{card.label}<ArrowUpRight size={15} /></button></h3>
          <p className={s.participant}>{card.groupLabel} · {card.familyLabel}</p>
          <div className={s.value}><strong>{loading && !card.available ? '…' : signed(card.netPctOi, '%')}</strong><span>net / open interest</span></div>
          <div className={s.track} aria-hidden="true"><i style={{ width: `${width}%`, left: `${(card.netPctOi ?? 0) < 0 ? 50 - width : 50}%` }} /><span /></div>
          <div className={s.move}>
            {loading && !card.available ? <span>Loading reported positions…</span> : card.weeklyChange === null ? <span>{card.available ? 'Weekly comparison unavailable' : 'This observation is unavailable'}</span> : <><span className={s.moveValue}>{card.weeklyChange < 0 ? <ArrowDownRight size={15} /> : card.weeklyChange > 0 ? <ArrowUpRight size={15} /> : <ArrowRight size={15} />}{signed(card.weeklyChange, ' pp')}</span><span>one-week change</span></>}
          </div>
          <div className={s.cardFoot}><time dateTime={card.reportDate || undefined}>{card.reportDate || 'Report date unavailable'}</time>{card.sourceUrl ? <a href={card.sourceUrl} target="_blank" rel="noreferrer" aria-label={`CFTC source for ${card.label}, ${card.reportDate}`}>Source ↗</a> : <span>CFTC {card.code}</span>}</div>
        </article>;
      })}
    </div>
    {largest && <div className={s.spotlight}><div><span>Largest weekly shift in this selection</span><p><b>{largest.label}</b> · {largest.groupLabel}: {largest.description}</p></div><strong>{signed(largest.weeklyChange, ' pp')}</strong><small>Among {summary.comparableCount} comparable observations<br />Report date {largest.reportDate}</small></div>}
    <p className={s.caption}>Each bar uses the same −100% to +100% scale, centered at zero. Teal = net long; gold = net short. Changes are percentage points of each contract’s own open interest, not investment flows or price forecasts.</p>
    <details className={s.details}>
      <summary>How to read the macro context · sources and selected contracts</summary>
      <div className={s.method}>
        <p><b>What the numbers mean.</b> Net = reported long contracts − short contracts. Net / open interest = 100 × net / total open interest. Weekly change compares compatible reports exactly seven days apart. The ratio can change with positions or open interest. Missing comparisons remain unavailable.</p>
        <p><b>How this informs the briefing.</b> These six fixed observations provide separate lenses on financial and physical markets. Leveraged Funds (TFF) and Managed Money (Disaggregated) are different participant categories. Positions may hedge other exposures; they do not establish a growth, inflation, yield, or currency forecast. No contracts are combined into a market-wide score.</p>
      </div>
      <div className={s.sourceTable} role="region" aria-label="Macro positioning sources and underlying values" tabIndex={0}><table><thead><tr><th scope="col">Selected contract / macro context</th><th scope="col">Report / participant</th><th scope="col">Long</th><th scope="col">Short</th><th scope="col">Open interest</th><th scope="col">Explore</th></tr></thead><tbody>{summary.cards.map(card => <tr key={card.id}><th scope="row"><b>{card.label} · {card.code}</b><small>{card.exchange || 'Exchange unavailable'}</small><small>{card.context}</small></th><td>{card.reportDate || 'Unavailable'}<small>{card.familyLabel} · {card.groupLabel}</small></td><td>{format(card.long, 0)}</td><td>{format(card.short, 0)}</td><td>{format(card.openInterest, 0)}</td><td><button onClick={() => openCard(card.view)}>History <ArrowUpRight size={13} /></button></td></tr>)}</tbody></table></div>
      <p className={s.methodFooter}>All positions are futures-only contracts; contract sizes and conventions differ. <a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noreferrer">CFTC methodology ↗</a></p>
      {summary.families.map(family => family.valid ? <p className={s.sourceStatus} key={family.family}><b>{family.label}:</b> report {family.reportDate} · source age {family.sourceAgeDays ?? 'unavailable'} days · retrieved {family.retrievedAt || 'unavailable'}{family.partial ? ' · partial snapshot coverage' : ''}{family.warning ? ` · ${family.warning}` : ''}</p> : null)}
    </details>
  </section>;
}
