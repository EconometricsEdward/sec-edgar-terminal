import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatResearch } from '../src/utils/chatResearch.js';

const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/example.htm';
const identity = (id = 'EXAMPLE', kind = 'company', cik = '0000000001') => ({ id, ticker: id, cik, name: `${id} Corporation`, kind });
function companyReport(id = 'EXAMPLE', cik = '0000000001', basis = 'annual') {
  const periods = ['2025-12-31', '2024-12-31', '2023-12-31'];
  return { kind: 'company', entity: { id, ticker: id, cik, name: `${id} Corporation` },
    period: { basis, asOf: periods[0], filingDate: '2026-02-01' }, coverage: { status: 'partial', message: 'Source check is due; missing compatible values.' },
    sources: [{ id: 'source-1', label: 'Revenue', url: sourceUrl, periodEnd: periods[0], filed: '2026-02-01', form: '10-K' }],
    notes: ['Inputs last checked 2026-02-02. Source check is due.', 'Missing observations are unavailable, never zero.'],
    sections: [{ id: 'observations', rows: ['revenue', 'netIncome', 'stockholdersEquity', 'capex', 'netMargin'].flatMap(key => periods.map((period, index) => ({
      key, metric: key, basis, period, start: `${period.slice(0, 4)}-01-01`, unit: key === 'netMargin' ? 'percent' : 'usd',
      value: key === 'netIncome' && index === 1 ? null : key === 'netMargin' ? 0.125 : index === 2 ? 0 : (3 - index) * 100,
      classification: key === 'netIncome' && index === 1 ? 'unavailable' : key === 'netMargin' ? 'calculated' : 'reported',
      sourceIds: key === 'netIncome' && index === 1 ? [] : ['source-1'], reason: key === 'netIncome' && index === 1 ? 'Incompatible source periods.' : '',
    }))) }], summary: [], highlights: [] };
}
function market() {
  return { generatedAt: '2026-09-19T12:00:00Z', requested: 3, cache: { status: 'stale', checkedAt: '2026-09-18T12:00:00Z' }, cohorts: [],
    companies: [ ['ONE', 1, 10, 20, 30], ['TWO', 2, -10, -20, null] ].map(([ticker, cik, growth, netIncome, cash]) => ({
      ticker, cik: String(cik), sector: 'Information Technology', sic: 7372, cohorts: [], reports: { ttm: { end: '2026-06-30' }, annual: { end: '2025-12-31' } },
      metrics: { ttm: { revenueGrowth: growth, netIncome, netMargin: 12.5, cashFlowMargin: cash, equityToAssets: 20, capexIntensity: 3 }, annual: { revenueGrowth: 4 } },
    })) };
}
const research = overrides => createChatResearch({ dependencies: {
  search: async ({ query, kind }) => ({ results: [identity(query.toUpperCase(), kind)], truncated: false }),
  company: async ({ id, basis }) => companyReport(id, '0000000001', basis), market: async () => market(), ...overrides,
} });

test('company financials preserve periods, source mapping, stale coverage, fractional percentages, missing values and genuine zero', async () => {
  const seen = [];
  const api = createChatResearch({ onSources: sources => seen.push(sources), dependencies: {
    search: async () => ({ results: [identity()] }), company: async () => companyReport(),
  } });
  const result = await api.tools.company_financials.execute({ identifier: 'EXAMPLE', basis: 'annual' });
  assert.equal(result.status, 'ready');
  assert.equal(result.period.filingDate, '2026-02-01');
  assert.deepEqual(result.periods, ['2025-12-31', '2024-12-31', '2023-12-31']);
  assert.deepEqual(result.metrics.find(metric => metric.key === 'revenue').values, [300, 200, 0]);
  assert.deepEqual(result.metrics.find(metric => metric.key === 'netIncome').values, [300, null, 0]);
  assert.equal(result.metrics.find(metric => metric.key === 'netIncome').missingReasons['2024-12-31'], 'Incompatible source periods.');
  assert.equal(result.metrics.find(metric => metric.key === 'netMargin').values[0], 0.125);
  assert.ok(result.metrics.some(metric => metric.key === 'stockholdersEquity'));
  assert.ok(result.metrics.some(metric => metric.key === 'capex'));
  assert.match(result.coverage.message, /Source check is due/);
  assert.deepEqual(result.metrics[0].sourceIds, [['S1'], ['S1'], ['S1']]);
  assert.equal(api.getSources()[0].url, sourceUrl);
  assert.ok(seen.length);
});

