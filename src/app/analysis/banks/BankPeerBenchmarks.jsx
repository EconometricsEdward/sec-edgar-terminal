'use client';
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { bankHref,quarterLabel } from '../../../utils/bank/viewModel.js';
import { CAMELS_DIMENSIONS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import BankCamelsReview from './BankCamelsReview';
import BankPeerHistory from './BankPeerHistory';
import BankMetricRows,{PeerLegend} from './BankMetricRows';
import styles from './banks.module.css';
const assets=n=>n==null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:1}).format(n*1000);
export default function BankPeerBenchmarks({rssd,period,onCompare,lens='peers',category='core',onViewChange}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0),[requesting,setRequesting]=useState(false);
  const [historyData,setHistoryData]=useState(null),[historyError,setHistoryError]=useState(''),[historyReload,setHistoryReload]=useState(0),[historyMetric,setHistoryMetric]=useState('roa');
  const historyRef=useRef(null),cohortRef=useRef(null),contextRef=useRef(null),wrapperRef=useRef(null),snapshotId=data?.snapshot?.id;
  const history=historyData?.snapshotId===snapshotId?historyData:null;
  useEffect(()=>{
    const context=contextRef.current,wrapper=wrapperRef.current;
    if(!context||!wrapper)return;
    const measure=()=>wrapper.style.setProperty('--peer-context-height',`${Math.ceil(context.getBoundingClientRect().height)}px`);
    measure();
    const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(measure);
    observer?.observe(context);
    return()=>observer?.disconnect();
  },[data?.bank?.rssd]);
  useEffect(()=>{
    const controller=new AbortController();let timer,stopped=false,attempts=0;
    async function load(){
      try{
        const response=await fetch(`/api/banks/peers?${new URLSearchParams({rssd:String(rssd),period})}`,{signal:controller.signal});
        if(!response.ok)throw Error('Peer benchmarks could not be loaded. Please try again.');
        const next=await response.json();if(stopped)return;setData(next);setError('');
        if(['queued','running','retry'].includes(next.ubpr?.status)&&++attempts<60)timer=setTimeout(load,15000);
      }catch(e){if(e.name!=='AbortError'&&!stopped)setError(e.message);}
    }
    load();return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[rssd,period,reload]);
  useEffect(()=>{
    if(!snapshotId)return;
    const controller=new AbortController();
    async function load(){
      try{
        const response=await fetch(`/api/banks/peers?${new URLSearchParams({rssd:String(rssd),period,history:'1'})}`,{signal:controller.signal});
        if(!response.ok)throw Error('Historical metrics could not be loaded. Current-quarter benchmarks are available above.');
        const next=await response.json();
        if(next.snapshotId!==snapshotId)throw Error('The source data refreshed. Retry to align the history with the latest benchmarks.');
        if(!controller.signal.aborted){setHistoryData(next);setHistoryError('');}
      }catch(e){if(e.name!=='AbortError'&&!controller.signal.aborted)setHistoryError(e.message);}
    }
    load();return()=>controller.abort();
  },[rssd,period,snapshotId,historyReload]);
  function retryHistory(){setHistoryError('');setHistoryReload(n=>n+1);setReload(n=>n+1);}
  function focusSection(element){element?.focus({preventScroll:true});element?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}
  function exploreHistory(key){setHistoryMetric(key);focusSection(historyRef.current);}
  function exploreGroup(){if(cohortRef.current){cohortRef.current.open=true;focusSection(cohortRef.current);}}
  async function prepare(){
    setRequesting(true);setError('');
    try{
      const response=await fetch('/api/banks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rssd:String(rssd)})});
      if(!response.ok)throw Error((await response.json()).error||'Report preparation is unavailable.');
      setData(old=>({...old,ubpr:{...old?.ubpr,status:'queued'}}));setReload(n=>n+1);
    }catch(e){setError(e.message);}finally{setRequesting(false);}
  }
  if(!period)return <p className={styles.empty}>Choose a reporting quarter to see peer benchmarks.</p>;
  if(!data)return <section className={styles.peerLoading} aria-busy={!error}><h3>{error?'Peer benchmarks unavailable':'Finding financial peers…'}</h3><p role="status">{error||'Matching the bank against the quarterly reporting universe.'}</p>{error&&<button onClick={()=>setReload(n=>n+1)}>Try again</button>}</section>;
  const ready=data.peers?.length>0,bank=data.bank,peers=data.peers||[];
  const visibleMetrics=data.benchmarks.filter(b=>category==='core'?b.core:b.category===category);
  const historyByKey=new Map((history?.metrics||[]).map(m=>[m.key,m]));
  const historyPanel=<BankPeerHistory history={history} error={historyError} onRetry={retryHistory} metricKey={historyMetric} onMetricChange={setHistoryMetric} period={period} sectionRef={historyRef} bankName={bank?.name||`Bank RSSD ${rssd}`}/>;
  return <div className={styles.benchmarks} ref={wrapperRef}>
    {error&&<p className={styles.notice} role="status">{error} <button onClick={()=>setReload(n=>n+1)}>Try again</button></p>}
    {bank&&<section className={styles.peerContext} ref={contextRef} aria-label="Selected bank and peer group">
      <div className={styles.contextBank}><span className={styles.contextScope}><i className={styles.bankDot}/>Selected bank · individual values</span><strong>{bank.name}</strong><small>RSSD {bank.rssd} · {assets(bank.assets)} assets · {quarterLabel(period)}</small></div>
      <span className={styles.contextVersus} aria-hidden="true">vs</span>
      <div className={styles.contextPeers}><span className={styles.contextScope}><i className={styles.peerDiamond}/>Peer group · aggregate values</span><strong>{peers.length} matched banks <button onClick={exploreGroup}>View group ↗</button></strong><small>Unweighted median · Selected bank excluded</small></div>
    </section>}
    {bank&&<div className={styles.peerLenses} role="group" aria-label="Peer research lens"><button aria-pressed={lens==='peers'} onClick={()=>onViewChange({lens:'peers'})}>Peer explorer <small>24 metrics</small></button><button aria-pressed={lens==='camels'} onClick={()=>onViewChange({lens:'camels'})}>CAMELS review <small>Capital &amp; risk context</small></button></div>}
    {lens==='camels'&&bank?<BankCamelsReview data={data} period={period} history={history} historyPanel={historyPanel} onHistory={exploreHistory} onExplore={category=>onViewChange({lens:'peers',category})}/>:!bank?<section className={styles.empty}><h3>No matching quarterly FDIC record</h3><p>Automatic matching covers FDIC records verified against the FFIEC reporting panel for this date. Choose another quarter or compare selected banks.</p><button onClick={()=>onCompare([])}>Open selected-bank comparison</button></section>:<>
      <div className={styles.explorerIntro}><span className={styles.chartEyebrow}>THE BANK WITHIN ITS PEER GROUP</span><h3>See where the differences are.</h3><p>Compare individual bank ratios with the median of {peers.length} matched banks. The lavender distributions show how reported peer values are spread.</p></div>
      <div className={styles.metricFilters} role="group" aria-label="Peer metric category"><button aria-pressed={category==='core'} onClick={()=>onViewChange({category:'core'})}>Core six</button>{CAMELS_DIMENSIONS.map(d=><button key={d.key} aria-pressed={category===d.key} onClick={()=>onViewChange({category:d.key})}>{d.shortLabel||d.label}</button>)}</div>
      <PeerLegend/>
      {(data.assetBand===8||peers.length<10)&&<p className={styles.basis}>{!ready?'A matched group could not be formed from the available inputs. Individual bank values are shown.':data.assetBand===8?'The peer asset range was expanded to ⅛–8× this bank’s size. Review group membership when interpreting the comparison.':'Fewer than 10 peers are available. Review group membership when interpreting the comparison.'}</p>}
      {category==='capital'&&bank.cblr===true&&<p className={styles.basis}>{bank.name} elected CBLR for this quarter. Risk-based capital ratios are not required and are excluded from peer calculations; leverage remains comparable with its framework disclosed.</p>}
      <BankMetricRows metrics={visibleMetrics} historyByKey={historyByKey} bankName={bank.name} peerCount={peers.length} onHistory={exploreHistory} density/>
      <p className={styles.basis}>P0–P100 is the bank’s numeric percentile among reported peers, not a quality score. At least five reported peer values are required for group statistics. History changes are in basis points (100 bp = 1 percentage point).</p>
      {historyPanel}
    </>}
    {bank&&<details className={styles.cohortDetails} ref={cohortRef} tabIndex={-1}><summary>Inside the peer group <span>{peers.length} matched banks · Selected bank excluded from all group statistics</span></summary>
      <div className={styles.cohortHeading}><p>Group statistics give each reporting peer equal weight. The list below shows individual banks; the selected bank is included only as a reference. Peers are ordered by similarity: size 40% · lending 35% · funding 25%.</p>{ready&&<button onClick={()=>onCompare(peers.slice(0,3).map(p=>String(p.rssd)))}>Compare top {Math.min(3,peers.length)} peers →</button>}</div>
      <p className={styles.basis}>{bank.name}: {pct(bank.loanShare==null?null:bank.loanShare*100)} loans / assets · {pct(bank.funding?.[0]==null?null:bank.funding[0]*100)} deposits / assets · {pct(bank.funding?.[1]==null?null:bank.funding[1]*100)} noninterest / domestic deposits.</p>
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Matched bank peer group"><table className={styles.comparison}><caption>{quarterLabel(period)} · Individual-bank values · Source amounts in USD thousands; ratios in percent</caption><thead><tr><th>Bank / role</th><th>Assets ($000)</th>{visibleMetrics.map(m=><th key={m.key}>{m.label}</th>)}<th>Compare</th></tr></thead><tbody>{[bank,...peers].map((p,i)=><tr key={p.rssd} className={i===0?styles.selectedCohortRow:undefined}><th scope="row"><Link href={bankHref(p.rssd,{view:'compare',period,panel:'benchmarks',category})}>{p.name}</Link><small>{i===0?'Selected bank · Excluded from median':'Peer '+i+' · Included when reported'}<br/>RSSD {p.rssd} · {p.cblr===true?'CBLR':p.cblr===false?'Risk-based':'Framework unverified'}</small></th><td>{p.assets==null?'Unavailable':p.assets.toLocaleString('en-US')}</td>{visibleMetrics.map(m=><td key={m.key}>{p.cblr===true&&m.riskBased?'N/A · CBLR':pct(p.metrics[m.key])}</td>)}<td>{i>0?<button aria-label={'Compare with '+p.name} onClick={()=>onCompare([String(p.rssd)])}>Compare →</button>:'Reference'}</td></tr>)}</tbody></table></div>
    </details>}
    <UbprReference bankName={bank?.name||"Bank RSSD "+rssd} ubpr={data.ubpr} rssd={rssd} period={period} prepare={prepare} requesting={requesting}/>
    <details className={styles.audit}><summary>How peers are matched · sources and coverage</summary><p>Universe: {data.universeCount.toLocaleString('en-US')} FDIC quarterly records joined to the FFIEC panel by RSSD and FDIC certificate, with {data.eligibleCount.toLocaleString('en-US')} complete matching profiles. The subject bank is excluded from its peer group. No performance outcomes influence matching.</p><p>We rank up to 30 banks within ¼–4× asset size, expanding to ⅛–8× if fewer than 10 qualify. Distance weights: 40% logarithmic asset size, 35% lending and 25% funding. Lending combines real estate, commercial &amp; industrial, consumer and other loan shares (75%) with loans / assets (25%). Funding averages the differences in deposits / assets, noninterest / domestic deposits and brokered / domestic deposits.</p><p>The charts use unweighted peer medians and linearly interpolated quartiles, with no outlier trimming. Percentiles count peers below the bank plus half of ties, divided by valid peer count. Missing values are omitted per metric. These are BankScope calculations, distinct from FFIEC’s official peer groups, trimmed averages and ranks.</p><p>Matching uses broad categories. Specialty lenders, foreign offices, tax status, acquisitions and reporting amendments can still affect comparability. FDIC and UBPR calculations, source dates and precision can differ.</p>{data.snapshot&&<><p>FDIC source version: {data.snapshot.source_index} · Retrieved {new Date(data.snapshot.created_at).toLocaleDateString('en-US',{timeZone:'UTC'})} (UTC). Model {data.snapshot.model_version}.</p><p><a href={data.snapshot.source_url} target="_blank" rel="noreferrer">Open quarterly FDIC source data ↗</a> · <a href="https://api.fdic.gov/banks/docs/" target="_blank" rel="noreferrer">FDIC field definitions ↗</a></p></>}</details>
  </div>;
}
function UbprReference({ubpr,rssd,period,prepare,requesting,bankName}){
  const report=ubpr?.report?.data?.stage==='validated'?ubpr.report:null,pending=['queued','running','retry'].includes(ubpr?.status);
  return <section className={styles.ubprReference}><div className={styles.sectionHeading}><div><span className={styles.chartEyebrow}>OFFICIAL FFIEC · INDIVIDUAL BANK</span><h3>The bank’s published UBPR ratios</h3></div><a href="https://cdr.ffiec.gov/public/" target="_blank" rel="noreferrer">Open FFIEC reports ↗</a></div><p className={styles.capitalBankName}>{bankName}</p><p className={styles.basis}>FFIEC’s published bank ratios for {quarterLabel(period)}. UBPR can use different adjustments and precision from FDIC. Official FFIEC peer averages and percentile ranks are available in the full UBPR; they are not supplied by the bank XBRL feed used here.</p>
    {report?<><div className={styles.ubprMetrics}>{report.data.metrics.map(m=><div key={m.key} title={m.basis}><span>{m.label}</span><strong>{pct(m.value)}</strong><small>{m.code}</small></div>)}</div><details className={styles.metricDefinition}><summary>UBPR source record</summary><p>RSSD {rssd} · Period {period} · Retrieved {report.retrieved_at}</p><p className={styles.hash}>SHA-256 {report.source_sha256}</p><a href={`/api/banks/source?${new URLSearchParams({rssd:String(rssd),period,hash:report.source_sha256,series:'ubpr'})}`} download>Download original UBPR XBRL</a><p>Ratios are displayed as published percentages. They are not inserted into the FDIC peer distributions.</p></details></>:<div className={styles.ubprPending}><p role="status">{pending?'Preparing official FFIEC reports… This view updates automatically.':ubpr?.status==='unavailable'?'FFIEC has no UBPR document available for this bank and date.':ubpr?.status==='review'?'The UBPR source needs review before its ratios can be displayed.':'Prepare the bank’s official FFIEC reports to add its UBPR reference ratios.'}</p>{!pending&&!['unavailable','review'].includes(ubpr?.status)&&<button disabled={requesting} onClick={prepare}>{requesting?'Requesting…':'Prepare FFIEC reports'}</button>}</div>}
  </section>;
}
