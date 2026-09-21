import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecFilerSearch, parseSecFilerQuery, SEC_FILER_RESULT_LIMIT } from '../src/utils/secFilerSearchServer.js';
import { GET } from '../src/app/api/sec-filers/route.js';
import { createFilerSearchClient } from '../src/utils/secFilerSearch.js';

const CIK = '0001747057';
const NAME = 'D1 Capital Partners L.P.';
const NOW = Date.parse('2026-09-15T00:00:00Z');
function page(hits = [], total = hits.length) {
  return { timed_out: false, _shards: { failed: 0 }, hits: { total: { value: total, relation: 'eq' }, hits } };
}
const hint = (id, entity) => ({ _id: id, _source: { entity } });
function filing({ ciks = [CIK], names = [`${NAME}  (CIK ${CIK})`], form = '13F-HR' } = {}) {
  return { _source: { ciks, display_names: names, form } };
}
function setup(overrides = {}) {
  const calls = [];
  const search = createSecFilerSearch({ now: () => NOW, fetchSec: async (url, options) => {
    calls.push({ url, options });
    const params = new URL(url).searchParams;
    const data = params.has('keysTyped') ? page([hint('1747057', NAME)]) : page([filing()]);
    return Response.json(data);
  }, ...overrides });
  return { search, calls };
}

test('name search accepts legal punctuation and CIKs but rejects URL and query syntax before fetching', async () => {
  assert.deepEqual(parseSecFilerQuery('  D1  Capital Partners L.P. '), { query: NAME, cik: null });
  assert.deepEqual(parseSecFilerQuery('CIK 1747057'), { query: 'CIK 1747057', cik: CIK });
  assert.deepEqual(parseSecFilerQuery('1747057'), { query: '1747057', cik: CIK });
  assert.deepEqual(parseSecFilerQuery("O'Brien & Partners (U.S.)"), { query: "O'Brien & Partners (U.S.)", cik: null });
  for (const value of ['', 'D', '0', '0000', '12345678901', 'https://example.com', 'www.sec.gov', 'D1\nCapital', 'name:Capital', 'D1*', 'A'.repeat(161), '<script>'])
    assert.throws(() => parseSecFilerQuery(value), { status: 400 });
  const { search, calls } = setup();
  await assert.rejects(search('https://example.com'), { status: 400 });
  assert.equal(calls.length, 0);
});

test('uses actual SEC name parameters and root forms without document text or amendment-only filtering', async () => {
  const { search, calls } = setup();
  const result = await search('D1 Capital');
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url).searchParams, second = new URL(calls[1].url).searchParams;
  assert.equal(first.get('keysTyped'), 'D1 Capital');
  assert.equal(first.has('keys'), false);
  assert.equal(second.get('entityName'), 'D1 Capital');
  assert.equal(second.get('forms'), '13F-HR,13F-NT,X-17A-5');
  assert.equal(second.get('q'), null);
  assert.equal(second.get('dateRange'), 'all');
  assert.ok(calls.every(call => call.options.maxBytes === 2 * 1024 * 1024 && call.options.timeoutMs === 8000 && call.options.retries === 1));
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.deepEqual(result.results, [{ cik: CIK, name: NAME, formTypes: ['13F-HR'] }]);
  assert.equal(result.source.fetchedAt, new Date(NOW).toISOString());
  assert.equal(result.truncated, false);
});

