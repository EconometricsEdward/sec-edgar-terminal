'use client';
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { bankHref,quarterLabel } from '../../../utils/bank/viewModel.js';
import { CAMELS_DIMENSIONS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import BankCamelsReview from './BankCamelsReview';
import BankPeerHistory,{MetricHistoryMini} from './BankPeerHistory';
import styles from './banks.module.css';
const assets=n=>n==null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:1}).format(n*1000);
const mixLabels=['Real estate','Commercial & industrial','Consumer','Other loans & leases'];
const mixColors=['#65baff','#a899ff','#62d8ba','#e9b660'];
export default function BankPeerBenchmarks({rssd,period,onCompare,lens='peers',category='core',onViewChange}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0),[requesting,setRequesting]=useState(false),[showMore,setShowMore]=useState(false);
  const [historyData,setHistoryData]=useState(null),[historyError,setHistoryError]=useState(''),[historyReload,setHistoryReload]=useState(0),[historyMetric,setHistoryMetric]=useState('roa');
  const historyRef=useRef(null),snapshotId=data?.snapshot?.id;
  const history=historyData?.snapshotId===snapshotId?historyData:null;
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
  function exploreHistory(key){setHistoryMetric(key);historyRef.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}
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
  const historyPanel=<BankPeerHistory history={history} error={historyError} onRetry={retryHistory} metricKey={historyMetric} onMetricChange={setHistoryMetric} period={period} sectionRef={historyRef}/>;
  return <div className={styles.benchmarks}>
    {error&&<p className={styles.notice} role="status">{error} <button onClick={()=>setReload(n=>n+1)}>Try again</button></p>}
    <section className={styles.peerHero}><div><span className={styles.chartEyebrow}>BANKSCOPE MATCHED PEERS</span><h3>A more useful point of comparison.</h3><p>Banks with similar size, lending and funding. Every comparison uses {quarterLabel(period)}.</p></div><div className={styles.peerHeroStats}><div><strong>{peers.length}</strong><span>matched peers</span></div><div><strong>{data.universeCount.toLocaleString('en-US')}</strong><span>banks in this quarter</span></div></div></section>
    {bank&&<div className={styles.peerLenses} role="group" aria-label="Peer research lens"><button aria-pressed={lens==='peers'} onClick={()=>onViewChange({lens:'peers'})}>Peer explorer <small>24 metrics</small></button><button aria-pressed={lens==='camels'} onClick={()=>onViewChange({lens:'camels'})}><span className={styles.camelsDots}>● ● ●</span> CAMELS review <small>Capital &amp; risk context</small></button></div>}
    {lens==='camels'&&bank?<BankCamelsReview data={data} period={period} history={history} historyPanel={historyPanel} onHistory={exploreHistory} onExplore={category=>onViewChange({lens:'peers',category})}/>:!ready?<section className={styles.empty}><h3>{data.status==='insufficient_inputs'?'Not enough matching inputs':data.status==='bank_not_covered'?'No matching quarterly FDIC record':'Peer data unavailable for this quarter'}</h3><p>{data.status==='insufficient_inputs'?'This bank has missing lending or funding fields. We keep those values unavailable.':data.status==='bank_not_covered'?'Automatic matching covers FDIC records that can be verified against the FFIEC reporting panel for this date.':'Choose another reporting quarter or return after the next data refresh.'}</p><button onClick={()=>onCompare([])}>Open selected-bank comparison</button></section>:<>
      <div className={styles.sectionHeading}><div><h3>Start with the closest matches</h3><p className={styles.basis}>Ranked by size 40% · lending 35% · funding 25%</p></div><button className={styles.primaryButton} onClick={()=>onCompare(peers.slice(0,3).map(p=>String(p.rssd)))}>Compare top {Math.min(3,peers.length)}</button></div>
      <div className={styles.suggestedPeers}>{peers.slice(0,showMore?6:3).map((p,i)=><article key={p.rssd} className={styles.suggestedPeer}><span className={styles.peerRank}>MATCH {String(i+1).padStart(2,'0')}</span><h4><Link href={bankHref(p.rssd,{view:'compare',panel:'benchmarks',period})}>{p.name}</Link></h4><p>{p.city}, {p.state} · RSSD {p.rssd}</p><div className={styles.peerAsset}><strong>{assets(p.assets)}</strong><span>{p.match.assetMultiple.toFixed(2)}× bank assets</span></div><MixBar values={p.loanMix}/><div className={styles.matchNotes}><span>{p.match.lending<.1?'Closely aligned lending':'Broader lending match'}</span><span>{p.match.funding<.1?'Closely aligned funding':'Broader funding match'}</span></div><button onClick={()=>onCompare([String(p.rssd)])} aria-label={`Compare with ${p.name}`}>Compare bank →</button></article>)}</div>
      <div className={styles.peerLegend}>{mixLabels.map((label,i)=><span key={label}><i style={{background:mixColors[i]}}/>{label}</span>)}{peers.length>3&&<button onClick={()=>setShowMore(!showMore)}>{showMore?'Show fewer matches':'Show more matches'}</button>}</div>
      <section className={styles.subjectMix}><span><strong>This bank’s lending mix</strong><small>{assets(bank.assets)} assets · {pct(bank.loanShare*100)} loans / assets</small></span><MixBar values={bank.loanMix}/><small>Deposits / assets {pct(bank.funding[0]*100)} · Noninterest deposits / domestic deposits {pct(bank.funding[1]*100)}</small></section>
      <div className={styles.sectionHeading}><div><h3>Where the bank stands</h3><p className={styles.basis}>Distribution of {peers.length} matched peers · FDIC ratios and transparent calculations</p></div><div className={styles.distributionLegend}><span>● This bank</span><span>│ Peer median</span><span>▬ Middle 50%</span></div></div>
      <div className={styles.metricFilters} role="group" aria-label="Peer metric category"><button aria-pressed={category==='core'} onClick={()=>onViewChange({category:'core'})}>Core six</button>{CAMELS_DIMENSIONS.map(d=><button key={d.key} style={{'--accent':d.color}} aria-pressed={category===d.key} onClick={()=>onViewChange({category:d.key})}>{d.shortLabel||d.label}</button>)}</div>
      {(data.assetBand===8||peers.length<10)&&<p className={styles.basis}>This bank has a smaller comparable universe. {data.assetBand===8?'The asset range was expanded to ⅛–8× this bank’s size.':'Fewer than 10 peers are available.'} Review the cohort before interpreting ranks.</p>}
      {category==='capital'&&bank.cblr===true&&<p className={styles.basis}>This bank elected CBLR for this quarter. Risk-based capital ratios are not required and are excluded from peer calculations; leverage remains comparable with its framework disclosed.</p>}
      <div className={styles.benchmarkGrid}>{visibleMetrics.map(b=><DistributionCard key={b.key} metric={b} history={historyByKey.get(b.key)} onHistory={()=>exploreHistory(b.key)}/>)}</div>
      <p className={styles.basis}>Percentile means relative numeric position, not a quality score. Higher credit-loss or noncurrent-loan ratios have a different meaning from higher profitability. At least five reported peer values are required.</p>
      {historyPanel}
      <details className={styles.exactDetails}><summary>Explore the full peer group <span>{peers.length} peers + this bank · Selected metric category</span></summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Matched bank peer group"><table className={styles.comparison}><caption>{quarterLabel(period)} · Source amounts in USD thousands; ratios in percent</caption><thead><tr><th>Bank</th><th>Assets ($000)</th>{visibleMetrics.map(m=><th key={m.key}>{m.label}</th>)}</tr></thead><tbody>{[bank,...peers].map(p=><tr key={p.rssd}><th scope="row"><Link href={bankHref(p.rssd,{view:'compare',period,panel:'benchmarks',category})}>{p.name}</Link><small>{p.rssd===bank.rssd?'This bank · ':''}RSSD {p.rssd} · {p.cblr===true?'CBLR':p.cblr===false?'Risk-based':'Framework unverified'}</small></th><td>{p.assets.toLocaleString('en-US')}</td>{visibleMetrics.map(m=><td key={m.key}>{p.cblr===true&&m.riskBased?'N/A · CBLR':pct(p.metrics[m.key])}</td>)}</tr>)}</tbody></table></div></details>
    </>}
    <UbprReference ubpr={data.ubpr} rssd={rssd} period={period} prepare={prepare} requesting={requesting}/>
    <details className={styles.audit}><summary>How peers are matched · sources and coverage</summary><p>Universe: {data.universeCount.toLocaleString('en-US')} FDIC quarterly records joined to the FFIEC panel by RSSD and FDIC certificate, with {data.eligibleCount.toLocaleString('en-US')} complete matching profiles. The subject bank is excluded from its peer group. No performance outcomes influence matching.</p><p>We rank up to 30 banks within ¼–4× asset size, expanding to ⅛–8× if fewer than 10 qualify. Distance weights: 40% logarithmic asset size, 35% lending and 25% funding. Lending combines real estate, commercial &amp; industrial, consumer and other loan shares (75%) with loans / assets (25%). Funding averages the differences in deposits / assets, noninterest / domestic deposits and brokered / domestic deposits.</p><p>The charts use unweighted peer medians and linearly interpolated quartiles, with no outlier trimming. Percentiles count peers below the bank plus half of ties, divided by valid peer count. Missing values are omitted per metric. These are BankScope calculations, distinct from FFIEC’s official peer groups, trimmed averages and ranks.</p><p>Matching uses broad categories. Specialty lenders, foreign offices, tax status, acquisitions and reporting amendments can still affect comparability. FDIC and UBPR calculations, source dates and precision can differ.</p>{data.snapshot&&<><p>FDIC source version: {data.snapshot.source_index} · Retrieved {new Date(data.snapshot.created_at).toLocaleDateString('en-US',{timeZone:'UTC'})} (UTC). Model {data.snapshot.model_version}.</p><p><a href={data.snapshot.source_url} target="_blank" rel="noreferrer">Open quarterly FDIC source data ↗</a> · <a href="https://api.fdic.gov/banks/docs/" target="_blank" rel="noreferrer">FDIC field definitions ↗</a></p></>}</details>
  </div>;
}
function MixBar({values}){return <div className={styles.loanMix} role="img" aria-label={mixLabels.map((label,i)=>`${label} ${(values[i]*100).toFixed(1)}%`).join(', ')}>{values.map((v,i)=><span key={i} style={{width:`${v*100}%`,background:mixColors[i]}} title={`${mixLabels[i]}: ${(v*100).toFixed(1)}%`}/>)}</div>;}
function DistributionCard({metric:b,history,onHistory}){
  const scale=n=>24+(n-b.domain[0])/(b.domain[1]-b.domain[0])*272;
  const tallest=b.available?Math.max(1,...b.bins.map(x=>x.count)):1;
  return <article className={styles.benchmarkCard} style={{'--accent':b.color}}><span className={styles.chartEyebrow}>{b.group}</span><h4>{b.label}</h4><div className={styles.benchmarkValue}><strong>{b.notRequired?'N/A · CBLR':pct(b.value)}</strong><span>{b.percentile==null?'No percentile':`P${Math.round(b.percentile)}`}<small>{b.percentile==null?'':'within matched peers'}</small></span></div>{b.notRequired&&<p className={styles.basis}>Not required under the bank’s elected CBLR framework. Reported risk-based peers are shown for context.</p>}
    {b.available?<><svg className={styles.distributionChart} viewBox="0 0 320 112" role="img" aria-label={`${b.label}. This bank ${pct(b.value)}. Peer median ${pct(b.median)}. Middle half from ${pct(b.q1)} to ${pct(b.q3)}. ${b.count} peers.`}><line x1="24" x2="296" y1="76" y2="76" stroke="currentColor" opacity=".25"/>{b.bins.map((bin,i)=><rect key={i} x={scale(bin.low)+1} y={76-bin.count/tallest*56} width={272/12-2} height={Math.max(bin.count?2:0,bin.count/tallest*56)} rx="2" fill={b.color} opacity=".5"><title>{pct(bin.low)} to {pct(bin.high)}: {bin.count} peers</title></rect>)}<rect x={scale(b.q1)} y="84" width={Math.max(2,scale(b.q3)-scale(b.q1))} height="5" rx="2" fill={b.color} opacity=".8"/><line x1={scale(b.median)} x2={scale(b.median)} y1="17" y2="91" stroke="var(--text)" strokeDasharray="3 3" strokeWidth="1.5"/>{b.value!=null&&<g><line x1={scale(b.value)} x2={scale(b.value)} y1="12" y2="80" stroke={b.color} strokeWidth="2"/><circle cx={scale(b.value)} cy="12" r="4" fill={b.color} stroke="var(--bg)" strokeWidth="1.5"/></g>}<text x="24" y="108" fontSize="9" fill="currentColor">{pct(b.domain[0])}</text><text x="296" y="108" textAnchor="end" fontSize="9" fill="currentColor">{pct(b.domain[1])}</text></svg><div className={styles.benchmarkFoot}><span>Median <strong>{pct(b.median)}</strong></span><span>{b.count} reported peers</span></div></>:<p className={styles.basis}>Only {b.count} peer values available. Distribution withheld.</p>}
    <MetricHistoryMini metric={history} onOpen={onHistory}/>
    <details className={styles.metricDefinition}><summary>Definition &amp; exact figures</summary><p>{b.basis}</p><p>FDIC {b.field} · This bank {b.value==null?'unavailable':`${b.value.toFixed(4)}%`}{b.available?` · Peer median ${b.median.toFixed(4)}% · Middle 50% ${b.q1.toFixed(4)}–${b.q3.toFixed(4)}%`:''}</p></details></article>;
}
function UbprReference({ubpr,rssd,period,prepare,requesting}){
  const report=ubpr?.report?.data?.stage==='validated'?ubpr.report:null,pending=['queued','running','retry'].includes(ubpr?.status);
  return <section className={styles.ubprReference}><div className={styles.sectionHeading}><div><span className={styles.chartEyebrow}>OFFICIAL FFIEC REFERENCE</span><h3>Check the UBPR perspective</h3></div><a href="https://cdr.ffiec.gov/public/" target="_blank" rel="noreferrer">Open FFIEC reports ↗</a></div><p className={styles.basis}>FFIEC’s published bank ratios for {quarterLabel(period)}. UBPR can use different adjustments and precision from FDIC. Official FFIEC peer averages and percentile ranks are available in the full UBPR; they are not supplied by the bank XBRL feed used here.</p>
    {report?<><div className={styles.ubprMetrics}>{report.data.metrics.map(m=><div key={m.key} title={m.basis}><span>{m.label}</span><strong>{pct(m.value)}</strong><small>{m.code}</small></div>)}</div><details className={styles.metricDefinition}><summary>UBPR source record</summary><p>RSSD {rssd} · Period {period} · Retrieved {report.retrieved_at}</p><p className={styles.hash}>SHA-256 {report.source_sha256}</p><a href={`/api/banks/source?${new URLSearchParams({rssd:String(rssd),period,hash:report.source_sha256,series:'ubpr'})}`} download>Download original UBPR XBRL</a><p>Ratios are displayed as published percentages. They are not inserted into the FDIC peer distributions.</p></details></>:<div className={styles.ubprPending}><p role="status">{pending?'Preparing official FFIEC reports… This view updates automatically.':ubpr?.status==='unavailable'?'FFIEC has no UBPR document available for this bank and date.':ubpr?.status==='review'?'The UBPR source needs review before its ratios can be displayed.':'Prepare the bank’s official FFIEC reports to add its UBPR reference ratios.'}</p>{!pending&&!['unavailable','review'].includes(ubpr?.status)&&<button disabled={requesting} onClick={prepare}>{requesting?'Requesting…':'Prepare FFIEC reports'}</button>}</div>}
  </section>;
}
