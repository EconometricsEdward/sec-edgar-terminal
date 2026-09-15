import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobalSearch, describeSearchPath } from '../src/utils/globalSearchEngine.js';
import { safeInternalPath } from '../src/utils/siteRoutes.js';
import { readFilingsSettings } from '../src/utils/filingsResearch.js';
import { readFundWorkspaceSettings } from '../src/utils/fundWorkspaceSettings.js';
import { readAnalysisSettings } from '../src/utils/analysisNotebook.js';
import { parseRiskLocation } from '../src/app/risk/riskNavigation.js';
import { parseMarketView } from '../src/utils/marketResearch.js';
import { CFTC_LAUNCH_CATALOG } from '../src/utils/cftc.js';

const map = {
  AAPL: { ticker: 'AAPL', name: 'Apple Inc.', cik: '0000320193', isFund: false },
  APLE: { ticker: 'APLE', name: 'Apple Hospitality REIT, Inc.', cik: '0001418121', isFund: false },
  MSFT: { ticker: 'MSFT', name: 'Microsoft Corp', cik: '0000789019', isFund: false },
  JPM: { ticker: 'JPM', name: 'JPMorgan Chase & Co', cik: '0000019617', isFund: false },
  AI: { ticker: 'AI', name: 'C3.ai, Inc.', cik: '0001577526', isFund: false },
  CAT: { ticker: 'CAT', name: 'Caterpillar Inc.', cik: '0000018230', isFund: false },
  GOLD: { ticker: 'GOLD', name: 'Example Gold Mining Corporation', cik: '0000001001', isFund: false },
  GOOG: { ticker: 'GOOG', name: 'Alphabet Inc.', cik: '0001652044', isFund: false },
  GOOGL: { ticker: 'GOOGL', name: 'Alphabet Inc.', cik: '0001652044', isFund: false },
  SPY: { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', cik: '0000884394', isFund: true },
  VOO: { ticker: 'VOO', name: 'Vanguard S&P 500 ETF', cik: '0000036405', isFund: true },
};
const plan = (query, options) => buildGlobalSearch(query, map, options);
const url = result => new URL(result.directPath, 'https://secedgarterminal.com');

test('confirmed companies open financial analysis with meaningful secondary destinations', () => {
  for (const query of ['AAPL', 'aapl', '$AAPL', 'ticker:AAPL', 'Apple', 'Apple Inc.', 'Apple Inc']) {
    const result = plan(query);
    assert.equal(result.directPath, '/analysis/AAPL', query);
    assert.equal(result.entity.cik, '0000320193');
    assert.deepEqual(result.items.map(item => item.path), ['/analysis/AAPL', '/filings/AAPL', '/risk?ticker=AAPL', '/disclosures?tickers=AAPL']);
    assert.equal(result.items[0].group, 'Best match');
    assert.equal(result.lookupQuery, '');
  }
  assert.equal(plan('Apple Hospitality').directPath, '/analysis/APLE');
  assert.equal(plan('CAT').directPath, '/analysis/CAT');
});

test('company financial questions land on settings the Analysis page actually accepts', () => {
  const cases = [
    ['Apple revenue', 'statements', 'income', 'annual'],
    ["What is Apple's revenue?", 'statements', 'income', 'annual'],
    ['Apple balance sheet', 'statements', 'balance', 'annual'],
    ['AAPL quarterly income statement', 'statements', 'income', 'quarter'],
    ['Microsoft cash flow', 'cash', 'income', 'annual'],
    ['MSFT YTD financials', 'statements', 'income', 'ytd'],
    ['AAPL trailing twelve months ratios', 'statements', 'ratios', 'ttm'],
    ['Apple capital allocation', 'capital', 'income', 'annual'],
  ];
  for (const [query, view, statement, basis] of cases) {
    const result = plan(query);
    assert.match(result.directPath || '', /^\/analysis\//, query);
    const settings = readAnalysisSettings(url(result).search);
    assert.deepEqual([settings.view, settings.statement, settings.basis], [view, statement, basis], query);
  }
});

test('report intent uses supported form and filing-date filters', () => {
  for (const query of ['Apple 2025 10-K', 'AAPL 10k 2025', 'Apple 2025 10 K']) {
    const result = plan(query), target = url(result);
    assert.equal(target.pathname, '/filings/AAPL');
    const settings = readFilingsSettings(target.search);
    assert.equal(settings.form, '10-K');
    assert.equal(settings.start, '2025-01-01');
    assert.equal(settings.end, '2025-12-31');
    assert.match(result.items[0].description, /filed in 2025/);
  }
  assert.equal(url(plan('filings: AAPL')).pathname, '/filings/AAPL');
  assert.equal(readFilingsSettings(url(plan('Microsoft annual reports')).search).family, 'annual');
  assert.equal(readFilingsSettings(url(plan('AAPL proxy')).search).family, 'proxy');
});

test('risk intent opens risk tools while specific disclosure questions preserve the whole question', () => {
  for (const [query, view] of [['JPM risk', 'overview'], ['JPM credit risk', 'overview'], ['JPM stress test', 'stress'], ['JPM commodity exposure', 'exposures'], ['JPM CFTC', 'cftc']]) {
    const result = plan(query);
    assert.equal(url(result).pathname, '/risk', query);
    assert.deepEqual([parseRiskLocation(url(result).search).ticker, parseRiskLocation(url(result).search).view], ['JPM', view]);
  }
  for (const query of ['Microsoft cybersecurity risks', 'Apple supply chain risks', 'What did Apple disclose about revenue?', 'Apple revenue recognition', 'AAPL China exposure']) {
    const result = plan(query);
    assert.equal(url(result).pathname, '/disclosures');
    assert.equal(url(result).searchParams.get('query'), query);
    assert.equal(result.lookupQuery, '');
  }
});

test('a natural financial query retains its original wording in the alternative disclosure search', () => {
  const result = plan('Apple revenue');
  const alternative = result.items.find(item => item.group === 'Search disclosures');
  assert.ok(alternative);
  assert.equal(new URL(alternative.path, 'https://secedgarterminal.com').searchParams.get('query'), 'Apple revenue');
});

test('topic and symbol collisions require an explicit choice and exact ticker syntax resolves intent', () => {
  for (const query of ['AI', 'ai', 'GOLD', 'gold']) {
    const result = plan(query);
    assert.equal(result.directPath, null);
    assert.match(result.message, /Choose/);
    assert.ok(result.items.some(item => item.path.startsWith('/analysis/')));
    assert.ok(result.items.some(item => item.type === 'disclosures' || item.type === 'market'));
  }
  assert.equal(plan('$AI').directPath, '/analysis/AI');
  assert.equal(plan('ticker:AI').directPath, '/analysis/AI');
  assert.equal(url(plan('topic: AI')).searchParams.get('query'), 'AI');
  assert.equal(url(plan('AI risks')).searchParams.get('query'), 'AI risks');
});

test('shared issuer names and inferred aliases do not silently pick a share class', () => {
  for (const query of ['Alphabet', 'Alphabet Inc.', 'Google', 'Google revenue', 'Alphabet cash flow']) {
    const result = plan(query);
    assert.equal(result.directPath, null, query);
    assert.equal(result.lookupQuery, '', query);
    assert.ok(result.items.some(item => /\/GOOG(?:\?|$)/.test(item.path)), query);
    assert.ok(result.items.some(item => /\/GOOGL(?:\?|$)/.test(item.path)), query);
    assert.match(result.message, /share class/);
  }
  assert.match(plan('GOOG revenue').directPath, /^\/analysis\/GOOG\?/);
});

test('manager queries use remote legal-entity discovery and retain a separate disclosure choice', () => {
  for (const [query, lookup] of [
    ['D1 Capital', 'D1 Capital'], ['D1 Capital holdings', 'D1 Capital'],
    ['Bridgewater Associates 13f holdings', 'Bridgewater Associates'],
    ['D1 Capital Partners L.P.', 'D1 Capital Partners L.P.'],
    ['D1 Capital Holdings', 'D1 Capital Holdings'], ['Citadel, LLC', 'Citadel, LLC'],
  ]) {
    const result = plan(query);
    assert.equal(result.directPath, null, query);
    assert.equal(result.lookupQuery, lookup, query);
    assert.ok(result.items.some(item => item.group === 'Search disclosures'));
    assert.ok(result.items.every(item => !item.path.includes('managerCik=')));
  }
});

test('CIKs stay filer identities and malformed numeric identities do not route', () => {
  for (const query of ['1747057', '0001747057', 'CIK: 1747057']) assert.equal(plan(query).directPath, '/filings/0001747057');
  for (const query of ['0', '0000', '12345678901']) {
    assert.equal(plan(query).directPath, null);
    assert.match(plan(query).message, /positive SEC CIK/);
  }
});

test('company and fund comparisons resolve names, symbols and natural separators', () => {
  for (const query of ['compare Apple and Microsoft', 'Apple vs Microsoft', 'AAPL versus MSFT', 'AAPL against MSFT', 'AAPL,MSFT', 'AAPL MSFT', 'aapl, msft, aapl,']) assert.equal(plan(query).directPath, '/compare/AAPL,MSFT', query);
  const funds = plan('SPY versus VOO');
  assert.equal(url(funds).pathname, '/fund');
  const settings = readFundWorkspaceSettings(url(funds).search);
  assert.equal(settings.view, 'compare');
  assert.deepEqual(settings.tickers, ['SPY', 'VOO']);
  for (const query of ['AAPL versus SPY', 'compare Google and Microsoft', 'AAPL,ZZZZ', 'AAPL,AAPL']) {
    assert.equal(plan(query).directPath, null, query);
    assert.ok(plan(query).message, query);
  }
});

test('company and fund comparison limits are checked before navigation', () => {
  const companies = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`T${index}`, { ticker: `T${index}`, name: `Company ${index}`, cik: String(index + 1), isFund: false }]));
  const symbols = Object.keys(companies);
  assert.ok(buildGlobalSearch(symbols.slice(0, 12).join(','), companies).directPath);
  assert.equal(buildGlobalSearch(symbols.join(','), companies).directPath, null);
  assert.match(buildGlobalSearch(symbols.join(','), companies).message, /12 companies/);
  const funds = Object.fromEntries(Object.entries(companies).map(([key, entry]) => [key, { ...entry, isFund: true }]));
  assert.ok(buildGlobalSearch(symbols.slice(0, 4).join(','), funds).directPath);
  assert.match(buildGlobalSearch(symbols.slice(0, 5).join(','), funds).message, /4 funds/);
});