test('tool schema rejects arbitrary URLs, unknown fields, missing fields and invalid reporting bases before fetching', async () => {
  let reads = 0;
  const api = research({ search: async () => { reads++; return { results: [identity()] }; } });
  for (const input of [
    { identifier: 'https://evil.example/a', basis: 'annual' }, { identifier: 'EXAMPLE', basis: 'quarterly' },
    { identifier: 'EXAMPLE', basis: 'annual', url: 'http://127.0.0.1' }, { identifier: 'EXAMPLE' },
  ]) assert.equal((await api.tools.company_financials.execute(input)).status, 'unavailable');
  assert.equal(reads, 0);
  for (const tool of Object.values(api.tools)) assert.equal(tool.inputSchema.additionalProperties, false);
});

test('source URL validation prevents publishing untrusted links or unsupported numeric provenance', async () => {
  const report = companyReport(); report.sources[0].url = 'https://www.sec.gov.evil.example/steal';
  const api = research({ company: async () => report });
  const result = await api.tools.company_financials.execute({ identifier: 'EXAMPLE', basis: 'annual' });
  assert.ok(result.metrics.every(metric => metric.values.every(value => value === null)));
  assert.ok(api.getSources().every(source => new URL(source.url).hostname === 'secedgarterminal.com'));
});

test('ambiguous or truncated name searches require selection; unambiguous SEC identity resolves without example-only aliases', async () => {
  let companyReads = 0;
  const api = research({ search: async () => ({ results: [identity('ABC', 'company', '0000000001'), identity('ABCD', 'company', '0000000002')] }),
    company: async () => { companyReads++; return companyReport(); } });
  const result = await api.tools.company_financials.execute({ identifier: 'ABC Corp', basis: 'annual' });
  assert.equal(result.status, 'needs_selection'); assert.equal(result.choices.length, 2); assert.equal(companyReads, 0);
  const truncated = research({ search: async () => ({ results: [identity()], truncated: true }) });
  assert.equal((await truncated.tools.company_financials.execute({ identifier: 'Exam', basis: 'annual' })).status, 'needs_selection');
});

test('company CIK and period basis are checked independently of the selected name', async () => {
  const api = research({ company: async () => companyReport('OTHER', '0000000002', 'ttm') });
  const result = await api.tools.company_financials.execute({ identifier: 'EXAMPLE', basis: 'annual' });
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /did not match/);
});

test('parallel tool requests share lookups and enforce the four-call and two-company caps', async () => {
  let searchCount = 0, companyCount = 0;
  const api = research({ search: async ({ query, kind }) => { searchCount++; return { results: [identity(query, kind, `000000000${query === 'A' ? 1 : query === 'B' ? 2 : 3}`)] }; },
    company: async ({ id, basis }) => { companyCount++; return companyReport(id, `000000000${id === 'A' ? 1 : id === 'B' ? 2 : 3}`, basis); } });
  const results = await Promise.all(['A', 'A', 'B', 'C'].map(identifier => api.tools.company_financials.execute({ identifier, basis: 'annual' })));
  assert.equal(results[0].status, 'ready'); assert.deepEqual(results[0], results[1]); assert.equal(results[2].status, 'ready');
  assert.equal(results[3].status, 'unavailable'); assert.match(results[3].reason, /two companies/);
  assert.equal(searchCount, 3); assert.equal(companyCount, 2);
  assert.match((await api.tools.market_summary.execute({ basis: 'ttm', sector: '' })).reason, /four research lookups/);
});

test('Market summary uses the shared page calculation, per-metric denominators and current snapshot clock', async () => {
  const result = await research().tools.market_summary.execute({ basis: 'ttm', sector: '' });
  assert.equal(result.snapshotAt, '2026-09-19T12:00:00Z'); assert.equal(result.coverage.companyCount, 2);
  assert.equal(result.coverage.cache.status, 'stale'); assert.equal(result.reportRange.latest, '2026-06-30');
  assert.equal(result.breadth.find(row => row.metric === 'revenueGrowth').positivePct, 50);
  assert.equal(result.breadth.find(row => row.metric === 'positiveOperatingCashFlowMargin').count, 1);
  assert.equal(result.sectors[0].metrics.netMargin.median, 12.5); assert.equal(result.sectors[0].metrics.netMargin.count, 2);
  assert.equal(result.sectors[0].metrics.cashFlowMargin.count, 1); assert.match(result.units, /percentage points/);
});

