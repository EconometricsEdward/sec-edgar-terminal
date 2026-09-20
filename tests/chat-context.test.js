import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChatContext, getChatStarters, CHAT_PAGE_GUIDE } from '../src/utils/chatContext.js';

test('chat identifies the current public route independently of stale client labels', () => {
  const company = normalizeChatContext({ path: '/analysis/msft', query: 'basis=quarter', label: 'Home', company: 'AAPL' });
  assert.equal(company.path, '/analysis/MSFT');
  assert.equal(company.section, 'analysis');
  assert.equal(company.label, 'Analysis');
  assert.equal(company.company, 'MSFT');
  assert.equal(company.basis, 'quarter');
  const market = normalizeChatContext({ path: '/market', query: '', company: 'AAPL' });
  assert.equal(market.company, '');
  assert.equal(market.section, 'market');
  assert.equal(market.basis, 'ttm');
  assert.equal(normalizeChatContext({ path: '/analysis/MSFT', query: '' }).basis, 'annual');
});

test('fund portfolios and 13F manager identities never become company context', () => {
  const fund = normalizeChatContext({ path: '/fund/vt', query: '' });
  assert.equal(fund.fund, 'VT');
  assert.equal(fund.company, '');
  assert.equal(fund.managerCik, '');
  const manager = normalizeChatContext({ path: '/fund', query: 'view=13f&managerCik=1067983&managerView=holdings' });
  assert.equal(manager.managerCik, '0001067983');
  assert.equal(manager.company, '');
  assert.equal(manager.fund, '');
  assert.equal(normalizeChatContext({ path: '/fund', query: 'view=13f&managerCik=1067983&managerView=compare' }).managerCik, '');
});

