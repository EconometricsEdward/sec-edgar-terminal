import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalizeCikIdentifier } from '../src/utils/siteRoutes.js';
import { validTicker } from '../src/utils/researchWorkspace.js';
import { FEATURED_COMPARE_GROUPS, comparePageSelection, comparePageMetadata } from '../src/utils/comparePublicMetadata.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
function compile(path, dependencies = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', output)(name => {
    if (name in dependencies) return dependencies[name];
    if (name === 'react' || name === 'react/jsx-runtime') return require(name);
    if (name.endsWith('/siteMetadata')) return compile('src/utils/siteMetadata.ts');
    if (name === 'next/link' || name.endsWith('/FilingsClient')) return () => null;
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected dependency in SEO fixture: ${name}`);
  }, testModule, testModule.exports);
  return testModule.exports;
}
function filingsFixture({ company = null, tickerError = null, broker = null, filerError = null } = {}) {
  const calls = [];
  const page = compile('src/app/filings/[ticker]/page.tsx', {
    'next/navigation': { notFound: () => { throw new Error('NOT_FOUND'); } },
    '../../../utils/researchWorkspace.js': { validTicker },
    '../../../utils/siteRoutes.js': { normalizeCikIdentifier },
    '../../../utils/tickerMap.js': { getOperatingTicker: async ticker => {
      calls.push(['ticker', ticker]); if (tickerError) throw tickerError; return company;
    } },
    '../../../utils/brokerDealerResearch.js': { loadBrokerDealerResearch: async (cik, options) => {
      calls.push(['broker', cik, options]); if (filerError) throw filerError;
      return broker || { status: 'not-applicable', company };
    } },
    '../../../utils/filingsResearchServer.js': { loadFilingsCompany: async cik => {
      calls.push(['filer', cik]); if (filerError) throw filerError; return company;
    } },
  });
  return { page, calls };
}
const props = ticker => ({ params: Promise.resolve({ ticker }) });

test('malformed filing selectors cannot create indexable empty pages or trigger data reads', async () => {
  const { page, calls } = filingsFixture();
  for (const ticker of ['<script>', 'AAPL/MSFT', 'AAPL%2FMSFT', '0', '0000000000', '12345678901', 'A'.repeat(16), '']) {
    const metadata = await page.generateMetadata(props(ticker));
    assert.equal(metadata.robots.index, false, ticker);
    assert.equal(metadata.alternates.canonical, 'https://secedgarterminal.com/filings');
    await assert.rejects(page.default(props(ticker)), /NOT_FOUND/);
  }
  assert.deepEqual(calls, []);
});

test('verified filing identities keep normalized canonical and social URLs', async () => {
  const ticker = filingsFixture({ company: { name: 'Apple Inc.', cik: '0000320193' } });
  const metadata = await ticker.page.generateMetadata(props(' aapl '));
  assert.equal(metadata.robots, undefined);
  assert.equal(metadata.alternates.canonical, 'https://secedgarterminal.com/filings/AAPL');
  assert.equal(metadata.openGraph.url, metadata.alternates.canonical);
  assert.match(metadata.title, /Apple Inc/);
  assert.deepEqual(ticker.calls, [['ticker', 'AAPL']]);

  const broker = filingsFixture({ broker: { status: 'available', company: { name: 'Example Broker LLC' } } });
  const brokerMeta = await broker.page.generateMetadata(props('3001'));
  assert.equal(brokerMeta.robots, undefined);
  assert.equal(brokerMeta.alternates.canonical, 'https://secedgarterminal.com/filings/0000003001');
  assert.match(brokerMeta.title, /X-17A-5/);
  assert.deepEqual(broker.calls, [['broker', '0000003001', { metadataOnly: true }]]);
});

test('missing filing identities are noindex without treating temporary lookup errors as absence', async () => {
  const missingTicker = filingsFixture();
  assert.equal((await missingTicker.page.generateMetadata(props('UNKNOWN'))).robots.index, false);
  await assert.doesNotReject(missingTicker.page.default(props('UNKNOWN')), 'The interactive explorer remains available for a valid selector');
  const unavailableTicker = filingsFixture({ tickerError: new Error('Temporary SEC error') });
  assert.equal((await unavailableTicker.page.generateMetadata(props('AAPL'))).robots, undefined);
  const missingFiler = filingsFixture({ filerError: Object.assign(new Error('Unknown CIK'), { status: 404 }) });
  assert.equal((await missingFiler.page.generateMetadata(props('9876543210'))).robots.index, false);
  const unavailableFiler = filingsFixture({ filerError: Object.assign(new Error('Temporary SEC error'), { status: 503 }) });
  assert.equal((await unavailableFiler.page.generateMetadata(props('3001'))).robots, undefined);
});

function sitemapFixture(companies = []) {
  return compile('src/app/sitemap.ts', {
    '../utils/fundResearch': { FUND_CATALOG: [{ ticker: 'VOO' }] },
    '../utils/fundPublicSelectors.js': { PUBLIC_FUND_MANAGERS: [{ cik: '0001350694' }] },
    '../utils/secCoverageRegistry.js': {
      loadSecCoverageRegistry: async () => {}, getActiveSecCoverageCompanies: () => companies,
    },
  });
}
function pagePaths(directory = 'src/app') {
  return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? pagePaths(path) : /^page\.(tsx|jsx)$/.test(entry.name) ? [path] : [];
  });
}

test('every public page defines metadata and every static page is discovered once', async () => {
  const redirects = new Set(['src/app/crypto/page.tsx', 'src/app/market/factors/page.tsx', 'src/app/market/positioning/page.tsx']);
  const sitemap = await sitemapFixture().default();
  const urls = sitemap.map(entry => entry.url);
  assert.equal(urls.length, new Set(urls).size);
  for (const path of pagePaths()) {
    const source = read(path);
    if (redirects.has(path)) {
      assert.match(source, /(?:permanentRedirect|redirect)\(/);
      continue;
    }
    assert.match(source, /export (?:const metadata|async function generateMetadata)/, `${path} must publish metadata`);
    if (path.includes('[')) continue;
    const url = `https://secedgarterminal.com${path.replace('src/app', '').replace(/\/page\.(tsx|jsx)$/, '') || '/'}`;
    if (path === 'src/app/bank-pilot/page.jsx') {
      assert.match(source, /index:\s*false/);
      assert.ok(!urls.includes(url));
    } else assert.equal(urls.filter(value => value === url).length, 1, `${path} is missing from the sitemap`);
  }
  for (const url of urls) {
    assert.equal(new URL(url).origin, 'https://secedgarterminal.com');
    assert.equal(new URL(url).search, '');
    assert.equal(new URL(url).hash, '');
  }
});

