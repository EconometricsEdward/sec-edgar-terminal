'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, ArrowUpRight, BarChart3, Bookmark, Check, Download, Grid2X2, ListFilter, Loader2, RefreshCw, Share2, Sigma, Star, X } from 'lucide-react';
import { MARKET_ATLAS_FRESH_MS, MARKET_SAVED_KEY, parseMarketView, marketViewForCftcAvailability, marketViewQuery, marketViewPath, marketViewHistoryMode, parseMarketSaved, selectMarketCompanies, marketCsv, marketBrief } from '../../utils/marketResearch.js';
import { QUANT_GROUPS } from '../../utils/quantGroups.js';
import { MARKET_LENSES } from '../../utils/marketCohorts.js';
import { updateMarketView, MARKET_OVERVIEW_VERSION } from '../../utils/marketOverview.js';
import { isMarketOverview } from '../../utils/marketResearchValidation.js';
import { downloadText } from '../../utils/download.js';
import { Briefing, CompanyTable, ObservationHistory, PeerComparison, SavedResearch, SectorMap } from './MarketPanels';
import type { Company, MarketData, MarketView, Saved } from './marketTypes';
import s from './market.module.css';

const MarketEvidence = dynamic(() => import('./MarketEvidence'), { ssr: false });
const CftcPositioning = dynamic(() => import('./CftcPositioning'), { ssr: false, loading: () => <p role="status">Loading CFTC Positioning…</p> });
const CftcPositioningPreview = dynamic(() => import('./CftcPositioning').then(module => module.CftcPositioningPreview), { ssr: false });
const MarketFactorUniverse = dynamic(() => import('./MarketFactorUniverse'), { ssr: false, loading: () => <p role="status">Loading Fundamental Lab…</p> });
const COHORT_IDS = [...MARKET_LENSES,...QUANT_GROUPS].map((c) => c.id);
const EMPTY_COMPANIES: Company[] = [];
const TABS = [{ id: 'overview', label: 'Market briefing', icon: Activity }, { id: 'positioning', label: 'CFTC Positioning', icon: BarChart3 }, { id: 'sectors', label: 'Sector heatmap', icon: Grid2X2 }, { id: 'companies', label: 'Companies', icon: ListFilter }, { id: 'fundamentals', label: 'Fundamental Lab', icon: Sigma }, { id: 'saved', label: 'Saved research', icon: Bookmark }] as const;

