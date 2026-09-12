import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarketCompany, marketAcceptanceTimes, marketPeriodMetrics, marketCompanySummary, marketRevenuePoint } from '../src/utils/marketResearchData.js';
import { MARKET_VERSION, MARKET_METRICS, DEFAULT_MARKET_VIEW, metricStats, selectMarketCompanies, parseMarketView, marketViewQuery, marketViewHistoryMode, marketViewPath, canonicalMarketViewQuery, marketSavedViewSummary, cftcPercentileForHistory, cftcHeatCellDescription, parseMarketSaved, baselineChanges, marketTrendPoints, marketCsv, formatMarket, isOlderReport } from '../src/utils/marketResearch.js';

const inputs = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
function company(ticker, values, end = '2026-06-30') {
  return { ticker, name: ticker, cik: '0000000001', cohorts: ['credit'], version: MARKET_VERSION, observedAt: '2026-09-05T00:00:00Z', metrics: { ttm: values, annual: values }, reports: { ttm: { end, filed: '2026-08-01' }, annual: { end, filed: '2026-08-01' } } };
}
const obs = (val, start, end, fp, fy) => ({ val, start, end, fp, fy, form: fp === 'FY' ? '10-K' : '10-Q', filed: `${Number(end.slice(0, 4)) + (fp === 'FY' ? 1 : 0)}-${fp === 'FY' ? '02-01' : `${String(Number(end.slice(5, 7)) + 1).padStart(2, '0')}-25`}`, accn: `0000000001-${String(fy).slice(-2)}-00000${fp === 'FY' ? 4 : fp.slice(1)}` });
const make = (facts, extra = {}) => buildMarketCompany({ ticker: 'TEST', cik: '0000000001', name: 'Test', sic: '3571', facts, ...extra }, ['software'], '2026-09-05T00:00:00Z');

test('Bank revenue uses net revenue and never gross interest income as the denominator', () => {
  const period = { kind: 'annual', end: '2025-12-31', start: '2025-01-01', fy: 2025, fp: 'FY' };
  const facts = { 'us-gaap': Object.fromEntries([['InterestIncomeOperating', 100], ['RevenuesNetOfInterestExpense', 60], ['InterestIncomeExpenseNet', 40], ['NoninterestIncome', 20]].map(([tag, val]) => [tag, { units: { USD: [obs(val, '2025-01-01', '2025-12-31', 'FY', 2025)] } }])) };
  assert.equal(marketRevenuePoint(facts, period, '6021').value, 60);
  delete facts['us-gaap'].RevenuesNetOfInterestExpense;
  const calculated = marketRevenuePoint(facts, period, '6021');
  assert.equal(calculated.value, 60); assert.equal(calculated.sources.length, 2);
  delete facts['us-gaap'].NoninterestIncome;
  assert.equal(marketRevenuePoint(facts, period, '6021').value, null);
});
test('Insurance premium income alone cannot substitute total revenue', () => {
  const period = { kind: 'annual', end: '2025-12-31', start: '2025-01-01', fy: 2025, fp: 'FY' };
  const facts = { 'us-gaap': { PremiumsEarnedNet: { units: { USD: [obs(70, '2025-01-01', '2025-12-31', 'FY', 2025)] } } } };
  assert.equal(marketRevenuePoint(facts, period, '6311').value, null);
});