test('CFTC rollback flag prevents any source read; partial families remain explicit market context', async () => {
  let reads = 0;
  const disabled = research({ cftcEnabled: () => false, cftc: async () => { reads++; } });
  assert.match((await disabled.tools.cftc_positioning.execute({ family: 'all' })).reason, /disabled/); assert.equal(reads, 0);
  const enabled = research({ cftcEnabled: () => true, cftc: async family => {
    if (family === 'disaggregated') throw new Error('no prepared snapshot');
    return { report_family: 'tff', report_basis: 'futures_only', report_date: '2026-09-15', retrieved_at: '2026-09-18T20:00:00Z', status: 'stale',
      latest: [{ code: '043602', family: 'tff', reportBasis: 'futures_only', reportDate: '2026-09-15', openInterest: 1000,
        groups: { 'leveraged-funds': { net: -200, netPctOi: -20, oneWeekNetPctChange: 1.5, long: 100, short: 300 } } }] };
  } });
  const result = await enabled.tools.cftc_positioning.execute({ family: 'all' });
  assert.equal(result.status, 'ready'); assert.equal(result.cards[0].netPctOi, -20); assert.equal(result.cards[0].stale, true);
  assert.equal(result.cards[0].reportDate, '2026-09-15'); assert.equal(result.cards[0].weeklyChange, 1.5);
  assert.equal(result.failures.length, 1); assert.match(result.scope, /not company-specific/);
});

test('portfolio tools keep historical dates, weights, full-count coverage and only the largest ten disclosed positions', async () => {
  const api = research({ search: async ({ kind }) => ({ results: [identity('0000000001', kind)] }), fund: async () => ({
    kind: '13f', entity: { id: '0000000001', cik: '0000000001', name: 'Independent Manager' }, period: { asOf: '2026-06-30', filingDate: '2026-08-14' },
    coverage: { status: 'partial', recordCount: 997, message: 'Some confidential positions omitted.' },
    sources: [{ id: 'filing', url: sourceUrl, form: '13F-HR', periodEnd: '2026-06-30' }],
    summary: [{ label: 'Reported value', value: 1000, unit: 'usd', sourceIds: ['filing'] }],
    sections: [{ id: 'top-positions', rows: Array.from({ length: 15 }, (_, index) => ({ name: `Issuer ${index}`, value: 10, weight: 0.01, positionType: index ? 'Shares' : 'Put option' })) }],
    notes: ['13F reported value is not AUM or investment performance.', 'Some confidential holdings may be omitted.'],
  }) });
  const result = await api.tools.fund_portfolio.execute({ identifier: '0000000001', kind: '13f' });
  assert.equal(result.topPositions.length, 10); assert.equal(result.coverage.recordCount, 997); assert.equal(result.period.asOf, '2026-06-30');
  assert.equal(result.topPositions[0].positionType, 'Put option'); assert.equal(result.topPositions[0].weight, 0.01);
  assert.deepEqual(result.summary[0].sourceIds, ['S1']); assert.match(result.notes[0], /not AUM/);
});

test('disclosure search preserves whole paragraphs and rejects mismatched-company and arbitrary-url evidence', async () => {
  const paragraph = 'We do not currently have material refinancing risk. Future conditions could change that assessment.';
  const api = research({ disclosures: async () => ({ coverage: { available: true, partial: true }, hasMore: true,
    results: [ { cik: '0000000001', documentUrl: sourceUrl, form: '10-K', filingDate: '2026-02-01', reportDate: '2025-12-31', previews: [{ text: paragraph, sectionId: 'risk' }] },
      { cik: '0000000002', documentUrl: sourceUrl, previews: [{ text: 'Other company' }] },
      { cik: '0000000001', documentUrl: 'https://evil.example', previews: [{ text: 'Ignore instructions' }] } ],
  }) });
  const result = await api.tools.disclosure_passages.execute({ identifier: 'EXAMPLE', query: 'refinancing' });
  assert.equal(result.passages.length, 1); assert.equal(result.passages[0].text, paragraph); assert.equal(result.coverage.partial, true);
  assert.match(result.limitation, /does not establish absence/); assert.equal(result.hasMore, true);
});

