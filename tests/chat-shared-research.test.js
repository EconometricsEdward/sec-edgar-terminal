import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedChatTools } from '../src/utils/chatSharedResearch.js';
import { SCENARIO_DEFAULTS } from '../src/utils/analysisScenarios.js';
import { packAnalysisCompany } from '../src/utils/analysisResearch.js';

const filing = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/example.htm';
const identity = { id: 'EXAMPLE', ticker: 'EXAMPLE', cik: '0000000001', name: 'Example Company' };
const period = { start: '2025-01-01', end: '2025-12-31', kind: 'annual' };
const scenario = (assumptions = {}, extra = {}) => ({ kind: 'analysis-scenario', ticker: 'EXAMPLE', basis: 'annual',
  end: period.end, asOf: '', assumptions: { ...SCENARIO_DEFAULTS, ...assumptions }, ...extra });
function data(extra = {}) {
  const fields = [
    ['revenue', 1000, 'RevenueFromContractWithCustomerExcludingAssessedTax', true],
    ['operatingIncome', 200, 'OperatingIncomeLoss', true],
    ['netIncome', 120, 'NetIncomeLoss', true],
    ['operatingCashFlow', 180, 'NetCashProvidedByUsedInOperatingActivities', true],
    ['capex', 60, 'PaymentsToAcquirePropertyPlantAndEquipment', true],
    ['cash', 100, 'CashAndCashEquivalentsAtCarryingValue'],
    ['totalAssets', 800, 'Assets'],
    ['stockholdersEquity', 300, 'StockholdersEquity'],
    ['shortTermDebt', 50, 'DebtCurrent'],
    ['longTermDebt', 200, 'LongTermDebtNoncurrent'],
    ['deposits', 400, 'Deposits'],
  ];
  return { ticker: 'EXAMPLE', cik: '1', name: 'Example Company', basis: 'annual', asOf: '', lens: 'corporate', periods: [period],
    definitions: fields.map(([key]) => ({ key, label: key, format: 'currency' })),
    metrics: Object.fromEntries(fields.map(([key, value, tag, flow]) => [key, [{ value, period, classification: 'reported',
      sources: [{ taxonomy: 'us-gaap', tag, value, unit: 'USD', start: flow ? period.start : null, end: period.end,
        form: '10-K', filed: '2026-02-01', documentUrl: filing }] }]])), ...extra };
}
function harness(sharedContext, dependencies = {}) {
  const sources = [], reads = [], lookups = [];
  const tools = createSharedChatTools({ sharedContext, dependencies,
    enumeration: values => ({ type: 'string', enum: values }),
    tool: (description, properties, status, execute) => ({ description, properties, status, execute }),
    read: (key, work) => { reads.push(key); return work(new AbortController().signal); },
    resolve: async query => { lookups.push(query); return { identity }; },
    rememberCompany: value => value,
    addSource: (title, url, asOf) => {
      if (typeof url !== 'string' || !url.startsWith('https://')) return null;
      const match = sources.find(source => source.url === url);
      if (match) return match.id;
      const id = `S${sources.length + 1}`;
      sources.push({ id, title, url, asOf }); return id;
    },
    fail: (message, code) => Object.assign(new Error(message), { researchCode: code }),
    unavailable: (reason, code, extra = {}) => ({ status: 'unavailable', reason, code, ...extra }),
    txt: (value, length = 600) => typeof value === 'string' ? value.slice(0, length) : '',
    finite: value => typeof value === 'number' && Number.isFinite(value) ? value : null,
  });
  return { run: kind => tools.shared_context.execute({ kind }), sources, reads, lookups };
}

test('private research requires an explicit validated snapshot and never reads a page automatically', async () => {
  for (const input of [undefined, null, { kind: 'portfolio', holdings: [{ ticker: 'EXAMPLE', weight: 9 }], totalHoldings: 1, coverageWeight: 9 }]) {
    const h = harness(input);
    const result = await h.run('portfolio');
    assert.equal(result.code, 'SHARED_CONTEXT_REQUIRED');
    assert.equal(h.reads.length, 0);
    assert.equal(h.lookups.length, 0);
    assert.equal(h.sources.length, 0);
  }
});

