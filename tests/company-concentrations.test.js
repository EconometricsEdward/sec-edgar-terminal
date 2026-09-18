import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyConcentrations, extractConcentrationFacts } from '../src/utils/companyConcentrations.js';
import { discoverCompanyConcentrations } from '../src/utils/companyConcentrationsServer.js';
const filing = { reportDate: '2026-06-30', filed: '2026-07-30', form: '10-Q', url: 'https://www.sec.gov/Archives/edgar/data/1234/000000123426000010/company.htm' };
const revenue = 'RevenueFromContractWithCustomerExcludingAssessedTax';
const make = (concept, value, dimensions = [], start = null, end = filing.reportDate) => ({ id: JSON.stringify([concept, dimensions, start, end]), concept, tag: `us-gaap:${concept}`, unit: 'USD', value, dimensions, start, end, periodType: start ? 'duration' : 'instant', sourceUrl: filing.url });
const dim = (axis, member, label = member.split(':')[1].replace(/Member$/, '')) => ({ axis, member, label });
const product = name => [dim('srt:ProductOrServiceAxis', `example:${name}Member`, name)];
const grouped = (rows, basis = 'ttm') => buildCompanyConcentrations(rows, { filing, basis });

test('quarter revenue is chosen over YTD and every share retains the exact quarter denominator', () => {
  const rows = ['2026-01-01', '2026-04-01'].flatMap(start => [make(revenue, start.includes('04') ? 100 : 250, [], start), make(revenue, start.includes('04') ? 60 : 180, product('A'), start), make(revenue, start.includes('04') ? 40 : 70, product('B'), start)]);
  const group = grouped(rows).revenue[0];
  assert.equal(group.start, '2026-04-01'); assert.match(group.period, /^Quarter/); assert.equal(group.rows[0].share, .6); assert.equal(group.reconciles, true);
});
test('annual selection cannot silently use a quarter or year-to-date revenue breakdown', () => {
  const rows = [make(revenue,100,[],'2026-04-01'),make(revenue,60,product('A'),'2026-04-01'),make(revenue,40,product('B'),'2026-04-01')];
  assert.deepEqual(grouped(rows,'annual').revenue, []);
});
test('matching revenue totals are required: other units, periods or tags do not supply a denominator', () => {
  const rows = [make('Revenues',100,[],'2026-04-01'),make(revenue,600,[],'2026-01-01'),make(revenue,60,product('A'),'2026-04-01'),make(revenue,40,product('B'),'2026-04-01')];
  const g = grouped(rows).revenue[0]; assert.equal(g.denominator,null); assert.equal(g.rows[0].share,null); assert.equal(g.reconciles,false);
});
test('known product parent is suppressed only after both rollup and consolidated reconciliation', () => {
  const start='2026-04-01'; const rows=[make(revenue,100,[],start),make(revenue,70,[dim('srt:ProductOrServiceAxis','us-gaap:ProductMember')],start),make(revenue,30,[dim('srt:ProductOrServiceAxis','us-gaap:ServiceMember')],start),make(revenue,50,product('A'),start),make(revenue,20,product('B'),start)];
  assert.equal(grouped(rows).revenue[0].rows.length,3); assert.equal(grouped(rows).revenue[0].reconciles,true);
  rows[3].value=40; assert.equal(grouped(rows).revenue[0].rows.length,4); assert.equal(grouped(rows).revenue[0].reconciles,false);
});
test('overlapping geographic parent is not counted twice when regions reconcile', () => {
  const start='2026-04-01',axis='srt:StatementGeographicalAxis'; const rows=[make(revenue,100,[],start),make(revenue,80,[dim(axis,'country:US')],start),make(revenue,20,[dim(axis,'us-gaap:NonUsMember')],start),make(revenue,12,[dim(axis,'srt:EuropeMember')],start),make(revenue,8,[dim(axis,'srt:AsiaMember')],start)];
  const g=grouped(rows).revenue[0];assert.equal(g.rows.length,3);assert.equal(g.reconciles,true);assert.equal(g.rows.reduce((n,r)=>n+r.value,0),100);
});
test('funding uses exact-date total liabilities and never sums debt and repo overlaps', () => {
  const g=grouped([make('Liabilities',1000),make('Deposits',600),make('ShortTermBorrowings',200),make('CommercialPaper',100),make('LongTermDebt',250),make('SecuritiesSoldUnderAgreementsToRepurchase',180)]).funding;
  assert.equal(g.rows.length,4); assert.equal(g.rows.find(r=>r.label==='Deposits').share,.6); assert.ok(!g.rows.some(r=>r.label==='Commercial paper')); assert.equal(g.reconciles,false);
});
test('missing denominator stays missing, and a prior date cannot become the current funding total', () => {
  const g=grouped([make('Liabilities',1000,[],null,'2025-12-31'),make('LongTermDebt',50)]).funding;
  assert.equal(g.denominator,null);assert.equal(g.rows[0].share,null);assert.equal(grouped([]).funding,null);
});
test('loan classes use their portfolio denominator and exclude credit-score and past-due axes', () => {
  const tag='FinancingReceivableExcludingAccruedInterestBeforeAllowanceForCreditLoss',segment=dim('us-gaap:FinancingReceivablePortfolioSegmentAxis','us-gaap:CommercialPortfolioSegmentMember','Commercial Portfolio');
  const rows=[make(tag,1000),make(tag,600,[segment]),make(tag,250,[segment,dim('us-gaap:FinancingReceivableRecordedInvestmentByClassOfFinancingReceivableAxis','example:RealEstateMember')]),make(tag,350,[segment,dim('us-gaap:FinancingReceivableRecordedInvestmentByClassOfFinancingReceivableAxis','example:OtherMember')]),make(tag,200,[segment,dim('us-gaap:CreditScoreFicoAxis','example:ExcellentMember')])];
  const g=grouped(rows).credit[0];assert.equal(g.denominator.value,600);assert.equal(g.rows.length,2);assert.equal(g.reconciles,true);assert.equal(g.rows[0].share,350/600);
});
const header='<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">';
const context='<xbrli:context id="c"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">1234</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2026-06-30</xbrli:instant></xbrli:period></xbrli:context>';
const units='<xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>';
const inline=v=>`<ix:nonFraction name="us-gaap:Deposits" contextRef="c" unitRef="usd" scale="6">${v}</ix:nonFraction>`;
test('shared namespace-aware extractor retains scale and omits conflicting duplicates',()=>{
  assert.equal(extractConcentrationFacts(header+context+units+inline(20)+'</html>',{cik:'1234',filing}).rows[0].value,20e6);
  assert.equal(extractConcentrationFacts(header+context+units+inline(20)+inline(21)+'</html>',{cik:'1234',filing}).rows.length,0);
  assert.equal(extractConcentrationFacts((header+context+units+inline(20)+'</html>').replace('iso4217:USD','iso4217:EUR'),{cik:'1234',filing}).rows.length,0);
});
test('discovery retains verified issuer, reporting date and cutoff, and strips raw fact payload',async()=>{
  const result=await discoverCompanyConcentrations({ticker:'EX',basis:'ttm',asOf:'2026-08-01'},{now:new Date('2026-09-18'),lookupTicker:async()=>({cik:1234,name:'Example'}),loadSubmissions:async()=>({cik:1234,name:'Example',sic:'6021',filings:{recent:{accessionNumber:['0000001234-26-000010'],form:['10-Q'],filingDate:['2026-07-30'],reportDate:['2026-06-30'],primaryDocument:['company.htm']},files:[]}}),loadFiling:async()=>header+context+units+inline(20)+'</html>'});
  assert.equal(result.ticker,'EX');assert.equal(result.asOf,'2026-08-01');assert.equal(result.filing.reportDate,'2026-06-30');assert.equal(result.funding.rows[0].value,20e6);assert.equal('rows' in result,false);assert.equal(result.sic,'6021');
});

