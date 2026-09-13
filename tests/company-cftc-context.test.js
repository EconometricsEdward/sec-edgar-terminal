import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY_CFTC_MAX_LINKS, COMPANY_CFTC_MAX_TEXT, companyCftcAnnualFilings, extractCompanyCftcLinks, parseCompanyCftcRequest } from '../src/utils/companyCftc.js';
import { discoverCompanyCftcContext, isCompanyCftcCachedContext, loadCompanyCftcContext } from '../src/utils/companyCftcServer.js';
import { GET, OPTIONS } from '../src/app/api/v1/cftc/company-context/route.js';
import { CFTC_LAUNCH_CATALOG, cftcGroup } from '../src/utils/cftc.js';

const now = new Date('2026-09-13T12:00:00Z');
const cik = '0000320193';
const filing = { form: '10-K', accession: '0000320193-25-000079', filed: '2025-10-31', reportDate: '2025-09-27', url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm' };
function rows(items) {
  const all = { accessionNumber: [], form: [], filingDate: [], reportDate: [], primaryDocument: [] };
  for (const [i, item] of items.entries()) {
    all.accessionNumber.push(item.accession || `0000320193-25-${String(i + 1).padStart(6, '0')}`);
    all.form.push(item.form || '10-K'); all.filingDate.push(item.filed); all.reportDate.push(item.reportDate || '2024-12-31'); all.primaryDocument.push(item.primaryDoc || `report${i}.htm`);
  }
  return all;
}

test('company context validates full dates, cutoff, tickers and query shape', () => {
  assert.deepEqual(parseCompanyCftcRequest('https://test/?ticker=brk-b&asOf=2026-09-01', now), { ticker: 'BRK-B', asOf: '2026-09-01' });
  assert.deepEqual(parseCompanyCftcRequest('https://test/?ticker=AAPL', now), { ticker: 'AAPL', asOf: null });
  for (const query of ['ticker=AAPL&asOf=2026-02-30', 'ticker=AAPL&asOf=2026-09-14', 'ticker=AAPL&asOf=2026-09-01junk', 'ticker=AAPL&asOf=', 'ticker=AAPL&asOf=1900-01-01', 'ticker=../AAPL', 'ticker=AAPL&ticker=XOM', 'ticker=AAPL&url=https://evil.example/']) {
    assert.throws(() => parseCompanyCftcRequest(`https://test/?${query}`, now), { status: 400 }, query);
  }
});

test('only a complete annual filing available by cutoff can supply evidence', () => {
  const recent = rows([
    { filed: '2026-08-01', form: '10-Q' }, { filed: '2026-07-01', form: '10-K/A' },
    { filed: '2026-03-01', reportDate: '2025-12-31' },
    { filed: '2025-03-01', reportDate: '2024-12-31', form: '20-F' },
    { filed: '2025-01-01', reportDate: '2024-12-31', primaryDoc: '../unsafe.htm' },
    { filed: '2025-02-01', reportDate: '2026-12-31' },
    { filed: '2025-02-30', reportDate: '2024-12-31' },
  ]);
  const selected = companyCftcAnnualFilings(recent, cik, '2026-02-01');
  assert.equal(selected.length, 1); assert.equal(selected[0].form, '20-F'); assert.equal(selected[0].filed, '2025-03-01');
  assert.equal(companyCftcAnnualFilings(recent, 'bad-cik', '2026-02-01').length, 0);
  assert.equal(companyCftcAnnualFilings(recent, cik, '2026-03-01')[0].filed, '2026-03-01');
});

test('matched links retain exact evidence and use only catalogued contracts and valid participant groups', () => {
  const rates = 'Our variable-rate debt accrues interest based on SOFR, creating exposure to changes in interest rates.';
  const euros = 'We hedge our euro-denominated revenue with foreign exchange forward contracts.';
  const copper = 'Our copper production revenue is sensitive to copper prices and demand.';
  const text = `${rates}\n\n${euros}\n\n${copper}`;
  const result = extractCompanyCftcLinks(text, filing);
  assert.deepEqual(result.links.map(link => link.id), ['sofr', 'rates', 'euro', 'copper']);
  for (const link of result.links) {
    assert.equal(link.reviewStatus, 'candidate'); assert.ok(link.reviewQuestion);
    assert.ok(CFTC_LAUNCH_CATALOG.some(item => item.code === link.contract && item.family === link.family));
    assert.ok(cftcGroup(link.family, link.group));
    for (const evidence of link.evidence) { assert.ok(text.includes(evidence.text)); assert.equal(evidence.url, filing.url); assert.equal(evidence.accession, filing.accession); assert.equal(evidence.filed, filing.filed); assert.equal(evidence.reportDate, filing.reportDate); }
  }
});

test('generic FX, sector associations, financial glossaries and misleading names do not invent market links', () => {
  const texts = [
    'Our international revenue is exposed to foreign currency exchange rate fluctuations.',
    'Our energy business has significant revenues and costs across several markets.',
    'A gold futures contract represents an agreement to buy or sell gold at an agreed price.',
    'Our Gold loyalty program increased revenues during the fiscal year.',
    'Our Euro Disney operations increased revenue during the year.',
    'Our copper-colored products generated significant sales revenue.',
    'Our Cornell contract increased revenue and borrowing during the year.',
    'Our operations in the euro zone generated revenue during the year.',
    'Refer to Table IV for the company’s average sales price per barrel of crude oil and natural gas produced.',
    'The company’s discussion of interest rate risk is contained in Note 10 Financial Instruments.',
    'The following table summarizes our crude oil sales and natural gas production revenue.',
    'Our LNG sales under long-term agreements generated substantial revenue in Asia.',
  ];
  for (const text of texts) assert.deepEqual(extractCompanyCftcLinks(text, filing).links, [], text);
});

test('issuer names support first-person-free disclosures but names alone cannot create commodity links', () => {
  const jpm = 'Changes in interest rates and credit spreads could adversely affect JPMorganChase’s earnings or its liquidity and capital levels.';
  assert.deepEqual(extractCompanyCftcLinks(jpm, filing, { companyName: 'JPMORGAN CHASE & CO' }).links.map(link => link.id), ['rates']);
  const bank = 'Gold Bank’s revenue and net income increased during the current year.';
  assert.deepEqual(extractCompanyCftcLinks(bank, filing, { companyName: 'Gold Bank Inc.' }).links, []);
  const rates = 'Gold Bank’s loans and deposits create exposure to changes in interest rates.';
  assert.deepEqual(extractCompanyCftcLinks(rates, filing, { companyName: 'Gold Bank Inc.' }).links.map(link => link.id), ['rates']);
});

test('Brent-only and soybean-oil-only disclosures do not become WTI or raw-soybean links', () => {
  const brent = 'The company estimates that our production revenue will grow assuming a Brent crude oil price of $60 per barrel.';
  const soybeanOil = 'Chevron holds a 50 percent working interest in a venture which produces soybean oil from processing facilities.';
  assert.deepEqual(extractCompanyCftcLinks(brent, filing).links, []);
  assert.deepEqual(extractCompanyCftcLinks(soybeanOil, filing, { companyName: 'Chevron Corp' }).links, []);
  assert.deepEqual(extractCompanyCftcLinks('Our soybean-meal purchases are exposed to changes in commodity prices.', filing).links, []);
  assert.deepEqual(extractCompanyCftcLinks('Our crude oil sales are priced using both Brent and WTI benchmarks.', filing).links.map(link => link.id), ['crude']);
  assert.deepEqual(extractCompanyCftcLinks('We purchase soybeans to produce soybean oil, exposing our margins to raw soybean prices.', filing).links.map(link => link.id), ['soybeans']);
});

test('negative and immaterial exposure disclosures are excluded without converting them into positive links', () => {
  for (const text of [
    'We have no material exposure to changes in gold prices.',
    'Our debt is not materially exposed to interest rate changes.',
    'We do not hold bitcoin or other digital assets on our balance sheet.',
    'Our exposure to copper prices is immaterial to the company.',
    'We do not have exposure to natural gas prices or reserves.',
    'Our negligible exposure to euro-denominated debt is managed by treasury.',
    'We have no gold holdings or gold production revenue.',
    'We do not believe changes in interest rates pose a material risk to our earnings.',
  ]) assert.deepEqual(extractCompanyCftcLinks(text, filing).links, [], text);
  const combined = 'We have no material exposure to gold prices.\n\nOur copper production revenue is sensitive to copper prices.';
  assert.deepEqual(extractCompanyCftcLinks(combined, filing).links.map(link => link.id), ['copper']);
});

test('search and response limits are explicit and duplicate passages are not multiplied', () => {
  const passage = 'Our gold production revenue depends on gold prices and supply conditions.';
  const result = extractCompanyCftcLinks(`${passage}\n\n${passage}\n\n${'x'.repeat(COMPANY_CFTC_MAX_TEXT)}`, filing);
  assert.equal(result.links[0].evidence.length, 1);
  assert.equal(result.textCharactersScanned, COMPANY_CFTC_MAX_TEXT); assert.equal(result.textTruncated, true);
  const many = extractCompanyCftcLinks('Our revenue and costs are exposed to SOFR, interest rates, euros, Japanese yen, British pounds, crude oil, natural gas, copper, gold, silver, corn, wheat, soybeans, cattle, coffee, cocoa, cotton, bitcoin and ether.', filing);
  assert.equal(many.links.length, COMPANY_CFTC_MAX_LINKS);
});

test('company discovery selects the latest available annual report and preserves different SEC dates', async () => {
  const calls = [];
  const result = await discoverCompanyCftcContext({ ticker: 'AAPL', asOf: '2025-08-01' }, {
    now, lookupTicker: async () => ({ cik, name: 'Apple Inc.' }),
    loadSubmissions: async name => { calls.push(name); return { name: 'Apple Inc.', filings: { recent: rows([{ filed: '2026-02-01', reportDate: '2025-12-31' }, { filed: '2025-02-01', reportDate: '2024-12-31' }]) } }; },
    loadFilingText: async (_cik, accession) => { calls.push(accession); return { text: 'Our euro-denominated revenue is exposed to changes in foreign exchange rates.' }; },
  });
  assert.equal(result.status, 'ready'); assert.equal(result.retryable, false); assert.equal(result.filing.filed, '2025-02-01'); assert.equal(result.filing.reportDate, '2024-12-31');
  assert.equal(result.asOf, '2025-08-01'); assert.equal(result.coverage.filingsScanned, 1); assert.equal(result.links[0].contract, '099741');
  assert.deepEqual(calls, ['CIK0000320193.json', '0000320193-25-000002']);
  assert.ok(result.limitations.some(line => /filing-date cutoff applies to SEC evidence only/.test(line)));
});

test('historical selection fetches at most two allowed SEC archive files and reports coverage gaps', async () => {
  const calls = [];
  const files = [1, 2, 3].map(i => ({ name: `CIK${cik}-submissions-00${i}.json`, filingFrom: `${2025 - i}-01-01`, filingTo: `${2025 - i}-12-31` }));
  files.unshift({ name: 'https://evil.example/submissions.json', filingFrom: '2024-01-01', filingTo: '2024-12-31' });
  const result = await discoverCompanyCftcContext({ ticker: 'AAPL', asOf: '2024-08-01' }, {
    now, lookupTicker: async () => ({ cik, name: 'Apple Inc.' }),
    loadSubmissions: async name => { calls.push(name); return calls.length === 1 ? { filings: { recent: rows([{ filed: '2025-02-01' }]), files } } : rows([]); },
    loadFilingText: async () => { throw new Error('Must not fetch missing filing'); },
  });
  assert.equal(result.status, 'no_filing'); assert.equal(result.filing, null); assert.equal(result.retryable, false);
  assert.equal(result.coverage.historyFilesScanned, 2); assert.equal(result.coverage.historyLimited, true);
  assert.deepEqual(calls, ['CIK0000320193.json', 'CIK0000320193-submissions-001.json', 'CIK0000320193-submissions-002.json']);
});

test('persistent context rejects unexpected source URLs, mismatched evidence and invented contracts', async () => {
  const selection = { ticker: 'AAPL', asOf: null };
  const value = await discoverCompanyCftcContext(selection, {
    now, lookupTicker: async () => ({ cik, name: 'Apple Inc.' }),
    loadSubmissions: async () => ({ filings: { recent: rows([{ filed: '2025-02-01' }]) } }),
    loadFilingText: async () => ({ text: 'Our copper production revenue depends on copper prices and supply conditions.' }),
  });
  assert.equal(isCompanyCftcCachedContext(value, selection), true);
  for (const mutate of [
    item => { item.filing.url = 'https://evil.example/filing.htm'; },
    item => { item.links[0].evidence[0].url = 'javascript:alert(1)'; },
    item => { item.links[0].evidence[0].filed = '2020-01-01'; },
    item => { item.links[0].contract = 'FAKE'; },
    item => { item.links[0].group = 'leveraged-funds'; },
    item => { item.links[0].evidence[0].text = 'x'.repeat(901); },
    item => { item.filing.filed = '2999-01-01'; },
  ]) {
    const corrupt = structuredClone(value); mutate(corrupt); assert.equal(isCompanyCftcCachedContext(corrupt, selection), false);
  }
});

test('missing evidence stays distinct from source outages, with retryable failures and retained source identity', async () => {
  const options = { now, lookupTicker: async () => ({ cik, name: 'Apple Inc.' }), loadSubmissions: async () => ({ filings: { recent: rows([{ filed: '2025-02-01' }]) } }) };
  const unavailable = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { ...options, loadFilingText: async () => ({ text: '', error: 'HTTP 429' }) });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.retryable, true); assert.equal(unavailable.code, 'SEC_FILING_TEXT_UNAVAILABLE');
  assert.equal(unavailable.filing.filed, '2025-02-01'); assert.deepEqual(unavailable.links, []);
  const unmatched = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { ...options, loadFilingText: async () => ({ text: 'Our international revenue is exposed to foreign exchange risks.' }) });
  assert.equal(unmatched.status, 'no_matches'); assert.equal(unmatched.retryable, false); assert.equal(unmatched.coverage.filingsScanned, 1);
  const malformed = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { ...options, loadSubmissions: async () => ({}) });
  assert.equal(malformed.status, 'unavailable'); assert.equal(malformed.retryable, true); assert.equal(malformed.code, 'SEC_SOURCE_INVALID');
  await assert.rejects(discoverCompanyCftcContext({ ticker: 'ZZZZ' }, { ...options, lookupTicker: async () => null }), { code: 'COMPANY_NOT_FOUND', status: 404 });
});

