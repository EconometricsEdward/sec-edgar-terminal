import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCallXbrl } from '../src/utils/bank/parser.js';
import { normalizeBankReport } from '../src/utils/bank/normalization.js';
import { riskMaturityContext, riskMarketContext, riskBankContext, createRiskMaturityRead } from '../src/utils/riskContext.js';
import { createRiskContextApi } from '../src/utils/riskContextApi.js';
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const funding = readJson('../src/data/market-research/funding.json');
const derivatives = readJson('../src/data/market-research/derivatives.json');
const now = Date.parse('2026-09-30T12:00:00Z');

function bankEvidence() {
  const parsed = parseCallXbrl(readFileSync(new URL('./fixtures/bank-852218-2026-06-30.xml', import.meta.url), 'utf8'), { rssd:852218, reportDate:'2026-06-30' });
  const report = normalizeBankReport(parsed, { form:'031' });
  return { banks:[{ id_rssd:852218, legal_name:'JPMORGAN CHASE BANK, NATIONAL ASSOCIATION', form_type:'031', available_periods:['2026-06-30'] }],
    reports:[{ ...report, id_rssd:852218, report_date:'2026-06-30', source_sha256:parsed.sha256, retrieved_at:'2026-09-29T12:00:00Z' }],
    periods:['2026-06-30'], jobs:[] };
}

test('bank view reconciles real Call Report amounts and keeps percentage units and office scope', () => {
  const raw = bankEvidence(), view = riskBankContext(raw,852218);
  const values = Object.fromEntries(raw.reports[0].metrics.map(m => [m.key,m.value]));
  const get = key => view.metrics.find(m => m.key === key).value;
  assert.equal(view.status,'ready');
  assert.deepEqual(view.reportingPeriods.map(row => [row.date, row.status]), [['2026-06-30', 'ready']]);
  assert.ok(view.reportingPeriods[0].sourceUrl.includes(`hash=${raw.reports[0].source_sha256}`));
  assert.equal(get('cet1_ratio'), values.cet1_ratio);
  assert.equal(get('nonaccrual_share'),values.nonaccrual / values.loans * 100);
  assert.equal(get('allowance_share'),values.allowance / values.loans_hfi * 100);
  assert.equal(get('brokered_share'),values.brokered_deposits / values.domestic_deposits * 100);
  assert.equal(get('fhlb_share'),values.fhlb_advances / values.assets * 100);
  assert.ok(view.metrics.every(m => m.sources.every(s => s.url.includes('rssd=852218') && s.url.includes('period=2026-06-30'))));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 15000);
});

test('bank gaps, failed validation, zero denominators and wrong identities cannot become reassuring ratios', () => {
  const raw = bankEvidence();
  assert.throws(() => riskBankContext(raw,480228));
  raw.reports[0].metrics.find(m => m.key === 'nonaccrual').value = null;
  raw.reports[0].metrics.find(m => m.key === 'domestic_deposits').value = 0;
  let view = riskBankContext(raw,852218);
  assert.equal(view.metrics.find(m => m.key === 'nonaccrual_share').value,null);
  assert.equal(view.metrics.find(m => m.key === 'brokered_share').value,null);
  raw.reports[0].validation.passed = false;
  view = riskBankContext(raw,852218);
  assert.equal(view.status,'review'); assert.ok(view.metrics.every(m => m.value === null));
  assert.equal(view.reportingPeriods[0].sourceUrl, null, 'unvalidated quarters do not expose a verified report link');
  raw.periods.push('2026-09-30');
  view = riskBankContext(raw,852218);
  assert.equal(view.status,'pending'); assert.equal(view.period,'2026-09-30');
  assert.deepEqual(view.reportingPeriods.map(row => [row.date, row.status]), [['2026-06-30', 'review'], ['2026-09-30', 'pending']]);
  assert.ok(view.metrics.every(m => m.value === null),'do not substitute an older report for the latest quarter');
});

