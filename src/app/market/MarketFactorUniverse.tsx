'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { downloadText } from '../../utils/download.js';
import { UNIVERSE_VERSION, universeMarkdown, UNIVERSE_METRICS, universeBrief, upgradeUniverseSnapshot } from '../../utils/marketUniverse.js';
import { computeFundamentalDiagnostics, normalizeChangeThreshold, changeDirection } from '../../utils/marketFundamentals.js';
import { filingEligibility, matchesResearchScreen, researchCsvCell, universeResearchChecks } from '../../utils/marketUniverseChecks.js';
import { compareFundamentalPeer } from '../../utils/fundamentalPeers.js';
import type { MarketData, MarketView } from './marketTypes';
import type { FundamentalDiagnostics, UniverseSnapshot } from './marketUniverseTypes';
import MarketFundamentalDiagnostics from './MarketFundamentalDiagnostics';
import { FundamentalResearchChecks } from './MarketResearchChecks';
import s from './factorUniverse.module.css';

const cache = new Map<string,{at:number;data:UniverseSnapshot}>();
const number = (value:number|null|undefined,digits=2) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const signed = (value:number|null|undefined) => typeof value === 'number' && Number.isFinite(value) ? `${value>0?'+':''}${value.toFixed(2)}` : '—';
const day = (value:string|null|undefined) => value?.slice(0,10) || 'Unavailable';

