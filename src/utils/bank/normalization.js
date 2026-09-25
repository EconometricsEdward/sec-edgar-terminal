import { BANK_METRICS } from './metrics.js';
import { pickFact } from './parser.js';
import { CALL_FORMS, SCOPE_MAPPING_VERSION } from './catalog.js';
import { BankDataError } from './errors.js';

const riskBased = new Set(['rwa','total_capital','cet1_ratio','tier1_ratio','total_capital_ratio']);
export function bankMetricDefinitions(form) {
  if (!CALL_FORMS.has(form)) throw new BankDataError('unsupported_call_report_form');
  return BANK_METRICS.map(original => {
    const d = {...original, codes:[...original.codes]};
    if (form !== '031') {
      d.codes = d.codes.map(c => c.replace(/^RCFD/,'RCON').replace(/^RCFA/,'RCOA'));
      if (d.basis === 'Consolidated bank; domestic and foreign offices') d.basis = 'Consolidated bank; domestic offices only';
      if (d.key === 'cet1') { d.codes=['RCOAP859']; d.operation=undefined; d.item='19'; d.basis='Common equity Tier 1 capital; domestic-only Call Report'; }
      if (d.key === 'deposits') { d.codes=['RCON2200']; d.operation=undefined; d.item='13.a'; d.basis='Total deposits; domestic-only bank'; }
      if (d.key === 'foreign_deposits') d.notApplicable='not_applicable_domestic_only_form';
      if (d.key === 'loans') d.item='12';
      if (d.key === 'brokered_deposits') d.schedule='RC-E';
      if (d.key === 'total_capital') d.item='47';
      if (d.key === 'rwa') d.item='48';
      if (d.unit === 'percent' && d.key !== 'leverage_ratio') d.item=d.item.replace(', column A','');
    }
    return d;
  });
}
function auditedFact(parsed,code,period) {
  const direct=pickFact(parsed,code,period);
  if (!['RCFDJJ34','RCONJJ34'].includes(code) || direct.value!==null) return direct;
  const duration=pickFact(parsed,code,'ytd'), gross=pickFact(parsed,code.slice(0,4)+'1754'), allowance=pickFact(parsed,'RIADJH93','ytd');
  if ([duration,gross,allowance].every(f=>f.value!==null&&/(^|:)USD$/i.test(f.unit)) && Math.abs(gross.value-allowance.value-duration.value)<=1000)
    return {...duration,contextNote:'Quarter-end HTM balance uses an FFIEC YTD context; reconciled to RC-B 8.A less RI-B II 7.B',corroboration:[gross,allowance]};
  return direct;
}
export function normalizeBankReport(parsed,{form,ingestedAt=new Date().toISOString()}={}) {
  const schemaForms=parsed.schemaReferences.map(s=>/report(031|041|051)\//i.exec(s)?.[1]).filter(Boolean);
  if (schemaForms.some(f=>f!==form)) throw new BankDataError('source_form_mismatch');
  const election=pickFact(parsed,form==='031'?'RCFALE74':'RCOALE74');
  const cblr=election.value===1 && /(^|:)pure$/i.test(election.unit);
  const capitalFramework=cblr?'CBLR':'risk_based';
  const metrics=bankMetricDefinitions(form).map(d=>{
    let facts=d.codes.map(c=>auditedFact(parsed,c,d.period));
    let reason=d.notApplicable || (cblr&&riskBased.has(d.key)?'not_required_under_cblr':null);
    if (!reason&&d.operation==='exclusive') { facts=facts.filter(f=>f.value!==null); if(facts.length!==1)reason=facts.length?'ambiguous_capital_column':'item_not_reported_on_required_basis'; }
    if (!reason&&facts.some(f=>f.value===null))reason=facts.find(f=>f.value===null).reason;
    if (!reason&&facts.some(f=>!(d.unit==='USD'?/(^|:)USD$/i.test(f.unit):/(^|:)pure$/i.test(f.unit))))reason='unsupported_source_unit';
    const value=reason?null:facts.reduce((n,f)=>n+f.value,0)*(d.unit==='percent'?100:1);
    return {...d,value,status:reason?(reason.startsWith('not_')?'not_applicable':'unavailable'):d.operation==='sum'?'calculated':'reported',reason,
      form,capitalFramework,reportDate:parsed.reportDate,startDate:d.period==='ytd'?`${parsed.reportDate.slice(0,4)}-01-01`:null,
      rssd:parsed.rssd,ingestedAt,mappingVersion:SCOPE_MAPPING_VERSION,formSource:`https://www.ffiec.gov/resources/reporting-forms/ffiec${form}`,
      sourceHash:parsed.sha256,lineage:facts,frameworkLineage:cblr?[election]:[],formula:d.operation==='sum'?d.codes.join(' + '):null};
  });
  return {metrics,capitalFramework,validation:validateBankReport(metrics,cblr)};
}
export function validateBankReport(metrics,cblr=false) {
  const v=Object.fromEntries(metrics.map(m=>[m.key,m.value])), checks=[];
  const check=(name,keys,predicate)=>checks.push({name,passed:keys.every(k=>v[k]!=null)&&predicate(...keys.map(k=>v[k])),inputs:Object.fromEntries(keys.map(k=>[k,v[k]]))});
  for(const k of ['assets','loans','deposits','equity','net_income','tier1','nonaccrual'])check(`${k}_reported`,[k],()=>true);
  check('balance_sheet_reconciles',['assets','liabilities','equity'],(a,l,e)=>Math.abs(a-l-e)<=2000);
  check('loans_reconcile',['loans','loans_hfs','loans_hfi'],(a,b,c)=>Math.abs(a-b-c)<=2000);
  check('net_interest_income_reconciles',['interest_income','interest_expense','net_interest_income'],(a,b,c)=>Math.abs(a-b-c)<=2000);
  if(!cblr) for(const [cap,ratio] of [['cet1','cet1_ratio'],['tier1','tier1_ratio'],['total_capital','total_capital_ratio']])check(`${ratio}_reconciles`,[cap,'rwa',ratio],(c,r,p)=>r>0&&Math.abs(c/r*100-p)<=.001);
  else check('cblr_leverage_reported',['leverage_ratio'],x=>Number.isFinite(x));
  return {passed:checks.every(c=>c.passed),capitalFramework:cblr?'CBLR':'risk_based',checks};
}
