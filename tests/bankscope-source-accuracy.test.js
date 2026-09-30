import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { normalizeBankReport } from '../src/utils/bank/normalization.js';
import { buildExposureReport } from '../src/utils/bank/exposureModel.js';
import { normalizePeerRecord } from '../src/utils/bank/peerSource.js';
import { bankMetric } from '../src/utils/bank/viewModel.js';

// Independently calculated with Python ElementTree and explicit official-form
// mappings. Every original report URL/hash, observed value and context is kept.
const ledger=JSON.parse(gunzipSync(readFileSync(new URL('../docs/audits/bankscope-2026-09-30.json.gz',import.meta.url))).toString('utf8'));
const approx=(a,b,message)=>assert.ok(Math.abs(a-b)<1e-9,`${message}: ${a} != ${b}`);
function sourceExcerpt(row){
  const contexts=new Map();
  for(const facts of Object.values(row.facts))for(const f of facts)contexts.set(f.contextRef,f.period);
  const contextXml=[...contexts].map(([id,period])=>`<context id="${id}"><entity><identifier scheme="https://www.cdr.ffiec.gov/cdr">${row.rssd}</identifier></entity><period>${period==='instant'?`<instant>${row.period}</instant>`:`<startDate>${row.period.slice(0,4)}-01-01</startDate><endDate>${row.period}</endDate>`}</period></context>`).join('');
  const facts=Object.entries(row.facts).flatMap(([code,values])=>values.filter(f=>f.value!==null).map(f=>`<c:${code} contextRef="${f.contextRef}" unitRef="${f.unit}" decimals="${f.decimals}">${f.rawValue}</c:${code}>`)).join('');
  return `<xbrl xmlns:c="https://www.cdr.ffiec.gov/xbrl/call/concepts" xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:schemaRef xlink:href="https://www.cdr.ffiec.gov/xbrl/call/report${row.form}/${row.period}/concepts.xsd"/>${contextXml}<unit id="USD"><measure>iso4217:USD</measure></unit><unit id="pure"><measure>xbrli:pure</measure></unit><unit id="nonMonetary"><measure>ffieci:nonMonetary</measure></unit>${facts}</xbrl>`;
}
const reports=ledger.reports.map(row=>{
  const parsed=parseCallXbrl(sourceExcerpt(row),{rssd:row.rssd,reportDate:row.period});
  return {row,parsed,normalized:normalizeBankReport(parsed,{form:row.form})};
});

test('independent six-bank, four-quarter ledger reconciles all 840 core and 1452 exposure observations',()=>{
  assert.equal(reports.length,24);
  assert.deepEqual(ledger.coreComparisons,{count:840,matching:840});
  assert.deepEqual(ledger.exposuresComparisons,{count:1452,matching:1452});
  for(const {row,parsed,normalized}of reports){
    assert.equal(normalized.validation.passed,true,`${row.rssd} ${row.period}`);
    for(const metric of normalized.metrics){
      const expected=row.core[metric.key].expected;
      if(expected===null)assert.equal(metric.value,null);else approx(metric.value,expected,`${row.rssd} ${row.period} ${metric.key}`);
    }
    const exposure=buildExposureReport(parsed,{form:row.form});
    for(const [key,metric]of Object.entries(exposure.values))assert.equal(metric.value,row.exposures[key].expected,`${row.rssd} ${row.period} ${key}`);
  }
});

test('Alliance screenshot grouping and its other-loan residual have exact source support',()=>{
  const row=ledger.reports.find(r=>r.rssd===493741&&r.period==='2026-06-30');
  const values=Object.fromEntries(Object.entries(row.exposures).map(([k,m])=>[k,m.expected]));
  assert.deepEqual(['total','cre','construction','residential','commercial','consumer','other'].map(k=>values[`loan_${k}`]),
    [325761000,139874000,23532000,28120000,31311000,532000,102392000]);
  assert.equal(values.loan_cre,39996000+38107000+61771000);
  assert.equal(values.loan_other,54727000+46256000+1409000); // Farmland, agricultural production, state/local obligations.
  // RC-C and RC totals differ by one reported $1,000 rounding unit. Do not
  // overwrite the filed RC-C portfolio with FDIC's RC-based loan denominator.
  assert.equal(row.core.loans.expected,325761000);
  assert.equal(row.core.loans_hfi.expected,325762000);
});

test('all audited published FDIC ratios retain their documented denominators and corrected office scope',()=>{
  for(const row of ledger.fdic){
    const normalized=normalizePeerRecord(row.raw,row.period);
    const original=ledger.reports.find(r=>r.rssd===row.rssd&&r.period===row.period);
    assert.equal(row.raw.DEPNIDOM*1000,original.exposures.noninterest.expected,'FDIC and original Call Report domestic scope agree');
    for(const [key,ratio]of Object.entries(row.ratios)){
      if(ratio.expected===null)assert.equal(normalized.metrics[key],null);
      else approx(normalized.metrics[key],ratio.expected,`${row.rssd} ${key}`);
    }
  }
  const mismatches=ledger.fdic.flatMap(row=>Object.entries(row.ratios).filter(([,r])=>!r.matches).map(([key])=>[row.rssd,key])).sort((a,b)=>a[0]-b[0]);
  assert.deepEqual(mismatches,[[451965,'noninterestDeposits'],[480228,'noninterestDeposits'],[852218,'noninterestDeposits']]);
  const alliance=ledger.fdic.find(r=>r.rssd===493741);
  assert.equal(alliance.raw.NTLNLS,-2); // USD thousands: $8k charge-offs less $10k recoveries.
  assert.equal(alliance.raw.NTLNLSA,-4); // Annualized six-month YTD, still negative.
  assert.equal(alliance.raw.LNLSGR5,320619);
  approx(alliance.ratios.chargeoffs.expected,-4/320619*100,'Alliance net-recovery rate');
});

test('regulatory leverage capital uses adjusted average assets, not quarter-end equity or assets',()=>{
  for(const {row}of reports){
    const prefix=row.form==='031'?'RCFA':'RCOA';
    const denominator=row.facts[`${prefix}A224`][0].value;
    assert.ok(denominator>0);
    assert.ok(Math.abs(row.core.tier1.expected/denominator*100-row.core.leverage_ratio.expected)<=0.000051);
  }
});

test('actual earnings histories derive standalone quarters only from consecutive same-year YTD',()=>{
  const state={reports:reports.map(({row,normalized})=>({id_rssd:row.rssd,report_date:row.period,...normalized}))};
  for(const {row}of reports)for(const key of ['net_income','net_interest_income','charge_offs','recoveries']){
    const metric=bankMetric(state,row.rssd,row.period,key,'quarterly');
    if(row.period.endsWith('03-31'))assert.equal(metric.value,row.core[key].expected);
    else if(row.period.endsWith('09-30'))assert.equal(metric.value,null); // Q2 2025 is outside retained history.
    else{
      const suffix=row.period.endsWith('06-30')?'03-31':'09-30';
      const prior=ledger.reports.find(r=>r.rssd===row.rssd&&r.period===`${row.period.slice(0,4)}-${suffix}`);
      assert.equal(metric.value,row.core[key].expected-prior.core[key].expected);
    }
  }
});