test('partial comparisons offer input completion without navigating to a standalone company', () => {
  for (const query of ['AAPL,Micr', 'compare Apple and Micr']) {
    const result = plan(query);
    assert.equal(result.directPath, null);
    const suggestion = result.items.find(item => item.input === 'AAPL, MSFT');
    assert.ok(suggestion, query);
    assert.equal(suggestion.group, 'Complete comparison');
    assert.equal(plan(suggestion.input).directPath, '/compare/AAPL,MSFT');
  }
});

test('registered-fund holdings do not route to operating-company analysis', () => {
  for (const query of ['SPY', 'SPY holdings', 'SPY portfolio', 'fund: SPY']) {
    const result = plan(query);
    assert.equal(result.directPath, '/fund/SPY', query);
    assert.ok(result.items.every(item => !item.path.startsWith('/analysis')));
  }
});

test('tool navigation works without waiting for a company directory', () => {
  const cases = [['research hub', '/workspace'], ['Open the research hub', '/workspace'], ['stock screener', '/market?tab=fundamentals'], ['13F', '/fund?view=13f'], ['compare managers', '/fund?view=13f&managerView=compare'], ['SEC filings', '/filings'], ['help', '/help'], ['funds', '/fund']];
  for (const [query, expected] of cases) {
    const result = buildGlobalSearch(query, null);
    assert.equal(result.directPath, expected, query);
    assert.equal(result.needsDirectory, false);
  }
});