test('an interrupted discovery exits with retryable status before any filing work', async () => {
  const controller = new AbortController(); controller.abort();
  let filingCalls = 0;
  const result = await discoverCompanyCftcContext({ ticker: 'AAPL' }, { now, signal: controller.signal, lookupTicker: async () => ({ cik }), loadFilingText: async () => { filingCalls += 1; } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.retryable, true); assert.equal(filingCalls, 0);
});

test('company-context route is read-only, validates parameters and obeys the shared disabled switch', async () => {
  const invalid = await GET(new Request('https://test/?ticker=AAPL&asOf=2999-01-01', { headers: { 'x-forwarded-for': '192.0.2.212' } }));
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'INVALID_AS_OF'); assert.equal(invalid.headers.get('cache-control'), 'private, no-store');
  assert.equal(OPTIONS().headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  const prior = process.env.CFTC_ENABLED; process.env.CFTC_ENABLED = '0';
  try {
    const disabled = await GET(new Request('https://test/?ticker=AAPL'));
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'CFTC_DISABLED'); assert.equal(disabled.headers.get('ratelimit-limit'), null);
    await assert.rejects(loadCompanyCftcContext({ ticker: 'AAPL' }), { code: 'CFTC_DISABLED' });
  } finally { if (prior == null) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = prior; }
});
