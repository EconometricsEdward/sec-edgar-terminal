'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, ArrowUpRight, Bookmark, Check, Download, Grid2X2, ListFilter, Loader2, RefreshCw, Share2, Sigma, Star, X } from 'lucide-react';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION, MARKET_SAVED_KEY, DEFAULT_MARKET_VIEW, parseMarketView, marketViewQuery, parseMarketSaved, selectMarketCompanies, marketCsv, marketBrief } from '../../utils/marketResearch.js';
import { MARKET_LENSES } from '../../utils/marketCohorts.js';
import { isMarketAtlas } from '../../utils/marketResearchValidation.js';
import { downloadText } from '../../utils/download.js';
import { Briefing, CompanyTable, ObservationHistory, PeerComparison, SavedResearch, SectorMap } from './MarketPanels';
import type { Company, MarketData, MarketView, Saved } from './marketTypes';
import s from './market.module.css';

const MarketEvidence = dynamic(() => import('./MarketEvidence'), { ssr: false });
const MarketFactorUniverse = dynamic(() => import('./MarketFactorUniverse'), { ssr: false, loading: () => <p role="status">Loading Quant Lab…</p> });
const COHORT_IDS = MARKET_LENSES.map((c) => c.id);
const EMPTY_COMPANIES: Company[] = [];
const TABS = [{ id: 'overview', label: 'Market briefing', icon: Activity }, { id: 'sectors', label: 'Sector heatmap', icon: Grid2X2 }, { id: 'companies', label: 'Companies', icon: ListFilter }, { id: 'factors', label: 'Quant Lab', icon: Sigma }, { id: 'saved', label: 'Saved research', icon: Bookmark }];

