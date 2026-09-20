import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBrowserResearch, BROWSER_RESEARCH_MAX_CHARS } from '../src/utils/chatBrowserResearch.js';
import { buildMarketSectorCompanies, pageMarketSectorCompanies } from '../src/utils/marketSectorCompanies.js';
import { QUANT_GROUPS } from '../src/utils/quantGroups.js';

const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm';
const identities = {
  ALPHA: { id: 'ALPHA', ticker: 'ALPHA', cik: '0000000001', name: 'Alpha Corporation' },
  BETA: { id: 'BETA', ticker: 'BETA', cik: '0000000002', name: 'Beta Corporation' },
  FUND: { id: 'FUND', ticker: 'FUND', cik: '0000000003', name: 'Independent Balanced Fund', seriesId: 'S000000001' },
  '0000000004': { id: '0000000004', cik: '0000000004', name: 'Independent Capital Management' },
};
function report(identity, basis, end = '2025-12-31') {
  return { kind: 'company', entity: identity, period: { basis, asOf: end, filingDate: '2026-02-15' },
    coverage: { status: 'partial', message: 'Cash is unavailable; a newer source check is due.' },
    sources: [{ id: 'source', url: sourceUrl, form: '10-K', filed: '2026-02-15', periodEnd: end }],
    sections: [{ id: 'observations', rows: [['revenue', 'Revenue', 1200000, 'usd'], ['netIncome', 'Net income', 0, 'usd'],
      ['netMargin', 'Net margin', 0.125, 'percent'], ['cash', 'Cash', null, 'usd']].map(([key, metric, value, unit]) => ({ key, metric, value, unit,
      period: end, basis, ...(key !== 'cash' ? { start: '2025-01-01' } : {}), classification: value === null ? 'unavailable' : 'reported',
      sourceIds: value === null ? [] : ['source'], reason: value === null ? 'No compatible cash input.' : '' })) }],
    notes: ['Missing inputs are unavailable, never zero.', 'Financial period and filing date are different.'] };
}
function fixture(extra = {}) {
  const reads = [];
  const dependencies = {
    search: async ({ query, kind }) => {
      reads.push(['search', query, kind]);
      const found = Object.values(identities).filter(identity => [identity.id, identity.ticker, identity.name, identity.seriesId].includes(query));
      return { results: found.map(identity => ({ ...identity, kind })) };
    },
    company: async ({ id, basis, end, asOf }) => {
      reads.push(['company', id, basis, end, asOf]);
      return report(identities[id], basis, end);
    },
    fund: async ({ id, kind, period, accession }) => {
      reads.push(['fund', id, kind, period, accession]);
      return { kind, entity: identities[id], period: { asOf: period || '2026-06-30', filingDate: '2026-08-14' },
        coverage: { status: 'partial', message: 'Some confidential positions may be omitted.' },
        summary: [{ label: kind === '13f' ? 'Reported securities value' : 'Fund-series net assets', value: 1000000, unit: 'usd', sourceIds: ['source'] }],
        sources: [{ id: 'source', url: sourceUrl, form: kind === '13f' ? '13F-HR' : 'NPORT-P', filed: '2026-08-14', accession }],
        sections: [{ id: 'top-positions', rows: [{ name: 'Example Holdings', value: 125000, weight: 0.125, positionType: 'Put option' }] }],
        notes: ['Historical reported positions; not investment performance.'] };
    },
    market: async () => {
      reads.push(['market']);
      return { generatedAt: '2026-09-19T12:00:00Z', requested: 2, cohorts: [], cache: { status: 'stale' }, companies: [
        { ticker: 'ALPHA', cik: '1', sector: 'Information Technology', sic: 7372, reports: { ttm: { end: '2026-06-30' } },
          metrics: { ttm: { revenueGrowth: 20, netIncome: 5, netMargin: 12.5, cashFlowMargin: 4 } } },
        { ticker: 'BETA', cik: '2', sector: 'Financials', sic: 6022, reports: { ttm: { end: '2026-03-31' } },
          metrics: { ttm: { revenueGrowth: -10, netIncome: -2, netMargin: -1, cashFlowMargin: null } } },
      ] };
    },
    cftcEnabled: () => true,
    cftc: async family => {
      reads.push(['cftc', family]);
      return { report_family: family, report_basis: 'futures_only', report_date: '2026-09-15', retrieved_at: '2026-09-18T20:00:00Z', status: 'stale',
        latest: family === 'tff' ? [{ code: '043602', family: 'tff', reportBasis: 'futures_only', reportDate: '2026-09-15', openInterest: 1000,
          groups: { 'leveraged-funds': { net: -200, netPctOi: -20, oneWeekNetPctChange: 1.5, long: 100, short: 300 } } }] : [] };
    },
    ...extra,
  };
  const ask = (content, context = {}, overrides = {}) => prepareBrowserResearch({ messages: [{ role: 'user', content }], context, dependencies, ...overrides });
  return { ask, reads, dependencies };
}