test('CFTC market intent uses existing canonical contracts and destination settings', () => {
  for (const [query, code] of [['gold positioning', '088691'], ['oil futures', '067651'], ['Bitcoin CFTC', '133741'], ['Nasdaq positioning', '209742'], ['10 year treasury positioning', '043602']]) {
    const result = buildGlobalSearch(query, null);
    const settings = parseMarketView(url(result).search);
    const catalog = CFTC_LAUNCH_CATALOG.find(item => item.code === code);
    assert.equal(settings.tab, 'positioning', query);
    assert.equal(settings.cftcContract, code);
    assert.equal(settings.cftcFamily, catalog.family);
    assert.equal(settings.cftcGroup, catalog.family === 'tff' ? 'leveraged-funds' : 'managed-money');
    assert.equal(result.needsDirectory, false);
  }
  assert.equal(buildGlobalSearch('CFTC', null).directPath, '/market?tab=positioning');
});

test('disabling CFTC removes every CFTC destination and never implies company futures positions', () => {
  for (const query of ['gold positioning', 'CFTC', 'FCM capital', 'JPM CFTC', 'JPM commodity exposure', 'gold']) {
    const result = plan(query, { cftcEnabled: false });
    assert.ok(result.items.every(item => !/[?&](?:tab=positioning|view=(?:cftc|exposures|fcm))/.test(item.path)), query);
    assert.ok(!result.directPath || !/[?&](?:tab=positioning|view=(?:cftc|exposures|fcm))/.test(result.directPath));
  }
});