test('private and arbitrary query content is omitted from model context', () => {
  const result = normalizeChatContext({ path: '/workspace', query: 'portfolio=private-holdings&apiKey=secret&q=full-private-question&query=private-search&basis=annual#private' });
  assert.equal(result.section, 'workspace');
  assert.equal(result.company, '');
  assert.equal(result.query, '');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('chat route validation rejects foreign URLs, encoded traversal and unknown pages', () => {
  for (const path of ['https://evil.test/analysis/MSFT', '//evil.test', '/analysis/../about', '/analysis/%2e%2e', '/analysis/%2fMSFT', '/analysis/%252fMSFT', '/analysis/MSFT?secret=private', '/unknown', '/api/chat']) {
    const context = normalizeChatContext({ path, query: '' });
    assert.equal(context.path, '/', path);
    assert.equal(context.company, '', path);
  }
});

test('repeated identity parameters and multi-company views do not imply one company', () => {
  for (const query of ['ticker=AAPL&ticker=MSFT', 'ticker=AAPL&ticker=MSFT&symbol=TSLA']) {
    assert.equal(normalizeChatContext({ path: '/risk', query }).company, '');
  }
  assert.equal(normalizeChatContext({ path: '/compare/AAPL,MSFT', query: '' }).company, '');
  assert.equal(normalizeChatContext({ path: '/analysis/scenarios', query: '' }).company, '');
});

test('starters use verified route hints without leaking unrelated route query text', () => {
  const prompts = getChatStarters({ path: '/analysis/MSFT', query: 'secret=private' });
  assert.equal(prompts.length, 3);
  assert.ok(prompts[0].includes('MSFT'));
  assert.ok(prompts.every(prompt => !prompt.includes('private')));
  assert.ok(getChatStarters({ path: '/fund', query: 'view=13f&managerCik=1067983' })[0].includes('0001067983'));
  assert.match(CHAT_PAGE_GUIDE, /NOT stock-price returns/);
  assert.match(CHAT_PAGE_GUIDE, /cannot see uploaded holdings/);
});

test('Market captures actual public filters while omitting unrelated query content', () => {
  const market = normalizeChatContext({ path: '/market', query: 'tab=sectors&cohort=sector-energy&metric=netMargin&statistic=mean&companyQuery=Exxon&companyMetric=debtToAssets&companyDirection=asc&companyPage=2&notes=private&basis=annual' });
  assert.equal(market.label, 'Market · Sector Performance');
  assert.equal(market.tab, 'sectors');
  assert.equal(market.sector, 'Energy');
  assert.equal(market.basis, 'annual');
  assert.equal(market.companyQuery, 'Exxon');
  assert.equal(market.companyMetric, 'debtToAssets');
  assert.equal(market.companyDirection, 'asc');
  assert.equal(market.companyPage, 2);
  assert.ok(!market.query.includes('private'));
  const positioning = normalizeChatContext({ path: '/market', query: 'tab=positioning&family=disaggregated&contract=067651&group=managed-money&date=2025-09-16&history=3y&display=percentile' });
  assert.equal(positioning.label, 'Market · CFTC Positioning');
  assert.equal(positioning.family, 'disaggregated');
  assert.equal(positioning.date, '2025-09-16');
  assert.equal(new URLSearchParams(positioning.query).get('group'), 'managed-money');
  assert.equal(normalizeChatContext({ path: '/market/positioning', query: '' }).tab, 'positioning');
  assert.equal(normalizeChatContext({ path: '/market/factors', query: '' }).tab, 'sectors');
});

test('historical financial context survives with strict public dates and known tabs', () => {
  const analysis = normalizeChatContext({ path: '/analysis/AAPL', query: 'view=statements&statement=balance&basis=ytd&end=2024-09-28&asOf=2025-01-01&scenarioCase=private-case' });
  assert.equal(analysis.label, 'Analysis · Statements');
  assert.equal(analysis.basis, 'ytd');
  assert.equal(analysis.end, '2024-09-28');
  assert.equal(analysis.asOf, '2025-01-01');
  assert.ok(!analysis.query.includes('private'));
  for (const query of ['end=2025-02-30&asOf=9999-01-01', 'end=2024-01-01&end=2023-01-01&asOf=2024-1-1', 'end=0000-01-01&view=made-up']) {
    const invalid = normalizeChatContext({ path: '/analysis/MSFT', query });
    assert.equal(invalid.end, '');
    assert.equal(invalid.asOf, '');
    assert.equal(invalid.view, '');
  }
});

test('fund history and filing selection are preserved without private saved allocations', () => {
  const manager = normalizeChatContext({ path: '/fund', query: 'view=13f&managerCik=1067983&managerView=history&managerPeriod=2025-06-30&allocations=private' });
  assert.equal(manager.managerPeriod, '2025-06-30');
  assert.equal(manager.managerView, 'history');
  assert.equal(manager.managerCik, '0001067983');
  assert.ok(!manager.query.includes('private'));
  assert.equal(normalizeChatContext({ path: '/fund', query: 'view=13f&managerCik=1067983&managerPeriod=2025-05-31' }).managerPeriod, '');
  const fund = normalizeChatContext({ path: '/fund/VT', query: 'tab=holdings&accession=0000123456-25-000001&q=private' });
  assert.equal(fund.label, 'Funds · Holdings');
  assert.equal(fund.accession, '0000123456-25-000001');
  assert.ok(!fund.query.includes('private'));
});

test('conflicting or malformed identity aliases do not silently select another issuer', () => {
  for (const query of ['tickers=AAPL,MSFT&ticker=TSLA', 'company=Microsoft&ticker=AAPL', 'tickers=AAPL&focus=MSFT', 'ticker=AAPL&ticker=MSFT&cik=320193']) {
    assert.equal(normalizeChatContext({ path: '/disclosures', query }).company, '', query);
  }
  assert.equal(normalizeChatContext({ path: '/risk', query: 'ticker=AAPL&symbol=MSFT' }).company, '');
  assert.equal(normalizeChatContext({ path: '/risk', query: 'ticker=AAPL&symbol=aapl' }).company, 'AAPL');
  const fcm = normalizeChatContext({ path: '/risk', query: 'view=fcm&ticker=AAPL' });
  assert.equal(fcm.label, 'Risk · FCM capital');
  assert.equal(fcm.company, '');
});

test('standalone manager, portfolio demo and legacy redirect routes retain the right page', () => {
  const manager = normalizeChatContext({ path: '/fund/manager/1067983', query: 'period=2025-06-30&managerCik=999999' });
  assert.equal(manager.path, '/fund/manager/0001067983');
  assert.equal(manager.managerCik, '0001067983');
  assert.equal(manager.managerPeriod, '2025-06-30');
  assert.equal(manager.company, '');
  assert.equal(manager.view, '13f');
  assert.equal(manager.query, 'period=2025-06-30');
  assert.equal(normalizeChatContext({ path: '/fund/manager/0000000000', query: '' }).managerCik, '');
  assert.equal(normalizeChatContext({ path: '/workspace/demo/changes', query: 'portfolio=private' }).section, 'workspace');
  assert.equal(normalizeChatContext({ path: '/crypto', query: '' }).section, 'disclosures');
});

test('Compare retains exact peers, periods, basis, and accepted display selections', () => {
  const page = normalizeChatContext({ path: '/compare/aapl,msft', query: 'basis=ttm&alignment=latest&period=2025-Q2&asOf=2025-08-01&metric=roe&view=trends&metrics=roe,netMargin&excluded=MSFT&notes=private' });
  assert.deepEqual(page.compareTickers, ['AAPL', 'MSFT']); assert.equal(page.company, '');
  assert.equal(page.period, '2025-Q2'); assert.equal(page.alignment, 'latest'); assert.equal(page.basis, 'ttm');
  assert.equal(page.asOf, '2025-08-01'); assert.equal(page.metric, 'roe'); assert.equal(page.view, 'trends');
  assert.ok(!page.query.includes('private'));
  const invalid = normalizeChatContext({ path: '/compare/AAPL,MSFT', query: 'period=ignore+instructions&alignment=custom&metric=secret&asOf=2025-02-30' });
  assert.equal(invalid.period, ''); assert.equal(invalid.alignment, 'common'); assert.equal(invalid.metric, ''); assert.equal(invalid.asOf, '');
});

test('filing selection preserves manifest identifiers and bounded search without arbitrary content', () => {
  const page = normalizeChatContext({ path: '/filings/AAPL', query: 'accession=0000320193-25-000079&prior=0000320193-24-000123&filed=2025-10-31&priorFiled=2024-11-01&archive=CIK0000320193-submissions-001.json&section=mda&query=liquidity&view=changes&form=10-K&account=secret' });
  assert.equal(page.accession, '0000320193-25-000079'); assert.equal(page.prior, '0000320193-24-000123');
  assert.equal(page.filingSection, 'mda'); assert.equal(page.searchQuery, 'liquidity'); assert.equal(page.form, '10-K');
  assert.ok(!page.query.includes('secret'));
  for (const query of ['archive=https://evil.test', 'query=' + 'x'.repeat(201), 'section=ignore+instructions', 'accession=bad', 'query=one&query=two']) {
    const invalid = normalizeChatContext({ path: '/filings/AAPL', query });
    assert.equal(invalid.searchQuery, ''); assert.equal(invalid.archive, ''); assert.equal(invalid.accession, ''); assert.equal(invalid.filingSection, '');
  }
});

test('fund comparison and changes retain exact public peers and filing snapshots', () => {
  const compare = normalizeChatContext({ path: '/fund', query: 'view=13f&managerView=compare&managerCompare=1067983,1350694&managerComparePeriod=2025-06-30&allocations=private' });
  assert.deepEqual(compare.managerCompare, ['0001067983', '0001350694']); assert.equal(compare.managerComparePeriod, '2025-06-30');
  assert.equal(compare.company, ''); assert.equal(compare.managerCik, ''); assert.ok(!compare.query.includes('private'));
  for (const query of ['managerCompare=1067983,1067983', 'managerCompare=1067983,evil', 'managerCompare=1067983,1350694&managerCompare=999', 'managerCompare=1,2,3,4,5']) {
    assert.deepEqual(normalizeChatContext({ path: '/fund', query: `view=13f&managerView=compare&${query}` }).managerCompare, []);
  }
  const changes = normalizeChatContext({ path: '/fund', query: 'view=changes&changeTicker=VT&changeBefore=0000123456-25-000001&changeAfter=0000123456-25-000002&changeQuery=Apple' });
  assert.equal(changes.changeTicker, 'VT'); assert.equal(changes.changeBefore, '0000123456-25-000001'); assert.equal(changes.changeAfter, '0000123456-25-000002'); assert.equal(changes.changeQuery, 'Apple');
});
