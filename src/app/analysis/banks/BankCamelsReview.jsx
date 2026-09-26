'use client';
import { useState } from 'react';
import { CAMELS_DIMENSIONS,formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import { regulatoryContext,REGULATORY_SOURCES } from '../../../utils/bank/regulatoryContext.js';
import { quarterLabel } from '../../../utils/bank/viewModel.js';
import styles from './banks.module.css';
import BankMetricRows,{PeerLegend} from './BankMetricRows';

export default function BankCamelsReview({data,period,onExplore,history,historyPanel,onHistory}) {
  const [baseline,setBaseline]=useState('prior');
  const metrics=new Map(data.benchmarks.map(b=>[b.key,b]));
  const trends=new Map((history?.metrics||[]).map(m=>[m.key,m]));
  const context=regulatoryContext(data.bank,period);
  return <section className={styles.camelsReview} aria-label="CAMELS public-data review">
    <div className={styles.camelsIntro}><div><span className={styles.chartEyebrow}>SIX LENSES. ONE BANK.</span><h3>A CAMELS-style financial review</h3><p>Read across to compare the bank with its peer group. Follow both through the available quarters.</p></div></div>
    <p className={styles.camelsDisclosure}>Official CAMELS ratings are confidential supervisory assessments. This review uses public financial indicators; it does not assign component scores or a composite rating. Management and sensitivity require information beyond these filings.</p>
    {(data.assetBand===8||data.peers.length<10)&&<p className={styles.basis}>{data.assetBand===8?'The asset range was widened to ⅛–8× this bank’s size. ':''}{data.peers.length===0?'Peer medians are unavailable because matching inputs are incomplete.':data.peers.length<10?'Fewer than ten peers are available; interpret numeric ranks with care.':'Review the wider cohort when interpreting numeric ranks.'}</p>}
    <div className={styles.camelsHistoryControls}><PeerLegend/><label>History changes vs<select aria-label="CAMELS change baseline" value={baseline} onChange={e=>setBaseline(e.target.value)}><option value="prior">Prior quarter</option><option value="first">First available period</option></select></label></div>
    <p className={styles.basis}>{history?.periods.length?`${quarterLabel(history.periods[0])} → ${quarterLabel(period)} · `:''}Solid cyan tracks the bank; dashed lavender tracks the same peer group. Select a metric to explore its history.</p>
    <div className={styles.camelsSections}>{CAMELS_DIMENSIONS.map(d=><section className={styles.camelsSection} key={d.key} style={{'--accent':d.color}} aria-label={d.label}>
      <header><span className={styles.camelsLetter} aria-hidden="true">{d.letter}</span><div><h4>{d.label}</h4><p>{d.note}</p></div><button onClick={()=>onExplore(d.key)}>All {d.shortLabel?.toLowerCase()||d.label.toLowerCase()} metrics →</button></header>
      <BankMetricRows metrics={d.keys.map(key=>metrics.get(key))} historyByKey={trends} bankName={data.bank.name} peerCount={data.peers.length} onHistory={onHistory} baseline={baseline}/>
    </section>)}</div>
    <p className={styles.basis}>P0–P100 is the bank’s numeric percentile within reported peers. Changes are in basis points (100 bp = 1 percentage point), not percentage growth. Direction is not a quality score. CBLR electors are excluded from risk-based capital distributions.</p>
    {historyPanel}
    <CapitalReferences context={context} period={period} bankName={data.bank.name}/>
    <details className={styles.audit}><summary>Regulatory context, limitations &amp; sources</summary><div className={styles.regulatoryNotes}><article><h4>Liquidity &amp; rate risk</h4><p>LCR and NSFR require eligible liquid assets, stressed cash flows and stable-funding inputs, with applicability that varies by institution. They cannot be reconstructed from cash / assets or loans / deposits.</p><p>A long-term asset share is not a rate-shock estimate. Economic value of equity, net interest income sensitivity, deposit assumptions and hedges require additional disclosures.</p></article><article><h4>Basel in U.S. context</h4><p>The chart uses general U.S. bank capital references implementing Basel standards. Holding-company stress capital buffers and GSIB surcharges are not automatically the bank’s requirements.</p><p>Supplementary leverage, countercyclical buffers, institution-specific requirements, supervisory orders and transition provisions can change the applicable constraint. These are reference comparisons, not compliance findings.</p></article></div><p>Sources reviewed September 25, 2026. The selected report date determines the CBLR reference. Other capital references cover the retained reporting history from 2022 onward. Proposals are not treated as effective rules. The 2026 CAMELS proposal retains the six-component structure; this page does not apply proposed supervisory scoring changes.</p><p>CBLR election is read from the selected quarter’s FDIC CBLRIND indicator (1 elected, 0 not elected); size alone is never used to assign the framework. Numeric PCA references do not establish a “well capitalized” supervisory category, which also depends on orders and other conditions.</p><ul>{REGULATORY_SOURCES.map(s=><li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.label} ↗</a></li>)}</ul></details>
  </section>;
}