test('Market ratios require every component, retain zero, and reject nonpositive denominators', () => {
  const missing = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: 20, totalAssets: 200 }));
  assert.equal(missing.freeCashFlowMargin, null); assert.equal(missing.netMargin, null);
  const zero = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: 0, capex: 0, netIncome: 0, totalAssets: 200, cash: 0 }));
  assert.equal(zero.freeCashFlowMargin, 0); assert.equal(zero.netMargin, 0); assert.equal(zero.cashToAssets, 0);
  assert.equal(marketPeriodMetrics(inputs({ revenue: -10, netIncome: -5 })).netMargin, null);
  assert.equal(marketPeriodMetrics(inputs({ totalAssets: 0, stockholdersEquity: 10 })).equityToAssets, null);
  assert.equal(formatMarket(0, 'usd'), '$0');
});
test('Free cash flow consistently subtracts PP&E purchases while preserving operating losses', () => {
  const a = marketPeriodMetrics(inputs({ revenue: 100, operatingCashFlow: -20, capex: -10, netIncome: -5, totalAssets: 200, stockholdersEquity: -10 }));
  assert.equal(a.freeCashFlowMargin, -30); assert.equal(a.netMargin, -5); assert.equal(a.equityToAssets, -5);
});
test('Current Market metrics never fall back to an older reporting period', () => {
  const facts = { 'us-gaap': { Assets: { units: { USD: [obs(100, undefined, '2025-12-31', 'FY', 2025), obs(90, undefined, '2024-12-31', 'FY', 2024)] } }, Revenues: { units: { USD: [obs(50, '2024-01-01', '2024-12-31', 'FY', 2024)] } } } };
  const c = make(facts); assert.equal(c.reports.annual.end, '2025-12-31'); assert.equal(c.metrics.annual.revenue, null); assert.equal(c.evidence.annual[1].metrics.revenue, 50);
});
test('Annual growth does not bridge a missing financial year', () => {
  const c = make({ 'us-gaap': { Revenues: { units: { USD: [obs(120, '2025-01-01', '2025-12-31', 'FY', 2025), obs(100, '2023-01-01', '2023-12-31', 'FY', 2023)] } } } });
  assert.equal(c.metrics.annual.revenueGrowth, null); assert.equal(c.evidence.annual[0].priorRevenue, null);
});
test('TTM and annual metrics remain distinct with auditable cumulative source inputs', () => {
  const c = make({ 'us-gaap': { Revenues: { units: { USD: [
    obs(60, '2023-01-01', '2023-09-30', 'Q3', 2023), obs(90, '2023-01-01', '2023-12-31', 'FY', 2023),
    obs(10, '2024-01-01', '2024-03-31', 'Q1', 2024), obs(30, '2024-01-01', '2024-06-30', 'Q2', 2024), obs(60, '2024-01-01', '2024-09-30', 'Q3', 2024), obs(100, '2024-01-01', '2024-12-31', 'FY', 2024),
    obs(40, '2025-01-01', '2025-03-31', 'Q1', 2025), obs(90, '2025-01-01', '2025-06-30', 'Q2', 2025), obs(150, '2025-01-01', '2025-09-30', 'Q3', 2025),
  ] } } } });
  assert.equal(c.metrics.annual.revenue, 100); assert.equal(c.metrics.ttm.revenue, 190);
  assert.equal(c.evidence.ttm[0].priorRevenue.value, 90);
  assert.ok(Math.abs(c.metrics.ttm.revenueGrowth - (190 / 90 - 1) * 100) < 1e-9);
  assert.ok(c.evidence.ttm[0].inputs.revenue.sources.some((s) => s.value === 100 && s.end === '2024-12-31'));
  assert.ok(c.evidence.ttm[0].inputs.revenue.calculations.some((p) => p.value === 40));
  assert.equal(marketCompanySummary(c).evidence, undefined);
  assert.equal(c.filingComparisons.ttm.prior.end, '2024-09-30');
  assert.equal(c.filingComparisons.ttm.gapDays, 365);
  assert.ok(marketCompanySummary(c).filingComparisons.ttm);
});
test('Filing comparisons preserve exact SEC timing and compare the closest year-over-year reports', () => {
  const facts = { 'us-gaap': {
    Assets: { units: { USD: [
      obs(300, undefined, '2025-12-31', 'FY', 2025),
      obs(250, undefined, '2024-12-31', 'FY', 2024),
      obs(220, undefined, '2023-12-31', 'FY', 2023),
    ] } },
    Revenues: { units: { USD: [
      obs(120, '2025-01-01', '2025-12-31', 'FY', 2025),
      obs(100, '2024-01-01', '2024-12-31', 'FY', 2024),
      obs(80, '2023-01-01', '2023-12-31', 'FY', 2023),
    ] } },
  } };
  const currentAccession = '0000000001-25-000004';
  const priorAccession = '0000000001-24-000004';
  const acceptanceTimes = marketAcceptanceTimes({ filings: { recent: {
    accessionNumber: [currentAccession, priorAccession, 'bad-accession'],
    acceptanceDateTime: ['2026-02-01T21:05:00.000Z', '2025-02-01T20:45:00.000Z', 'not-a-date'],
  } } });
  const c = make(facts, { acceptanceTimes });
  const comparison = c.filingComparisons.annual;
  assert.equal(MARKET_VERSION, 'market-research-v3');
  assert.equal(comparison.pointInTime, true);
  assert.deepEqual(comparison.cutoff, {
    filed: '2026-02-01',
    acceptedAt: '2026-02-01T21:05:00.000Z',
    accession: currentAccession,
  });
  assert.deepEqual(acceptanceTimes, {
    [currentAccession]: '2026-02-01T21:05:00.000Z',
    [priorAccession]: '2025-02-01T20:45:00.000Z',
  });
  assert.deepEqual({
    end: comparison.current.end,
    filed: comparison.current.filed,
    acceptedAt: comparison.current.acceptedAt,
    form: comparison.current.form,
    accession: comparison.current.accession,
    source: comparison.current.source,
  }, {
    end: '2025-12-31',
    filed: '2026-02-01',
    acceptedAt: '2026-02-01T21:05:00.000Z',
    form: '10-K',
    accession: currentAccession,
    source: 'https://www.sec.gov/Archives/edgar/data/1/000000000125000004/',
  });
  assert.equal(comparison.prior.end, '2024-12-31');
  assert.equal(comparison.prior.acceptedAt, '2025-02-01T20:45:00.000Z');
  assert.equal(comparison.gapDays, 365);
  assert.equal(comparison.current.metrics.revenue, 120);
  assert.equal(comparison.prior.metrics.revenue, 100);
  assert.equal(comparison.changes.revenue, 20);
  assert.ok(Math.abs(comparison.changes.revenueGrowth + 5) < 1e-9);
  assert.equal(comparison.changes.operatingMargin, null);
  assert.ok(comparison.current.metricSources.revenueGrowth.length >= 2);
  assert.ok(comparison.current.metricSources.revenueGrowth.every((source) => source.filed <= comparison.cutoff.filed));
  const summary = marketCompanySummary(c);
  assert.deepEqual(Object.keys(summary.filingComparisons.annual.current.metrics), [
    'revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets',
  ]);
  assert.equal(summary.filingComparisons.annual.current.metricSources, undefined);
  assert.ok(summary.filingComparisons.annual.current.factorSourceAccessions.includes(currentAccession));
  assert.notEqual(summary.filingComparisons.annual.current.factorSourceMasks[0], '0');
  assert.equal(summary.filingComparisons.annual.current.source, undefined);
});

