import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreparedOperatingTickers } from '../src/utils/tickerMap.js';
import { searchDisclosurePassageIndex, DISCLOSURE_INDEX_LIMITS } from '../src/utils/disclosurePassageIndex.js';

const settings = { query: 'cybersecurity', forms: ['10-K'], scope: 'paragraph', section: 'all', start: '2025-01-01', end: '2026-09-25' };
const row = { cik: '0000789019', ticker: '0000789019', accession: '0001193125-26-323660', primaryDoc: 'msft-ex19_1.htm',
  companyName: 'MICROSOFT CORP', form: '10-K', filingDate: '2026-07-29', reportDate: '2026-06-30',
  parserVersion: DISCLOSURE_INDEX_LIMITS.parserVersion, passage: { index: 1, sectionId: 'other', section: 'Other',
    text: 'Cybersecurity risks and incidents (including vulnerabilities and breaches)' } };

test('a ticker finds the same prepared passages as its CIK even when the index retained a CIK in the ticker field', async () => {
  let lookups = 0;
  const resolveTickers = async (symbols, options) => {
    lookups++; assert.deepEqual(symbols, ['MSFT']);
    assert.ok(options.deadline <= Date.now() + 1500);
    return { MSFT: { cik: row.cik, name: row.companyName } };
  };
  const search = async ({ ciks, tickers }) => ({ results: ciks.includes(row.cik) || tickers.includes(row.ticker) ? [row] : [], hasMore: false });
  const byTicker = await searchDisclosurePassageIndex(settings, { tickers: ['msft'] }, { resolveTickers, search });
  const byCik = await searchDisclosurePassageIndex(settings, { tickers: ['789019'] }, { resolveTickers, search });
  assert.equal(lookups, 1, 'numeric identities need no directory lookup');
  assert.equal(byTicker.results.length, 1);
  assert.deepEqual(byTicker.results, byCik.results);
});

test('missing identities and directory outages keep the original filter and never become all-company searches', async () => {
  for (const resolveTickers of [async () => ({}), async () => { throw new Error('directory offline'); }]) {
    let calls = 0;
    await searchDisclosurePassageIndex(settings, { tickers: ['UNKNOWN'] }, { resolveTickers,
      search: async query => { calls++; assert.deepEqual(query.ciks, []); assert.deepEqual(query.tickers, ['UNKNOWN']); return { results: [] }; } });
    assert.equal(calls, 1);
  }
  await searchDisclosurePassageIndex(settings, {}, { resolveTickers: async () => assert.fail('No selector to resolve'), search: async () => ({ results: [] }) });
});

test('prepared identities use a bounded cache read, validate source age, and preserve exact share-class matches', async () => {
  const now = Date.now();
  const value = { schema: 1, kind: 'operating', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
    data: { MSFT: { cik: row.cik, name: row.companyName }, 'BRK-B': { cik: '0001067983', name: 'Berkshire Hathaway' } } };
  const read = async (type, ids, options) => {
    assert.equal(type, 'sec-directory-v1'); assert.deepEqual(ids, ['operating']);
    assert.ok(options.deadline <= Date.now() + 1500); return [value];
  };
  const identities = await getPreparedOperatingTickers(['msft', 'BRK.B', 'UNKNOWN'], {}, read);
  assert.deepEqual(Object.keys(identities), ['MSFT', 'BRK.B']);
  assert.equal(identities.MSFT.cik, row.cik);
  assert.equal(identities['BRK.B'].cik, '0001067983');
  value.fetchedAt = new Date(now - 8 * 86400000).toISOString();
  value.expiresAt = new Date(now - 7 * 86400000).toISOString();
  assert.deepEqual(await getPreparedOperatingTickers(['MSFT'], {}, read), {});
  assert.deepEqual(await getPreparedOperatingTickers(['MSFT'], {}, async () => [null]), {});
});

test('cancellation during identity resolution stops the following index request', async () => {
  const controller = new AbortController();
  await assert.rejects(searchDisclosurePassageIndex(settings, { tickers: ['MSFT'], signal: controller.signal }, {
    resolveTickers: async () => { controller.abort(new Error('selection changed')); return {}; },
    search: async () => assert.fail('Canceled search must not query the index'),
  }), /selection changed/);
});