test('company summary preserves selected period/cutoff, dollar units, fractional percentages and real zero', async () => {
  const { ask, reads } = fixture();
  const result = await ask("Summarize ALPHA's financial results.", { path: '/analysis/ALPHA', query: 'basis=quarter&end=2025-12-31&asOf=2026-02-20' });
  assert.equal(result.status, 'ready');
  assert.equal(result.category, 'company');
  assert.ok(reads.some(row => row[0] === 'company' && row[2] === 'quarter' && row[3] === '2025-12-31' && row[4] === '2026-02-20'));
  assert.match(result.answer, /\$1,200,000/);
  assert.match(result.answer, /Net income:\*\* \$0/);
  assert.match(result.answer, /12\.5%/);
  assert.match(result.answer, /2025-01-01 to 2025-12-31/);
  assert.match(result.answer, /Coverage: Cash is unavailable/);
  assert.ok(result.sources.some(source => source.url === sourceUrl));
  assert.equal(result.evidence, result.answer);
});

test('named company from another page resolves actual entity without adopting the selected company', async () => {
  const { ask, reads } = fixture();
  const result = await ask('Summarize Beta Corporation financial results.', { path: '/analysis/ALPHA', query: 'basis=annual&end=2025-12-31' });
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /Beta Corporation/);
  assert.ok(reads.some(row => row[0] === 'search' && row[1] === 'Beta Corporation'));
  assert.ok(reads.some(row => row[0] === 'company' && row[1] === 'BETA' && row[3] === undefined));
  assert.ok(!reads.some(row => row[0] === 'company' && row[1] === 'ALPHA'));
});

test('subject after of or explain never falls through to the page company', async () => {
  for (const question of ['What is the debt of Beta Corporation?', 'Explain Beta Corporation liquidity.']) {
    const { ask, reads } = fixture();
    const result = await ask(question, { path: '/analysis/ALPHA' });
    assert.equal(result.status, 'ready', question);
    assert.match(result.answer, /Beta Corporation/, question);
    assert.ok(!reads.some(row => row[0] === 'company' && row[1] === 'ALPHA'), question);
  }
  const { ask, reads } = fixture();
  const unknown = await ask('Does Microsoft have less debt than the selected company?', { path: '/analysis/ALPHA' });
  assert.equal(unknown.status, 'needs_selection');
  assert.equal(reads.length, 0);
});