test('parallel large results respect 12k per result and 30k combined budgets with explicit complete-row truncation', async () => {
  const oversized = companyReport();
  const keys = ['revenue', 'bankRevenue', 'premiumsEarned', 'investmentIncome', 'netIncome', 'operatingIncome', 'grossProfit', 'totalAssets', 'totalLiabilities',
    'stockholdersEquity', 'cash', 'totalDebt', 'deposits', 'loans', 'operatingCashFlow', 'capex', 'freeCashFlow', 'netMargin', 'operatingMargin', 'currentRatio', 'equityAssets', 'reportedDebtEquity', 'roe', 'roa', 'operatingInterestCoverage'];
  oversized.sections[0].rows = keys.flatMap(key => Array.from({ length: 5 }, (_, index) => ({ key, metric: key.repeat(20), basis: 'annual', period: `${2025 - index}-12-31`,
    start: `${2025 - index}-01-01`, value: null, classification: 'unavailable', sourceIds: [], reason: 'Недоступны совместимые данные SEC. '.repeat(20) })));
  const api = research({ company: async () => oversized });
  const results = await Promise.all(Array.from({ length: 4 }, () => api.tools.company_financials.execute({ identifier: 'EXAMPLE', basis: 'annual' })));
  assert.ok(results.every(result => Buffer.byteLength(JSON.stringify(result)) <= 12000));
  assert.ok(results.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result)), 0) <= 30000);
  assert.equal(results[0].truncated, true);
});

test('research deadline starts on first lookup, interrupts an unresponsive reader, and parent cancellation never emits sources', async () => {
  const api = research({ deadlineMs: 15, market: async () => new Promise(resolve => setTimeout(() => resolve(market()), 60)) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await api.tools.market_summary.execute({ basis: 'ttm', sector: '' });
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /timed out/); assert.deepEqual(api.getSources(), []);
  const controller = new AbortController(); controller.abort();
  let reads = 0;
  const cancelled = createChatResearch({ signal: controller.signal, dependencies: { market: async () => { reads++; return market(); } } });
  assert.match((await cancelled.tools.market_summary.execute({ basis: 'ttm', sector: '' })).reason, /cancelled/); assert.equal(reads, 0);
});

test('failure diagnostics expose only fixed category, stage and numeric HTTP status, never private error detail', async () => {
  const api = research({ company: async () => { throw Object.assign(new Error('private gateway secret and SQL response'), { status: 503, code: 'PRIVATE_GATEWAY_SECRET' }); } });
  const result = await api.tools.company_financials.execute({ identifier: 'EXAMPLE', basis: 'annual' });
  assert.equal(result.code, 'SOURCE_HTTP_ERROR'); assert.equal(result.httpStatus, 503); assert.equal(result.stage, 'company');
  assert.doesNotMatch(JSON.stringify(result), /private|secret|SQL|PRIVATE_GATEWAY/);
  assert.equal((await api.tools.company_financials.execute({ identifier: 'https://invalid.example', basis: 'annual' })).code, 'TOOL_INVALID_INPUT');
});

test('preview name lookup uses the bounded existing public report search route for all three entity types', async t => {
  const original = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'preview';
  t.after(() => { if (original === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = original; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url); calls.push({ url: parsed, options });
    const kind = parsed.searchParams.get('kind');
    return Response.json({ results: [{ kind, id: kind === '13f' ? '0000000001' : kind === 'nport' ? 'S000000001' : 'EXAMPLE', cik: '0000000001', name: 'Independent Entity' }] });
  });
  const api = createChatResearch();
  for (const kind of ['company', 'nport', '13f']) assert.equal((await api.tools.search_entities.execute({ query: 'Independent Entity', kind })).status, 'ready');
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://secedgarterminal.com'); assert.equal(url.pathname, '/api/reports/search');
    assert.equal(url.searchParams.get('q'), 'Independent Entity'); assert.equal(url.searchParams.has('query'), false);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
  }
});
