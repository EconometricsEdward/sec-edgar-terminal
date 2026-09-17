'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, BarChart3, Check, Grid2X2, Loader2, RefreshCw, Share2, X } from 'lucide-react';
import { MARKET_ATLAS_FRESH_MS, parseMarketView, marketViewForCftcAvailability, marketViewQuery, marketViewPath, marketViewHistoryMode } from '../../utils/marketResearch.js';
import { buildMarketMacroSummary } from '../../utils/marketMacroSummary.js';
import { QUANT_GROUPS } from '../../utils/quantGroups.js';
import { updateMarketView, MARKET_OVERVIEW_VERSION } from '../../utils/marketOverview.js';
import { isMarketOverview } from '../../utils/marketResearchValidation.js';
import MarketMacroBriefing from './MarketMacroBriefing';
import MarketMacroPositioning from './MarketMacroPositioning';
import MarketSectorPerformance from './MarketSectorPerformance';
import MarketUniverseCoverage from './MarketUniverseCoverage';
import type { MarketData, MarketView } from './marketTypes';
import s from './market.module.css';
import m from './marketMacro.module.css';

const CftcPositioning = dynamic(() => import('./CftcPositioning'), { ssr: false, loading: () => <p role="status">Loading CFTC Positioning…</p> });
const COHORT_IDS = QUANT_GROUPS.map((c) => c.id);
const TABS = [{ id: 'overview', label: 'Market Briefing', icon: Activity }, { id: 'positioning', label: 'CFTC Positioning', icon: BarChart3 }, { id: 'sectors', label: 'Sector Performance', icon: Grid2X2 }] as const;

