import { universeResearchChecks } from '../../utils/marketUniverseChecks.js';
import s from './factorUniverse.module.css';

type Checks = ReturnType<typeof universeResearchChecks>;
type Props = { checks:Checks; onScreen:(screen:string)=>void };
const signed = (n:number|null) => n===null?'Unavailable':`${n>0?'+':''}${n.toFixed(1)}`;

export function FundamentalResearchChecks({checks,onScreen,onThreshold}:{
  checks:Checks;onScreen:Props['onScreen'];onThreshold:(n:number)=>void;
}) {
  const paired=checks.eligibility.find(x=>x.id==='paired')!.tickers.length;
  const balances=checks.sensitivity.map(x=>x.balance_pct).filter((x):x is number=>x!==null);
  const directions=new Set(balances.map(Math.sign));
  return <details className={s.panel}>
    <summary>Check sensitivity and missing comparisons · {paired} of {checks.population} issuers have pairs</summary>
    <h3>Does the conclusion depend on small changes?</h3>
    <p>Compare direction bands side by side on exactly the same issuers. Larger bands move small changes into neutral; they do not remove those companies or alter magnitude and dispersion.</p>
    <p>{balances.length?<>Net balance ranges from <b>{signed(Math.min(...balances))} to {signed(Math.max(...balances))} percentage points</b>. {directions.size===1?(balances[0]>0?'Higher changes outnumber lower changes at every tested band.':balances[0]<0?'Lower changes outnumber higher changes at every tested band.':'Higher and lower counts balance at every tested band.'):'The direction balance changes sign or reaches zero under at least one tested band.'}</>:'No comparable pairs are available, so direction-band sensitivity cannot be assessed.'}</p>
    <div className={s.tableWrap}><table><caption>Selected financial measure · net balance in percentage points</caption><thead><tr><th>Direction band</th><th>Higher</th><th>Lower</th><th>Neutral</th><th>Paired issuers</th><th>Net balance</th></tr></thead><tbody>{checks.sensitivity.map(row=><tr key={row.threshold}><th><button className={s.textButton} onClick={()=>onThreshold(row.threshold)}>{row.threshold===0?'All measured changes':`Outside ±${row.threshold} points`}</button></th><td>{row.higher}</td><td>{row.lower}</td><td>{row.neutral}</td><td>{row.eligible}</td><td>{signed(row.balance_pct)}</td></tr>)}</tbody></table></div>
    <p>A balance that approaches zero or changes sign under a wider band needs a more qualified interpretation. Agreement across these bands is descriptive sensitivity evidence, not a statistical significance test.</p>
    <h3>Who is absent from this calculation?</h3>
    <p>Missing comparisons are not zero changes. Excluded issuer types use different accounting structures; they are separate from missing data.</p>
    <div className={s.actions}>{checks.eligibility.map(item=><button key={item.id} className={s.button} disabled={!item.tickers.length} onClick={()=>onScreen(`eligibility:${item.id}`)}>{item.id==='paired'?'Comparable pairs':item.id==='missing'?'Missing comparisons':'Excluded issuer types'}: {item.tickers.length}</button>)}</div>
    <p className={s.caption}>These three groups partition the selected scope. Inspect missing issuers in the table for their supplied reason codes; no missing financial values are filled in.</p>
  </details>;
}

export function BetaResearchChecks({checks,onScreen}:Props) {
  return <details className={s.panel}><summary>How much uncertainty is behind the beta estimates?</summary>
    <p>Classify each company using its 95% HAC interval, not just the fitted slope. An interval including 1 does not distinguish the slope from 1 at this interval level; an interval including 0 leaves its direction uncertain.</p>
    <div className={s.tableWrap}><table><caption>{checks.population} issuers in scope · mutually exclusive interval groups</caption><thead><tr><th>Interval reading</th><th>Companies</th><th>Share of scope</th></tr></thead><tbody>{checks.beta.map(item=><tr key={item.id}><th>{item.label}</th><td><button className={s.textButton} disabled={!item.tickers.length} onClick={()=>onScreen(`beta:${item.id}`)}>{item.tickers.length}</button></td><td>{checks.population?`${(100*item.tickers.length/checks.population).toFixed(1)}%`:'Unavailable'}</td></tr>)}</tbody></table></div>
    <p>HAC intervals allow for heteroskedasticity and serial correlation in model errors. They are uncertainty intervals for historical slopes, not ranges for tomorrow’s returns. These are individual intervals without adjustment for comparing many companies. Negative beta is an inverse fitted relationship, not a low-risk label.</p>
    <p className={s.caption}>Intervals touching 0 enter “includes 0”; otherwise those touching 1 enter “includes 1.” Unavailable includes missing price models and invalid or missing intervals. Select a count to inspect individual estimates and bounds.</p>
  </details>;
}
