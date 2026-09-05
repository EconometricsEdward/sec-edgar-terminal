import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk, classifyTrajectory } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile, runRiskStress, riskDelta, riskBrief, riskHistoryCsv } from '../src/utils/riskWorkspace.js';

function bankFacts({ missingAllowance = false, missingCurrentEquity = false } = {}) {
  const values = { Assets: 1000, Liabilities: 900, StockholdersEquity: 100, CashAndDueFromBanks: 80, FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss: 500, FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest: 20, Deposits: 800, DebtSecuritiesHeldToMaturityAmortizedCostAfterAllowanceForCreditLoss: 200, HeldToMaturitySecuritiesFairValue: 160, NetIncomeLoss: 15 };
  const facts = { 'us-gaap': {} };
  for (const [tag,val] of Object.entries(values)) facts['us-gaap'][tag] = { units: { USD: [2024,2025].flatMap((fy) => missingAllowance && tag === 'FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest' || missingCurrentEquity && tag === 'StockholdersEquity' && fy === 2025 ? [] : [{ val, end: `${fy}-12-31`, start: tag === 'NetIncomeLoss' ? `${fy}-01-01` : undefined, fy, fp:'FY', form:'10-K', accn:`0000000001-${fy-2000}-000001`, filed:`${fy+1}-02-01` }]) } };
  return facts;
}
const bank = (options) => decorateRiskProfile(assessRisk(bankFacts(options),6021,1));
const metric = (p,id) => p.metrics.find((m) => m.id === id);