test('selected-company summary is not treated as a literal SEC entity name', async () => {
  const { ask, reads } = fixture();
  const result = await ask('Summarize the selected company.', { path: '/analysis/ALPHA' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(reads[0], ['search', 'ALPHA', 'company']);
});

test('instant financial metrics ignore inherited flow start dates', async () => {
  const { ask } = fixture({ company: async ({ id, basis }) => {
    const result = report(identities[id], basis);
    result.sections[0].rows.push({ key: 'totalAssets', metric: 'Total assets', value: 200, unit: 'usd', basis,
      period: '2025-12-31', start: '2025-01-01', classification: 'reported', sourceIds: ['source'] });
    return result;
  } });
  const result = await ask('Summarize ALPHA financial results.');
  assert.match(result.answer, /Total assets:\*\* \$200 \(at 2025-12-31\)/);
  assert.doesNotMatch(result.answer, /Total assets:\*\*.*2025-01-01/);
});

test('unknown or ambiguous named entity asks selection and never answers using page company', async () => {
  const { ask, reads } = fixture({ search: async () => ({ results: Object.values(identities).slice(0, 2).map(identity => ({ ...identity, kind: 'company' })) }) });
  const result = await ask('Summarize Unknown Industries financial results.', { path: '/analysis/ALPHA' });
  assert.equal(result.status, 'needs_selection');
  assert.match(result.answer, /ALPHA/);
  assert.match(result.answer, /BETA/);
  assert.equal(reads.length, 0);
  assert.equal(result.sources.length, 0);
});

test('generic current-page liquidity summary preserves missing values and does not invent debt', async () => {
  const { ask } = fixture();
  const result = await ask('Explain liquidity and debt trends.', { path: '/analysis/ALPHA' });
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /Cash:\*\* Unavailable/);
  assert.doesNotMatch(result.answer, /Total debt:\*\* \$0/);
});

test('page explanations and definitions perform no source fetches', async () => {
  const { ask, reads } = fixture();
  const help = await ask('Explain what this page shows.', { path: '/market' });
  assert.equal(help.category, 'help');
  assert.match(help.answer, /not stock returns/);
  const term = await ask('What is free cash flow?', { path: '/analysis/ALPHA' });
  assert.equal(term.category, 'definition');
  assert.match(term.answer, /compatible operating cash flow/);
  assert.equal(reads.length, 0);
});

test('historical natural-language and unsupported YTD requests do not silently fetch latest or annual', async () => {
  const { ask, reads } = fixture();
  const historical = await ask('Summarize ALPHA in 2023.', { path: '/analysis/ALPHA' });
  assert.equal(historical.status, 'needs_selection');
  const ytd = await ask('Summarize ALPHA.', { path: '/analysis/ALPHA', query: 'basis=ytd' });
  assert.equal(ytd.status, 'unavailable');
  assert.match(ytd.answer, /YTD basis is not supported/);
  assert.equal(reads.length, 0);
});

test('ambiguous pronoun followup does not use stale page identity or assistant-invented numbers', async () => {
  const { ask, reads } = fixture();
  const result = await ask('What are its debt trends?', { path: '/analysis/ALPHA' }, { messages: [
    { role: 'user', content: 'Summarize BETA.' }, { role: 'assistant', content: 'BETA has $999 billion of cash.' }, { role: 'user', content: 'What are its debt trends?' },
  ] });
  assert.equal(result.status, 'needs_selection');
  assert.equal(reads.length, 0);
  assert.doesNotMatch(result.evidence, /999/);
});

test('13F manager names resolve from any page and preserve selected historical quarter', async () => {
  const { ask, reads } = fixture();
  const result = await ask('Summarize 13F manager Independent Capital Management.', { path: '/fund/manager/0000000004', query: 'period=2026-03-31' });
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /13F manager/);
  assert.match(result.answer, /not total assets under management/);
  assert.match(result.answer, /12\.5%/);
  assert.match(result.answer, /Put option/);
  assert.ok(reads.some(row => row[0] === 'fund' && row[3] === '2026-03-31'));
});

test('N-PORT fund lookup supports any name/ticker and respects selected filing accession', async () => {
  const { ask, reads } = fixture();
  const accession = '0000000003-26-000001';
  const result = await ask('Summarize N-PORT fund FUND.', { path: '/fund/FUND', query: `accession=${accession}` });
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /fund-series/);
  assert.ok(reads.some(row => row[0] === 'fund' && row[2] === 'nport' && row[4] === accession));
});

test('plural possessive fund names preserve the final s', async () => {
  let searched;
  const { ask } = fixture({ search: async ({ query }) => { searched = query; return { results: [] }; } });
  await ask("Summarize 13F manager Bridgewater Associates' reported holdings.");
  assert.equal(searched, 'Bridgewater Associates');
});

test('explicit company financial query on Funds routes to company, not N-PORT', async () => {
  const { ask, reads } = fixture();
  const result = await ask('Summarize BETA financial results.', { path: '/fund/FUND' });
  assert.equal(result.category, 'company');
  assert.equal(result.status, 'ready');
  assert.ok(!reads.some(row => row[0] === 'fund'));
});

