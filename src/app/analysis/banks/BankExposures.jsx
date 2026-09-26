'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CREDIT_SEGMENTS, finite, exposureChange, exposureRatio, priorExposurePeriod } from '../../../utils/bank/exposureDefinitions.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './exposures.module.css';

const colors = { credit: '#ac9bff', funding: '#71d8b3', securities: '#f5bc68' };
const deposits = [
  {key:'transaction',label:'Transaction accounts',color:'#65c9ef'},
  {key:'mmda',label:'Money market accounts',color:'#71d8b3'},
  {key:'savings',label:'Other savings',color:'#ac9bff'},
  {key:'time_small',label:'Time deposits ≤ $250k',color:'#f5bc68'},
  {key:'time_large',label:'Time deposits > $250k',color:'#f58f9f'},
];
const money = value => !finite(value) ? 'Unavailable' : `${value < 0 ? '−' : ''}$${new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Math.abs(value))}`;
const pct = value => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const val = (report,key) => report?.values?.[key]?.value ?? null;
const history = (data,keys) => data.periods.map(period => {
  const report = data.reports.find(r => r.period === period);
  return {period,...Object.fromEntries(keys.map(k => [k,val(report,k)]))};
});

export default function BankExposures({ rssd, bankName, period, options, href, onChange, sourceHash }) {
  const [result,setResult] = useState(null), [error,setError] = useState(''), [retry,setRetry] = useState(0);
  const identity = `${rssd}:${period}:${sourceHash}:${retry}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(`/api/banks/exposures?${new URLSearchParams({rssd:String(rssd),period})}`,{signal:controller.signal,cache:'no-store'})
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error); if (!controller.signal.aborted) setResult({identity,data:body}); })
      .catch(e => { if (e.name !== 'AbortError' && !controller.signal.aborted) setError(e.message || 'Exposure details could not be loaded.'); });
    return () => controller.abort();
  },[rssd,period,sourceHash,retry,identity]);
  const data = result?.identity === identity ? result.data : null;
  const report = data?.reports?.find(r => r.period === period);
  const lens = options.exposure || 'credit';
  return <section className={styles.workspace} style={{'--accent':colors[lens]}} aria-label="Bank exposures">
    <nav className={styles.lenses} aria-label="Exposure lenses">{[['credit','Credit','Composition & performance'],['funding','Funding','Deposits & borrowing'],['securities','Securities','Cost, value & maturity']].map(([key,label,sub],i) => <Link key={key} href={href({exposure:key})} scroll={false} aria-current={lens===key?'page':undefined} style={{'--lens-color':colors[key]}}><span className={styles.lensNumber}>0{i+1}</span><span><strong>{label}</strong><small>{sub}</small></span><span className={styles.arrow} aria-hidden="true">↗</span></Link>)}</nav>
    <div className={styles.identity}><span><i/>SELECTED BANK <strong>{bankName}</strong></span><span>{quarterLabel(period)} · Quarter-end · USD</span></div>
    {error ? <div className={styles.empty} role="alert"><p>{error}</p><button onClick={()=>setRetry(n=>n+1)}>Retry exposure details</button></div> : !data ? <div className={styles.loading} role="status"><span/>Reading the bank’s reported exposures…</div> : !report ? <div className={styles.empty}>No validated exposure details for this quarter. Choose a prepared reporting period.</div> : <>
      {data.missing.length>0 && <p className={styles.coverage} role="status">History unavailable: {data.missing.map(quarterLabel).join(', ')}. Charts preserve the gaps. <button onClick={()=>setRetry(n=>n+1)}>Retry history</button></p>}
      {lens==='credit' && <Credit data={data} report={report} segment={options.segment} onSelect={segment=>onChange({segment})}/>}
      {lens==='funding' && <Funding data={data} report={report}/>}
      {lens==='securities' && <Securities data={data} report={report}/>}
      <Audit data={data} report={report} lens={lens}/>
    </>}
  </section>;
}

function Heading({eyebrow,title,meta}) { return <div className={styles.heading}><div><span className={styles.eyebrow}>{eyebrow}</span><h3>{title}</h3></div>{meta&&<span className={styles.meta}>{meta}</span>}</div>; }
function Note({title='How to read this',children}) { return <details className={styles.note}><summary>{title}</summary>{children}</details>; }
function Composition({items,total,label,selected,onSelect}) {
  const sum = items.reduce((s,d)=>s+(d.value||0),0);
  const complete = finite(total) && total>0 && items.every(d=>finite(d.value)&&d.value>=0) && Math.abs(sum-total)<=5000;
  let offset=0;
  return <div className={styles.composition}>
    <div className={styles.ringWrap}><svg viewBox="0 0 270 230" role="img" aria-label={`${label}: ${money(total)}. ${complete?'Composition is listed below.':'A complete composition is unavailable.'}`}>
      <circle cx="135" cy="115" r="85" fill="none" stroke="#203043" strokeWidth="21"/>
      {complete&&items.map(d=>{const size=d.value/sum*100,start=offset;offset+=size;return <circle key={d.key} cx="135" cy="115" r="85" pathLength="100" fill="none" stroke={d.color} strokeWidth={selected===d.key?27:21} strokeDasharray={`${size} ${100-size}`} strokeDashoffset={-start} transform="rotate(-90 135 115)" opacity={!selected||selected===d.key?1:.47}><title>{d.label}: {money(d.value)} · {(d.value/total*100).toFixed(1)}%</title></circle>;})}
      <text x="135" y="100" textAnchor="middle" fill="#97acc3" fontSize="10" letterSpacing="1.3">{label.toUpperCase()}</text><text x="135" y="134" textAnchor="middle" fill="#edf4fc" fontSize="28" fontWeight="550">{money(total)}</text>
    </svg></div>
    {!complete&&<p className={styles.coverage}>{total===0?'No reported balance this quarter.':'Composition incomplete · see reported values below.'}</p>}
    <div className={styles.mixList} role={onSelect?'group':undefined} aria-label={onSelect?'Choose a loan category':undefined}>{items.map(d=>{
      const share=exposureRatio(d.value,total);
      const content=<><i style={{background:d.color}}/><span className={styles.mixName}>{d.label}<span className={styles.mixTrack}><span style={{width:`${finite(share)?Math.min(100,Math.max(0,share)):0}%`,background:d.color}}/></span></span><span className={styles.mixValue}>{money(d.value)}<small>{finite(share)?`${share.toFixed(1)}%`:'—'}</small></span></>;
      return onSelect?<button key={d.key} aria-pressed={selected===d.key} onClick={()=>onSelect(d.key)}>{content}</button>:<div key={d.key}>{content}</div>;
    })}</div>
  </div>;
}

function Credit({data,report,segment,onSelect}) {
  const selected=CREDIT_SEGMENTS.find(s=>s.key===segment)||CREDIT_SEGMENTS[1];
  const key=`loan_${selected.key}`, current=val(report,key), previous=data.reports.find(r=>r.period===priorExposurePeriod(report.period));
  const qualityKeys=['past30','past90','nonaccrual'].map(s=>`${selected.key}_${s}`);
  const qualitySeries=qualityKeys.map((key,i)=>({key,label:['30–89 days','90+ days','Nonaccrual'][i],color:['#f5bc68','#f58f9f','#ac9bff'][i]}));
  const qualityScope=report.values[qualityKeys[0]]?.scope;
  return <>
    <div className={styles.split}>
      <section className={styles.mixColumn}><Heading eyebrow="WHERE THE LOANS SIT" title="The credit portfolio" meta="Domestic offices"/>
        <Composition items={CREDIT_SEGMENTS.map(s=>({...s,value:val(report,`loan_${s.key}`)}))} total={val(report,'loan_total')} label="Loans & leases" selected={selected.key} onSelect={onSelect}/>
        <Note title="Portfolio definitions"><p>Choose a category to explore its balances and credit performance. Composition uses domestic-office loans and leases before credit-loss allowances, including held-for-sale loans. Other loans &amp; leases is the residual after the five named categories.</p><p>{selected.note}</p><p>CRE here includes owner-occupied property and multifamily loans, and excludes construction and farmland. It is not a regulatory CRE concentration calculation.</p></Note>
      </section>
      <section className={styles.focus} style={{'--accent':selected.color}} aria-label={`${selected.label} detail`}>
        <Heading eyebrow="CATEGORY SPOTLIGHT" title={selected.label} meta="Domestic balances"/>
        <div className={styles.heroValue}><strong>{money(current)}</strong><span>{pct(exposureChange(current,val(previous,key)))}<small>vs prior quarter</small></span></div>
        <TimeSeries points={history(data,[key])} series={[{key,label:'Loan balance',color:selected.color}]} label={`${selected.label} domestic loan balances`} height={180}/>
        {qualityScope?<>
          <div className={styles.qualityHeading}><h4>Credit performance</h4><span>{qualityScope}</span></div>
          <div className={styles.qualityMetrics}>{qualitySeries.map(s=><div key={s.key}><span><i style={{background:s.color}}/>{s.label}</span><strong>{money(val(report,s.key))}</strong></div>)}</div>
          <TimeSeries points={history(data,qualityKeys)} series={qualitySeries} label={`${selected.label} credit performance · ${qualityScope}`} height={165}/>
          <Note title="Credit performance basis"><p>30–89 and 90+ day balances are still accruing. Nonaccrual is a separate status; these are quarter-end stocks, not new defaults or loss rates.</p><p>{report.form==='031'&&['commercial','consumer'].includes(selected.key)?'On Form 031, C&I and consumer performance covers all offices, while the portfolio and balance chart above cover domestic offices. No delinquency ratio is calculated across these different scopes.':'These performance categories and the loan balance above both cover domestic offices.'}</p><p>Missing periods remain gaps. Percentage growth requires a positive prior-quarter balance.</p></Note>
        </>:<div className={styles.empty}>Category-level delinquency cannot be isolated consistently for this residual. Select a named loan category to explore its credit performance.</div>}
      </section>
    </div>
  </>;
}

function Funding({data,report}) {
  const highlights=[{key:'uninsured',label:'Reported uninsured estimate',color:'#f5bc68'},{key:'brokered',label:'Brokered deposits',color:'#ac9bff'},{key:'fhlb_total',label:'FHLB advances',color:'#71d8b3'}];
  return <>
    <div className={styles.split}>
      <section className={styles.mixColumn}><Heading eyebrow="THE DEPOSIT BASE" title="How the bank is funded" meta="Domestic deposits"/>
        <Composition items={deposits.map(d=>({...d,value:val(report,d.key)}))} total={val(report,'deposits')} label="Deposits"/>
        {report.form==='031'&&<div className={styles.foreign}><span>Foreign-office deposits · separate</span><strong>{money(val(report,'foreign_deposits'))}</strong></div>}
        <Note title="Deposit definitions"><p>The five composition categories are mutually exclusive. Transaction accounts include demand deposits; money-market and other savings are nontransaction accounts as reported. The $250k split describes time-deposit account size, not insurance coverage.</p><p>Brokered and uninsured balances overlap these categories and each other. They are shown separately, never added to the composition.</p></Note>
      </section>
      <section className={styles.focus}>
        <Heading eyebrow="WHEN FUNDING CAN RESET" title="Maturity & repricing"/>
        <Ladder title="Time deposits" scope="Domestic offices · remaining maturity / next repricing" rows={['≤ 3 months','3–12 months','1–3 years','> 3 years'].map((label,i)=>({label,value:val(report,`time_maturity_${i}`),color:'#65c9ef'}))}/>
        <Ladder title="FHLB advances" scope={`${report.form==='031'?'All offices':'Domestic offices'} · remaining maturity / next repricing`} rows={['≤ 1 year','1–3 years','3–5 years','> 5 years'].map((label,i)=>({label,value:val(report,`fhlb_${i}`),color:'#71d8b3'}))}/>
        <Note title="What the ladder shows"><p>Fixed-rate balances use remaining maturity; floating-rate balances use their next repricing date. Repricing does not necessarily mean funding leaves the bank. Each ladder has its own dollar scale and reported buckets.</p><p>These are reported timing exposures, not forecast cash outflows or a liquidity stress test. Unused borrowing capacity, collateral availability and deposit behavior are not inferred.</p></Note>
      </section>
    </div>
    <div className={styles.metricStrip}>{highlights.map(s=><article key={s.key} style={{'--accent':s.color}}><span className={styles.eyebrow}>{s.key==='fhlb_total'?'BORROWED FUNDING':'DEPOSIT CHARACTERISTIC'}</span><h4>{s.label}</h4><strong className={styles.statValue}>{money(val(report,s.key))}</strong><span className={styles.meta}>{s.key==='fhlb_total'?(report.form==='031'?'Consolidated bank · all offices':'Domestic offices'):'Domestic offices'}</span><TimeSeries points={history(data,[s.key])} series={[s]} label={`${s.label} over time`} height={155}/></article>)}</div>
    <Note title="Uninsured estimate & availability"><p>Uninsured deposits are the bank’s reported RC-O estimate, including related accrued and unpaid interest. The item is required for banks meeting the form’s $1 billion prior-June asset test. A missing estimate is unavailable, never zero or inferred from account size.</p><p>FHLB advances sum the four RC-M maturity/repricing buckets. The separate short-maturity and structured-advance memoranda are not added again.</p></Note>
  </>;
}

function Securities({data,report}) {
  const max=Math.max(1,...['htm_cost','htm_fair','afs_cost','afs_fair'].map(k=>val(report,k)||0));
  const scope=report.values.htm_cost.scope;
  const maturitySeries=[{key:'other',label:'Other debt & eligible pass-throughs',color:'#65c9ef'},{key:'pass',label:'Residential mortgage pass-throughs',color:'#ac9bff'}];
  return <>
    <Heading eyebrow="THE PRICE OF THE PORTFOLIO" title="Cost meets market value" meta={scope}/>
    <div className={styles.valuationGrid}>{[['htm','Held to maturity','#65c9ef'],['afs','Available for sale','#ac9bff']].map(([key,label,color])=>{
      const cost=val(report,`${key}_cost`),fair=val(report,`${key}_fair`),gap=val(report,`${key}_gap`);
      return <article key={key} className={styles.valuation} style={{'--accent':color}}><div className={styles.portfolioLabel}><span>{key.toUpperCase()}</span><h4>{label}</h4></div><div className={styles.valuationBars}>{[['Amortized cost',cost,.45],['Fair value',fair,1]].map(([label,value,opacity])=><div key={label}><div><span>{label}</span><strong>{money(value)}</strong></div><div className={styles.barTrack}><i style={{width:`${finite(value)?value/max*100:0}%`,background:color,opacity}}/></div></div>)}</div><div className={styles.gapValue}><strong style={{color:gap<0?'#f58f9f':'#71d8b3'}}>{money(gap)}</strong><span>Fair value less cost<small>{pct(exposureRatio(gap,cost))} of amortized cost</small></span></div></article>;
    })}</div>
    <div className={styles.securitiesGrid}>
      <section><Heading eyebrow="VALUATION THROUGH TIME" title="The fair-value gap" meta="USD · fair value − cost"/>
        <TimeSeries points={history(data,['htm_gap','afs_gap'])} series={[{key:'htm_gap',label:'HTM gap',color:'#65c9ef'},{key:'afs_gap',label:'AFS gap',color:'#ac9bff'}]} label="HTM and AFS fair-value gaps over time" height={230}/>
        <Legend series={[{label:'Held to maturity',color:'#65c9ef'},{label:'Available for sale',color:'#ac9bff'}]}/>
        <Note title="Valuation, accounting & capital"><p>Fair value less amortized cost is a signed valuation difference; a negative value indicates a shortfall. HTM amortized cost here is the RC-B amount before the credit-loss allowance, not the net balance-sheet carrying amount.</p><p>This difference is not a realized loss, an AOCI reconciliation or an automatic deduction from regulatory capital. Taxes, allowances, hedges, accounting treatment and capital elections matter. Debt securities held for trading and equity securities are excluded.</p></Note>
      </section>
      <section><Heading eyebrow="THE TIMING PROFILE" title="Maturity & repricing" meta="HTM cost + AFS fair value"/>
        <MaturityBars report={report} series={maturitySeries}/><Legend series={maturitySeries}/>
        <div className={styles.lifeRow}><h4>Other mortgage-backed securities</h4><span>Expected average life · separate basis</span><Ladder rows={[{label:'≤ 3 years',value:val(report,'mbs_life_short'),color:'#f5bc68'},{label:'> 3 years',value:val(report,'mbs_life_long'),color:'#f5bc68'}]}/></div>
        <Note title="Timing coverage & definitions"><p>The six buckets use remaining maturity for fixed-rate debt and next repricing for floating-rate debt. Residential pass-throughs here are backed by closed-end first-lien 1–4 family mortgages; the other category follows RC-B M2.a, including other eligible pass-through securities.</p><p>Other MBS use expected average life in two separate buckets. They are not added to the six-bucket ladder. Timing data exclude nonaccrual securities and combine HTM amortized cost with AFS fair value. They are neither duration estimates nor a cash-flow or rate-shock forecast.</p></Note>
      </section>
    </div>
  </>;
}

function Legend({series}) { return <div className={styles.legend}>{series.map(s=><span key={s.label}><i style={{background:s.color}}/>{s.label}</span>)}</div>; }
function Ladder({title,scope,rows}) {
  const max=Math.max(1,...rows.map(r=>finite(r.value)?r.value:0));
  return <div className={styles.ladder}>{title&&<div className={styles.ladderTitle}><h4>{title}</h4><span>{scope}</span></div>}{rows.map(r=><div className={styles.ladderRow} key={r.label}><span>{r.label}</span><div className={styles.barTrack}><i style={{width:`${finite(r.value)?r.value/max*100:0}%`,background:r.color}}/></div><strong>{money(r.value)}</strong></div>)}</div>;
}
function MaturityBars({report,series}) {
  const rows=['≤ 3m','3–12m','1–3y','3–5y','5–15y','> 15y'].map((label,i)=>({label,parts:series.map(s=>({...s,value:val(report,`securities_${s.key}_${i}`)}))}));
  const max=Math.max(1,...rows.map(r=>r.parts.reduce((s,p)=>s+(p.value||0),0)));
  return <div className={styles.maturityBars}>{rows.map(r=>{const complete=r.parts.every(p=>finite(p.value));return <div key={r.label}><span>{r.label}</span><div className={styles.stackedTrack}>{r.parts.map(p=><i key={p.key} style={{width:`${finite(p.value)?p.value/max*100:0}%`,background:p.color}}><span className={styles.srOnly}>{p.label}: {money(p.value)}</span><span className={styles.barTip}>{p.label}: {money(p.value)}</span></i>)}</div><strong>{complete?money(r.parts.reduce((s,p)=>s+p.value,0)):'Incomplete'}</strong></div>;})}</div>;
}

function TimeSeries({points,series,label,height=185}) {
  const [active,setActive]=useState(null);
  const all=points.flatMap(p=>series.map(s=>p[s.key])).filter(finite);
  if (!all.length) return <div className={styles.noChart}>No reported values in the available periods.</div>;
  const min=Math.min(0,...all),max=Math.max(0,...all),span=max-min||1;
  const top=12,bottom=height-33,left=55,right=446;
  const x=i=>points.length<2?(left+right)/2:left+i/(points.length-1)*(right-left),y=v=>bottom-(v-min)/span*(bottom-top);
  return <div className={styles.timeSeries}>
    <svg viewBox={`0 0 460 ${height}`} role="img" aria-label={`${label}. ${points.map(p=>`${quarterLabel(p.period)}: ${series.map(s=>`${s.label} ${money(p[s.key])}`).join(', ')}`).join('; ')}`}>
      {[min,min+span/2,min+span].map((v,i)=><g key={i}><line x1={left} x2={right} y1={y(v)} y2={y(v)} stroke="#28394d" strokeDasharray={v===0?undefined:'2 5'}/><text x={left-9} y={y(v)+3} fill="#8fa5c0" textAnchor="end" fontSize="10">{all.every(v=>v===0)&&i>0?'':money(v)}</text></g>)}
      {series.map(s=>points.map((p,i)=>finite(p[s.key])&&<g key={s.key+p.period}>
        {i>0&&finite(points[i-1][s.key])&&<line x1={x(i-1)} x2={x(i)} y1={y(points[i-1][s.key])} y2={y(p[s.key])} stroke={s.color} strokeWidth="2.5"/>}
        <circle cx={x(i)} cy={y(p[s.key])} r="4.3" fill={s.color} stroke="#0b1019" strokeWidth="2"><title>{quarterLabel(p.period)} · {s.label}: {money(p[s.key])}</title></circle>
      </g>))}
      {points.map((p,i)=><g key={p.period}><rect x={x(i)-17} y={top} width="34" height={bottom-top+5} fill="transparent" tabIndex="0" role="button" aria-label={`${quarterLabel(p.period)}: ${series.map(s=>`${s.label} ${money(p[s.key])}`).join(', ')}`} onMouseEnter={()=>setActive(p.period)} onMouseLeave={()=>setActive(null)} onFocus={()=>setActive(p.period)} onBlur={()=>setActive(null)} onClick={()=>setActive(p.period)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setActive(p.period);}}}/><text x={x(i)} y={height-8} fill="#99afc9" textAnchor={i===0?'start':i===points.length-1?'end':'middle'} fontSize="10">{quarterLabel(p.period)}</text></g>)}
    </svg>
    <div className={styles.chartReadout} aria-live="polite">{active?<><b>{quarterLabel(active)}</b>{series.map(s=><span key={s.key} style={{color:s.color}}>{s.label} {money(points.find(p=>p.period===active)?.[s.key])}</span>)}</>:<span>Hover or focus a quarter for values</span>}</div>
  </div>;
}

function Audit({data,report,lens}) {
  const rows=Object.entries(report.values).filter(([,m])=>m.group===lens);
  const codes=[...new Set(rows.flatMap(([,m])=>m.codes))];
  return <div className={styles.audit}>
    <details><summary>Exact figures &amp; period comparison <span>USD millions · {rows.length} measures</span></summary><div className={styles.tableWrap} tabIndex="0" role="region" aria-label="Exposure figures"><table><caption>{lens} · Quarter-end USD millions · Missing values are unavailable</caption><thead><tr><th>Measure / reporting scope</th>{data.periods.map(p=><th key={p}>{quarterLabel(p)}</th>)}</tr></thead><tbody>{rows.map(([key,m])=><tr key={key}><th scope="row">{m.label}<small>{m.scope} · {m.schedule}</small></th>{data.periods.map(p=>{const r=data.reports.find(r=>r.period===p),v=val(r,key);return <td key={p} title={r?.values[key]?.reason||undefined}>{finite(v)?(v/1e6).toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3}):'Unavailable'}</td>;})}</tr>)}</tbody></table></div></details>
    <details><summary>Definitions, source fields &amp; original reports</summary><p>Figures come from the selected legal bank’s FFIEC Call Reports. History uses the latest validated stored submission for each available quarter up to the selected date. Missing, nil, inconsistent-unit and out-of-basis facts are not imputed. No peer-group values appear in this view.</p><p>Monetary values are read in XBRL USD; the exact table converts to millions. Chart labels use compact dollars. Codes beginning RCON cover domestic offices, RCFD the consolidated bank, and RCFN foreign offices. Form differences are applied explicitly.</p><div className={styles.tableWrap} tabIndex="0" role="region" aria-label="Metric source mappings"><table><thead><tr><th>Measure</th><th>Source / calculation</th></tr></thead><tbody>{rows.map(([k,m])=><tr key={k}><th>{m.label}</th><td>{m.formula||m.codes.join(' + ')}<small>{m.schedule} · {m.scope}{m.reason?` · ${m.reason.replaceAll('_',' ')}`:''}</small></td></tr>)}</tbody></table></div><details className={styles.rawFacts}><summary>Selected-quarter XBRL facts</summary>{codes.map(code=>{const f=report.facts[code];return <p key={code}><code>{code}</code> = {f?.rawValue??'Unavailable'} {f?.unit} · context {f?.contextRef||'Unavailable'}{f?.reason?` · ${f.reason.replaceAll('_',' ')}`:''}{f?.contextNote?` · ${f.contextNote}`:''}</p>;})}</details>{data.reports.map(r=><div className={styles.sourceRow} key={r.period}><strong>{quarterLabel(r.period)} · FFIEC {r.form}</strong><a href={`/api/banks/source?${new URLSearchParams({rssd:String(r.rssd),period:r.period,hash:r.hash})}`} download>Original XBRL ↗</a><small>Retrieved {r.retrievedAt||'unavailable'} · Submission {r.submission||'unavailable'}</small><code>SHA-256 {r.hash}</code></div>)}<p><a href={`https://www.ffiec.gov/resources/reporting-forms/ffiec${report.form}`} target="_blank" rel="noreferrer">FFIEC {report.form} forms &amp; instructions ↗</a> · Mapping {report.mappingVersion}</p></details>
  </div>;
}