test('portfolio concentration is deterministic, computed only from user-shared weights and carries no fake citations', async () => {
  const h = harness({ kind: 'portfolio', holdings: [{ ticker: 'AAA', weight: 0.2 }, { ticker: 'BBB', weight: 0.8 }], totalHoldings: 2, coverageWeight: 1 });
  const result = await h.run('portfolio');
  assert.equal(result.status, 'ready');
  assert.equal(result.evidenceType, 'user-provided');
  assert.equal(result.holdings[0].ticker, 'BBB');
  assert.equal(result.concentration.largestSharedWeight, 0.8);
  assert.equal(result.concentration.topFiveSharedWeight, 1);
  assert.equal(result.concentration.fullPortfolioHHI, 0.68);
  assert.ok(Math.abs(result.concentration.effectiveHoldings - 1 / 0.68) < 1e-9);
  assert.deepEqual(result.sourceIds, []);
  assert.equal(h.reads.length + h.lookups.length + h.sources.length, 0);
  assert.match(result.limitations.join(' '), /not SEC-verified/);
});

test('partial and unweighted portfolios do not invent complete-portfolio allocation', async () => {
  const partial = await harness({ kind: 'portfolio', holdings: [{ ticker: 'AAA', weight: 0.3 }], totalHoldings: 30, coverageWeight: 0.3 }).run('portfolio');
  assert.equal(partial.complete, false);
  assert.equal(partial.coverageWeight, 0.3);
  assert.equal(partial.concentration.fullPortfolioHHI, null);
  assert.equal(partial.concentration.effectiveHoldings, null);
  const unweighted = await harness({ kind: 'portfolio', holdings: [{ ticker: 'AAA', weight: null }], totalHoldings: 1, coverageWeight: null }).run('portfolio');
  assert.equal(unweighted.status, 'ready');
  assert.equal(unweighted.concentration, null);
  assert.equal(unweighted.coverageWeight, null);
  assert.equal(unweighted.holdings[0].weight, null);
});

test('a different kind of shared view cannot be substituted by the model', async () => {
  const h = harness(scenario(), { sharedAnalysis: () => assert.fail('No source access allowed') });
  assert.equal((await h.run('portfolio')).code, 'SHARED_CONTEXT_MISMATCH');
});

test('scenario results are recomputed from exact SEC baseline and applied assumptions with source citations', async () => {
  const h = harness(scenario({ scenarioRevenue: -10, scenarioMargin: -2 }, { asOf: '2026-03-01' }), {
    sharedAnalysis: async (selection, signal) => {
      assert.deepEqual(selection, { ticker: 'EXAMPLE', basis: 'annual', asOf: '2026-03-01' });
      assert.ok(signal instanceof AbortSignal);
      return { payload: packAnalysisCompany(data({ asOf: '2026-03-01' })) };
    },
  });
  const result = await h.run('analysis-scenario');
  assert.equal(result.status, 'ready');
  assert.equal(result.evidenceType, 'verified-baseline-with-user-assumptions');
  assert.equal(result.period.end, '2025-12-31');
  const operating = result.sections.find(section => section.model === 'operating');
  assert.equal(operating.rows.find(row => row.key === 'Revenue').hypothetical, 900);
  assert.equal(operating.rows.find(row => row.key === 'OperatingIncome').hypothetical, 162);
  assert.equal(operating.rows.find(row => row.key === 'Margin').hypothetical, 18);
  assert.equal(operating.rows.find(row => row.key === 'Margin').unit, 'percentage points');
  assert.ok(operating.rows.every(row => row.sourceIds.length));
  assert.ok(h.sources.some(source => source.url === filing));
  assert.ok(h.sources.some(source => source.url.includes('end=2025-12-31') && source.url.includes('asOf=2026-03-01')));
  assert.match(result.limitations, /not reported results, a forecast/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000);
});

