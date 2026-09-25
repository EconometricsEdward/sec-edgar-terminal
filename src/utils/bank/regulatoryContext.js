/** Dated, general U.S. legal-bank references. Never a supervisory or compliance conclusion. */
export const REGULATORY_REVIEWED = '2026-09-25';
export const REGULATORY_SOURCES = [
  {label:'U.S. capital minimums',url:'https://www.ecfr.gov/current/title-12/chapter-III/subchapter-B/part-324/subpart-B/section-324.10'},
  {label:'Capital conservation buffer',url:'https://www.ecfr.gov/current/title-12/chapter-I/part-3/subpart-B/section-3.11'},
  {label:'PCA categories',url:'https://www.ecfr.gov/current/title-12/chapter-III/subchapter-B/part-324/subpart-H/section-324.403'},
  {label:'CBLR final rule · effective July 1, 2026',url:'https://occ.gov/news-issuances/federal-register/2026/91fr22973.pdf'},
  {label:'CAMELS framework',url:'https://www.ffiec.gov/news/press-releases/2026/pr-05-19'},
  {label:'Supervisory ratings and public information',url:'https://www.frbsf.org/research-and-insights/publications/economic-letter/1999/06/using-camels-ratings-to-monitor-bank-conditions/'},
  {label:'Liquidity regulation · LCR and NSFR',url:'https://www.federalreserve.gov/frrs/regulations/regulation-ww-liquidity-risk-measurement-standards-and-monitoring.htm'},
];
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function cblrReference(period) {
  if(!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(period)||period<'2022-01-01')return null;
  return period<'2026-07-01'?{threshold:9,graceQuarters:2,graceFloor:8}:{threshold:8,graceQuarters:4,graceFloor:7};
}
export function regulatoryContext(bank,period) {
  const framework=bank?.cblr===true?'cblr':bank?.cblr===false?'risk_based':'unknown';
  const cblr=cblrReference(period);
  const base={framework,reviewed:REGULATORY_REVIEWED,period,rows:[],cblr};
  if(framework==='unknown'||!cblr)return base;
  const definitions=framework==='cblr'
    ?[{key:'leverage',label:'CBLR leverage ratio',minimum:cblr.threshold,strict:true}]
    :[{key:'cet1',label:'Common equity Tier 1',minimum:4.5,buffer:7,pca:6.5},
      {key:'tier1',label:'Tier 1 risk-based',minimum:6,buffer:8.5,pca:8},
      {key:'totalCapital',label:'Total risk-based',minimum:8,buffer:10.5,pca:10},
      {key:'leverage',label:'Tier 1 leverage',minimum:4,pca:5}];
  return {...base,rows:definitions.map(d=>{
    const value=finite(bank.metrics?.[d.key])?bank.metrics[d.key]:null;
    return {...d,value,gapBps:value===null?null:(value-d.minimum)*100,
      position:value===null?'unavailable':value>d.minimum?'above':value<d.minimum?'below':'at'};
  })};
}