export default function MarketOverviewClient({ initialData = null, initialQuery = '', cftcEnabled = true }: { initialData?: MarketData | null; initialQuery?: string; cftcEnabled?: boolean }) {
  const [data, setData] = useState<MarketData | null>(initialData);
  const dataRef = useRef(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<MarketView>(() => marketViewForCftcAvailability(parseMarketView(initialQuery, COHORT_IDS), cftcEnabled) as MarketView);
  const viewRef = useRef(view);
  const [notice, setNotice] = useState('');
  const [shareFallback, setShareFallback] = useState('');
  const isCftcTab = cftcEnabled && view.tab === 'positioning';

  useEffect(() => {
    const restore = () => {
      const restored = marketViewForCftcAvailability(parseMarketView(window.location.search, COHORT_IDS), cftcEnabled) as MarketView;
      const canonicalPath = marketViewPath(restored);
      viewRef.current = restored;
      setView(restored); setShareFallback('');
      if (`${window.location.pathname}${window.location.search}` !== canonicalPath) window.history.replaceState(null, '', canonicalPath);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [cftcEnabled]);

  useEffect(() => {
    // Coverage loads independently; a missing SEC snapshot never blocks CFTC.
    const current = dataRef.current;
    const age = current?.generatedAt ? Date.now() - Date.parse(current.generatedAt) : Infinity;
    if (current && current.cache?.status !== 'stale' && age >= 0 && age < MARKET_ATLAS_FRESH_MS && retry === 0) return;
    setLoading(true); setSlow(false);
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    const timeout = setTimeout(() => controller.abort(new Error('The sector snapshot is taking longer than expected. Please retry shortly.')), 25000);
    async function load() {
      try {
        const response = await fetch(`/api/market-research?v=${MARKET_OVERVIEW_VERSION}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !isMarketOverview(result)) throw new Error(result.error || 'Sector fundamentals are temporarily unavailable.');
        dataRef.current = result; setData(result); setError('');
      } catch (e) {
        if (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load sector fundamentals.');
      } finally {
        clearTimeout(slowTimer); clearTimeout(timeout);
        if (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') setLoading(false);
      }
    }
    load();
    return () => { clearTimeout(slowTimer); clearTimeout(timeout); controller.abort(); };
  }, [retry]);

  const updateView = useCallback((patch: Partial<MarketView>, push = false) => {
    const current = viewRef.current;
    const next = updateMarketView(current, patch) as MarketView;
    if (!cftcEnabled && next.tab === 'positioning') return;
    const mode = marketViewHistoryMode(current, next, push);
    if (!mode) return;
    viewRef.current = next;
    setView(next); setShareFallback('');
    window.history[mode](null, '', marketViewPath(next));
  }, [cftcEnabled]);

  async function shareView() {
    const query = marketViewQuery(view);
    const url = `${window.location.origin}/market${query ? `?${query}` : ''}`;
    try { await navigator.clipboard.writeText(url); setNotice('View link copied.'); }
    catch { setShareFallback(url); setNotice('Copy the view link below.'); }
  }
  const summary = useMemo(() => data ? buildMarketMacroSummary(data, view.basis) : null, [data, view.basis]);
  const sectorProps = {
    data: data!, basis: view.basis, statistic: view.statistic, selectedSector: view.cohort, metric: view.metric,
    onStatistic: (statistic: MarketView['statistic']) => updateView({ statistic }),
    onSector: (cohort: string) => updateView({ cohort, tab: 'sectors' }, true),
    onMetric: (metric: string) => updateView({ metric }),
  };

  return <div className={s.page}>
    <header className={m.hero}>
      <div><div className={s.eyebrow}><Activity size={15} />The macro perspective</div><h1>The market, <span>in context.</span></h1><p>Business conditions across sectors. {cftcEnabled && 'Positioning across futures. '}A wider view of the forces worth watching.</p></div>
      <div className={m.sourcePair}><span><i />SEC filings <small>Reported business performance</small></span>{cftcEnabled && <span><i />CFTC reports <small>Weekly futures positioning</small></span>}</div>
    </header>
    <div className={s.topbar}><nav className={s.tabs} aria-label="Market sections">{TABS.filter((tab) => cftcEnabled || tab.id !== 'positioning').map((tab) => <button key={tab.id} aria-current={view.tab === tab.id ? 'page' : undefined} onClick={() => updateView({ tab: tab.id }, true)}><tab.icon size={16} />{tab.label}</button>)}</nav><button className={s.button} onClick={shareView}><Share2 size={14} />Share view</button></div>
    {shareFallback && <label className={s.shareFallback}>Shareable view link<input readOnly value={shareFallback} onFocus={(e) => e.target.select()} /></label>}
    {notice && <div className={s.notice} role="status" aria-live="polite"><Check size={14} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={13} /></button></div>}
    {data && <MarketUniverseCoverage data={data} basis={view.basis} />}
    {!isCftcTab && <div className={m.contextBar}><div><span className={s.eyebrow}>{view.tab === 'sectors' ? 'Sector Performance' : 'Market Briefing'}</span><p>Filing-based fundamentals · Equal company weights · {view.basis === 'ttm' ? 'Trailing-twelve-month flows' : 'Annual flows'}</p></div><div className={s.segmented} aria-label="Reporting basis"><button aria-pressed={view.basis === 'ttm'} onClick={() => updateView({ basis: 'ttm' })}>Latest TTM</button><button aria-pressed={view.basis === 'annual'} onClick={() => updateView({ basis: 'annual' })}>Annual</button></div></div>}
    {!isCftcTab && summary && <p className={m.reportClock}>Reported fiscal ends: {summary.reportRange ? `${summary.reportRange.earliest} – ${summary.reportRange.latest}` : 'unavailable'} · {summary.olderReports.toLocaleString('en-US')} older or missing reports <span>(period end over {view.basis === 'ttm' ? '200' : '550'} days before the snapshot)</span></p>}
    {loading && !data && <div className={s.loading} role="status"><Loader2 className={s.spin} size={25} /><div><h2>{slow ? 'Retrieving the prepared sector snapshot' : 'Loading the market universe'}</h2><p>Loading sector coverage and reported fundamentals. {cftcEnabled && 'CFTC reports load independently.'}</p></div></div>}
    {error && <div className={s.error} role="alert"><h2>Sector snapshot unavailable</h2><p>{error}</p><button className={s.button} onClick={() => { setError(''); setRetry((n) => n + 1); }}><RefreshCw size={14} />Retry sector data</button></div>}
    {data?.cache?.status === 'stale' && <div className={s.warning} role="status"><RefreshCw size={16} /><p><b>Showing the last completed SEC snapshot.</b> {data.cache.warning} Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</p></div>}
    {view.tab === 'overview' && <>
      {data && <MarketMacroBriefing data={data} basis={view.basis} cftcEnabled={cftcEnabled} onSector={(cohort) => updateView({ tab: 'sectors', cohort, metric: 'revenueGrowth', statistic: 'median' }, true)} />}
      {cftcEnabled && <MarketMacroPositioning onView={updateView} cftcEnabled={cftcEnabled} />}
      {data && <MarketSectorPerformance {...sectorProps} compact />}
    </>}
    {isCftcTab && <CftcPositioning view={view} onView={updateView} onNotice={setNotice} />}
    {view.tab === 'sectors' && data && <MarketSectorPerformance {...sectorProps} />}
    {!isCftcTab && <details className={`${s.panel} ${s.details}`}><summary>How to read this market view · methods & sources</summary><div className={s.methodology}>
      <p><b>Two reporting clocks.</b> SEC fundamentals describe businesses over their reported fiscal periods. CFTC reports describe positions at a weekly report date. They are complementary observations, with different coverage and timing.</p>
      <p><b>Universe.</b> {data?.coverage ? 'Published IVV, IJH and IJR holdings define the issuer coverage proxy; this is not certified current index membership.' : 'The prepared SEC issuer universe supplies the sector coverage.'} Each issuer has one primary sector. Industry counts use reported SEC SIC codes. Coverage lists and source links are available above.</p>
      <p><b>Sector calculations.</b> Means and medians use equal company weights and exclude missing values separately for every metric. Revenue growth compares compatible prior-year periods. TTM flows, annual flows, and latest reported balances are kept distinct. Fiscal ends vary. Sector Performance describes business fundamentals, not stock-price returns, GDP, or the whole economy.</p>
      <p><b>Comparability.</b> Revenue can change through pricing, volume, currency translation, or acquisitions. Banks and broker-dealers use net revenue after interest expense where reported. Rental REITs without a tagged total may use reported lease revenue, excluding non-lease income; the company directory identifies these bases. Insurers and industrial businesses have different revenue, cash-flow, and capital structures. Ratios across those sectors need that context.</p>
      {cftcEnabled && <p><b>Positioning.</b> Official futures-only TFF and Disaggregated reports retain their own participant categories. Net positions are scaled by each contract’s open interest; contracts are never added across markets. A long or short position is not a forecast, capital flow, or automatic investment signal. <a href="https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm" target="_blank" rel="noreferrer">CFTC report documentation ↗</a></p>}
      <p><b>Timing.</b> Report dates and metric coverage accompany the observations. The SEC universe uses scheduled prepared snapshots; unavailable values remain unavailable. An old report is not made current by recalculating its ratios.</p>
    </div></details>}
  </div>;
}