test('A dense 158-company factor atlas projection remains below the shared-cache value limit', () => {
  const metricMap = Object.fromEntries(MARKET_METRICS.map(({ key }, index) => [key, index + 0.25]));
  const factorKeys = ['revenueGrowth', 'netMargin', 'operatingMargin', 'freeCashFlowMargin', 'equityToAssets', 'cashToAssets'];
  const densePoint = (companyIndex, year) => {
    const sources = Array.from({ length: 12 }, (_, sourceIndex) => ({
      accession: `${String(companyIndex + 1).padStart(10, '0')}-${String(year).slice(-2)}-${String(sourceIndex + 1).padStart(6, '0')}`,
    }));
    return {
      end: `${year}-12-31`, filed: `${year + 1}-02-15`, acceptedAt: `${year + 1}-02-15T21:00:00.000Z`,
      form: '10-K', accession: sources[0].accession, source: `https://www.sec.gov/Archives/edgar/data/${companyIndex + 1}/${sources[0].accession.replaceAll('-', '')}/`,
      metrics: metricMap,
      metricSources: Object.fromEntries(factorKeys.map((key) => [key, sources])),
    };
  };
  const companies = Array.from({ length: 158 }, (_, index) => {
    const current = densePoint(index, 2025);
    const prior = densePoint(index, 2024);
    const full = {
      version: MARKET_VERSION, ticker: `T${index}`, name: `Representative issuer ${index}`,
      cik: String(index + 1).padStart(10, '0'), sic: '3571', cohorts: ['ai-infrastructure', 'software-security'],
      observedAt: '2026-09-09T00:00:00.000Z', metrics: { annual: metricMap, ttm: metricMap },
      reports: {
        annual: { end: current.end, filed: current.filed, form: current.form, accession: current.accession },
        ttm: { end: current.end, filed: current.filed, form: current.form, accession: current.accession },
      },
      revenueBasis: 'Reported total revenue', evidence: { annual: [], ttm: [] },
      filingComparisons: {
        annual: { pointInTime: true, cutoff: { filed: current.filed, acceptedAt: current.acceptedAt, accession: current.accession }, current, prior, gapDays: 365, changes: metricMap },
        ttm: { pointInTime: true, cutoff: { filed: current.filed, acceptedAt: current.acceptedAt, accession: current.accession }, current, prior, gapDays: 365, changes: metricMap },
      },
    };
    return marketCompanySummary(full);
  });
  const bytes = Buffer.byteLength(JSON.stringify({
    version: MARKET_VERSION, generatedAt: '2026-09-09T00:00:00.000Z', requested: companies.length,
    companies, cohorts: [], failures: [], observations: [], historyPersistence: true,
  }));
  // Keep material headroom below warmCache's 900 KB hard guard for names,
  // cohort membership, and unusually source-dense issuers.
  assert.ok(bytes < 700_000, `representative atlas is ${bytes} bytes`);
});
test('Filing comparisons exclude later metric revisions that were unknown at the cited event', () => {
  const currentOperating = obs(20, '2025-01-01', '2025-12-31', 'FY', 2025);
  const laterOperatingRevision = {
    ...currentOperating,
    val: 40,
    filed: '2026-03-01',
    accn: '0000000001-26-000099',
  };
  const facts = { 'us-gaap': {
    Assets: { units: { USD: [
      obs(300, undefined, '2025-12-31', 'FY', 2025),
      obs(250, undefined, '2024-12-31', 'FY', 2024),
    ] } },
    Revenues: { units: { USD: [
      obs(120, '2025-01-01', '2025-12-31', 'FY', 2025),
      obs(100, '2024-01-01', '2024-12-31', 'FY', 2024),
      obs(80, '2023-01-01', '2023-12-31', 'FY', 2023),
    ] } },
    OperatingIncomeLoss: { units: { USD: [
      currentOperating,
      laterOperatingRevision,
      obs(10, '2024-01-01', '2024-12-31', 'FY', 2024),
    ] } },
  } };
  const c = make(facts);
  assert.ok(Math.abs(c.metrics.annual.operatingMargin - (40 / 120 * 100)) < 1e-9);
  const comparison = c.filingComparisons.annual;
  assert.equal(comparison.cutoff.filed, '2026-02-01');
  assert.ok(Math.abs(comparison.current.metrics.operatingMargin - (20 / 120 * 100)) < 1e-9);
  assert.ok(comparison.current.metricSources.operatingMargin.every((source) => source.accession !== laterOperatingRevision.accn));
});
test('A current filing remains identifiable when no comparable prior year exists', () => {
  const c = make({ 'us-gaap': { Assets: { units: { USD: [obs(100, undefined, '2025-12-31', 'FY', 2025)] } } } });
  assert.ok(c.filingComparisons.annual.current);
  assert.equal(c.filingComparisons.annual.prior, null);
  assert.equal(c.filingComparisons.annual.gapDays, null);
  assert.ok(Object.values(c.filingComparisons.annual.changes).every((value) => value === null));
  assert.ok(c.filingComparisons.ttm.current);
  assert.equal(c.filingComparisons.ttm.prior, null);
});
test('Breadth denominators include only available values and distinguish zero from missing', () => {
  const rows = [company('A', { revenueGrowth: 10 }), company('B', { revenueGrowth: 0 }), company('C', { revenueGrowth: null })];
  const stat = metricStats(rows, 'ttm', 'revenueGrowth');
  assert.deepEqual({ count: stat.count, total: stat.total, positivePct: stat.positivePct, median: stat.median }, { count: 2, total: 3, positivePct: 50, median: 5 });
  assert.equal(metricStats([], 'ttm', 'revenueGrowth').positivePct, null);
});
test('Screener filters do not treat unavailable values as losses; missing values sort last both ways', () => {
  const rows = [company('MISSING', { revenueGrowth: null }), company('NEG', { revenueGrowth: -10 }), company('POS', { revenueGrowth: 20 })];
  const view = { ...DEFAULT_MARKET_VIEW, screen: 'contraction' };
  assert.deepEqual(selectMarketCompanies(rows, view, [], '').map((c) => c.ticker), ['NEG']);
  for (const direction of ['asc', 'desc']) assert.equal(selectMarketCompanies(rows, { ...view, screen: 'all', direction }, [], '').at(-1).ticker, 'MISSING');
  assert.deepEqual(selectMarketCompanies(rows, { ...view, screen: 'watchlist' }, ['POS'], '').map((c) => c.ticker), ['POS']);
});
test('Shareable views round-trip filters, sanitize invalid options, and cap peer selection', () => {
  const view = { ...DEFAULT_MARKET_VIEW, tab: 'fundamentals', cohort: 'credit', basis: 'annual', query: 'JPM & bank', selected: ['JPM', 'BAC'], screen: 'losses' };
  assert.deepEqual(parseMarketView(marketViewQuery(view), ['credit']), view);
  const defaultFundamentalQuery = new URLSearchParams(marketViewQuery({ ...DEFAULT_MARKET_VIEW, tab: 'fundamentals' }));
  assert.equal(defaultFundamentalQuery.get('tab'), 'fundamentals');
  assert.equal(defaultFundamentalQuery.has('asset'), false);
  assert.equal(defaultFundamentalQuery.has('window'), false);
  assert.equal(defaultFundamentalQuery.has('proxy'), false);
  assert.deepEqual(parseMarketView('tab=factors&asset=JPM&window=5y&proxy=XLF', ['credit']), { ...DEFAULT_MARKET_VIEW, tab: 'fundamentals' });
  const malformed = parseMarketView('basis=invalid&cohort=unknown&peers=A,A,B,C,D,E,F,%3Cscript%3E&asset=%2FBAD&window=10y&proxy=QQQ', ['credit']);
  assert.equal(malformed.basis, 'ttm'); assert.equal(malformed.cohort, 'all'); assert.deepEqual(malformed.selected, ['A', 'B', 'C', 'D', 'E']);
  assert.equal('factorTicker' in malformed, false);assert.equal('factorWindow' in malformed, false);assert.equal('factorSector' in malformed, false);
});
test('CFTC positioning views round-trip family-specific controls without altering SEC selections',()=>{
  const view={...DEFAULT_MARKET_VIEW,tab:'positioning',basis:'annual',cohort:'credit',cftcFamily:'disaggregated',cftcContract:'067651',cftcGroup:'managed-money',cftcDate:'2026-09-08',cftcHistory:'3y',cftcDisplay:'percentile'};
  assert.deepEqual(parseMarketView(marketViewQuery(view),['credit']),view);
  const wrong=parseMarketView('tab=positioning&family=disaggregated&contract=%2FBAD&group=leveraged-funds&date=2026-02-30&history=9y&display=other');
  assert.equal(wrong.cftcContract,'067651');assert.equal(wrong.cftcGroup,'managed-money');assert.equal(wrong.cftcHistory,'5y');assert.equal(wrong.cftcDisplay,'net-oi');
  assert.equal(parseMarketView('tab=positioning&date=2026-09-08junk').cftcDate,'latest');
});
test('Market history pushes real tab transitions, replaces filter changes, and skips no-op entries',()=>{
  const companies={...DEFAULT_MARKET_VIEW,tab:'companies'};
  assert.equal(marketViewHistoryMode(DEFAULT_MARKET_VIEW,companies),'pushState');
  assert.equal(marketViewHistoryMode(companies,{...companies,screen:'losses'}),'replaceState');
  assert.equal(marketViewHistoryMode(companies,{...companies}),null);
  assert.equal(marketViewHistoryMode(companies,{...companies,screen:'losses'},true),'pushState');
  assert.equal(marketViewPath(companies),'/market?tab=companies');
});
test('Saved views canonicalize supported state and reject unknown or malformed rules without substitution',()=>{
  const positioning=canonicalMarketViewQuery('tab=positioning&family=tff&contract=abc123&group=dealer&history=1y&display=percentile');
  assert.equal(new URLSearchParams(positioning.query).get('contract'),'ABC123','structurally valid unsupported codes remain explicit for catalog validation');
  const raw=JSON.stringify({version:1,watchlist:[],baselines:{},views:[
    {name:' Legacy price view ',query:'tab=overview&basis=annual&asset=SPY&window=5y&proxy=QQQ'},
    {name:'Unknown rule',query:'tab=companies&futureMetric=alpha'},
    {name:'Invalid screen',query:'tab=companies&screen=marketBeta'},
    {name:'Duplicate state',query:'tab=companies&tab=overview'},
  ]});
  const saved=parseMarketSaved(raw,['credit']);
  assert.equal(saved.views.length,1);
  assert.equal(saved.views[0].name,'Legacy price view');
  assert.equal(new URLSearchParams(saved.views[0].query).get('tab'),'fundamentals');
  assert.match(saved.migrationNotice,/moved to Fundamental Lab/);
  assert.match(saved.migrationNotice,/3 saved views were not restored/);
  assert.match(saved.migrationNotice,/no replacement screening rule was applied/);
});
test('CFTC presentation selects the requested prior-report percentile and discloses its exact comparison range',()=>{
  const group={netPctOi:4.5,oneWeekNetPctChange:-1.25,percentile:{value:80,observations:260,required:260,comparisonRange:{observations:260,earliest:'2021-09-14',latest:'2026-09-01'}},shorterPercentiles:[
    {value:60,observations:52,required:52,comparisonRange:{observations:52,earliest:'2025-09-09',latest:'2026-09-01'}},
    {value:70,observations:156,required:156,comparisonRange:{observations:156,earliest:'2023-09-12',latest:'2026-09-01'}},
  ]};
  assert.equal(cftcPercentileForHistory(group,'1y').value,60);
  assert.equal(cftcPercentileForHistory(group,'3y').value,70);
  assert.equal(cftcPercentileForHistory(group,'5y').value,80);
  const description=cftcHeatCellDescription({family:'TFF',row:{launchLabel:'E-mini S&P 500',code:'13874A',exchange:'CME',reportDate:'2026-09-08'},group,groupLabel:'Leveraged Funds',display:'percentile',historyWindow:'1y'});
  assert.match(description,/52-prior-report within-series percentile: 60\.0%/);
  assert.match(description,/exact-week change in net\/open interest: -1\.3 percentage points/);
  assert.match(description,/2025-09-09 to 2026-09-01/);
  assert.doesNotMatch(description,/2026-09-08 to/,'the selected observation is not part of its comparison range');
});
test('Saved-view summaries distinguish CFTC scope from SEC fundamental views',()=>{
  assert.match(marketSavedViewSummary('tab=positioning&family=disaggregated&contract=067651&group=managed-money&history=3y'),/Disaggregated futures only · CFTC 067651 · Managed Money · 156 prior reports/);
  assert.match(marketSavedViewSummary('tab=fundamentals&basis=annual'),/Fundamental Lab · Annual SEC fundamentals/);
});
test('Saved research refuses incompatible versions and keeps unavailable-company baselines', () => {
  assert.throws(() => parseMarketSaved('{"version":2,"watchlist":[],"views":[]}'));
  const c = company('OLD', { revenueGrowth: 5 });
  const restored = parseMarketSaved(JSON.stringify({ version: 1, watchlist: ['OLD'], views: [{ name: 'Saved', query: 'screen=losses' }], baselines: { OLD: c } }));
  assert.equal(restored.baselines.OLD.metrics.ttm.revenueGrowth, 5);
});
test('Watchlist changes distinguish new periods from changed values and skip incomparable missing metrics', () => {
  const before = company('A', { revenueGrowth: 10, netMargin: null });
  let after = company('A', { revenueGrowth: 12, netMargin: 5 });
  assert.equal(baselineChanges(before, after, 'ttm').length, 1);
  assert.equal(baselineChanges(before, after, 'ttm')[0].reason, 'Updated value for the same period');
  after = company('A', { revenueGrowth: 12 }, '2026-09-30');
  assert.equal(baselineChanges(before, after, 'ttm')[0].reason, 'Different reporting period');
  assert.deepEqual(baselineChanges({ ...before, version: 'old' }, after, 'ttm'), []);
});
test('Trend charts insert a break for unobserved quarters and retain missing metric values', () => {
  const rows = [{ period: { end: '2026-06-30' }, metrics: { revenue: 10 } }, { period: { end: '2025-12-31' }, metrics: { revenue: null } }];
  const points = marketTrendPoints(rows, 'revenue', 'ttm');
  assert.equal(points.length, 3); assert.equal(points[1].value, null); assert.equal(points[0].value, null);
});
test('CSV exports raw numeric negatives, empty unavailable cells, and escapes spreadsheet formulas in text', () => {
  const c = { ...company('A', { revenueGrowth: -5, netMargin: null }), name: '=HYPERLINK("bad")' };
  const csv = marketCsv([c], 'ttm', '2026-09-05');
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"')); assert.ok(csv.includes(',-5,"",')); assert.ok(csv.includes('CIK0000000001.json'));
});
test('Freshness is based on financial report end rather than retrieval date', () => {
  assert.equal(isOlderReport(company('A', {}, '2025-12-31'), 'ttm', '2026-09-05'), true);
  assert.equal(isOlderReport(company('A', {}, '2026-06-30'), 'ttm', '2026-09-05'), false);
});
