import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findProviderBoundaryHits, providerBoundaryViolations } from '../scripts/provider-boundary-rules.mjs';

const root = new URL('..', import.meta.url).pathname;
function files(path) {
  const output = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) output.push(...files(child)); else output.push(child);
  }
  return output;
}

test('runtime, build scripts and public documentation have no retired provider acquisition boundary', () => {
  const rootFiles = readdirSync(root).filter(name => /\.(?:js|mjs|cjs|json|md|txt|ya?ml)$/i.test(name)).map(name => join(root, name));
  const scanned = ['src', 'scripts', 'public', 'docs', '.github']
    .flatMap(folder => files(join(root, folder)))
    .concat(rootFiles, [join(root, '.env.example')]);
  const skippedSecurityFiles = new Set([
    'scripts/assert-provider-free.mjs',
    'scripts/provider-boundary-rules.mjs',
  ]);
  const violations = [];
  for (const path of scanned) {
    const name = relative(root, path);
    if (skippedSecurityFiles.has(name)) continue;
    const value = readFileSync(path, 'utf8');
    const hits = providerBoundaryViolations(name, value);
    if (hits.length) violations.push({ name, hits });
  }
  assert.deepEqual(violations, []);
});

test('provider boundary recognizes aliases, finance CDNs, proxy services, packages and retired callers precisely', () => {
  const forbidden = [
    'https://query7.finance.yahoo.com/v8/finance/chart/AAPL',
    'https://cdn.finance.yahoo.com/example',
    'https://s.yimg.com/finance.js',
    'https://query.yahooapis.com/v1/public/yql',
    'https://consent.yahoo.com/v2/collectConsent',
    'https://stooq.pl/q/d/l/?s=aapl.us',
    'https://stooq.co.uk/q/d/l/?s=aapl.us',
    'https://prices.stooq.com/a.csv',
    'https://nested.cdn.finance.yahoo.com/example',
    'https://nested.images.yimg.com/finance.js',
    'https://nested.prices.stooq.co.uk/a.csv',
    'https://apidojo-yahoo-finance-v1.p.rapidapi.com/market/get-quotes',
    'https://yfapi.net/v6/finance/quote',
    'https://api.allorigins.win/raw?url=https%3A%2F%2Fquery1%2Efinance%2Eyahoo%2Ecom%2Fv8%2Ffinance%2Fchart%2FAAPL',
    'https://corsproxy.io/?https%253A%252F%252Fstooq%252Epl%252Fq%252Fd%252Fl%252F',
    "import prices from 'yahoo-finance2'",
    "fetch('/api/prices?ticker=AAPL')",
    "apiFetch('/api/v1/market-signals?ticker=AAPL')",
    "useSWR('/api/prices?ticker=AAPL')",
    "ky.get('/api/v1/factor-universe?basis=ttm')",
    'const loader = loadPriceSeries;',
  ];
  for (const value of forbidden) {
    assert.notDeepEqual(findProviderBoundaryHits(value), [], value);
  }
  for (const allowed of [
    'Form 4 transactionPrice is SEC-reported.',
    'Return on equity and market value are accounting/user inputs.',
    "fetch('/api/v2/factor-universe?basis=ttm')",
    'Use the internal SEC proxy only for filing documents.',
    'Official CFTC futures positioning has no spot prices.',
  ]) {
    assert.deepEqual(findProviderBoundaryHits(allowed), [], allowed);
  }
});

test('provider boundary remains bounded on long source-map segments', () => {
  const startedAt = performance.now();
  assert.deepEqual(findProviderBoundaryHits('A'.repeat(100_000)), []);
  assert.ok(performance.now() - startedAt < 2_000, 'provider scan exceeded its bounded runtime budget');
});

test('security-gate executables contain no network client and compiled exceptions are exact', () => {
  for (const name of ['scripts/assert-provider-free.mjs', 'scripts/provider-boundary-rules.mjs']) {
    const value = readFileSync(join(root, name), 'utf8');
    assert.doesNotMatch(value, /\b(?:await\s+fetch|globalThis\.fetch|window\.fetch|axios\.)\s*\(/, name);
    assert.doesNotMatch(value, /from\s+["'](?:node:)?https?["']/, name);
  }
  const compiledMigration = "security-price-retirement-2026-09-r4 stock-raw-yahoo";
  assert.deepEqual(providerBoundaryViolations('server/chunk.js', compiledMigration, { built: true }), []);
  assert.notDeepEqual(providerBoundaryViolations('server/chunk.js', `${compiledMigration} finance.yahoo.com`, { built: true }), []);
  assert.deepEqual(providerBoundaryViolations('server/framework.js', 'metadata: { yahoo: [] }', { built: true }), []);
  assert.deepEqual(providerBoundaryViolations('server/vendor.js.map', 'Copyright 2015, Yahoo! Inc.', { built: true }), []);
  assert.deepEqual(providerBoundaryViolations('server/vendor.js.map', 'https://finance.yahoo.com', { built: true }), ['provider-host']);
});