export default function MarketFactorUniverse({ view, onView, onNotice, onInspect }: { atlas:MarketData|null; view:MarketView; onView:(patch:Partial<MarketView>)=>void; onNotice:(message:string)=>void; onInspect:(ticker:string)=>void }) {
  const [snapshot,setSnapshot] = useState<UniverseSnapshot|null>(null);
  const [error,setError] = useState(''), [loading,setLoading] = useState(true), [retry,setRetry] = useState(0);
  const [query,setQuery] = useState(''), [sort,setSort] = useState('change-desc'), [screen,setScreen] = useState('all'), [page,setPage] = useState(0);
  const constituentRef = useRef<HTMLElement>(null);
  const metric = UNIVERSE_METRICS.some(item=>item.key===view.metric) ? view.metric : 'revenueGrowth';
  const threshold = normalizeChangeThreshold(view.quantThreshold);

  useEffect(()=>{
    const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),25000);
    const basis = view.basis, prior = cache.get(basis); let active = true;
    setLoading(true); setError('');
    if(prior && Date.now()-prior.at<300000 && retry===0){ setSnapshot(prior.data); setLoading(false); clearTimeout(timer); return ()=>controller.abort(); }
    fetch(`/api/v2/factor-universe?basis=${basis}`,{signal:controller.signal}).then(async response=>{
      const result=await response.json();
      if(!response.ok||result.schema_version!==UNIVERSE_VERSION||!result.scopes?.all) throw new Error(result.error||'The fundamental snapshot is unavailable.');
      return upgradeUniverseSnapshot(result) as UniverseSnapshot;
    }).then(result=>{ if(active){ setSnapshot(result); if(result.status==='ready') cache.set(basis,{at:Date.now(),data:result}); } })
      .catch(reason=>{ if(active)setError(reason.name==='AbortError'?'The prepared SEC snapshot timed out. Please retry.':reason.message); })
      .finally(()=>{ clearTimeout(timer); if(active)setLoading(false); });
    return()=>{active=false;clearTimeout(timer);controller.abort();};
  },[view.basis,retry]);

  const current=snapshot?.basis===view.basis?snapshot:null;
  const preparedScope=current?.scopes[view.cohort]||current?.scopes.all;
  const selected=useMemo(()=>current?.rows.filter(row=>!current.scopes[view.cohort]||view.cohort==='all'||row.group===view.cohort)||[],[current,view.cohort]);
  const diagnostics=useMemo(()=>computeFundamentalDiagnostics(selected,threshold) as FundamentalDiagnostics,[selected,threshold]);
  const researchChecks=useMemo(()=>universeResearchChecks(selected,metric),[selected,metric]);
  const scope=useMemo(()=>preparedScope?{...preparedScope,...diagnostics,brief:universeBrief({...preparedScope,...diagnostics})}:null,[preparedScope,diagnostics]);
  const groups=useMemo(()=>current?Object.values(current.scopes).filter(group=>group.id!=='all'&&group.companies>0).map(group=>({...group,...computeFundamentalDiagnostics(current.rows.filter(row=>row.group===group.id),threshold)})):[],[current,threshold]);
  const screenMembers=useMemo(()=>new Set(screen.startsWith('cash:')?diagnostics.cash_confirmation.cells.find(cell=>`cash:${cell.growth}:${cell.cash}`===screen)?.tickers:screen==='weakening'?diagnostics.simultaneous_weakening.tickers:[]),[screen,diagnostics]);
  const rows=useMemo(()=>selected.filter(row=>
    matchesResearchScreen(row,screen,metric)
    && (!screen.startsWith('direction:') || filingEligibility(row,metric)==='paired' && changeDirection(row.metrics[metric]?.change,threshold)===screen.slice(10))
    && (!screen.startsWith('cash:') || screenMembers.has(row.ticker))
    && (screen!=='weakening' || screenMembers.has(row.ticker))
    && (!query.trim() || `${row.ticker} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase()))
  ).sort((a,b)=>{
    if(sort==='ticker')return a.ticker.localeCompare(b.ticker);
    if(sort==='filed')return String(b.filed||'').localeCompare(String(a.filed||''))||a.ticker.localeCompare(b.ticker);
    const av=a.metrics[metric]?.change,bv=b.metrics[metric]?.change;
    if(av==null)return bv==null?a.ticker.localeCompare(b.ticker):1;
    if(bv==null)return -1;
    return (sort==='change-asc'?av-bv:bv-av)||a.ticker.localeCompare(b.ticker);
  }),[selected,screen,metric,threshold,screenMembers,query,sort]);
  const pages=Math.max(1,Math.ceil(rows.length/15)),visiblePage=Math.min(page,pages-1);
  const visibleRows=useMemo(()=>rows.slice(visiblePage*15,visiblePage*15+15),[rows,visiblePage]);
  const visiblePeerContext=useMemo(()=>new Map(visibleRows.map(row=>[row.ticker,compareFundamentalPeer(row,selected,metric)])),[visibleRows,selected,metric]);

  function setMetric(key:string){onView({metric:key});setScreen('all');setPage(0);}
  function showScreen(next:string,key?:string){if(key)setMetric(key);setScreen(next);setPage(0);setQuery('');constituentRef.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
  function exportJson(){if(!current||!scope)return;downloadText(`fundamental-universe-${current.basis}-${day(current.sec_snapshot_at)}.json`,JSON.stringify({...current,selected_scope:preparedScope?.id||'all',analysis_settings:{metric,threshold,screen,query,sort},selected_screen_tickers:rows.map(row=>row.ticker),selected_peer_context:rows.map(row=>compareFundamentalPeer(row,selected,metric)),selected_research_checks:researchChecks,selected_diagnostics:diagnostics,selected_brief:scope.brief},null,2),'application/json');onNotice('SEC Fundamental Lab snapshot exported with definitions, coverage, peer context, and filing links.');}
  function exportCsv(){if(!current)return;const lines=[['schema_version','methodology_version','sec_snapshot_at','basis','ticker','company','cik','primary_sector','metric','current_percent','prior_percent','change_percentage_points','eligibility','unavailable_reason','sector_peer_count','sector_peer_median_change','sector_peer_robust_z','sector_peer_percentile','filing_date','fiscal_end','prior_fiscal_end','accession','sec_filing','sec_checked_at','facts_retrieved_at','scope','direction_threshold_percentage_points'],...rows.map(row=>{const peer=compareFundamentalPeer(row,selected,metric);return[current.schema_version,current.methodology_version,current.sec_snapshot_at,current.basis,row.ticker,row.name,row.cik,row.group,metric,row.metrics[metric]?.current,row.metrics[metric]?.prior,row.metrics[metric]?.change,filingEligibility(row,metric),row.metrics[metric]?.unavailable_reason,peer.distribution.count,peer.distribution.median,peer.z,peer.percentile,row.filed,row.fiscal_end,row.prior_fiscal_end,row.accession,row.source,row.sec_checked_at,row.facts_retrieved_at,preparedScope?.id||'all',threshold]})];downloadText('fundamental-universe-screen.csv',lines.map(line=>line.map(researchCsvCell).join(',')).join('\r\n'),'text/csv');onNotice(`${rows.length} SEC-derived company rows exported. Blank values remain unavailable.`);}

  return <section className={s.lab} aria-label="SEC Fundamental Lab">
    {loading&&<p role="status" className={s.loading}><Loader2 className={s.spin} size={18}/>Loading the prepared SEC fundamental snapshot…</p>}
    {error&&<div role="alert" className={s.warning}><p>{error}</p><button className={s.button} onClick={()=>setRetry(value=>value+1)}><RefreshCw size={15}/>Retry snapshot</button></div>}
    {current&&scope&&<>
      <div className={s.controls}><label>Sector scope<select value={preparedScope?.id||'all'} onChange={event=>{onView({cohort:event.target.value});setPage(0);setScreen('all');}}>{Object.values(current.scopes).filter(group=>group.companies>0).map(group=><option key={group.id} value={group.id}>{group.label} · {group.companies}</option>)}</select></label></div>
      <div className={s.snapshotLine}><span><b>{scope.companies}</b> issuers in scope</span><span><b>{scope.comparable_companies}</b> with at least one comparable measure</span><span>SEC snapshot <b>{day(current.sec_snapshot_at)}</b></span><span>Calculated <b>{day(current.generated_at)}</b></span></div>
      {(current.status==='stale'||current.status==='partial'||current.refresh_warning)&&<p className={s.warning} role="status">{current.refresh_warning||(current.status==='partial'?'This SEC fundamental snapshot has disclosed coverage or validation limits. Missing values remain unavailable.':'Showing the last completed SEC fundamental snapshot with its original source dates.')}</p>}
      <section className={s.brief} aria-labelledby="fundamental-brief-heading"><div><span className={s.eyebrow}>Filing-derived market briefing</span><h2 id="fundamental-brief-heading">What changed across reported fundamentals?</h2><ol>{scope.brief.map((item,index)=><li key={index}>{item}</li>)}</ol></div><aside><h3>How to read this snapshot</h3><p>Each issuer counts once; missing values never become zero.</p><p>Higher and lower compare each company with its own compatible prior-year filing period.</p><p>{current.basis==='ttm'?'TTM compares trailing-12-month flows and matching period-end balances.':'Annual compares the latest annual period with the compatible prior year.'} Fiscal calendars vary.</p><p>No security-price, return, beta, correlation, volatility, or post-filing response data is used.</p></aside></section>
      <MarketFundamentalDiagnostics diagnostics={diagnostics} metric={metric} onMetric={setMetric} onThreshold={value=>{onView({quantThreshold:value});setPage(0);}} onScreen={showScreen} groups={groups} onGroup={id=>{onView({cohort:id});setPage(0);setScreen('all');}} />
      <FundamentalResearchChecks checks={researchChecks} onScreen={showScreen} onThreshold={value=>{onView({quantThreshold:value});setPage(0);}} />
      <div className={s.pressure}><div><h3>Three measures declining together</h3><p>Slower revenue growth, lower operating margin, and lower free-cash-flow margin in the same operating company outside the selected direction band.</p></div><strong>{scope.simultaneous_weakening.count}<small>of {scope.simultaneous_weakening.eligible} eligible</small></strong><button className={s.button} onClick={()=>showScreen('weakening')}>Review issuers</button><p className={s.caption}>{scope.simultaneous_weakening.missing} operating issuers lack at least one required comparison. This is an investigation list, not a distress score.</p></div>
      <details className={s.panel}><summary>Observed whole-universe history</summary>{current.history_note&&<p>{current.history_note}</p>}<p>History records completed SEC snapshots using all measured changes. It is not a reconstructed point-in-time backtest.</p>{current.history.length<2?<p>History is beginning with this version. Scheduled SEC snapshots will add observations without inventing earlier values.</p>:<div className={s.tableWrap}><table><thead><tr><th>SEC snapshot</th><th>Issuers</th>{UNIVERSE_METRICS.map(item=><th key={item.key}>{item.short} · higher / eligible</th>)}</tr></thead><tbody>{[...current.history].reverse().map(point=><tr key={point.sec_snapshot_at}><th>{day(point.sec_snapshot_at)}</th><td>{point.issuers.length}</td>{point.breadth.map(item=><td key={item.metric}>{item.higher} / {item.eligible}</td>)}</tr>)}</tbody></table></div>}</details>
      <section className={s.panel} ref={constituentRef} aria-labelledby="fundamental-companies-heading"><div className={s.sectionHeading}><div><h2 id="fundamental-companies-heading">Companies behind the result</h2><p>Screen the same paired filing sample, then inspect the exact SEC evidence for any company.</p></div></div><div className={s.filters}><label>Find a company<div className={s.searchField}><Search size={15}/><input value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}} placeholder="Ticker or company"/></div></label><label>Filing measure<select value={metric} onChange={event=>setMetric(event.target.value)}>{UNIVERSE_METRICS.map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</select></label><label>Order<select value={sort} onChange={event=>{setSort(event.target.value);setPage(0);}}><option value="change-desc">Largest increase</option><option value="change-asc">Largest decrease</option><option value="filed">Most recently filed</option><option value="ticker">Ticker</option></select></label><label>Screen<select value={screen} onChange={event=>{setScreen(event.target.value);setPage(0);}}><option value="all">All in scope</option><option value="direction:higher">Increases beyond band</option><option value="direction:lower">Decreases beyond band</option><option value="direction:neutral">Inside direction band</option><option value="eligibility:paired">Comparable pairs</option><option value="eligibility:missing">Missing comparisons</option><option value="eligibility:excluded">Excluded issuer types</option><option value="weakening">Three measures declining</option></select></label></div>
        <div className={s.pagination}><p role="status">{rows.length} of {selected.length} issuers match this screen. Headline statistics keep the full sector scope.</p><button className={s.button} onClick={()=>{setScreen('all');setQuery('');setSort('change-desc');setPage(0);}}>Reset screen</button></div>
        <div className={s.tableWrap} role="region" aria-label="SEC fundamental company screen" tabIndex={0}><table><caption>{rows.length} SEC-derived issuer comparisons · changes in percentage points</caption><thead><tr><th scope="col">Company</th><th scope="col">Current</th><th scope="col">Prior</th><th scope="col">Change</th><th scope="col">Sector context</th><th scope="col">Filed / period</th><th scope="col">Evidence</th></tr></thead><tbody>{visibleRows.map(row=>{const peer=visiblePeerContext.get(row.ticker);return <tr key={row.ticker}><th scope="row"><button className={s.textButton} onClick={()=>onInspect(row.ticker)}>{row.ticker}</button><small>{row.name}</small></th><td>{number(row.metrics[metric]?.current)}</td><td>{number(row.metrics[metric]?.prior)}</td><td>{signed(row.metrics[metric]?.change)}<small>{filingEligibility(row,metric)==='paired'?'percentage points':row.metrics[metric]?.unavailable_reason||'Unavailable'}</small></td><td>{peer?.available?`Percentile rank ${number(peer.percentile,0)}`:'—'}<small>{peer?.available?`Robust z ${signed(peer.z)} (clipped to ±3) · ${peer.distribution.count} peers`:peer?.reason||'Unavailable'}</small></td><td>{day(row.filed)}<small>Period {day(row.fiscal_end)}</small></td><td>{row.source&&<a href={row.source} target="_blank" rel="noreferrer">SEC filing <ExternalLink size={12}/></a>}<button className={s.textButton} onClick={()=>onInspect(row.ticker)}>Inspect inputs</button></td></tr>})}</tbody></table></div>
        {!rows.length&&<p className={s.empty}>No issuers match this screen. Change the filters or clear the search.</p>}<div className={s.pagination}><span>Page {visiblePage+1} of {pages}</span><button className={s.button} disabled={visiblePage===0} onClick={()=>setPage(visiblePage-1)}>Previous</button><button className={s.button} disabled={visiblePage+1===pages} onClick={()=>setPage(visiblePage+1)}>Next</button><button className={s.button} onClick={exportCsv}><Download size={15}/>Screen CSV</button></div>
      </section>
      <section className={s.handoff}><div><h2>Use the evidence outside this page</h2><p>Exports retain the SEC snapshot time, methodology, selected sample, eligibility reasons, period dates, filing links, and interpretation limits.</p></div><div className={s.actions}><button className={s.button} onClick={exportJson}><Download size={16}/>Universe JSON</button><button className={s.button} onClick={()=>{downloadText('fundamental-universe-brief.md',universeMarkdown(current,view.cohort,threshold),'text/markdown');onNotice('Fundamental research brief exported.');}}><Download size={16}/>Research brief</button><a className={s.button} href="/market/factors">Methodology</a></div></section>
      <details className={s.panel}><summary>Coverage, grouping, and interpretation limits</summary><p>{current.universe.issuers} unique issuers loaded from {current.universe.requested} targeted entries; {current.universe.share_classes_excluded} duplicate share classes excluded. SEC observed {current.sec_snapshot_at}; aggregate calculated {current.generated_at}.</p><p>{current.universe.grouping}</p>{current.universe.coverage&&<ul>{current.universe.coverage.sources.map(source=><li key={source.fund}><a href={source.url} target="_blank" rel="noreferrer">{source.fund} holdings</a> · {source.as_of} · {source.securities} listed securities</li>)}</ul>}<ul>{current.limitations.map(line=><li key={line}>{line}</li>)}</ul><p>Schema {current.schema_version} · Method {current.methodology_version}</p></details>
    </>}
  </section>;
}