test('utility operating revenue uses its own denominator and never substitutes customer-contract revenue', () => {
  const tag='RegulatedAndUnregulatedOperatingRevenue',start='2026-04-01',axis='us-gaap:StatementBusinessSegmentsAxis';
  const rows=[make(tag,7534,[],start),make(revenue,6500,[],start),make(tag,4896,[dim(axis,'example:UtilityMember')],start),make(tag,2532,[dim(axis,'example:EnergyResourcesMember')],start)];
  const g=grouped(rows).revenue[0];assert.equal(g.denominator.value,7534);assert.equal(g.rows[0].share,4896/7534);assert.equal(g.reconciles,false);assert.equal(g.denominatorLabel,'Regulated and unregulated operating revenue');
});
test('identical unscoped and OperatingSegments revenue groups produce one lens without hiding differing amounts', () => {
  const start='2026-04-01',axis='us-gaap:StatementBusinessSegmentsAxis',operating=dim('srt:ConsolidationItemsAxis','us-gaap:OperatingSegmentsMember','Operating Segments');
  const rows=[make(revenue,100,[],start),make(revenue,60,[dim(axis,'example:A')],start),make(revenue,40,[dim(axis,'example:B')],start),make(revenue,60,[operating,dim(axis,'example:A')],start),make(revenue,40,[operating,dim(axis,'example:B')],start)];
  assert.equal(grouped(rows).revenue.length,1);
  rows[3].value=65;assert.equal(grouped(rows).revenue.length,2);
});
test('broker secured and unsecured debt remain explicitly labeled and are not added to aggregate debt', () => {
  const rows=[make('Liabilities',2004969),make('Deposits',557955),make('UnsecuredDebtCurrent',34230),make('UnsecuredLongTermDebt',347963),make('SecuredLongTermDebt',11558)];
  let g=grouped(rows).funding;assert.equal(g.rows.length,4);assert.equal(g.rows.find(r=>r.label==='Unsecured long-term debt').share,347963/2004969);assert.equal(g.rows.find(r=>r.label==='Current unsecured debt, reported amount').value,34230);
  g=grouped([...rows,make('LongTermDebt',359521)]).funding;
  assert.ok(!g.rows.some(r=>['Unsecured long-term debt','Secured long-term debt'].includes(r.label)));assert.equal(g.rows.find(r=>r.label==='Long-term debt, reported total').value,359521);
});
test('funding with no compatible total describes dollar amounts, not nonexistent percentage shares', () => {
  const g=grouped([make('LongTermDebt',100)]).funding;assert.match(g.note,/percentage shares are not calculated/);assert.equal(g.rows[0].share,null);
});
test('customer-contract revenue is labeled as the denominator actually reported', () => {
  const rows=[make(revenue,100,[],'2026-04-01'),make(revenue,60,product('A'),'2026-04-01'),make(revenue,40,product('B'),'2026-04-01')];
  assert.equal(grouped(rows).revenue[0].denominatorLabel,'Revenue from customer contracts');
});
