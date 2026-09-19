'use client';

import dynamic from 'next/dynamic';
import { ArrowUpRight, BarChart3, Layers3 } from 'lucide-react';
import { MARKET_SECTOR_METRICS } from '../../utils/marketMacroSummary.js';
import { formatMarket } from '../../utils/marketResearch.js';
import type { Basis, MarketSummary, Stats } from './marketTypes';
import s from './marketSectorPerformance.module.css';

const MarketSectorIndustries = dynamic(() => import('./MarketSectorIndustries'), { loading: () => <p role="status">Loading industry breakdown…</p> });

type Props = {
  summary: MarketSummary; basis: Basis; statistic: string; onStatistic: (value: string) => void;
  selectedSector: string; onSector: (value: string) => void; metric: string; onMetric: (value: string) => void;
  compact?: boolean;
};
const statisticValue = (stats: Stats | undefined, statistic: string) => (statistic === 'mean' ? stats?.mean : stats?.median) ?? null;

export function MarketSectorPerformance({ summary, basis, statistic, onStatistic, selectedSector, onSector, metric, onMetric, compact = false }: Props) {
  const currentMetric = MARKET_SECTOR_METRICS.find(row => row.key === metric) || MARKET_SECTOR_METRICS[0];
  const statLabel = statistic === 'mean' ? 'Mean' : 'Median';
  const ranked = [...summary.sectors].sort((a, b) => {
    const av = statisticValue(a.metrics[currentMetric.key], statistic);
    const bv = statisticValue(b.metrics[currentMetric.key], statistic);
    return av == null ? bv == null ? a.label.localeCompare(b.label) : 1 : bv == null ? -1 : bv - av;
  });
  const selected = summary.sectors.find(sector => sector.id === selectedSector) || ranked[0];
  const range = Math.max(1, ...ranked.map(sector => Math.abs(statisticValue(sector.metrics[currentMetric.key], statistic) ?? 0)));
  const select = (id: string, key?: string) => {
    onSector(id);
    if (key) onMetric(key);
  };
  const statisticControl = <div className={s.segmented} role="group" aria-label="Sector statistic">{['median', 'mean'].map(value => <button key={value} type="button" aria-pressed={statistic === value} onClick={() => onStatistic(value)}>{value === 'mean' ? 'Mean' : 'Median'}</button>)}</div>;

  if (!summary.sectors.length) return <section className={s.panel}><span className={s.eyebrow}>Sector performance</span><h2>Sector coverage is unavailable</h2><p className={s.description}>The current snapshot does not identify primary sectors. Sector comparisons will appear when classified company data is available.</p></section>;

  return <div className={s.workspace}>
    {!compact && <>
      <div className={s.intro}><div><span className={s.eyebrow}><BarChart3 size={14} /> The corporate economy</span><h2>Where is performance diverging?</h2><p className={s.description}>Compare the financial results beneath the macro picture: demand, profitability, cash generation and investment.</p></div><span className={s.basisBadge}>{basis === 'ttm' ? 'Latest TTM' : 'Latest annual'} · Reported fundamentals</span></div>
      <div className={s.performanceGrid}>
        <section className={`${s.panel} ${s.rankingPanel}`} aria-labelledby="market-sector-ranking-title">
          <div className={s.heading}><div><span className={s.eyebrow}>Across sectors</span><h3 id="market-sector-ranking-title">{currentMetric.label}</h3></div>{statisticControl}</div>
          <div className={s.metricTabs} role="group" aria-label="Sector performance metric">{MARKET_SECTOR_METRICS.map(row => <button type="button" key={row.key} aria-pressed={row.key === currentMetric.key} onClick={() => onMetric(row.key)}>{row.shortLabel}</button>)}</div>
          <p className={s.chartNote}>{statLabel} company ratio · Equal issuer weights · Select a sector</p>
          <div className={s.rankings} aria-label={`${statLabel} ${currentMetric.label.toLowerCase()} by sector`}>
            {ranked.map((sector, index) => {
              const stats = sector.metrics[currentMetric.key];
              const value = statisticValue(stats, statistic);
              const width = value == null ? 0 : Math.abs(value) / range * 48;
              return <button type="button" key={sector.id} className={s.rankRow} aria-pressed={selected?.id === sector.id} onClick={() => select(sector.id)} aria-label={`${sector.label}: ${formatMarket(value)}, ${stats.count} of ${sector.count} companies with data. View industry breakdown.`}>
                <span className={s.rankNumber}>{String(index + 1).padStart(2, '0')}</span><span className={s.rankName}>{sector.label}<small>{stats.count}/{sector.count} with data</small></span>
                <span className={s.barTrack} aria-hidden="true"><i className={value != null && value < 0 ? s.negativeBar : s.positiveBar} style={{ width: `${width}%`, left: `${value != null && value < 0 ? 50 - width : 50}%` }} /></span>
                <strong className={value != null && value < 0 ? s.negative : ''}>{formatMarket(value)}</strong>
              </button>;
            })}
          </div>
          <p className={s.note}>{currentMetric.context} These are financial-statement measures, not stock-price returns.</p>
        </section>
        {selected && <section className={`${s.panel} ${s.sectorDetail}`} aria-labelledby="market-sector-detail-title">
          <div className={s.heading}><span className={s.eyebrow}><Layers3 size={14} /> Inside the sector</span><span className={s.basisBadge}>{selected.count.toLocaleString()} companies</span></div>
          <h3 id="market-sector-detail-title">{selected.label}</h3>
          <div className={s.detailValue}><strong>{formatMarket(statisticValue(selected.metrics[currentMetric.key], statistic))}</strong><span>{statLabel} {currentMetric.label.toLowerCase()}<small>{selected.metrics[currentMetric.key].count} of {selected.count} companies with comparable data</small></span></div>
          <div className={s.breadth}><div><span>Companies with growing revenue</span><b>{formatMarket(selected.metrics.revenueGrowth.positivePct, 'pct', 0)}</b></div><div className={s.breadthTrack}><i style={{ width: `${selected.metrics.revenueGrowth.positivePct || 0}%` }} /></div><small>{selected.metrics.revenueGrowth.positive} of {selected.metrics.revenueGrowth.count} with comparable revenue</small></div>
          <MarketSectorIndustries sector={selected} basis={basis} statistic={statistic} metric={currentMetric.key} generatedAt={summary.generatedAt || ''} />
        </section>}
      </div>
    </>}
    <section className={s.panel} aria-labelledby={`market-dispersion-title${compact ? '-compact' : ''}`}>
      <div className={s.heading}><div><span className={s.eyebrow}>Sector comparison</span><h2 id={`market-dispersion-title${compact ? '-compact' : ''}`}>Find the dispersion</h2></div>{statisticControl}</div>
      <p className={s.description}>Read across a sector to connect growth, profits and investment. Select any figure to explore its industry composition.</p>
      <div className={s.tableScroll} tabIndex={0} aria-label="Sector financial comparison"><table className={s.comparison}><caption className={s.srOnly}>{statLabel} sector fundamentals and metric-specific company counts. Colors represent numeric levels, not risk ratings.</caption><thead><tr><th scope="col">Sector</th>{MARKET_SECTOR_METRICS.map(row => <th key={row.key} scope="col">{row.label}</th>)}<th scope="col">Loaded</th></tr></thead><tbody>{summary.sectors.map(sector => <tr key={sector.id} data-selected={selectedSector === sector.id}><th scope="row"><button type="button" onClick={() => select(sector.id)}><span>{sector.label}</span><small>{sector.industries.length} industries <ArrowUpRight size={11} /></small></button></th>{MARKET_SECTOR_METRICS.map(row => {
        const stats = sector.metrics[row.key];
        const value = statisticValue(stats, statistic);
        return <td key={row.key}><button type="button" onClick={() => select(sector.id, row.key)} aria-label={`${sector.label}, ${statLabel.toLowerCase()} ${row.label.toLowerCase()}: ${formatMarket(value)}, ${stats.count} of ${sector.count} companies. Explore sector.`} className={value == null ? s.missing : value < 0 ? s.negative : s.positive} style={value == null ? undefined : { backgroundColor: `color-mix(in srgb, var(${value < 0 ? '--m-bad' : '--m-good'}) ${Math.min(28, 6 + Math.abs(value) * .4)}%, var(--m-panel))` }}><strong>{formatMarket(value)}</strong><small>{stats.count}/{sector.count}</small></button></td>;
      })}<td className={s.loaded}>{sector.count}{sector.targetCount != null && <small>of {sector.targetCount}</small>}</td></tr>)}</tbody></table></div>
      <p className={s.note}>Equal issuer weights; each cell has its own data denominator. Fiscal periods vary. Primary sectors do not overlap.{summary.missingSectorCount > 0 && ` ${summary.missingSectorCount} companies with no primary sector are excluded.`} Bank and insurer margins, cash flows and capital structures are not directly comparable with industrial companies. Colors show numeric levels, not risk ratings.</p>
    </section>
  </div>;
}

export default MarketSectorPerformance;