test('D1 manager remains first when SEC hints omit it and rank unrelated private funds above it', async () => {
  const { search, calls } = setup({ fetchSec: async (url) => {
    calls.push({ url });
    const params = new URL(url).searchParams;
    if (params.has('keysTyped')) return Response.json(page([
      hint('1981897', 'CapitalX, LP - D1'), hint('1880027', 'D1 Capital Series LLC - Series D11'),
      hint('2124401', 'D1 Capital Access LLC'),
    ], 46));
    if (params.has('forms')) return Response.json(page([filing()]));
    return Response.json(page([
      filing(), filing({ ciks: ['0001745259'], names: ['D1 Capital Partners Onshore LP  (CIK 0001745259)'], form: 'D/A' }),
      filing({ ciks: ['0002078856', CIK], names: ['Hyperliquid Strategies Inc  (PURR)  (CIK 0002078856)', `${NAME}  (CIK ${CIK})`], form: 'SCHEDULE 13G/A' }),
    ], 207));
  } });
  const result = await search('D1 Capital');
  assert.equal(calls.length, 3);
  assert.deepEqual(result.results[0], { cik: CIK, name: NAME, formTypes: ['13F-HR'] });
  assert.ok(result.results.some(item => item.cik === '0001745259' && item.formTypes.length === 0));
  assert.ok(!result.results.some(item => item.cik === '0002078856'));
  assert.equal(result.results.filter(item => item.cik === CIK).length, 1);
  assert.equal(result.truncated, true);
});

test('single-CIK 13F amendments and notices retain actual form types without assuming fund classification', async () => {
  const { search } = setup({ fetchSec: async url => Response.json(new URL(url).searchParams.has('keysTyped') ? page([hint('1747057', NAME)]) : page([
    filing({ form: '13F-HR/A' }), filing({ form: '13F-NT' }), filing({ form: '13F-NT/A' }),
  ])) });
  const result = await search('D1 Capital');
  assert.deepEqual(result.results[0].formTypes, ['13F-HR/A', '13F-NT', '13F-NT/A']);
  assert.equal(Object.hasOwn(result.results[0], 'isFund'), false);
});

test('arbitrary holdings reporters rank ahead of related notices without overriding a more precise legal-name match', async () => {
  const rows = [
    filing({ ciks: ['0001336476'], names: ['Pershing Square GP, LLC  (CIK 0001336476)'], form: '13F-NT' }),
    filing({ ciks: ['0001336528'], names: ['Pershing Square Capital Management, L.P.  (CIK 0001336528)'], form: '13F-HR/A' }),
    filing({ ciks: ['0002026053'], names: ['PERSHING SQUARE INC.  (CIK 0002026053)'], form: '13F-HR' }),
  ];
  const search = createSecFilerSearch({ fetchSec: async url => Response.json(new URL(url).searchParams.has('keysTyped')
    ? page([hint('1275323', 'PERSHING SQUARE L P')]) : page(rows)) });
  const result = await search('Pershing Square');
  assert.deepEqual(result.results.map(item => item.cik), ['0002026053', '0001336528', '0001336476', '0001275323']);
  const exact = createSecFilerSearch({ fetchSec: async url => Response.json(new URL(url).searchParams.has('keysTyped')
    ? page([hint('100', 'Example Capital')])
    : page([filing({ ciks: ['0000000200'], names: ['Example Capital Management LLC  (CIK 0000000200)'] })])) });
  assert.equal((await exact('Example Capital')).results[0].cik, '0000000100');
});

test('all discovery stages share a 25-second deadline and preserve verified results after it expires', async (t) => {
  const controller = new AbortController(), signals = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 25000);
    return controller.signal;
  });
  const search = createSecFilerSearch({ fetchSec: async (url, options) => {
    signals.push(options.signal);
    if (new URL(url).searchParams.has('keysTyped')) throw new Error('Temporary suggestion failure');
    controller.abort(new DOMException('Search deadline', 'TimeoutError'));
    return Response.json(page([filing({ ciks: ['0001167483'], names: ['TIGER GLOBAL MANAGEMENT LLC  (CIK 0001167483)'] })]));
  } });
  const result = await search('Tiger Global');
  assert.equal(signals.length, 2, 'expired deadline prevents an extra broader source request');
  assert.ok(signals.every(signal => signal === controller.signal));
  assert.equal(result.results[0].cik, '0001167483');
  assert.match(result.warning, /incomplete/);
});