export default function MarketOverviewClient({ initialData = null }: { initialData?: MarketData | null }) {
  const [data, setData] = useState<MarketData | null>(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<MarketView>(DEFAULT_MARKET_VIEW as MarketView);
  const [saved, setSaved] = useState<Saved>({ version: 1, watchlist: [], views: [], baselines: {} });
  const [notice, setNotice] = useState('');
  const [shareFallback, setShareFallback] = useState('');
  const [page, setPage] = useState(0);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const isFactorTab = view.tab === 'factors';

  useEffect(() => {
    const restore = () => setView(parseMarketView(window.location.search, COHORT_IDS) as MarketView);
    const restoreSaved = () => { try { setSaved(parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY)) as Saved); } catch (e) { setNotice(e instanceof Error ? e.message : 'Browser storage is unavailable.'); } };
    restore(); restoreSaved();
    window.addEventListener('popstate', restore);
    window.addEventListener('storage', restoreSaved);
    return () => { window.removeEventListener('popstate', restore); window.removeEventListener('storage', restoreSaved); };
  }, []);

  useEffect(() => {
    // Opening the quantitative tab must not start a full-universe SEC refresh.
    if (new URLSearchParams(window.location.search).get('tab') === 'factors') { setLoading(false); return; }
    const initialAge = initialData?.generatedAt
      ? Date.now() - Date.parse(initialData.generatedAt)
      : Number.POSITIVE_INFINITY;
    if (initialData && initialData.cache?.status !== 'stale' && initialAge >= 0 && initialAge < MARKET_ATLAS_FRESH_MS && retry === 0) return;
    setLoading(true); setSlow(false);
    const controller = new AbortController();
    const slowTimer = setTimeout(() => setSlow(true), 8000);
    const timeout = setTimeout(() => controller.abort(new Error('The Market snapshot is taking longer than expected. Please retry shortly.')), 285000);
    async function load() {
      try {
        const response = await fetch(`/api/market-research?v=${MARKET_VERSION}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !isMarketAtlas(result, MARKET_VERSION)) throw new Error(result.error || 'Market research is temporarily unavailable.');
        setData(result);
        setError('');
      } catch (e) {
        if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Could not load Market research.');
      } finally { clearTimeout(slowTimer); clearTimeout(timeout); if (!controller.signal.aborted || controller.signal.reason?.name !== 'AbortError') setLoading(false); }
    }
    load();
    return () => { clearTimeout(slowTimer); clearTimeout(timeout); controller.abort(); };
  }, [retry, initialData, isFactorTab]);

  const companies = data?.companies || EMPTY_COMPANIES;
  const cohortCompanies = useMemo(() => view.cohort === 'all' ? companies : companies.filter((c) => c.cohorts.includes(view.cohort)), [companies, view.cohort]);
  const rows = useMemo(() => selectMarketCompanies(companies, view, saved.watchlist, data?.generatedAt || ''), [companies, view, saved.watchlist, data?.generatedAt]);
  const peers = companies.filter((c) => view.selected.includes(c.ticker));
  const cohort = data?.cohorts.find((c) => c.id === view.cohort);

  function updateView(patch: Partial<MarketView>) {
    const next = { ...view, ...patch };
    setView(next); setPage(0); setShareFallback('');
    const query = marketViewQuery(next);
    window.history.replaceState(null, '', `/market${query ? `?${query}` : ''}`);
  }
  function persist(update: (current: Saved) => Saved, message: string) {
    try {
      const current = parseMarketSaved(localStorage.getItem(MARKET_SAVED_KEY)) as Saved;
      const next = update(current);
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

  return <div className={s.page}>
    <header className={`${s.hero} ${view.tab === 'factors' ? s.factorUniverseHero : ''}`}><div><div className={s.eyebrow}><Activity size={15} />SEC Market Research</div><h1>{view.tab === 'factors' ? 'Quant Lab' : <>See the market.<br /><span>Follow the evidence.</span></>}</h1><p>{view.tab === 'factors' ? 'A quantitative view of the covered universe: fundamental breadth, dispersion, market sensitivity and filing response.' : <>Explore the financial pulse of public companies.<br className={s.desktopBreak} /> Find sector differences, screen peers, and trace the numbers to SEC filings.</>}</p></div><div className={s.heroAside}><span className={s.badge}><i className={s.dot} />Filing-derived fundamentals</span><strong>{data ? `${data.companies.length}` : '—'}<small>companies across {data?.cohorts.length || 13} research cohorts</small></strong><p>Reported financials · Refreshed from cached SEC data<br />No account required</p></div></header>
    <div className={s.topbar}><nav className={s.tabs} aria-label="Market sections">{TABS.map((tab) => <button key={tab.id} aria-current={view.tab === tab.id ? 'page' : undefined} onClick={() => updateView({ tab: tab.id })}><tab.icon size={16} />{tab.label}{tab.id === 'saved' && saved.watchlist.length > 0 && <span>{saved.watchlist.length}</span>}</button>)}</nav><div className={s.segmented} aria-label={view.tab === 'factors' ? 'SEC factor reporting basis' : 'Reporting basis'}><button aria-pressed={view.basis === 'ttm'} onClick={() => updateView({ basis: 'ttm' })}>Latest TTM</button><button aria-pressed={view.basis === 'annual'} onClick={() => updateView({ basis: 'annual' })}>Annual</button></div></div>
    {loading && view.tab !== 'factors' && <div className={s.loading} role="status"><Loader2 className={s.spin} size={25} /><div><h2>{slow ? 'Assembling the latest filing snapshot' : 'Loading Market research'}</h2><p>{slow ? 'A cold snapshot can take a few minutes while the covered companies are checked. Completed snapshots are cached for subsequent visits.' : 'Loading company fundamentals, cohort coverage, and reporting dates…'}</p></div></div>}
    {error && view.tab !== 'factors' && <div className={s.error} role="alert"><h2>Could not update Market research</h2><p>{error}</p><button className={s.button} onClick={() => { setError(''); setLoading(true); setSlow(false); setRetry((n) => n + 1); }}><RefreshCw size={14} />Retry Market data</button></div>}
    {(data || view.tab === 'factors') && <>
      {data?.cache?.status === 'stale' && <div className={s.warning} role="status"><RefreshCw size={16} /><p><b>Showing the last completed snapshot.</b> {data.cache.warning} Calculated {data.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</p></div>}
      <div className={s.toolbar}><label>{view.tab === 'factors' ? 'Primary research group' : 'Research universe'}<select value={view.cohort} onChange={(e) => updateView({ cohort: e.target.value })}><option value="all">{'All covered companies'}</option>{(data?.cohorts || MARKET_LENSES.map(c => ({ id: c.id, label: c.assetClass }))).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label><div className={s.actions}><button className={s.button} onClick={shareView}><Share2 size={14} />Share view</button><button className={s.button} onClick={() => { setViewName(view.tab === 'factors' ? `${cohort?.label || 'Universe'} Quant Lab · ${view.basis === 'ttm' ? 'TTM' : 'Annual'}` : `${cohort?.label || 'Market'} · ${view.basis === 'ttm' ? 'TTM' : 'Annual'}`); setSaveOpen(!saveOpen); }}><Bookmark size={14} />Save view</button>{data && view.tab !== 'factors' && <><button className={s.button} onClick={() => { downloadText(`market-${view.basis}-screen.csv`, marketCsv(rows, view.basis, data.generatedAt), 'text/csv'); setNotice(`CSV exported: ${rows.length} companies in the current screen.`); }}><Download size={14} />Export CSV</button><button className={s.button} onClick={() => { downloadText('market-research-brief.md', marketBrief(rows, view, data, window.location.href), 'text/markdown'); setNotice('Research brief exported.'); }}><Download size={14} />Research brief</button></>}</div></div>
      {cohort && <div className={s.cohortNote}><span><b>{cohort.title}</b> · {cohort.description}</span><button onClick={() => updateView({ cohort: 'all' })} aria-label="Clear cohort filter"><X size={16} /></button></div>}
      <p className={s.basisNote}>{view.tab === 'factors' ? `${view.basis === 'ttm' ? 'Trailing-twelve-month' : 'Annual'} SEC filing change · Adjusted daily price returns · Exact interval matching` : view.basis === 'ttm' ? 'Quarter-end balances · Trailing-twelve-month flows · Year-over-year revenue growth' : 'Annual balances and flows · Year-over-year revenue growth'} <span>{view.tab === 'factors' ? 'Diagnostic research · No forecast or trade signal' : `Screen exports: ${rows.length} ${rows.length === 1 ? 'company' : 'companies'}${view.query ? ` · “${view.query}”` : ''}${view.screen !== 'all' ? ` · ${view.screen}` : ''}`}</span></p>
      {saveOpen && <form className={s.saveForm} onSubmit={(e) => { e.preventDefault(); if (!viewName.trim()) return; if (saved.views.length >= 12) { setNotice('You have 12 saved views. Delete a view before adding another.'); return; } if (persist((current) => ({ ...current, views: [...current.views, { name: viewName.trim().slice(0, 60), query: marketViewQuery(view) }] }), 'Research view saved in this browser.')) setSaveOpen(false); }}><label>View name<input value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={60} required /></label><button className={s.primary} type="submit">Save this view</button><button className={s.button} type="button" onClick={() => setSaveOpen(false)}>Cancel</button></form>}
      {shareFallback && <label className={s.shareFallback}>Shareable view link<input readOnly value={shareFallback} onFocus={(e) => e.target.select()} /></label>}
      <div className={s.notice} role="status" aria-live="polite">{notice && <><Check size={14} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={13} /></button></>}</div>
      {view.tab === 'factors' && <MarketFactorUniverse atlas={data} view={view} onView={updateView} onNotice={setNotice} />}
    </>}
    {data && <>
      {view.tab === 'overview' && <><Briefing companies={cohortCompanies} data={data} basis={view.basis} onScreen={screen} /><div className={s.sectionLink}><div><h2>From the market to a company</h2><p>Choose a sector below, or use the screener to build your own research list.</p></div><button className={s.primary} onClick={() => updateView({ tab: 'companies', screen: 'all', query: '' })}>Explore companies <ArrowUpRight size={16} /></button></div><SectorMap data={data} basis={view.basis} statistic={view.statistic} selectedCohort={view.cohort} onStatistic={(statistic) => updateView({ statistic })} onCohort={(cohort, metric) => updateView({ cohort, tab: 'companies', query: '', screen: 'all', metric: metric || view.metric, sort: metric || view.sort })} /><ObservationHistory data={data} /></>}
      {view.tab === 'sectors' && <SectorMap data={data} basis={view.basis} statistic={view.statistic} selectedCohort={view.cohort} onStatistic={(statistic) => updateView({ statistic })} onCohort={(cohort, metric) => updateView({ cohort, tab: 'companies', query: '', screen: 'all', metric: metric || view.metric, sort: metric || view.sort })} />}
      {view.tab === 'companies' && <CompanyTable rows={rows} view={view} watchlist={saved.watchlist} page={page} onPage={setPage} onView={updateView} onInspect={setInspecting} onWatch={toggleWatch} onPeer={togglePeer} />}
      {view.tab === 'saved' && <SavedResearch saved={saved} data={data} basis={view.basis} onOpenView={(query) => updateView(parseMarketView(query, COHORT_IDS) as MarketView)} onRemoveView={(index) => persist((current) => ({ ...current, views: current.views.filter((_, i) => i !== index) }), 'Saved view deleted.')} onInspect={setInspecting} onBaseline={(c) => persist((current) => ({ ...current, baselines: { ...current.baselines, [c.ticker]: c } }), `${c.ticker} review baseline updated.`)} />}
      {view.tab !== 'factors' && peers.length > 0 && <div className={s.peerTray}><div><Star size={15} /><b>{peers.length}/5 peers</b>{peers.map((c) => <button key={c.ticker} onClick={() => togglePeer(c.ticker)} aria-label={`Remove ${c.ticker} from comparison`}>{c.ticker}<X size={12} /></button>)}</div><div><button className={s.button} onClick={() => { updateView({ selected: [] }); setCompareOpen(false); }}>Clear peers</button><button className={s.primary} disabled={peers.length < 2} onClick={() => setCompareOpen(!compareOpen)}>{compareOpen ? 'Hide comparison' : 'Compare peers'}</button></div></div>}
      {view.tab !== 'factors' && compareOpen && peers.length >= 2 && <PeerComparison companies={peers} basis={view.basis} onInspect={setInspecting} />}
      <details className={`${s.panel} ${s.details}`}><summary>Methodology & interpretation</summary><div className={s.methodology}><p><b>Universe.</b> {data.requested} curated ticker entries grouped into {data.cohorts.length} overlapping research cohorts. Coverage reflects companies currently resolved and available from SEC Company Facts. Cohorts are research themes, not exhaustive industry indexes.</p><p><b>Calculations.</b> Only compatible USD contexts are used. Bank revenue is net of interest expense; gross interest income and insurance premiums alone cannot substitute total revenue. Annual and TTM figures are calculated independently. TTM requires a full reported year or four consecutive quarters; revenue growth compares periods about one year apart and requires a positive prior-year base. Missing values stay unavailable and are excluded from each metric’s own denominator.</p><p><b>Comparability.</b> Mean and median are equally weighted across available companies. Fiscal ends differ. The briefing, heatmap, and screener do not use market-cap weights or price returns. Quant Lab summarizes absolute filing changes and adjusted return diagnostics across unique issuers; its primary research groups are mutually exclusive. Company drilldowns retain the full model and source explanations. Banks and insurers have different capital and cash-flow structures.</p><p><b>Evidence.</b> Company evidence preserves the raw sources and intermediate calculations. Free cash flow is operating cash flow less PP&amp;E purchases. Quant Lab keeps absolute breadth, peer-normalized filing scores, price models and event associations distinct. Current comparisons are not historical factor returns.</p><p><b>Timing.</b> SEC Market snapshots are refreshed by the daily background job and remain fresh for 25 hours so visitors do not trigger a full-universe rebuild between scheduled runs. During upstream trouble, the last successfully cached snapshot may remain available and is labeled above. Observed market history records actual calculation dates, not point-in-time backtests. Saved research stays in this browser. <a href="/market/factors">Read the Quant Lab methodology.</a></p></div></details>
    </>}
    {inspecting && <MarketEvidence key={inspecting} ticker={inspecting} initialBasis={view.basis} initialMetric={view.metric} onClose={() => setInspecting(null)} />}
  </div>;
}