function CapitalReferences({context:c,period,bankName}) {
  const [reference,setReference]=useState('minimum');
  const cblr=c.framework==='cblr';
  const active=cblr?'minimum':reference;
  const max=Math.ceil(Math.max(12,...c.rows.flatMap(r=>[r.value||0,r.minimum,r.buffer||0,r.pca||0]))/5)*5;
  const refKey=active==='minimum'?'minimum':active==='buffer'?'buffer':'pca';
  const refLabel=cblr?'CBLR election threshold':active==='minimum'?'General minimum':active==='buffer'?'Minimum + 2.5 pp base buffer':'PCA well-capitalized numeric reference';
  return <section className={styles.capitalReferences} aria-label="Capital regulatory references">
    <div className={styles.sectionHeading}><div><span className={styles.chartEyebrow}>INDIVIDUAL BANK VS REGULATORY REFERENCES</span><h3>Capital in context</h3><p className={styles.capitalBankName}>{bankName}</p><p className={styles.basis}>{quarterLabel(period)} · Ratios in percent · References are regulatory thresholds, not peer statistics.</p></div><span className={styles.frameworkBadge}>{cblr?'CBLR elected':c.framework==='risk_based'?'Risk-based capital framework':'Framework unverified'}</span></div>
    {!c.rows.length?<p className={styles.notice}>A verified capital framework and a supported reporting date are required before showing reference comparisons.</p>:<>
      {cblr?<p className={styles.basis}>The election threshold for this quarter is <strong>greater than {c.cblr.threshold}%</strong>. It changed from &gt;9% to &gt;8% on July 1, 2026. Risk-based capital ratios are not required for qualifying CBLR electors.</p>:<div className={styles.metricFilters} role="group" aria-label="Capital reference"><button aria-pressed={active==='minimum'} onClick={()=>setReference('minimum')}>Minimums</button><button aria-pressed={active==='buffer'} onClick={()=>setReference('buffer')}>Base buffer</button><button aria-pressed={active==='pca'} onClick={()=>setReference('pca')}>PCA numeric</button></div>}
      <p className={styles.capitalLegend}><span>━ {bankName}</span><span>┆ {refLabel}</span><span>Common upper bound: {max}%</span></p>
      <div className={styles.capitalRows}>{c.rows.map(r=>{const ref=r[refKey],gap=r.value!=null&&ref!=null?(r.value-ref)*100:null;
        const gapText=gap==null?'No comparison available':`${gap>0?'+':''}${Math.round(gap).toLocaleString('en-US')} bp to ${cblr?'election threshold':'reference'}`;
        const min=Math.min(0,r.value||0),scale=n=>10+(n-min)/(max-min)*580;
        return <article key={r.key} className={styles.capitalRow}><div><h4>{r.label}</h4><strong>{pct(r.value)}</strong></div>
          <svg viewBox="0 0 600 32" role="img" aria-label={`${bankName}. ${r.label}: ${pct(r.value)}. ${refLabel}: ${ref==null?'not applicable':`${cblr?'>':''}${pct(ref)}`}. ${gapText}.`}><rect x="10" y="10" width="580" height="10" rx="5" fill="#24354b"/>{r.value!=null&&<rect x={Math.min(scale(0),scale(r.value))} y="10" width={Math.max(1,Math.abs(scale(r.value)-scale(0)))} height="10" rx="5" fill="var(--bank-color)"/>}{ref!=null&&<line x1={scale(ref)} x2={scale(ref)} y1="2" y2="28" stroke="#f2f6fc" strokeWidth="2" strokeDasharray="3 2"/>}</svg>
          <p><span>{ref==null?'No conservation buffer reference for leverage':`${refLabel}: ${cblr?'>':''}${pct(ref)}`}</span><span>{gapText}{cblr&&gap===0?' · Strictly greater required':''}</span></p>
        </article>;
      })}</div>
      {cblr?<p className={styles.regulatoryCaveat}>Qualification also requires assets below $10 billion and other eligibility conditions. A limited {c.cblr.graceQuarters}-quarter grace period may apply if leverage remains greater than {c.cblr.graceFloor}%;{c.cblr.graceQuarters===4?' the new rule also limits grace-period use over a five-year window;':''} entry, exit and merger conditions matter. The current ratio alone cannot establish eligibility or grace-period status.</p>:<p className={styles.regulatoryCaveat}>{active==='buffer'?'The 2.5 percentage point base conservation buffer is above each risk-based minimum. Exceeding this reference alone does not establish unrestricted distribution capacity; additional buffers and other constraints may apply.':active==='pca'?'These are only the numeric tests for PCA “well capitalized.” Supervisory orders and other conditions can change the actual category; no category is assigned here.':'General minimums are 4.5% CET1, 6% Tier 1 risk-based, 8% total risk-based and 4% Tier 1 leverage. Meeting these does not establish adequate capital for this bank’s particular risks.'} 100 basis points (bp) = 1 percentage point.</p>}
    </>}
  </section>;
}
