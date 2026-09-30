'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Building2, CalendarRange, ChartNoAxesCombined, FileSearch, Network } from 'lucide-react';
import { buildRiskProfilePresentation } from './riskProfilePresentation.js';
import type { RiskData, RiskProfile } from './riskTypes';
import s from './RiskEvidenceWorkspace.module.css';

const MaturityEvidence = dynamic(() => import('./RiskIntelligence').then(m => m.MaturityEvidence));
const BankEvidence = dynamic(() => import('./RiskBankEvidence'));
const MarketEvidence = dynamic(() => import('./RiskMarketEvidence'));
const RiskNoteEvidence = dynamic(() => import('./RiskNoteEvidence'));
const RiskProfileMarketContext = dynamic(() => import('./RiskProfileMarketContext'));
export type RiskEvidenceId = 'maturities' | 'bank' | 'notes' | 'markets' | 'connections';
const CATALOG = [
  {id:'maturities',label:'Debt timeline',source:'SEC annual filing',description:'Contractual principal maturities, annual cash measures and the exact filing date.',Icon:CalendarRange},
  {id:'notes',label:'Credit & currency notes',source:'SEC filing notes',description:'Reported credit concentration and derivative contract amounts. Read the scope before comparing.',Icon:FileSearch},
  {id:'bank',label:'Bank Call Reports',source:'FFIEC legal-bank reports',description:'Select a regulated legal bank for capital, credit quality and funding evidence. SEC parent figures remain separate.',Icon:Building2},
  {id:'markets',label:'Funding & swaps',source:'New York Fed · CFTC · DTCC references',description:'Market funding conditions, settlement frictions and aggregate swaps activity around the issuer.',Icon:ChartNoAxesCombined},
  {id:'connections',label:'CFTC connections',source:'SEC disclosures · CFTC positioning',description:'Connect disclosed company exposures to relevant market positioning, with the filing evidence and benchmark fit visible.',Icon:Network},
] as const;

export default function RiskEvidenceWorkspace({data,profile,selection,onSelect,cftcEnabled,asOf=''}:{data:RiskData;profile:RiskProfile;selection:RiskEvidenceId;onSelect:(id:RiskEvidenceId)=>void;cftcEnabled:boolean;asOf?:string}) {
  const companyType = buildRiskProfilePresentation(profile,data).lens.id;
  const bank = companyType === 'bank';
  const choices = CATALOG.filter(item => (item.id !== 'bank' || bank) && (item.id !== 'connections' || cftcEnabled));
  const active = choices.find(item => item.id === selection) || choices[0];
  const [visited,setVisited] = useState<RiskEvidenceId[]>([]);
  useEffect(() => { setVisited(previous => previous.includes(active.id) ? previous : [...previous,active.id]); },[active.id]);
  const mounted = (id:RiskEvidenceId) => active.id === id || visited.includes(id);
  const title = active.id === 'markets' && !cftcEnabled ? 'Funding markets' : active.label;
  const source = active.id === 'markets' && !cftcEnabled ? 'New York Fed · DTCC references' : active.source;
  function navigateSource(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(key)) return;
    event.preventDefault();
    const next = key === 'Home' ? 0 : key === 'End' ? choices.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
    onSelect(choices[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return <section id="risk-connected-evidence" className={s.workspace} aria-label="Connected risk evidence">
    <header className={s.heading}><div><span>CONNECTED EVIDENCE</span><h2>Source workspace</h2></div><span className={s.count}>{choices.length} sources</span></header>
    <div className={s.tabs} role="tablist" aria-label="Supporting risk sources">{choices.map((item,index) => <button key={item.id} id={'risk-source-tab-'+item.id} role="tab" tabIndex={active.id === item.id ? 0 : -1} onKeyDown={event=>navigateSource(event,index)} aria-selected={active.id === item.id} aria-controls={'risk-source-panel-'+item.id} onClick={()=>onSelect(item.id)}><item.Icon size={16}/>{item.id === 'markets' && !cftcEnabled ? 'Funding markets' : item.label}</button>)}</div>
    <div className={s.scope}><span className={s.sourceChip}>{source}</span><details key={active.id} className={s.scopeDetails}><summary>Scope & coverage</summary><strong>{title}</strong><p>{active.id === 'markets' && !cftcEnabled ? 'Prepared funding rates and Treasury settlement fails. DTCC charts open at the publisher.' : active.description}</p><p>Each source keeps its own entity, reporting date and coverage.</p></details></div>
    <div className={s.panelBody}>
      {mounted('maturities') && <div role="tabpanel" id="risk-source-panel-maturities" aria-labelledby="risk-source-tab-maturities" hidden={active.id !== 'maturities'}><MaturityEvidence key={data.cik} data={data} financial={companyType !== 'corporate'}/></div>}
      {mounted('notes') && <div role="tabpanel" id="risk-source-panel-notes" aria-labelledby="risk-source-tab-notes" hidden={active.id !== 'notes'}><RiskNoteEvidence key={data.ticker+':'+profile.basis+':'+asOf} ticker={data.ticker} basis={profile.basis} asOf={asOf}/></div>}
      {bank && mounted('bank') && <div role="tabpanel" id="risk-source-panel-bank" aria-labelledby="risk-source-tab-bank" hidden={active.id !== 'bank'}><BankEvidence key={data.cik} companyName={data.companyName} ticker={data.ticker} companyPeriod={profile.periods[0]?.end || ''}/></div>}
      {mounted('markets') && <div role="tabpanel" id="risk-source-panel-markets" aria-labelledby="risk-source-tab-markets" hidden={active.id !== 'markets'}><MarketEvidence ticker={data.ticker} companyType={companyType} cftcEnabled={cftcEnabled}/></div>}
      {cftcEnabled && mounted('connections') && <div role="tabpanel" id="risk-source-panel-connections" aria-labelledby="risk-source-tab-connections" hidden={active.id !== 'connections'}><RiskProfileMarketContext key={data.ticker+':'+profile.basis+':'+asOf} ticker={data.ticker} companyName={data.companyName} basis={profile.basis === 'annual' ? 'annual' : 'ttm'} asOf={asOf} companyType={companyType}/></div>}
    </div>
  </section>;
}