export default function MarketOverviewClient({ initialData = null, initialQuery = '', cftcEnabled = true }: { initialData?: MarketData | null; initialQuery?: string; cftcEnabled?: boolean }) {
  const [data, setData] = useState<MarketData | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<MarketView>(() => marketViewForCftcAvailability(parseMarketView(initialQuery, COHORT_IDS), cftcEnabled) as MarketView);
  const viewRef = useRef(view);
  const [saved, setSaved] = useState<Saved>({ version: 1, watchlist: [], views: [], baselines: {} });
  const [notice, setNotice] = useState('');
  const [shareFallback, setShareFallback] = useState('');
  const [page, setPage] = useState(0);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const isFundamentalTab = view.tab === 'fundamentals';
  const isCftcTab = cftcEnabled && view.tab === 'positioning';
  const isIndependentTab = isFundamentalTab || isCftcTab;

  useEffect(() => {
    const restore = () => {
      const restored = marketViewForCftcAvailability(parseMarketView(window.location.search, COHORT_IDS), cftcEnabled) as MarketView;
      const canonicalPath = marketViewPath(restored);
      viewRef.current = restored;
      setView(restored); setPage(0); setShareFallback(''); setCompareOpen(false);
      if (`${window.location.pathname}${window.location.search}` !== canonicalPath) window.history.replaceState(null, '', canonicalPath);
    };
    const restoreSaved = () => {
      try {
        const restored = parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY), COHORT_IDS) as Saved;
        const { migrationNotice, ...clean } = restored;
        if (migrationNotice) {
          localStorage.setItem(MARKET_SAVED_KEY, JSON.stringify(clean));
          setNotice(migrationNotice);
        }
        setSaved(clean);
      } catch (e) { setNotice(e instanceof Error ? e.message : 'Browser storage is unavailable.'); }
    };
    restore(); restoreSaved();
    window.addEventListener('popstate', restore);
    window.addEventListener('storage', restoreSaved);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('storage', restoreSaved); };
  }, [cftcEnabled]);

  useEffect(() => {
    // CFTC and the prepared Fundamental Lab own independent fetch lifecycles.
    if (isIndependentTab) { setLoading(false); return; }
    const initialAge = initialData?.generatedAt
      ? Date.now() - Date.parse(initialData.generatedAt)
      : Number.POSITIVE_INFINITY;
    if (initialData && initialData.cache?.status !== 'stale' && initialAge >= 0 && initialAge < MARKET_ATLAS_FRESH_MS && retry === 0) return;
    setLoading(true); setSlow(false);
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    const timeout = setTimeout(() => controller.abort(new Error('The Market snapshot is taking longer than expected. Please retry shortly.')), 25000);
    async function load() {
      try {
        const response = await fetch(`/api/market-research?v=${MARKET_OVERVIEW_VERSION}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !isMarketOverview(result)) throw new Error(result.error || 'Market research is temporarily unavailable.');
        setData(result);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load Market research.');
      } finally { clearTimeout(slowTimer); clearTimeout(timeout); if (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') setLoading(false); }
    }
    load();
    return () => { clearTimeout(slowTimer); clearTimeout(timeout); controller.abort(); };
  }, [retry, initialData, isIndependentTab]);

  const companies = data?.companies || EMPTY_COMPANIES;
  const cohortCompanies = useMemo(() => view.cohort === 'all' ? companies : companies.filter((c) => c.cohorts.includes(view.cohort)), [companies, view.cohort]);
  const rows = useMemo(() => selectMarketCompanies(companies, view, saved.watchlist, data?.generatedAt || ''), [companies, view, saved.watchlist, data?.generatedAt]);
  const peers = companies.filter((c) => view.selected.includes(c.ticker));
  const cohort = [...(data?.cohorts || []), ...(data?.themes || [])].find((c) => c.id === view.cohort);

  const updateView = useCallback((patch: Partial<MarketView>, push = false) => {
    const current = viewRef.current;
    const next = updateMarketView(current, patch) as MarketView;
    if (!cftcEnabled && next.tab === 'positioning') {
      setNotice('CFTC Positioning is temporarily disabled. Your saved view remains stored.');
      return;
    }
    const mode = marketViewHistoryMode(current, next, push);
    if (!mode) return;
    viewRef.current = next;
    setView(next); setPage(0); setShareFallback('');
    window.history[mode](null, '', marketViewPath(next));
  }, [cftcEnabled]);
  function persist(update: (current: Saved) => Saved, message: string) {
    try {
      const current = parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY), COHORT_IDS) as Saved;
      const { migrationNotice: _migrationNotice, ...clean } = current;
      const next = update(clean);
      localStorage.setItem(MARKET_SAVED_KEY, JSON.stringify(next)); setSaved(next); setNotice(message); return true;
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not save in this browser.'); return false; }
  }
  function toggleWatch(company: Company) {
    persist((current) => {
      const removing = current.watchlist.includes(company.ticker);
      return { ...current, watchlist: removing ? current.watchlist.filter((t) => t !== company.ticker) : [...current.watchlist, company.ticker],
        baselines: removing ? current.baselines : { ...current.baselines, [company.ticker]: company } };
    }, saved.watchlist.includes(company.ticker) ? `${company.ticker} removed from watchlist.` : `${company.ticker} saved with a review baseline.`);
  }
  function togglePeer(ticker: string) { updateView({ selected: view.selected.includes(ticker) ? view.selected.filter((t) => t !== ticker) : [...view.selected, ticker].slice(0, 5) }); }
  async function shareView() {
    const query = marketViewQuery(view); const url = `${window.location.origin}/market${query ? `?${query}` : ''}`;
    try { await navigator.clipboard.writeText(url); setNotice('View link copied.'); } catch { setShareFallback(url); setNotice('Copy the view link below.'); }
  }
  const screen = (screen: string) => updateView({ screen, query: '', tab: 'companies' });

  const hero = isCftcTab
    ? { eyebrow: 'Official CFTC market context', title: 'CFTC Positioning', description: 'Explore futures-only Commitments of Traders reports by contract, participant category, and report date.' }
    : isFundamentalTab
      ? { eyebrow: 'SEC Fundamental Lab', title: 'Fundamental Lab', description: 'Measure breadth, dispersion, and paired changes across filing-derived company fundamentals.' }
      : { eyebrow: 'SEC Market Research', title: 'See the market.', description: 'Explore the financial pulse of public companies. Find sector differences, screen peers, and trace every number to SEC filings.' };

  return <div className={s.page}>
    <header className={`${s.hero} ${isIndependentTab ? s.factorUniverseHero : ''}`}><div><div className={s.eyebrow}>{isCftcTab ? <BarChart3 size={15} /> : <Activity size={15} />}{hero.eyebrow}</div><h1>{hero.title}{!isIndependentTab && <><br /><span>Follow the evidence.</span></>}</h1><p>{hero.description}</p></div>{isCftcTab ? <div className={s.heroAside}><span className={s.badge}><i className={s.dot} />Official public data</span><strong>2<small>separate futures-only report families</small></strong><p>TFF · Disaggregated<br />Positioning is not a price or trade signal</p></div> : <div className={s.heroAside}><span className={s.badge}><i className={s.dot} />Filing-derived fundamentals</span><strong>{data ? data.companies.length.toLocaleString('en-US') : '—'}<small>companies across {data?.cohorts.length || '—'} {data?.coverage ? 'sectors' : 'research cohorts'}</small></strong><p>Reported financials · Refreshed from cached SEC data<br />No account required</p></div>}</header>
    <div className={s.topbar}><nav className={s.tabs} aria-label="Market sections">{TABS.filter((tab) => cftcEnabled || tab.id !== 'positioning').map((tab) => <button key={tab.id} aria-current={view.tab === tab.id ? 'page' : undefined} onClick={() => updateView({ tab: tab.id }, true)}><tab.icon size={16} />{tab.label}{tab.id === 'saved' && saved.watchlist.length > 0 && <span>{saved.watchlist.length}</span>}</button>)}</nav>{!isCftcTab && <div className={s.segmented} aria-label={isFundamentalTab ? 'SEC fundamental reporting basis' : 'Reporting basis'}><button aria-pressed={view.basis === 'ttm'} onClick={() => updateView({ basis: 'ttm' })}>Latest TTM</button><button aria-pressed={view.basis === 'annual'} onClick={() => updateView({ basis: 'annual' })}>Annual</button></div>}</div>
    {loading && !isIndependentTab && <div className={s.loading} role="status"><Loader2 className={s.spin} size={25} /><div><h2>{slow ? 'Retrieving the prepared snapshot' : 'Loading Market research'}</h2><p>{slow ? 'The latest completed snapshot is taking longer to arrive. Your visit does not trigger a bulk data refresh.' : 'Loading company fundamentals, sector coverage, and reporting dates…'}</p></div></div>}
    {error && !isIndependentTab && <div className={s.error} role="alert"><h2>Could not update Market research</h2><p>{error}</p><button className={s.button} onClick={() => { setError(''); setLoading(true); setSlow(false); setRetry((n) => n + 1); }}><RefreshCw size={14} />Retry Market data</button></div>}
    {(data || isIndependentTab) && <>
      {!isCftcTab && data?.cache?.status === 'stale' && <div className={s.warning} role="status"><RefreshCw size={16} /><p><b>Showing the last completed snapshot.</b> {data.cache.warning} Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</p></div>}
      <div className={s.toolbar}>{!isIndependentTab && <label>Research universe<select value={view.cohort} onChange={(e) => updateView({ cohort: e.target.value })}><option value="all">All covered companies</option>{(data?.cohorts || MARKET_LENSES.map(c => ({ id: c.id, label: c.assetClass }))).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}{data?.themes && data.themes.length > 0 && <optgroup label="Research themes (selected companies)">{data.themes.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>}</select></label>}<div className={s.actions}><button className={s.button} onClick={shareView}><Share2 size={14} />Share view</button><button className={s.button} onClick={() => { setViewName(isCftcTab ? `CFTC ${view.cftcFamily.toUpperCase()} · ${view.cftcContract}` : isFundamentalTab ? `Fundamental Lab · ${view.basis === 'ttm' ? 'TTM' : 'Annual'}` : `${cohort?.label || 'Market'} · ${view.basis === 'ttm' ? 'TTM' : 'Annual'}`); setSaveOpen(!saveOpen); }}><Bookmark size={14} />Save view</button>{data && !isIndependentTab && <><button className={s.button} onClick={() => { downloadText(`market-${view.basis}-screen.csv`, marketCsv(rows, view.basis, data.generatedAt, data), 'text/csv'); setNotice(`CSV exported: ${rows.length} companies in the current screen.`); }}><Download size={14} />Export CSV</button><button className={s.button} onClick={() => { downloadText('market-research-brief.md', marketBrief(rows, view, data, window.location.href), 'text/markdown'); setNotice('Research brief exported.'); }}><Download size={14} />Research brief</button></>}</div></div>
      {cohort && !isIndependentTab && <div className={s.cohortNote}><span><b>{cohort.title}</b> · {cohort.description}</span><button onClick={() => updateView({ cohort: 'all' })} aria-label="Clear research filter"><X size={16} /></button></div>}
      {!isCftcTab && <p className={s.basisNote}>{isFundamentalTab ? `${view.basis === 'ttm' ? 'Trailing-twelve-month' : 'Annual'} SEC filing changes · Equal-weighted issuers · Missing values excluded` : view.basis === 'ttm' ? 'Quarter-end balances · Trailing-twelve-month flows · Year-over-year revenue growth' : 'Annual balances and flows · Year-over-year revenue growth'} <span>{isFundamentalTab ? 'Descriptive diagnostics · No prices, forecast, or trade signal' : `Screen exports: ${rows.length} ${rows.length === 1 ? 'company' : 'companies'}${view.query ? ` · “${view.query}”` : ''}${view.screen !== 'all' ? ` · ${view.screen}` : ''}`}</span></p>}
      {saveOpen && <form className={s.saveForm} onSubmit={(e) => { e.preventDefault(); if (!viewName.trim()) return; if (saved.views.length >= 12) { setNotice('You have 12 saved views. Delete a view before adding another.'); return; } if (persist((current) => ({ ...current, views: [...current.views, { name: viewName.trim().slice(0, 60), query: marketViewQuery(view) }] }), 'Research view saved in this browser.')) setSaveOpen(false); }}><label>View name<input value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={60} required /></label><button className={s.primary} type="submit">Save this view</button><button className={s.button} type="button" onClick={() => setSaveOpen(false)}>Cancel</button></form>}
      {shareFallback && <label className={s.shareFallback}>Shareable view link<input readOnly value={shareFallback} onFocus={(e) => e.target.select()} /></label>}
      <div className={s.notice} role="status" aria-live="polite">{notice && <><Check size={14} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={13} /></button></>}</div>
      {cftcEnabled && isCftcTab && <CftcPositioning view={view} onView={updateView} onNotice={setNotice} />}
      {isFundamentalTab && <MarketFactorUniverse atlas={data} view={view} onView={updateView} onNotice={setNotice} onInspect={setInspecting} />}
    </>}
    {data && <>
      {view.tab === 'overview' && <><Briefing companies={cohortCompanies} data={data} basis={view.basis} onScreen={screen} />{cftcEnabled && <CftcPositioningPreview onOpen={() => updateView({ tab: 'positioning' }, true)} />}<div className={s.sectionLink}><div><h2>From the market to a company</h2><p>Choose a sector below, or use the screener to build your own research list.</p></div><button className={s.primary} onClick={() => updateView({ tab: 'companies', screen: 'all', query: '' }, true)}>Explore companies <ArrowUpRight size={16} /></button></div><SectorMap data={data} basis={view.basis} statistic={view.statistic} selectedCohort={view.cohort} onStatistic={(statistic) => updateView({ statistic })} onCohort={(cohort, metric) => updateView({ cohort, tab: 'companies', query: '', screen: 'all', metric: metric || view.metric, sort: metric || view.sort }, true)} /><ObservationHistory data={data} /></>}
      {view.tab === 'sectors' && <SectorMap data={data} basis={view.basis} statistic={view.statistic} selectedCohort={view.cohort} onStatistic={(statistic) => updateView({ statistic })} onCohort={(cohort, metric) => updateView({ cohort, tab: 'companies', query: '', screen: 'all', metric: metric || view.metric, sort: metric || view.sort })} />}
      {view.tab === 'companies' && <CompanyTable rows={rows} view={view} watchlist={saved.watchlist} page={page} onPage={setPage} onView={updateView} onInspect={setInspecting} onWatch={toggleWatch} onPeer={togglePeer} />}
      {view.tab === 'saved' && <SavedResearch saved={saved} data={data} basis={view.basis} cftcEnabled={cftcEnabled} onOpenView={(query) => updateView(parseMarketView(query, COHORT_IDS) as MarketView, true)} onRemoveView={(index) => persist((current) => ({ ...current, views: current.views.filter((_, i) => i !== index) }), 'Saved view deleted.')} onInspect={setInspecting} onBaseline={(c) => persist((current) => ({ ...current, baselines: { ...current.baselines, [c.ticker]: c } }), `${c.ticker} review baseline updated.`)} />}
      {!isIndependentTab && peers.length > 0 && <div className={s.peerTray}><div><Star size={15} /><b>{peers.length}/5 peers</b>{peers.map((c) => <button key={c.ticker} onClick={() => togglePeer(c.ticker)} aria-label={`Remove ${c.ticker} from comparison`}>{c.ticker}<X size={12} /></button>)}</div><div><button className={s.button} onClick={() => { updateView({ selected: [] }); setCompareOpen(false); }}>Clear peers</button><button className={s.primary} disabled={peers.length < 2} onClick={() => setCompareOpen(!compareOpen)}>{compareOpen ? 'Hide comparison' : 'Compare peers'}</button></div></div>}
      {!isIndependentTab && compareOpen && peers.length >= 2 && <PeerComparison companies={peers} basis={view.basis} onInspect={setInspecting} />}
      {!isCftcTab && <details className={`${s.panel} ${s.details}`}><summary>Methodology & interpretation</summary><div className={s.methodology}><p><b>Universe.</b> {data?.coverage ? <>{data.companies.length} of {data.requested} targeted issuers across {data.cohorts.length} primary sectors, using the same prepared SEC universe as Fundamental Lab. Published IVV, IJH and IJR holdings define the coverage proxy; this is not certified current index membership. Optional research themes cover selected companies and can overlap.</> : <>{data?.requested || 'Prepared'} curated issuer entries in the SEC research universe.</>}</p><p><b>Calculations.</b> Only compatible SEC filing contexts are used. Annual and TTM figures are calculated independently. Missing values stay unavailable and are excluded from each metric’s own denominator.</p><p><b>Comparability.</b> Mean and median are equally weighted across available companies. Fiscal ends differ. The briefing, heatmap, screener, and Fundamental Lab do not use market-cap weights, security prices, or returns. Banks and insurers have different capital and cash-flow structures.</p><p><b>Evidence.</b> Company evidence preserves raw SEC sources, filing accessions, and intermediate calculations. Fundamental Lab keeps breadth, paired magnitude, dispersion, and cash confirmation distinct. These are descriptive filing diagnostics, not historical factor returns.</p><p><b>Timing.</b> SEC Market snapshots are refreshed by the daily background job and remain fresh for 25 hours. During upstream trouble, the last successfully cached SEC snapshot may remain available and is labeled above. Saved research stays in this browser. <a href="/market/factors">Read the Fundamental Lab methodology.</a></p></div></details>}
    </>}
    {inspecting && <MarketEvidence key={inspecting} ticker={inspecting} initialBasis={view.basis} initialMetric={view.metric} onClose={() => setInspecting(null)} />}
  </div>;
}
