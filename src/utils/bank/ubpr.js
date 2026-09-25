import { XMLParser,XMLValidator } from 'fast-xml-parser';
import { BankDataError } from './errors.js';
export const UBPR_VERSION='ubpr-1';
export const UBPR_METRICS=[
  {key:'roa',code:'UBPRE013',label:'Return on average assets',basis:'Annualized net income / average assets.'},
  {key:'nim',code:'UBPRE018',label:'Net interest margin · tax equivalent',basis:'Annualized tax-equivalent net interest income / average earning assets.'},
  {key:'leverage',code:'UBPRD486',label:'Tier 1 leverage ratio',basis:'FFIEC leverage ratio from Call Report schedule RC-R.'},
  {key:'noncurrent',code:'UBPR7414',label:'Noncurrent loans / gross loans',basis:'90+ days past due and nonaccrual loans / gross loans.'},
  {key:'chargeoffs',code:'UBPRE019',label:'Net losses / average loans',basis:'Annualized net loan losses / average loans.'},
];
const list=x=>x==null?[]:Array.isArray(x)?x:[x];
const value=x=>typeof x==='object'?x?.['#text']:x;
const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,parseAttributeValue:false,trimValues:true,processEntities:false});
export function parseUbprXbrl(xml,{rssd,period}){
  if(Buffer.byteLength(xml)>8*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new BankDataError('ubpr_parsing_failure');
  const root=parser.parse(xml).xbrl;if(!root)throw new BankDataError('ubpr_parsing_failure');
  const contexts=new Set(),units=new Map();
  for(const c of list(root.context)){
    if(String(value(c.entity?.identifier))===String(rssd)&&value(c.period?.instant)===period&&!c.scenario&&!c.entity?.segment)contexts.add(c['@_id']);
  }
  if(!contexts.size)throw new BankDataError('source_identity_period_mismatch');
  for(const u of list(root.unit))units.set(u['@_id'],String(value(u.measure)||'').split(':').at(-1));
  function fact(code,unit){
    const candidates=list(root[code]).filter(n=>contexts.has(n['@_contextRef']));
    if(!candidates.length)return null;
    if(new Set(candidates.map(n=>JSON.stringify([value(n),n['@_unitRef'],n['@_nil']]))).size!==1)throw new BankDataError('ubpr_conflicting_facts');
    const n=candidates[0],raw=String(value(n)??'').trim();
    if(['true','1'].includes(n['@_nil'])||units.get(n['@_unitRef'])!==unit||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)||!Number.isFinite(Number(raw)))return null;
    return {value:Number(raw),rawValue:raw,contextRef:n['@_contextRef'],unitRef:n['@_unitRef']};
  }
  if(!list(root.UBPR9999).some(n=>contexts.has(n['@_contextRef'])&&value(n)===period)||!(fact('UBPR2170','USD')?.value>0))throw new BankDataError('source_identity_period_mismatch');
  // UBPR computed ratios are already percentages. Call Report pure fractions use different scaling.
  const metrics=UBPR_METRICS.map(def=>({...def,...(fact(def.code,'pure')||{value:null}),unit:'percent'}));
  if(!metrics.some(m=>m.value!==null))throw new BankDataError('ubpr_ratios_unavailable');
  return {stage:'validated',parserVersion:UBPR_VERSION,rssd:Number(rssd),period,metrics,
    peerStatisticsAvailable:false,source:'FFIEC UBPR bank XBRL',schemaReferences:list(root.schemaRef).map(s=>s['@_href']).filter(Boolean)};
}