test('market uses existing snapshot denominators and percentage units without inventing price returns', async () => {
  const { ask } = fixture();
  const result = await ask('Summarize the market briefing.', { path: '/about' });
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /ttm basis/);
  assert.match(result.answer, /50% \(1 of 2/);
  assert.match(result.answer, /100% \(1 of 1/);
  assert.match(result.answer, /12\.5%/);
  assert.match(result.answer, /not share-price returns/);
  assert.match(result.answer, /2026-03-31 to 2026-06-30/);
  const unsupported = await ask('Show sector stock returns.', { path: '/market' });
  assert.equal(unsupported.status, 'needs_selection');
});

test('future fiscal end in a prepared market snapshot is flagged explicitly without altering source dates', async () => {
  const { dependencies } = fixture();
  const snapshot = await dependencies.market();
  snapshot.companies[0].reports.ttm.end = '2026-12-31';
  const { ask } = fixture({ market: async () => snapshot });
  const result = await ask('Summarize the market briefing.');
  assert.match(result.answer, /2026-12-31/);
  assert.match(result.answer, /Data-quality warning/);
  assert.match(result.answer, /later than its snapshot date/);
});

test('sector-company requests honor metric, direction, filter and selected page rather than returning sector medians', async () => {
  const snapshot = buildMarketSectorCompanies({ generatedAt: '2026-09-18T12:00:00Z', cohorts: QUANT_GROUPS,
    companies: Array.from({ length: 40 }, (_, index) => ({ ticker: `T${String(index).padStart(3, '0')}`, cik: String(index + 1),
      name: `Technology company ${index}`, sic: '3571', sector: 'Information Technology', cohorts: ['sector-technology'],
      metrics: { annual: { currentRatio: index }, ttm: { currentRatio: index } },
      reports: { annual: { end: '2025-12-31', filed: '2026-02-01', form: '10-K' }, ttm: { end: '2026-06-30', filed: '2026-08-01', form: '10-Q' } },
    })) });
  let selected;
  const { ask } = fixture({ sectorCompanies: async input => { selected = input; return pageMarketSectorCompanies(snapshot, input); } });
  const result = await ask('Show companies in the selected sector.', { path: '/market', query: 'tab=sectors&cohort=sector-technology&basis=annual&companyMetric=currentRatio&companyDirection=asc&companyPage=2&companyQuery=Technology' });
  assert.equal(result.status, 'ready');
  assert.equal(selected.sort, 'currentRatio');
  assert.equal(selected.direction, 'asc');
  assert.equal(selected.basis, 'annual');
  assert.equal(selected.page, 2);
  assert.equal(selected.query, 'technology');
  assert.match(result.answer, /T025/);
  assert.match(result.answer, /25×/);
  assert.match(result.answer, /Page 2/);
  assert.doesNotMatch(result.answer, /Sector medians/);
});

test('CFTC summary preserves dates, units and missing families, and never labels aggregate positioning company holdings', async () => {
  const { ask } = fixture();
  const result = await ask('What does the latest CFTC positioning show?', { path: '/analysis/ALPHA' });
  assert.equal(result.category, 'cftc');
  assert.equal(result.status, 'ready');
  assert.match(result.answer, /-20% net\/OI/);
  assert.match(result.answer, /1\.5 pp/);
  assert.match(result.answer, /2026-09-15/);
  assert.match(result.answer, /not an individual company/);
  assert.match(result.answer, /Unavailable/);
});

test('historical CFTC date without a contract never substitutes current macro snapshot', async () => {
  const { ask, reads } = fixture();
  const result = await ask('Summarize CFTC positioning.', { path: '/market', query: 'tab=positioning&date=2025-09-16' });
  assert.equal(result.status, 'needs_selection');
  assert.equal(reads.length, 0);
});

test('selected CFTC contract, family, group, date and window reach the bounded prepared-history reader unchanged', async () => {
  let selected;
  const { ask, reads } = fixture({ cftcHistory: async input => {
    selected = input;
    throw Object.assign(new Error('No exact prepared chart'), { code: 'CFTC_REPORT_NOT_PREPARED', status: 404 });
  } });
  const result = await ask('Summarize CFTC positioning.', { path: '/market',
    query: 'tab=positioning&family=tff&contract=13874A&group=leveraged-funds&date=2026-09-08&history=1y' });
  assert.deepEqual(selected, { family: 'tff', code: '13874A', group: 'leveraged-funds', reportDate: '2026-09-08', window: '1y' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.answer, /exact contract, trader group, date and window/);
  assert.ok(!reads.some(row => row[0] === 'cftc'));
});

test('source reader failures expose safe unavailability without model inference or raw errors', async () => {
  const { ask } = fixture({ company: async () => { throw new Error('secret upstream details'); } });
  const result = await ask('Summarize ALPHA.');
  assert.equal(result.status, 'unavailable');
  assert.doesNotMatch(result.answer, /secret/);
  assert.deepEqual(result.sources, []);
});

test('cancelled turns cannot publish evidence or sources', async () => {
  const controller = new AbortController();
  controller.abort();
  const { ask, reads } = fixture();
  await assert.rejects(ask('Summarize ALPHA.', {}, { signal: controller.signal }), /abort/i);
  assert.equal(reads.length, 0);
});

test('large source notes remain bounded complete blocks and unreferenced citations are removed', async () => {
  const { ask } = fixture({ company: async ({ id, basis }) => {
    const result = report(identities[id], basis);
    result.notes = Array.from({ length: 10 }, () => 'A'.repeat(3000));
    return result;
  } });
  const result = await ask('Summarize ALPHA.');
  assert.ok(result.answer.length <= BROWSER_RESEARCH_MAX_CHARS);
  assert.ok(result.evidence.length <= BROWSER_RESEARCH_MAX_CHARS);
  for (const source of result.sources) assert.ok(result.answer.includes(`[${source.id}]`));
});