test('maturity projection uses exact CIK, distinguishes pending/absent, and does not renew retention', () => {
  const wall = {sourceSnapshotAt:'2026-09-23T12:00:01Z', companies:[{cik:'0000320193',ticker:'AAPL',profile:{status:'ready',buckets:[{value:null}]}}],cache:{status:'stale'}};
  const found = riskMaturityContext(wall,'0000320193',now);
  assert.equal(found.ttl,1); assert.equal(found.profile.buckets[0].value,null); assert.equal(found.stale,true);
  assert.equal(riskMaturityContext(wall,'0000019617',now).status,'outside-coverage');
  wall.companies[0].profile=null;
  assert.equal(riskMaturityContext(wall,'0000320193',now).status,'pending');
  assert.throws(() => riskMaturityContext(wall,'0000320193',now+1000));
});

test('market projection retains units, gaps and source dates without summing overlapping swap breakdowns', () => {
  const view = riskMarketContext(funding,derivatives,now);
  const latest = view.funding.rates.at(-1);
  assert.equal(latest.spread,Math.round((latest.SOFR-latest.TGCR)*10000)/100);
  for (const [asset, series] of Object.entries(view.swaps.assets)) {
    const source = derivatives.observations.find(r=>r.asset===asset && r.measure==='volume' && r.date===series.date && r.product==='TOTAL' && r.bucket==='Total' && ['clearing','grade'].includes(r.dimension));
    assert.equal(series.total,source.value);
    assert.ok(series.trend.length<=26);
  }
  assert.equal(view.funding.generatedAt,funding.generatedAt);
  assert.ok(Buffer.byteLength(JSON.stringify(view))<100000,'bounded global payload');
  const gap = structuredClone(derivatives);
  const dates = [...new Set(gap.observations.filter(r=>r.asset==='rates'&&r.measure==='volume').map(r=>r.date))].sort();
  gap.observations=gap.observations.filter(r=>r.date!==dates.at(-2));
  assert.equal(riskMarketContext(null,gap,now).swaps.assets.rates.change,null);
});

test('API rejects parameter floods before any read and issues only requested prepared reads', async () => {
  const calls=[];
  const handler=createRiskContextApi({readMaturities:async()=>{calls.push('maturity');return {sourceSnapshotAt:'2026-09-29T12:00:00Z',companies:[]};},
    readMarket:async kind=>{calls.push(kind);return kind==='funding'?funding:derivatives;},
    readBank:async(operation,payload)=>{calls.push([operation,payload]);return bankEvidence();},rateLimit:async()=>null,now:()=>now});
  for(const query of ['source=bank&rssd=852218&refresh=true','source=maturities&cik=0000320193&cik=0000019617','source=markets&ticker=AAPL','source=bank&rssd=0']) {
    assert.equal((await handler(new Request(`https://example.com/api/risk/context?${query}`))).status,400);
  }
  assert.deepEqual(calls,[]);
  const response=await handler(new Request('https://example.com/api/risk/context?source=bank&rssd=852218'));
  assert.equal(response.status,200); assert.deepEqual(calls,[['read',{rssds:[852218]}]]);
  assert.equal(response.headers.get('cache-control'),'public, max-age=30, s-maxage=30');
});

test('market source failure remains partial, and disabled CFTC never invokes its reader', async()=>{
  const calls=[];const deps={readMaturities:async()=>{},readBank:async()=>{},rateLimit:async()=>null,now:()=>now,
    readMarket:async kind=>{calls.push(kind);if(kind==='derivatives')throw Error('unavailable');return funding;}};
  const request=new Request('https://example.com/api/risk/context?source=markets');
  const partial=await createRiskContextApi(deps)(request);
  assert.equal(partial.status,200);assert.equal(partial.headers.get('cache-control'),'private, no-store');
  assert.equal((await partial.json()).swaps,null);
  calls.length=0;
  const disabled=await createRiskContextApi({...deps,cftcEnabled:false})(request);
  assert.equal(disabled.status,200);assert.deepEqual(calls,['funding']);
});

test('different company lookups share one decoded universe, with single flight, expiry and failure cooldown', async()=>{
  let clock=now, reads=0, fail=false;
  const read=createRiskMaturityRead({now:()=>clock,read:async()=>{
    reads++;if(fail)throw Error('offline');
    return {sourceSnapshotAt:'2026-09-23T12:00:01Z',companies:[]};
  }});
  await Promise.all([read(),read(),read()]);assert.equal(reads,1);
  await read();assert.equal(reads,1);
  clock+=1000;fail=true;
  await assert.rejects(read());assert.equal(reads,2);
  await assert.rejects(read());assert.equal(reads,2,'a failed source must not be read for every visitor');
});