test('a transient SEC response is retried once through the shared transport', async (t) => {
  let hints = 0, managerCalls = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.searchParams.has('keysTyped')) {
      hints++;
      if (hints === 1) return new Response(null, { status: 502 });
      return Response.json(page([hint('1167483', 'TIGER GLOBAL MANAGEMENT LLC')]));
    }
    managerCalls++;
    return Response.json(page([filing({ ciks: ['0001167483'], names: ['TIGER GLOBAL MANAGEMENT LLC  (CIK 0001167483)'] })]));
  });
  const result = await createSecFilerSearch()('Tiger Global');
  assert.equal(hints, 2);
  assert.equal(managerCalls, 1);
  assert.equal(result.results[0].cik, '0001167483');
  assert.equal(result.warning, undefined);
});

test('matches displayed CIK to the filing identity, not array position or another named filer', async () => {
  const { search } = setup({ fetchSec: async url => Response.json(new URL(url).searchParams.has('keysTyped') ? page([hint('1747057', NAME)]) : page([
    filing({ ciks: ['0000000100', CIK], names: [`${NAME}  (CIK ${CIK})`, 'D1 Capital Other LLC  (CIK 0000000999)'] }),
  ])) });
  const result = await search('D1 Capital');
  assert.deepEqual(result.results, [{ cik: CIK, name: NAME, formTypes: [] }]);
});

test('large valid joint filings do not invalidate broader entity-name discovery or combine words across parties', async () => {
  const ciks = Array.from({ length: 150 }, (_, index) => String(index + 1).padStart(10, '0'));
  const names = ciks.map((cik, index) => `${index ? `CCLF Holdings (D${index}) LLC` : 'Cascade Private Capital Fund'}  (CIK ${cik})`);
  ciks.push(CIK); names.push(`${NAME}  (CIK ${CIK})`);
  const { search } = setup({ fetchSec: async url => {
    const params = new URL(url).searchParams;
    return Response.json(params.has('keysTyped') || params.has('forms') ? page() : page([filing({ ciks, names, form: '40-APP/A' })]));
  } });
  const result = await search('D1 Capital');
  assert.deepEqual(result.results, [{ cik: CIK, name: NAME, formTypes: [] }]);
  assert.equal(result.warning, undefined);
});

test('complete empty sources remain empty while unavailable sources cannot masquerade as no matches', async () => {
  let mode = 'empty';
  const { search, calls } = setup({ fetchSec: async url => {
    calls.push(url);
    if (mode === 'failed' && new URL(url).searchParams.has('forms')) return Response.json({ error: 'upstream' }, { status: 503 });
    return Response.json(page());
  } });
  const empty = await search('Unknown Filer');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.warning, undefined);
  assert.equal(empty.truncated, false);
  assert.equal(calls.length, 3);
  mode = 'failed';
  await assert.rejects(search('Another Filer'), { status: 503 });
});

test('partial source failures remain visible and uncached so recovery can restore manager discovery', async () => {
  let fail = true, count = 0;
  const { search } = setup({ fetchSec: async url => {
    count++;
    if (new URL(url).searchParams.has('keysTyped')) return Response.json(page([hint('1747057', NAME)]));
    return fail ? Response.json({ error: 'down' }, { status: 503 }) : Response.json(page([filing()]));
  } });
  const partial = await search('D1 Capital');
  assert.match(partial.warning, /incomplete/);
  assert.equal(partial.truncated, true);
  assert.deepEqual(partial.results[0].formTypes, []);
  fail = false;
  const recovered = await search('D1 Capital');
  assert.equal(count, 4);
  assert.equal(recovered.warning, undefined);
  assert.deepEqual(recovered.results[0].formTypes, ['13F-HR']);
});

test('malformed, timed-out and shard-failed SEC responses never become valid empty matches', async () => {
  for (const payload of [null, {}, { error: 'Blank search not valid', hits: { hits: [] } }, { ...page(), timed_out: true }, { ...page(), _shards: { failed: 1 } }, page([hint('../7', NAME)])]) {
    const { search } = setup({ fetchSec: async () => Response.json(payload) });
    await assert.rejects(search('D1 Capital'), { status: 502 });
  }
});

