import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyChatTools, loadChatCompanyRisk } from '../src/utils/chatCompanyResearch.js';
import { buildCompareCompany } from '../src/utils/compareResearch.js';
import { packAnalysisCompany } from '../src/utils/analysisResearch.js';
import { assessRisk } from '../src/utils/riskAnalysis.js';
import { decorateRiskProfile, RISK_VERSION } from '../src/utils/riskWorkspace.js';

const identities = {
  AAA: { id: 'AAA', ticker: 'AAA', cik: '0000000001', name: 'First company' },
  BBB: { id: 'BBB', ticker: 'BBB', cik: '0000000002', name: 'Second company' },
};
function facts(multiplier = 1, month = '12') {
  const inputs = { Assets: [1000, 1100], Liabilities: [650, 700], StockholdersEquity: [350, 400],
    CashAndCashEquivalentsAtCarryingValue: [80, 100], AssetsCurrent: [300, 350], LiabilitiesCurrent: [200, 220], InventoryNet: [60, 70],
    LongTermDebtNoncurrent: [300, 320], DebtCurrent: [30, 40], Revenues: [500, 600], NetIncomeLoss: [50, 65],
    OperatingIncomeLoss: [90, 100], InterestExpense: [15, 20], NetCashProvidedByUsedInOperatingActivities: [75, 90] };
  const flows = new Set(['Revenues', 'NetIncomeLoss', 'OperatingIncomeLoss', 'InterestExpense', 'NetCashProvidedByUsedInOperatingActivities']);
  return { 'us-gaap': Object.fromEntries(Object.entries(inputs).map(([tag, values]) => [tag, { units: { USD: values.map((val, index) => {
    const fy = 2023 + index, end = `${fy}-${month}-${month === '12' ? '31' : '30'}`;
    return { val: val * multiplier, fy, fp: 'FY', form: '10-K', start: flows.has(tag) ? month === '12' ? `${fy}-01-01` : `${fy - 1}-07-01` : undefined,
      end, filed: `${fy + 1}-02-01`, accn: `0000000001-${23 + index}-000001` };
  }) } }])) };
}
function compare(ticker, { basis = 'annual', asOf = '' } = {}, data = facts(ticker === 'AAA' ? 1 : 2)) {
  return packAnalysisCompany(buildCompareCompany({ ticker, cik: identities[ticker].cik, companyName: identities[ticker].name,
    sic: '3571', facts: data, filings: [], historyLimited: false }, { basis, asOf }));
}
function risk(ticker = 'AAA', data = facts()) {
  return { ticker, cik: identities[ticker].cik, companyName: identities[ticker].name, sic: '3571', version: RISK_VERSION,
    generatedAt: '2025-03-01T00:00:00Z', annual: decorateRiskProfile(assessRisk(data, '3571', identities[ticker].cik)),
    current: decorateRiskProfile(assessRisk(data, '3571', identities[ticker].cik, { basis: 'ttm' })) };
}
function harness(dependencies = {}, overrides = {}) {
  const sources = [], lookups = [], remembered = new Set(), controller = new AbortController();
  const api = { dependencies, context: {}, preview: false,
    tool: (description, properties, status, execute) => ({ description, properties, status, execute }),
    stringSchema: description => ({ type: 'string', minLength: 1, description }), enumeration: values => ({ type: 'string', enum: values }),
    read: async (key, work) => { lookups.push(key); return work(controller.signal); },
    resolve: async identifier => identities[identifier] ? { identity: identities[identifier] } : { status: 'needs_selection', choices: [] },
    rememberCompany: identity => { remembered.add(identity.cik); assert.ok(remembered.size <= 2); return identity; },
    addSource: (title, url, asOf) => { if (!url) return null; const found = sources.find(s => s.url === url); if (found) return found.id;
      const id = `S${sources.length + 1}`; sources.push({ id, title, url, asOf }); return id; },
    fail: (message, code) => Object.assign(new Error(message), { researchCode: code }),
    unavailable: (reason, code, detail = {}) => ({ status: 'unavailable', reason, code, ...detail }),
    txt: (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : '',
    finite: value => typeof value === 'number' && Number.isFinite(value) ? value : null,
    ...overrides,
  };
  return { tools: createCompanyChatTools(api), sources, lookups, remembered, controller };
}
const request = { first: 'AAA', second: 'BBB', basis: 'annual', asOf: '', metric: 'operatingCashFlow', alignment: 'common', period: '' };

test('comparison shares existing deterministic calculations, validates periods and preserves percentage units', async () => {
  const settings = [], h = harness({ companyComparison: async (input, signal) => { settings.push(input); assert.ok(signal instanceof AbortSignal); return { payload: compare(input.ticker, input) }; } });
  const result = await h.tools.company_comparison.execute(request), row = result.metrics[0];
  assert.equal(result.selectedBucket, '2024'); assert.equal(result.reportingEndSpanDays, 0);
  assert.deepEqual(settings.map(s => s.basis), ['annual', 'annual']);
  assert.equal(row.firstMinusSecond, -90); assert.equal(row.unit, 'USD'); assert.equal(row.comparable, true);
  assert.equal(row.points[0].period.start, '2024-01-01'); assert.equal(row.points[0].value, 90);
  assert.ok(Math.abs(row.points[0].yearOverYear.value - 20) < 1e-10); assert.equal(row.points[0].yearOverYear.unit, '%');
  assert.ok(row.points[0].sourceIds.length); assert.equal(h.remembered.size, 2);
  const ratios = await h.tools.company_comparison.execute({ ...request, metric: 'equityAssets' });
  assert.equal(ratios.metrics[0].unit, '%'); assert.equal(ratios.metrics[0].differenceUnit, 'pp');
  assert.ok(Math.abs(ratios.metrics[0].points[0].value - 400 / 1100 * 100) < 1e-10);
});

test('incompatible fiscal year ends remain inspectable but never produce a difference or ranking', async () => {
  const h = harness({ companyComparison: async input => ({ payload: compare(input.ticker, input, facts(1, input.ticker === 'AAA' ? '12' : '06')) }) });
  const result = await h.tools.company_comparison.execute(request), row = result.metrics[0];
  assert.equal(row.comparable, false); assert.equal(row.firstMinusSecond, null);
  assert.match(row.comparisonReason, /45 days/); assert.ok(result.reportingEndSpanDays > 45);
  assert.ok(row.points.every(p => p.value === 90));
});

test('cutoff and selected bucket reach the Compare loader without substituting a newer filing', async () => {
  const h = harness({ companyComparison: async input => ({ payload: compare(input.ticker, input) }) });
  const result = await h.tools.company_comparison.execute({ ...request, asOf: '2024-06-01', period: '2023' });
  assert.equal(result.selectedBucket, '2023'); assert.equal(result.filingCutoff, '2024-06-01');
  assert.equal(result.metrics[0].points[0].period.end, '2023-12-31');
  assert.ok(h.lookups.every(key => key.endsWith(':2024-06-01')));
  await assert.rejects(h.tools.company_comparison.execute({ ...request, asOf: '2024-02-30' }), /valid filing cutoff/);
  await assert.rejects(h.tools.company_comparison.execute({ ...request, asOf: '2999-01-01' }), /valid filing cutoff/);
  await assert.rejects(h.tools.company_comparison.execute({ ...request, period: '2024-Q2' }), /bucket/);
});

test('missing, zero and negative bases retain distinct meanings and never invent growth', async () => {
  const cases = [null, 0, -1];
  for (const value of cases) {
    const h = harness({ companyComparison: async input => {
      const data = facts();
      if (value === null) delete data['us-gaap'].NetCashProvidedByUsedInOperatingActivities;
      else data['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD[0].val = value;
      return { payload: compare(input.ticker, input, data) };
    } });
    const row = (await h.tools.company_comparison.execute(request)).metrics[0];
    assert.equal(row.points[0].yearOverYear.value, null);
    if (value === null) { assert.equal(row.points[0].value, null); assert.equal(row.firstMinusSecond, null); }
    else { assert.equal(row.points[0].yearOverYear.priorValue, value); assert.match(row.points[0].yearOverYear.reason, /zero or negative/); }
  }
});

test('different company, basis or cutoff returned by an adapter is rejected', async () => {
  for (const mismatch of [{ cik: '0000000008' }, { ticker: 'WRONG' }, { basis: 'ttm' }, { asOf: '2023-01-01' }]) {
    const h = harness({ companyComparison: async input => ({ payload: { ...compare(input.ticker, input), ...mismatch } }) });
    await assert.rejects(h.tools.company_comparison.execute(request), error => error.researchCode === 'SOURCE_IDENTITY_MISMATCH');
    assert.equal(h.sources.length, 0);
  }
});

test('same issuer, ambiguous identity and unsupported metrics do not start financial reads', async () => {
  const h = harness({ companyComparison: async () => assert.fail('No source read expected.') });
  assert.equal((await h.tools.company_comparison.execute({ ...request, second: 'AAA' })).status, 'unavailable');
  assert.equal((await h.tools.company_comparison.execute({ ...request, second: 'Ambiguous' })).status, 'needs_selection');
  assert.equal((await h.tools.company_comparison.execute({ ...request, metric: 'notAMetric' })).code, 'TOOL_INVALID_INPUT');
  assert.equal(h.lookups.length, 0);
});

test('source-less legacy observations cannot enter chat comparison calculations', async () => {
  const h = harness({ companyComparison: async input => {
    const data = compare(input.ticker, input);
    data.metrics.operatingCashFlow = data.metrics.operatingCashFlow.map(p => ({ ...p, sourceIds: [], classification: undefined }));
    return { payload: data };
  } });
  const row = (await h.tools.company_comparison.execute(request)).metrics[0];
  assert.equal(row.firstMinusSecond, null); assert.equal(row.points[0].value, null); assert.equal(row.points[0].yearOverYear.value, null);
});

test('unavailable selected calendar bucket never substitutes the latest company period', async () => {
  const h = harness({ companyComparison: async input => ({ payload: compare(input.ticker, input) }) });
  const result = await h.tools.company_comparison.execute({ ...request, period: '2020' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.requestedBucket, '2020'); assert.match(result.reason, /No newer period/);
  assert.equal(h.sources.length, 0);
});

test('matching Compare page selections inherit cutoff and calendar bucket; unrelated peers do not', async () => {
  const seen = [], dependencies = { companyComparison: async input => { seen.push(input); return { payload: compare(input.ticker, input) }; } };
  const h = harness(dependencies, { context: { compareTickers: ['BBB', 'AAA'], period: '2023', asOf: '2024-06-01' } });
  const result = await h.tools.company_comparison.execute(request);
  assert.equal(result.filingCutoff, '2024-06-01'); assert.equal(result.selectedBucket, '2023');
  assert.ok(seen.every(s => s.asOf === '2024-06-01'));
  const unrelated = harness(dependencies, { context: { compareTickers: ['AAA', 'CCC'], period: '2023', asOf: '2024-06-01' } });
  const other = await unrelated.tools.company_comparison.execute(request);
  assert.equal(other.filingCutoff, null); assert.equal(other.selectedBucket, '2024');
});

test('future source filings are unavailable even if adapter echoes the requested cutoff correctly', async () => {
  const h = harness({ companyComparison: async input => {
    const data = compare(input.ticker, { ...input, asOf: '' }); data.asOf = input.asOf;
    return { payload: data };
  } });
  const result = await h.tools.company_comparison.execute({ ...request, asOf: '2024-06-01' }), row = result.metrics[0];
  assert.equal(row.points[0].value, null); assert.equal(row.firstMinusSecond, null); assert.equal(row.points[0].yearOverYear.value, null);
  assert.match(row.points[0].reason, /filed by the selected cutoff/);
});

test('Risk tool uses the current page lens and meaningful source-backed dimensions without academic scores', async () => {
  const h = harness({ companyRisk: async input => { assert.equal(input.cik, identities.AAA.cik); return risk(); } });
  const result = await h.tools.company_risk.execute({ identifier: 'AAA', basis: 'annual', asOf: '' });
  assert.equal(result.lens.id, 'corporate'); assert.equal(result.period.end, '2024-12-31');
  const ratio = result.metrics.find(m => m.key === 'interest_coverage');
  assert.equal(ratio.value, 5); assert.equal(ratio.unit, 'x'); assert.ok(ratio.sourceIds.length);
  assert.equal(result.metrics.find(m => m.key === 'cash_to_assets').unit, 'fraction');
  assert.ok(result.strengths.length); assert.ok(result.strengths.every(s => s.sourceIds.length));
  assert.ok(result.metrics.every(m => !/z_score|beneish|zmijewski/.test(m.key)));
  assert.match(result.interpretation, /not establish a credit rating/);
});

test('Risk historical cutoffs are explicitly unavailable, never silently replaced with current data', async () => {
  const h = harness({ companyRisk: async () => assert.fail('No current risk read for a historical request.') });
  const result = await h.tools.company_risk.execute({ identifier: 'AAA', basis: 'annual', asOf: '2024-06-01' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.requestedCutoff, '2024-06-01'); assert.equal(h.lookups.length, 0);
});

test('Risk inherits the selected company cutoff but leaves another company current', async () => {
  const h = harness({ companyRisk: async input => risk(input.ticker) }, { context: { company: 'AAA', asOf: '2024-06-01' } });
  const selected = await h.tools.company_risk.execute({ identifier: 'AAA', basis: 'annual', asOf: '' });
  assert.equal(selected.status, 'unavailable'); assert.equal(selected.requestedCutoff, '2024-06-01'); assert.equal(h.lookups.length, 0);
  const another = await h.tools.company_risk.execute({ identifier: 'BBB', basis: 'annual', asOf: '' });
  assert.equal(another.status, 'ready'); assert.equal(h.lookups.length, 1);
});

test('Risk identity, supported version and basis are verified before publishing numbers', async () => {
  for (const mismatch of [{ cik: '0000000002' }, { ticker: 'BBB' }, { version: 'legacy' }, { annual: { ...risk().annual, basis: 'ttm' } }]) {
    const h = harness({ companyRisk: async () => ({ ...risk(), ...mismatch }) });
    await assert.rejects(h.tools.company_risk.execute({ identifier: 'AAA', basis: 'annual', asOf: '' }), /source did not match/);
    assert.equal(h.sources.length, 0);
  }
});

test('native Risk reader uses the existing cache without additional fetches or persistent writes', async () => {
  const cached = risk();
  const result = await loadChatCompanyRisk({ ticker: 'AAA', cik: identities.AAA.cik }, new AbortController().signal, {
    read: async (family, ticker) => { assert.equal(family, RISK_VERSION); assert.equal(ticker, 'AAA'); return cached; },
    source: async () => assert.fail('Cached Risk must not read source data.'),
  });
  assert.equal(result, cached);
});

test('cold native Risk reuses validated SEC sources, passes cancellation and performs no language crawl', async () => {
  const controller = new AbortController(), paths = [];
  const result = await loadChatCompanyRisk({ ticker: 'AAA', cik: identities.AAA.cik }, controller.signal, {
    read: async () => null,
    source: async (path, signal) => { paths.push(path); assert.equal(signal, controller.signal);
      return path.includes('companyfacts') ? { cik: 1, facts: facts() }
        : { cik: 1, sic: '3571', name: 'First company', filings: { recent: { accessionNumber: [], form: [], filingDate: [], reportDate: [], primaryDocument: [] } } }; },
    loadFiling: async () => assert.fail('No primary filing available for optional supplementation.'),
  });
  assert.equal(paths.length, 2); assert.equal(result.annual.basis, 'annual'); assert.equal(result.current.basis, 'ttm');
  assert.equal(result.annual.metrics.find(m => m.id === 'interest_coverage').value, 5);
  controller.abort(new Error('Shared research deadline'));
  await assert.rejects(loadChatCompanyRisk({ ticker: 'AAA', cik: identities.AAA.cik }, controller.signal, {
    read: async () => assert.fail('Aborted work must not read cache.'),
  }), /Shared research deadline/);
});

test('preview adapters use fixed public paths and bounded shared signals', async () => {
  const paths = [], h = harness({}, { preview: true, publicJson: async (path, settings, signal) => {
    paths.push(path); assert.ok(signal instanceof AbortSignal);
    return { payload: path === '/api/risk' ? risk(settings.ticker) : compare(settings.ticker, settings) };
  } });
  await h.tools.company_comparison.execute(request);
  await h.tools.company_risk.execute({ identifier: 'AAA', basis: 'annual', asOf: '' });
  assert.deepEqual(paths, ['/api/compare-research', '/api/compare-research', '/api/risk']);
});