test('directory-dependent requests wait rather than prematurely turning a company intent into a topic', () => {
  for (const directory of [null, {}]) {
    for (const query of ['Apple revenue', 'AI', 'AAPL,MSFT', 'Microsoft cybersecurity risks', 'D1 Capital', 'Apple']) {
      const result = buildGlobalSearch(query, directory);
      assert.equal(result.directPath, null, query);
      assert.equal(result.needsDirectory, true, query);
      assert.equal(result.lookupQuery, '');
      assert.ok(result.items.some(item => item.group === 'Search disclosures'));
    }
    for (const query of ['topic: covenant waiver', 'disclosures: revenue AND "cloud"', 'debt covenant breaches', 'supply chain risks']) {
      const result = buildGlobalSearch(query, directory);
      assert.match(result.directPath, /^\/disclosures\?/);
      assert.equal(result.needsDirectory, false);
    }
  }
});

test('unrecognized research language searches disclosure text, and spelling suggestions remain explicit', () => {
  for (const query of ['debt covenant breaches', 'companies mentioning payment defaults', 'What are companies saying about inflation?', 'artificial intelligence', 'capital expenditures', 'debt maturity', 'executive compensation', 'bankruptcies']) {
    const result = plan(query);
    assert.match(result.directPath || '', /^\/disclosures\?/);
    assert.equal(result.lookupQuery, '');
  }
  for (const query of ['Applle', 'Microsfot', 'ZZZZ']) {
    assert.equal(plan(query).directPath, null, query);
    assert.ok(plan(query).lookupQuery);
  }
  assert.ok(plan('Microsfot').items.some(item => item.path === '/analysis/MSFT' && item.group === 'Did you mean?'));
});

test('directory entries that cannot form valid site routes cannot crash suggestions or identity routing', () => {
  const directory = { ...map, ABCDEFGHIJKLMNOP: { ticker: 'ABCDEFGHIJKLMNOP', name: 'Long Symbol Corporation', cik: '10000' } };
  for (const query of ['ABCDEFGHIJKLMNOP', 'Long Symbol', 'Long Symbol revenue', 'AAPL,ABCDEFGHIJKLMNOP']) {
    const result = buildGlobalSearch(query, directory);
    assert.equal(result.directPath, null, query);
    assert.ok(result.items.every(item => safeInternalPath(item.path)));
  }
});

test('the normalized directory index is reused for subsequent keystrokes', () => {
  let nameReads = 0;
  const directory = { AAPL: { ticker: 'AAPL', cik: '320193', get name() { nameReads++; return 'Apple Inc.'; } } };
  buildGlobalSearch('Ap', directory);
  const firstReads = nameReads;
  for (const query of ['App', 'Appl', 'Apple', 'Apple revenue']) buildGlobalSearch(query, directory);
  assert.ok(firstReads > 0);
  assert.equal(nameReads, firstReads);
});

test('history describes real destinations in human language', () => {
  const cases = [['/analysis/AAPL', 'Financial analysis · AAPL'], ['/filings/1747057', 'SEC filings · CIK 0001747057'], ['/disclosures?query=D1%20Capital', 'Disclosure research'], ['/fund?view=13f&managerCik=0001747057', 'Manager holdings · SEC 13F'], ['/fund?view=13f&managerView=compare', 'Manager portfolio comparison'], ['/fund/SPY', 'Fund holdings · SPY'], ['/market?tab=positioning', 'CFTC market positioning']];
  for (const [path, expected] of cases) assert.equal(describeSearchPath(path), expected);
  assert.equal(describeSearchPath('javascript:alert(1)'), 'Research destination unavailable');
});

test('bounded searches only return safe internal routes and unique keyboard choices', () => {
  for (const query of ['AAPL', 'AI', 'Google', 'D1 Capital', 'topic: "><script>alert(1)</script>', '//evil.example/path', 'javascript:alert(1)', 'Apple revenue', 'gold positioning']) {
    const result = plan(query);
    assert.ok(result.items.length <= 10);
    assert.equal(new Set(result.items.map(item => item.path)).size, result.items.length);
    assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
    for (const item of result.items) {
      assert.equal(safeInternalPath(item.path), item.path);
      assert.ok(item.label && item.description && item.type && item.group);
    }
    assert.ok(!result.directPath || safeInternalPath(result.directPath));
  }
  for (const query of ['a'.repeat(501), 'Apple\nrevenue']) {
    assert.equal(plan(query).directPath, null);
    assert.deepEqual(plan(query).items, []);
  }
});
