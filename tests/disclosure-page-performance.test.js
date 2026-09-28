import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDisclosurePageSettings, readDisclosurePageSettings } from '../src/utils/disclosurePageState.js';
import { legacyDisclosureQuery } from '../src/utils/disclosureQuery.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const restore = query => readDisclosurePageSettings(new URLSearchParams(query));

test('disclosures landing defaults are deterministic for the serialized render date', () => {
  const settings = createDisclosurePageSettings({}, '2026-09-28');
  assert.deepEqual(settings, {
    tickers: '', mode: 'index', searchStyle: 'smart', query: '',
    start: '2025-01-01', end: '2026-09-28', forms: '10-K,10-Q,8-K',
    section: 'all', scope: 'paragraph', depth: 4, amendments: false, comparison: 'none',
  });
});

test('UTC rollover updates default dates without changing explicit link dates', () => {
  assert.equal(createDisclosurePageSettings({}, '2027-01-01').start, '2026-01-01');
  assert.equal(createDisclosurePageSettings({}, '2027-01-01').end, '2027-01-01');
  const settings = createDisclosurePageSettings(restore('start=2024-01-01&end=2025-12-31'), '2027-01-01');
  assert.equal(settings.start, '2024-01-01');
  assert.equal(settings.end, '2025-12-31');
});

for (const alias of ['focus', 'ticker', 'cik', 'company', 'tickers']) {
  test(`disclosure share links retain the ${alias} company filter`, () => {
    const result = restore(`query=liquidity&${alias}=MSFT`);
    assert.equal(result.query, 'liquidity');
    assert.equal(result.tickers, 'MSFT');
    assert.equal(result.searchStyle, 'smart');
  });
}

test('company filter precedence and first parameter behavior match existing links', () => {
  assert.equal(restore('tickers=AAPL&focus=MSFT&ticker=JPM').tickers, 'AAPL');
  assert.equal(restore('focus=MSFT&ticker=JPM&cik=123&company=Apple').tickers, 'MSFT');
  assert.equal(restore('query=first&query=second').query, 'first');
  assert.equal(restore('query=&query=second&keywords=liquidity').query, legacyDisclosureQuery('liquidity', ''));
});

test('legacy query and match-mode links retain their exact Boolean semantics', () => {
  for (const match of ['any', 'all', 'phrase']) {
    const params = new URLSearchParams({ keywords: 'liquidity, covenant', match });
    const initial = readDisclosurePageSettings(params);
    assert.equal(initial.searchStyle, 'exact');
    assert.equal(initial.query, legacyDisclosureQuery('liquidity, covenant', match));
    params.delete('match'); params.set('matchMode', match);
    assert.deepEqual(readDisclosurePageSettings(params), initial);
  }
  const query = '"material weakness" AND NOT hypothetical';
  const result = readDisclosurePageSettings(new URLSearchParams({ query, style: 'exact' }));
  assert.equal(result.query, legacyDisclosureQuery(query, ''));
});

test('all explicit research controls survive static-page hydration', () => {
  const params = new URLSearchParams({
    query: 'covenant', tickers: 'JPM,BAC', mode: 'companies', style: 'exact',
    start: '2024-01-01', end: '2025-12-31', forms: '10-K,10-Q', section: 'notes',
    scope: 'document', depth: '12', amendments: 'true', comparison: 'previous-report',
  });
  const result = createDisclosurePageSettings(readDisclosurePageSettings(params), '2026-09-28');
  for (const key of ['tickers', 'mode', 'start', 'end', 'forms', 'section', 'scope', 'comparison'])
    assert.equal(result[key], params.get(key));
  assert.equal(result.depth, 12);
  assert.equal(result.amendments, true);
  assert.equal(result.searchStyle, 'exact');
});

test('invalid controls are not silently broadened and reader URL fields are untouched', () => {
  const params = new URLSearchParams('query=liquidity&depth=bad&section=unknown&start=bad&reader=1&accession=0000000000-26-000001');
  const before = params.toString();
  const result = readDisclosurePageSettings(params);
  assert.ok(Number.isNaN(result.depth));
  assert.equal(result.section, 'unknown');
  assert.equal(result.start, 'bad');
  assert.equal(params.toString(), before);
  assert.equal(result.reader, undefined);
});

test('landing page remains prerenderable and sends a real search UI rather than a blank shell', () => {
  const page = read('src/app/disclosures/page.tsx');
  const client = read('src/app/disclosures/DisclosureSearchClient.tsx');
  assert.match(page, /export const revalidate = 3600/);
  assert.doesNotMatch(page, /await searchParams|useSearchParams|force-dynamic/);
  assert.match(page, /<DisclosureSearchClient initialToday=/);
  assert.match(client, /import DisclosureQueryBar from/);
  assert.match(client, /readDisclosurePageSettings\(params\)/);
  assert.match(client, /initialQueryRef\.current = hydratedSettings\.query/);
  assert.match(client, /<h1>Find what companies/);
});

test('result processing and coverage UI stay outside the eager landing bundle', () => {
  const client = read('src/app/disclosures/DisclosureSearchClient.tsx');
  assert.doesNotMatch(client, /import DisclosureResults from|import DisclosureCoverageDesk from/);
  assert.match(client, /dynamic\(\(\) => import\("\.\/DisclosureResults"\)/);
  assert.match(client, /dynamic\(\(\) => import\("\.\/DisclosureCoverageDesk"\)/);
  assert.match(client, /void import\("\.\/DisclosureResults"\)\.catch/);
});

test('draft typing does not force result filtering and passage cards to render again', () => {
  const result = read('src/app/disclosures/DisclosureResults.tsx');
  assert.match(result, /useDeferredValue\(filters\)/);
  assert.match(result, /const ResultCards = memo/);
  assert.match(result, /export default memo\(DisclosureResults\)/);
  assert.doesNotMatch(result, /\[filings, filters,/);
});