test('sitemap analysis discovery follows the active indexable universe, without stale featured issuers', async () => {
  const entries = await sitemapFixture([{ ticker: 'AAPL' }, { ticker: 'MSFT' }, { ticker: 'AAPL' }]).default();
  const urls = entries.map(entry => entry.url);
  assert.equal(urls.filter(url => url === 'https://secedgarterminal.com/analysis/AAPL').length, 1);
  assert.ok(urls.includes('https://secedgarterminal.com/analysis/MSFT'));
  assert.ok(!urls.includes('https://secedgarterminal.com/analysis/TSLA'));
  for (const group of FEATURED_COMPARE_GROUPS) {
    assert.ok(urls.includes(`https://secedgarterminal.com/compare/${group.tickers}`));
    assert.equal(comparePageMetadata(comparePageSelection(group.tickers)).index, true);
  }
  for (const legacy of ['/crypto', '/market/factors', '/market/positioning', '/bank-pilot']) {
    assert.ok(!urls.includes(`https://secedgarterminal.com${legacy}`));
  }
});

test('robots preserves intentional public JSON while excluding expensive preparation endpoints', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Disallow: \/api\/$/m);
  for (const route of ['/api/v1/cftc/portfolio-changes/demo', '/api/v1/funds/', '/api/v1/managers/', '/api/v1/analysis/', '/api/fund-13f/market-review']) {
    assert.ok(robots.split('\n').includes(`Allow: ${route}`));
  }
  assert.match(robots, /^Sitemap: https:\/\/secedgarterminal\.com\/sitemap.xml$/m);
  assert.match(robots, /^Sitemap: https:\/\/secedgarterminal\.com\/analysis\/banks\/sitemap.xml$/m);
  assert.doesNotMatch(robots, /Allow: \/api\/(?:cron|reports|filings-reader)/);
});
