'use client';
import { ArrowUpRight, MoveRight } from 'lucide-react';
import { formatMarket } from '../../utils/marketResearch.js';
import type { Basis, MarketSummary } from './marketTypes';
import m from './marketMacro.module.css';

type Sector = { id: string; label: string; count: number; metrics: Record<string, { median: number | null; count: number }> };

export default function MarketMacroBriefing({ summary, basis, onSector, cftcEnabled = true }: { summary: MarketSummary; basis: Basis; cftcEnabled?: boolean; onSector: (id: string) => void }) {
  const ranked = (summary.sectors as Sector[]).filter(sector => Number.isFinite(sector.metrics.revenueGrowth?.median)).sort((a, b) => b.metrics.revenueGrowth.median! - a.metrics.revenueGrowth.median!);
  const strongest = ranked[0];
  const weakest = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const breadth = [
    { label: 'Growing revenue', metric: summary.growth, detail: 'Positive year-over-year revenue growth', tone: 'green' },
    { label: 'Profitable businesses', metric: summary.profit, detail: 'Positive reported net income', tone: 'gold' },
    { label: 'Positive operating cash flow', metric: summary.cash, detail: 'Positive operating cash flow / revenue', tone: 'blue' },
  ];
  const growthPct = summary.growth.positivePct;
  const headline = growthPct == null ? 'The business picture, sector by sector.' : `${formatMarket(growthPct, 'pct', 0)} of companies grew revenue.`;
  return <section className={m.briefing} aria-labelledby="macro-briefing-heading">
    <div className={m.readout}>
      <div className={m.kicker}><span>01 / Business conditions</span><span>SEC · {basis === 'ttm' ? 'TTM' : 'Annual'}</span></div>
      <h2 id="macro-briefing-heading">{headline}</h2>
      <p>{summary.growth.count ? <>Based on <b>{summary.growth.count.toLocaleString('en-US')}</b> businesses with comparable revenue, covering {formatMarket(100 * summary.growth.count / summary.companyCount, 'pct', 0)} of the loaded universe. Sector medians show how outcomes differ.</> : 'Comparable revenue observations are unavailable in this snapshot. Available sector metrics remain visible below.'}</p>
      <div className={m.dispersion}>
        <div className={m.dispersionTitle}><span>Revenue growth · sector medians</span>{strongest && weakest && <b>{(strongest.metrics.revenueGrowth.median! - weakest.metrics.revenueGrowth.median!).toFixed(1)} pp spread</b>}</div>
        {strongest ? <div className={m.extremes}>{[{ sector: strongest, label: 'Highest' }, ...(weakest ? [{ sector: weakest, label: 'Lowest' }] : [])].map(({ sector, label }) => <button key={sector.id} onClick={() => onSector(sector.id)}><small>{label}</small><span>{sector.label}<ArrowUpRight size={14} /></span><strong>{formatMarket(sector.metrics.revenueGrowth.median)}</strong><small>{sector.metrics.revenueGrowth.count} / {sector.count} companies</small></button>)}</div> : <p>No comparable sector medians available.</p>}
      </div>
      <button className={m.textLink} onClick={() => onSector('all')}>Explore sector performance <MoveRight size={16} /></button>
    </div>
    <div className={m.pulse}>
      <div className={m.kicker}><span>How broad is the strength?</span><span>Share of available companies</span></div>
      {breadth.map(({ label, metric, detail, tone }) => <div className={m.pulseRow} key={label} data-tone={tone}><div><span>{label}</span><strong>{formatMarket(metric.positivePct, 'pct', 0)}</strong></div><div className={m.track} aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, metric.positivePct ?? 0))}%` }} /></div><small>{metric.positive.toLocaleString('en-US')} / {metric.count.toLocaleString('en-US')} available · {detail}</small></div>)}
      <p className={m.readingNote}>Read breadth alongside sector differences. These are reported business outcomes.{cftcEnabled && ' Futures positioning below adds a separate view of market exposure.'}</p>
    </div>
  </section>;
}