test('HTM sensitivity changes both assets and equity and retains all inputs', () => {
  const m = metric(bank(),'htm_adj_equity');
  assert.equal(m.value, 60/960);
  assert.equal(m.classification,'illustrative');
  assert.equal(m.zone.level,'info');
  assert.equal(m.sources.length,4);
  assert.ok(m.sources.every((s) => s.documentUrl.includes(s.accession.replaceAll('-',''))));
});
test('missing current equity cannot silently substitute prior-year equity', () => {
  const p = bank({missingCurrentEquity:true});
  assert.equal(metric(p,'bank_equity_assets').value,null);
  assert.equal(metric(p,'bank_equity_assets').series[0].value,0.1);
  assert.equal(runRiskStress(p).available,false);
});
test('untagged allowance is not treated as zero in gross loans', () => {
  const p = bank({missingAllowance:true});
  assert.equal(metric(p,'reserve_coverage').value,null);
  assert.equal(metric(p,'loans_deposits').value,500/800);
});
test('ratio evidence includes numerator and denominator, with exact values', () => {
  const m = metric(bank(),'bank_equity_assets');
  assert.deepEqual(m.sources.map((s) => s.value).sort((a,b)=>a-b),[100,1000]);
  assert.ok(m.series.every((p) => p.sources.length === 2));
});
test('TTM risk flow needs all four quarters and retains cumulative inputs', () => {
  const facts = bankFacts();
  const obs = (val, start, end, fp, fy, id) => ({val,start,end,fp,fy,form:fp === 'FY' ? '10-K':'10-Q',accn:`0000000001-${fy-2000}-${id}`,filed:`${fy+1}-02-01`});
  const entries = [obs(100,'2024-01-01','2024-12-31','FY',2024,'000001'),obs(70,'2024-01-01','2024-09-30','Q3',2024,'000003'),obs(150,'2025-01-01','2025-09-30','Q3',2025,'000004'),obs(90,'2025-01-01','2025-06-30','Q2',2025,'000003'),obs(40,'2025-01-01','2025-03-31','Q1',2025,'000002')];
  facts['us-gaap'].Revenues={units:{USD:entries}};
  facts['us-gaap'].ProvisionForLoanLeaseAndOtherLosses={units:{USD:entries}};
  for (const tag of ['Assets','FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss','FinancingReceivableAllowanceForCreditLossExcludingAccruedInterest']) facts['us-gaap'][tag].units.USD = [{...facts['us-gaap'][tag].units.USD[1],end:'2025-09-30',fp:'Q3',form:'10-Q',accn:'0000000001-25-000004'}];
  // Exclude the later annual anchor so September is the current reporting end.
  for (const data of Object.values(facts['us-gaap'])) data.units.USD=data.units.USD.filter((p)=>p.end<='2025-09-30');
  const p = decorateRiskProfile(assessRisk(facts,6021,1,{basis:'ttm'}));
  const provision = metric(p,'provision_rate');
  assert.equal(p.periods[0].end,'2025-09-30');
  assert.equal(provision.value,180/520);
  assert.ok(provision.sources.some((s)=>s.value===100 && s.end==='2024-12-31'));
  assert.ok(provision.sources.some((s)=>s.value===70 && s.end==='2024-09-30'));
  assert.equal(p.zScore,null);
});
test('trajectory never bridges missing observations or skipped fiscal years', () => {
  const seq=[2022,2023,2024,2025].map((fy,i)=>({fy,end:`${fy}-12-31`,value:i+1}));
  assert.equal(classifyTrajectory(seq,true).steps,3);
  assert.equal(classifyTrajectory(seq.map((p,i)=>i===2?{...p,value:null}:p),true),null);
  assert.equal(classifyTrajectory(seq.map((p,i)=>i===3?{...p,value:null}:p),true),null);
  assert.equal(classifyTrajectory([seq[0],seq[1],seq[3]],true),null);
});
test('watch queue deduplicates a threshold and a trend for the same metric', () => {
  const p = bank(); const sample={...p.metrics[0],id:'provision_rate',zone:{level:'elevated'},trajectory:{direction:'deteriorating',steps:4}};
  const decorated=decorateRiskProfile({...p,metrics:[sample]});
  assert.equal(decorated.watchItems.length,1);
  assert.match(decorated.watchItems[0].reason,/consecutive/);
});
test('context-only reserve movements do not claim improvement or deterioration', () => {
  const p=bank(); assert.equal(metric(p,'reserve_coverage').trajectory,null);
  assert.equal(metric(p,'reserve_coverage').zone.level,'info');
});
test('percentage deltas are percentage points, not percent changes', () => {
  assert.equal(riskDelta({delta:0.001,format:'pct'}),'+0.10 pp');
});
test('zero-shock bank scenario exactly reproduces the baseline', () => {
  const result=runRiskStress(bank()); assert.equal(result.available,true);
  assert.ok(result.rows.every((r)=>r.baseline===r.stressed));
});
test('bank stress caps paid withdrawals at cash and preserves an explicit funding gap', () => {
  const result=runRiskStress(bank(),{runoff:20,creditLoss:2});
  const rows=Object.fromEntries(result.rows.map((r)=>[r.label,r.stressed]));
  assert.equal(rows['Tagged cash remaining'],0);
  assert.equal(rows['Withdrawals beyond modeled cash'],80);
  assert.equal(rows['Additional unreserved credit loss'],10);
  assert.equal(rows['Book equity'],90);
  assert.equal(rows['Equity / assets'],90/910);
});
test('stress controls are bounded and missing inputs never create zero balances', () => {
  const p=bank(); const result=runRiskStress(p,{runoff:100,creditLoss:-2});
  assert.equal(result.parameters.runoff,30); assert.equal(result.parameters.creditLoss,0);
  p.stressInputs.cash.value=null; assert.equal(runRiskStress(p).available,false);
});
test('an earnings decline worsens an existing loss rather than improving it', () => {
  const profile={industry:{isBank:false,isFinancial:false},stressInputs:{operatingIncome:{value:-100},interestExpense:{value:10}}};
  const result=runRiskStress(profile,{earningsDecline:20,interestIncrease:50});
  assert.equal(result.rows[0].stressed,-120/15);
});
test('insurance sensitivity adjusts both book equity and assets', () => {
  const profile={industry:{isBank:false,isFinancial:true},stressInputs:{totalAssets:{value:1000},equity:{value:100}}};
  assert.equal(runRiskStress(profile,{assetLoss:5}).rows[0].stressed,50/950);
});
test('missing net income yields an unavailable count instead of zero losses', () => {
  const facts=bankFacts(); delete facts['us-gaap'].NetIncomeLoss;
  const p=decorateRiskProfile(assessRisk(facts,6021,1)); assert.equal(metric(p,'loss_years').value,null); assert.equal(metric(p,'loss_years').zone.level,'na');
});
test('brief and history exports include dates, sources, and reproducible scenario assumptions', () => {
  const p=bank(), data={ticker:'TEST',companyName:'Test company',generatedAt:'2026-09-05T00:00:00Z'};
  const brief=riskBrief(data,p,runRiskStress(p,{runoff:20}));
  assert.match(brief,/"runoff":20/); assert.match(brief,/2025-12-31/); assert.match(brief,/https:\/\/www.sec.gov\/Archives/); assert.match(brief,/Scenario input cash/);
  const csv=riskHistoryCsv(data,p,metric(p,'bank_equity_assets')); assert.match(csv,/percentages as fractions/); assert.match(csv,/"0.1"/); assert.match(csv,/2024-12-31/);
});

test('bank cash excludes explicitly tagged restrictions before a narrow cash fallback', () => {
  const facts=bankFacts(); const base=facts['us-gaap'].CashAndDueFromBanks.units.USD;
  facts['us-gaap'].CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents={units:{USD:base.map((p)=>({...p,val:300}))}};
  facts['us-gaap'].RestrictedCashAndCashEquivalents={units:{USD:base.map((p)=>({...p,val:30}))}};
  const p=decorateRiskProfile(assessRisk(facts,6021,1));
  assert.equal(p.stressInputs.cash.value,270);
  assert.equal(p.stressInputs.cash.sources.length,2);
  assert.match(p.stressInputs.cash.formula,/restricted/);
  delete facts['us-gaap'].RestrictedCashAndCashEquivalents;
  assert.equal(assessRisk(facts,6021,1).stressInputs.cash.value,80);
});
