'use client';

import { useEffect, useState } from 'react';
import { MARKET_SECTOR_METRICS } from '../../utils/marketMacroSummary.js';
import { formatMarket } from '../../utils/marketResearch.js';
import type { Basis, MarketIndustry, MarketSector, Stats } from './marketTypes';
import s from './marketSectorPerformance.module.css';

type IndustryPage = { version: 'market-industries-v1'; generatedAt: string; sector: string; basis: Basis; industries: MarketIndustry[]; missingIndustryCount: number };
const pages = new Map<string, { at: number; value: IndustryPage }>();
const CACHE_MS = 5 * 60 * 1000;
const statisticValue = (stats: Stats | undefined, statistic: string) => (statistic === 'mean' ? stats?.mean : stats?.median) ?? null;

export function isMarketIndustries(value: unknown, sector: string, basis: Basis): value is IndustryPage {
  if (!value || typeof value !== 'object') return false;
  const result = value as IndustryPage;
  return result.version === 'market-industries-v1' && result.sector === sector && result.basis === basis
    && typeof result.generatedAt === 'string' && Number.isFinite(Date.parse(result.generatedAt))
    && Number.isSafeInteger(result.missingIndustryCount) && result.missingIndustryCount >= 0
    && Array.isArray(result.industries) && result.industries.length <= 1000
    && result.industries.every(row => row && /^\d{4}$/.test(row.code) && typeof row.label === 'string'
      && typeof row.known === 'boolean' && Number.isSafeInteger(row.count) && row.count > 0
      && MARKET_SECTOR_METRICS.every(({ key }) => {
        const stats = row.metrics?.[key];
        return stats && Number.isSafeInteger(stats.count) && stats.count >= 0 && stats.count <= row.count && stats.total === row.count
          && (stats.mean === null || Number.isFinite(stats.mean)) && (stats.median === null || Number.isFinite(stats.median));
      }))
    && new Set(result.industries.map(row => row.code)).size === result.industries.length;
}

export default function MarketSectorIndustries({ sector, basis, statistic, metric, generatedAt }: { sector: MarketSector; basis: Basis; statistic: string; metric: string; generatedAt: string }) {
  const [result, setResult] = useState<IndustryPage | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const path = `/api/market-industries?${new URLSearchParams({ sector: sector.id, basis })}`;
  const cacheKey = `${generatedAt}:${path}`;
  const empty = !sector.industries.length;
  useEffect(() => {
    if (empty) return;
    const cached = pages.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) { setResult(cached.value); setError(''); return; }
    let current = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Industry data is taking longer than expected. Please retry.')), 15_000);
    setError('');
    void (async () => {
      try {
        const response = await fetch(path, { signal: controller.signal });
        const value = await response.json();
        if (!response.ok || !isMarketIndustries(value, sector.id, basis)) throw new Error('Industry metrics are temporarily unavailable. Please retry.');
        if (!current) return;
        pages.delete(cacheKey); pages.set(cacheKey, { at: Date.now(), value });
        while (pages.size > 12) pages.delete(pages.keys().next().value!);
        setResult(value);
      } catch (reason) {
        if (current) setError(reason instanceof Error ? reason.message : 'Could not load industry metrics.');
      } finally { clearTimeout(timeout); }
    })();
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [empty, cacheKey, path, sector.id, basis, attempt]);
  const currentResult = result?.sector === sector.id && result.basis === basis ? result : null;
  const industries = currentResult?.industries || sector.industries;
  const statLabel = statistic === 'mean' ? 'Mean' : 'Median';
  const metricLabel = MARKET_SECTOR_METRICS.find(row => row.key === metric)?.label.toLowerCase() || metric;
  const missing = currentResult?.missingIndustryCount ?? sector.missingIndustryCount;
  return <>
    <div className={s.industryHeading}><h4>Industry composition</h4><span>{industries.length} SEC SIC industries</span></div>
    {error ? <div className={s.directoryError} role="alert"><span>{error}</span><button type="button" onClick={() => { pages.delete(cacheKey); setAttempt(value => value + 1); }}>Retry industry data</button></div> : !empty && !currentResult && <p className={s.note} role="status">Loading industry metrics…</p>}
    {industries.length ? <div className={s.industryScroll} tabIndex={0} aria-label={`${sector.label} industry composition`} aria-busy={!currentResult && !error}><table className={s.industryTable}><caption className={s.srOnly}>{sector.label} industries: {statLabel.toLowerCase()} {metricLabel}, with company coverage.</caption><thead><tr><th scope="col">SEC industry</th><th scope="col">{statLabel}</th><th scope="col">Coverage</th></tr></thead><tbody>{industries.map(industry => <tr key={industry.code}><th scope="row"><span>{industry.label}</span><small>SIC {industry.code} · {industry.count} {industry.count === 1 ? 'company' : 'companies'}</small></th><td>{currentResult ? formatMarket(statisticValue(industry.metrics?.[metric], statistic)) : '—'}</td><td>{currentResult ? `${industry.metrics?.[metric]?.count ?? 0}/${industry.count}` : '—'}</td></tr>)}</tbody></table></div> : <p className={s.description}>SEC industry classifications are unavailable for this sector.</p>}
    <p className={s.note}>Industry rows use the same {statLabel.toLowerCase()} and metric as the chart. {missing > 0 && `${missing} companies lack a valid SEC SIC code and are excluded from industry rows. `}Small industry samples may be dominated by individual companies.</p>
    {currentResult && currentResult.generatedAt !== generatedAt && <p className={s.note}>Industry snapshot: {currentResult.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</p>}
  </>;
}