test('explicit CIK validates actual submissions name and does not depend on a ticker or name hint', async () => {
  const { search, calls } = setup({ fetchSec: async url => {
    calls.push(url);
    return Response.json({ cik: CIK, name: NAME, tickers: [], filings: { recent: { form: ['SCHEDULE 13G', '13F-HR', '13F-HR'] } } });
  } });
  const result = await search('1747057');
  assert.deepEqual(calls, ['https://data.sec.gov/submissions/CIK0001747057.json']);
  assert.deepEqual(result.results, [{ cik: CIK, name: NAME, formTypes: ['13F-HR'] }]);
  assert.equal(result.source.coverageStart, undefined);
  const mismatch = createSecFilerSearch({ fetchSec: async () => Response.json({ cik: '0000000100', name: NAME, filings: { recent: { form: [] } } }) });
  await assert.rejects(mismatch(CIK), { status: 502 });
});

test('direct CIK 404 remains different from SEC outage', async () => {
  const search = createSecFilerSearch({ fetchSec: async () => new Response(null, { status: 404 }) });
  await assert.rejects(search('1747057'), { status: 404 });
});

test('bounds results and keeps exact-name match ahead of less precise institutional matches', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => hint(String(index + 1), `Example Capital ${index} LLC`));
  rows.push(hint('99', 'Example Capital'));
  const { search } = setup({ fetchSec: async url => Response.json(new URL(url).searchParams.has('keysTyped') ? page(rows) : page()) });
  const result = await search('Example Capital');
  assert.equal(result.results.length, SEC_FILER_RESULT_LIMIT);
  assert.equal(result.results[0].name, 'Example Capital');
  assert.equal(result.truncated, true);
});

test('coalesces identical queries, expires results and prevents callers from mutating cache entries', async () => {
  let time = NOW, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const search = createSecFilerSearch({ now: () => time, ttlMs: 1000, fetchSec: async url => {
    calls++;
    await gate;
    return Response.json(new URL(url).searchParams.has('keysTyped') ? page([hint('1747057', NAME)]) : page([filing()]));
  } });
  const first = search('D1 Capital'), second = search('d1 capital');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(b.query, 'd1 capital');
  a.results[0].name = 'Modified';
  assert.equal((await search('D1 Capital')).results[0].name, NAME);
  time += 1001;
  await search('D1 Capital');
  assert.equal(calls, 4);
});

test('LRU and pending request bounds prevent arbitrary-query memory growth', async () => {
  let calls = 0;
  const search = createSecFilerSearch({ maxEntries: 2, fetchSec: async url => {
    calls++;
    const name = new URL(url).searchParams.get('keysTyped');
    return Response.json(name ? page([hint('100', name)]) : page());
  } });
  await search('Alpha Capital'); await search('Beta Capital'); await search('Alpha Capital'); await search('Gamma Capital');
  assert.equal(calls, 6);
  await search('Beta Capital');
  assert.equal(calls, 8);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const limited = createSecFilerSearch({ maxPending: 1, fetchSec: async () => { await gate; return Response.json(page()); } });
  const waiting = limited('First Entity');
  await assert.rejects(limited('Second Entity'), { status: 503 });
  release();
  await waiting;
});

test('API rejects invalid, duplicate and unknown parameters without contacting SEC', async () => {
  for (const query of ['', 'query=D', 'query=D1&query=Capital', 'query=D1&url=https://example.com', 'query=https://example.com', 'q=D1']) {
    const response = await GET(new Request(`https://example.test/api/sec-filers?${query}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('browser search reaches the actual API and returns the verified SEC manager identity', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'efts.sec.gov');
    calls.push(parsed);
    return Response.json(parsed.searchParams.has('keysTyped') ? page([hint(CIK, NAME)]) : page([filing()]));
  });
  const search = createFilerSearchClient({ fetchImpl: (path) => GET(new Request(`https://example.test${path}`)) });
  const result = await search('D1 Capital');
  assert.deepEqual(result.results, [{ cik: CIK, name: NAME, formTypes: ['13F-HR'] }]);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.searchParams.get('keysTyped') === 'D1 Capital' || url.searchParams.get('entityName') === 'D1 Capital'));
});