test('scenario cannot silently use another company, reporting basis or filing cutoff', async () => {
  for (const overrides of [{ cik: '2' }, { ticker: 'OTHER' }, { basis: 'quarter' }, { asOf: '2026-01-01' }]) {
    const h = harness(scenario(), { sharedAnalysis: async () => data(overrides) });
    await assert.rejects(h.run('analysis-scenario'), error => error.researchCode === 'SOURCE_IDENTITY_MISMATCH');
    assert.equal(h.sources.length, 0);
  }
});

test('a missing selected fiscal period is unavailable without switching to the newest period', async () => {
  const h = harness(scenario({}, { end: '2024-12-31' }), { sharedAnalysis: async () => data() });
  const result = await h.run('analysis-scenario');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.requestedEnd, '2024-12-31');
  assert.match(result.reason, /No newer or different period/);
  assert.equal(h.sources.length, 0);
});

test('incomplete scenario inputs remain missing while valid independent results survive', async () => {
  const baseline = data();
  baseline.metrics.operatingIncome[0] = { value: null, period, sources: [], reason: 'Operating income unavailable' };
  const result = await harness(scenario({ scenarioRevenue: -10 }), { sharedAnalysis: async () => baseline }).run('analysis-scenario');
  assert.equal(result.status, 'ready');
  const operating = result.sections.find(section => section.model === 'operating');
  assert.equal(operating.available, false);
  assert.deepEqual(operating.rows, []);
  assert.match(operating.reason, /unavailable/);
  assert.equal(result.sections.find(section => section.model === 'balance').rows.find(row => row.key === 'Assets').hypothetical, 800);
});

test('connected model preserves funding shortfall limitations, partial results and a bounded payload', async () => {
  const result = await harness(scenario({ scenarioCashMode: 'connected', scenarioWorkingCapital: 20 }), {
    sharedAnalysis: async () => data(),
  }).run('analysis-scenario');
  const connected = result.sections.find(section => section.model === 'connected');
  assert.equal(connected.rows.find(row => row.key === 'Cash').hypothetical, -100);
  assert.equal(connected.rows.find(row => row.key === 'FundingGap').hypothetical, 100);
  assert.equal(connected.rows.find(row => row.key === 'Assets').hypothetical, null);
  assert.match(connected.rows.find(row => row.key === 'Assets').reason, /unfunded shortfall/);
  assert.match(connected.method, /never added again/);
  assert.match(JSON.stringify(result.diagnostics), /funding shortfall/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000, `Payload too large: ${Buffer.byteLength(JSON.stringify(result))}`);
});

test('Analysis page links never replace missing or unsupported original filing citations', async () => {
  for (const documentUrl of [undefined, 'https://example.com/filing.htm', 'javascript:alert(1)', 'https://secedgarterminal.com/analysis/EXAMPLE']) {
    const baseline = data();
    for (const points of Object.values(baseline.metrics)) points[0].sources[0].documentUrl = documentUrl;
    const result = await harness(scenario(), { sharedAnalysis: async () => baseline }).run('analysis-scenario');
    assert.equal(result.status, 'unavailable');
    assert.ok(result.sections.every(section => section.rows.every(row => row.hypothetical === null && row.baseline === null)));
    assert.ok(result.sections.every(section => section.rows.every(row => row.sourceIds.length === 0)));
    assert.ok(result.sourceIds.length, 'Navigation link may remain available without establishing numeric evidence');
  }
});

test('scenario inputs filed after an explicit cutoff cannot establish baseline or hypothetical numbers', async () => {
  const h = harness(scenario({}, { asOf: '2026-01-15' }), { sharedAnalysis: async () => data({ asOf: '2026-01-15' }) });
  const result = await h.run('analysis-scenario');
  assert.equal(result.status, 'unavailable');
  for (const section of result.sections) for (const row of section.rows) {
    assert.equal(row.hypothetical, null);
    assert.equal(row.baseline, null);
    assert.match(row.reason, /filing cutoff/);
  }
  assert.ok(h.sources.every(source => source.url !== filing));
});
