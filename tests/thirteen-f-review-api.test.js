import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFReviewApi } from '../src/utils/thirteenFReviewApi.js';
import { hashThirteenFReviewReport, THIRTEEN_F_REVIEW_SCHEMA } from '../src/utils/thirteenFSharedReview.js';

const CIK = '0001747057', PERIOD = '2026-06-30', HASH = 'AB'.repeat(32), KEY = '000000001|SECURITY|SH';
const BASE = 'https://example.test/api/fund-13f/shared-review';
const SEARCH = `cik=${CIK}&period=${PERIOD}`;
function report(count = 75) {
  const totalValueUsd = count * 100;
  return { manager: { cik: CIK, name: 'Fixture Capital' }, selectedPeriod: PERIOD,
    observedAt: '2026-09-15T12:00:00.000Z', coverage: { selectedPeriodComplete: true },
    portfolio: { cik: CIK, period: PERIOD, complete: true, totalValueUsd, positionCount: count, entryCount: count,
      filings: [], holdings: Array.from({ length: count }, (_, i) => {
        const cusip = String(i + 1).padStart(9, '0');
        return { key: `${cusip}|SECURITY|SH`, cusip, issuer: `Company ${i + 1}`, classTitle: 'COM', putCall: null,
          quantity: 10, quantityType: 'SH', valueUsd: 100, weightPct: 100 / count };
      }) } };
}
const get = (suffix = '', options = {}) => new Request(`${BASE}?${SEARCH}${suffix ? `&${suffix}` : ''}`, options);
const post = (body = { cik: CIK, period: PERIOD }, options = {}) => new Request(BASE, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.test', ...options.headers },
  body: typeof body === 'string' ? body : JSON.stringify(body), ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'headers')),
});
const forbidden = async () => { assert.fail('This request must not perform source, worker or unrelated store operations.'); };
function api(overrides = {}) {
  return createThirteenFReviewApi({ enabled: () => true, rateLimit: async () => ({ allowed: true }),
    portfolioLoader: forbidden, schedule: forbidden, initialChart: forbidden,
    store: { read: forbidden, result: forbidden, enqueue: forbidden }, ...overrides });
}

test('progress GET only reads saved review pages, with bounded filters and a pinned report hash', async () => {
  let received, rate;
  const saved = { schemaVersion: THIRTEEN_F_REVIEW_SCHEMA, job: { reportHash: HASH, total: 5696, reviewed: 130 },
    rows: [{ ordinal: 51, status: 'linked' }], total: 80 };
  const endpoint = api({ rateLimit: async options => { rate = options; return { allowed: true }; }, store: {
    read: async (params, options) => { received = params; assert.ok(options.signal instanceof AbortSignal); assert.equal(options.timeoutMs, 11000); return saved; },
    result: forbidden, enqueue: forbidden,
  } });
  const response = await endpoint.GET(get(`reportHash=${HASH.toLowerCase()}&market=tff:134741:leveraged-funds&status=linked&query=Company&offset=50&limit=25`));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), saved);
  assert.deepEqual(received, { cik: CIK, period: PERIOD, reportHash: HASH, market: 'tff:134741:leveraged-funds',
    status: 'linked', query: 'Company', offset: 50, limit: 25 });
  assert.match(response.headers.get('cache-control'), /s-maxage=5/);
  assert.equal(response.headers.get('x-schema-version'), THIRTEEN_F_REVIEW_SCHEMA);
  assert.equal(rate.max, 120); assert.match(rate.key, /:read:/);
});

test('compact snapshot opens the latest saved quarter without loading the manager report', async () => {
  let received;
  const market = { family: 'tff', contract: '099741', group: 'leveraged-funds' };
  const chart = { report_family: 'tff', selection: { contract: '099741' } };
  const saved = { job: { cik: CIK, period: PERIOD, total: 5696 }, publicationVersion: '17', markets: [market], rows: [] };
  const endpoint = api({ store: { snapshot: async params => { received = params; return saved; } },
    initialChart: Object.assign(async () => forbidden(), { peek: value => { assert.equal(value, market); return chart; } }) });
  const response = await endpoint.GET(new Request(`${BASE}?cik=${CIK}&view=snapshot&version=17`));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { cik: CIK, period: null, view: 'snapshot' });
  assert.deepEqual(await response.json(), { ...saved, initialChart: chart });
  assert.match(response.headers.get('cache-control'), /s-maxage=60/);
});

test('progress uses only the small progress record and supports an unchanged 304', async () => {
  const saved = { job: { cik: CIK, period: PERIOD, reviewed: 102, total: 5696 }, publicationVersion: '17' };
  const endpoint = api({ store: { progress: async params => { assert.equal(params.view, 'progress'); return saved; } } });
  const response = await endpoint.GET(get('view=progress'));
  assert.deepEqual(await response.json(), saved);
  const unchanged = await endpoint.GET(get('view=progress', { headers: { 'If-None-Match': response.headers.get('etag') } }));
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
});

test('an unavailable initial chart cannot hide saved connections or trigger fallback source work', async () => {
  const saved = { job: { cik: CIK, period: PERIOD }, publicationVersion: '18', markets: [{ key: 'saved' }], rows: [] };
  const response = await api({ store: { snapshot: async () => saved }, initialChart: Object.assign(async () => null, { peek: () => { throw new Error('Chart unavailable'); } }) })
    .GET(get('view=snapshot'));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), saved);
});

test('snapshot delivery never waits for a slow prepared chart read', async () => {
  const market = { family: 'tff', contract: '099741', group: 'leveraged-funds' };
  const saved = { job: { cik: CIK, period: PERIOD }, publicationVersion: '19', markets: [market], rows: [] };
  let reads = 0, task, finish;
  const initialChart = Object.assign(async value => {
    reads++; assert.equal(value, market);
    return new Promise(resolve => { finish = resolve; });
  }, { peek: () => null });
  const response = await api({ store: { snapshot: async () => saved }, initialChart,
    scheduleInitialChart: next => { task = next; } }).GET(get('view=snapshot'));
  assert.equal(reads, 0); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), saved);
  const warming = task(); assert.equal(reads, 1); finish(null); await warming;
});

test('compact views reject ambiguous selectors and cannot accept caller-defined source work', async () => {
  for (const suffix of ['view=unknown', 'view=snapshot&view=progress', 'view=snapshot&key=abc', 'view=progress&offset=1',
    'view=snapshot&reportHash=' + HASH, 'view=progress&version=2', 'view=snapshot&version=', 'view=snapshot&version=bad%2Fpath', 'version=2']) {
    assert.equal((await api({ rateLimit: forbidden }).GET(get(suffix))).status, 400, suffix);
  }
});

test('GET defaults to fifty rows and an absent job does not create or schedule research', async () => {
  let params;
  const endpoint = api({ store: { read: async value => { params = value; return null; }, result: forbidden, enqueue: forbidden } });
  const response = await endpoint.GET(get());
  assert.deepEqual(await response.json(), { job: null });
  assert.equal(params.offset, 0); assert.equal(params.limit, 50); assert.equal(params.reportHash, null);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
});

test('saved evidence GET requires an exact holding and report revision and never discovers a missing result', async () => {
  let received, stored = { holding: { key: KEY }, selectedPeriod: PERIOD };
  const endpoint = api({ store: { read: forbidden, enqueue: forbidden,
    result: async params => { received = params; return stored; } } });
  const response = await endpoint.GET(get(`reportHash=${HASH.toLowerCase()}&key=${encodeURIComponent(KEY)}`));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), stored);
  assert.deepEqual(received, { cik: CIK, period: PERIOD, reportHash: HASH, key: KEY });
  stored = null;
  const missing = await endpoint.GET(get(`reportHash=${HASH}&key=${encodeURIComponent(KEY)}`));
  assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'REVIEW_RESULT_PENDING');
  assert.match(missing.headers.get('cache-control'), /no-store/);
});

test('GET rejects duplicate selectors, unknown fields, malformed keys and unbounded page filters before store work', async () => {
  const endpoint = api({ rateLimit: forbidden });
  for (const suffix of [
    `cik=${CIK}`, `period=${PERIOD}`, 'offset=0&offset=50', 'limit=10&limit=20',
    'url=https://example.org/source', 'issuerCik=0000001234', 'status=complete', 'market=tff:INVALID:leveraged-funds',
    'reportHash=made-up', 'offset=-1', 'offset=20001', 'limit=0', 'limit=51', 'limit=1.5',
    `query=${'a'.repeat(101)}`, 'query=bad%00value', `key=${encodeURIComponent(KEY)}`,
    `reportHash=${HASH}&key=made-up`, `reportHash=${HASH}&key=${encodeURIComponent(KEY)}&limit=25`,
  ]) {
    const response = await endpoint.GET(get(suffix));
    assert.equal(response.status, 400, suffix); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  for (const search of ['cik=0&period=2026-06-30', `cik=${CIK}`, `cik=${CIK}&period=2026-06-29`, `cik=${CIK}&period=2099-12-31`]) {
    assert.equal((await endpoint.GET(new Request(`${BASE}?${search}`))).status, 400, search);
  }
});

test('POST loads the complete server-owned report and schedules only after its shared job is acknowledged', async () => {
  const order = [], source = report(), job = { reportHash: hashThirteenFReviewReport(source), total: 75, reviewed: 0 };
  let rate, clock = 1000;
  const endpoint = api({ now: () => clock, rateLimit: async options => { rate = options; return { allowed: true }; },
    portfolioLoader: async (cik, options) => {
      order.push('load'); assert.equal(cik, CIK); assert.equal(options.period, PERIOD);
      clock += 55000;
      assert.ok(options.signal instanceof AbortSignal); assert.equal(options.delivery, undefined);
      return source;
    },
    store: { read: forbidden, result: forbidden, enqueue: async (frozen, hash, options) => {
      order.push('save'); assert.equal(frozen.portfolio.holdings.length, 75); assert.equal(frozen.portfolio.positionCount, 75);
      assert.equal(hash, job.reportHash); assert.equal(options.timeoutMs, 10000); assert.ok(options.signal instanceof AbortSignal);
      return job;
    } }, schedule: options => { order.push('schedule'); assert.equal(options.job, job); assert.equal(options.deadline, 141000); },
  });
  const response = await endpoint.POST(post({ cik: '1747057', period: PERIOD }));
  assert.equal(response.status, 202); assert.deepEqual(order, ['load', 'save', 'schedule']);
  assert.deepEqual(await response.json(), { schemaVersion: THIRTEEN_F_REVIEW_SCHEMA, job });
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.equal(rate.max, 4); assert.match(rate.key, /:write:/);
});

test('POST cannot enqueue a fallback manager, wrong quarter or abbreviated portfolio returned by a loader', async () => {
  for (const mutate of [
    value => { value.manager.cik = '0000000001'; value.portfolio.cik = '0000000001'; },
    value => { value.selectedPeriod = '2026-03-31'; value.portfolio.period = '2026-03-31'; },
    value => { value.portfolio.holdings = value.portfolio.holdings.slice(0, 20); },
  ]) {
    const source = report(); mutate(source);
    const response = await api({ portfolioLoader: async () => source }).POST(post());
    assert.ok([400, 422].includes(response.status), mutate.toString());
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('POST does not launch workers when durable storage fails or declines to acknowledge the job', async () => {
  for (const fails of [false, true]) {
    const endpoint = api({ portfolioLoader: async () => report(), store: { read: forbidden, result: forbidden,
      enqueue: async () => { if (fails) throw new Error('Sensitive internal store details'); return null; } } });
    const response = await endpoint.POST(post());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.doesNotMatch(body.error, /Sensitive internal/);
    assert.equal(body.code, fails ? 'SHARED_REVIEW_UNAVAILABLE' : 'REVIEW_NOT_SAVED');
  }
});

test('POST blocks foreign origins and malformed, oversized or caller-controlled research inputs before work', async () => {
  const endpoint = api({ rateLimit: forbidden });
  for (const headers of [{ origin: 'https://foreign.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await endpoint.POST(post(undefined, { headers }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'CROSS_ORIGIN_REQUEST');
  }
  for (const body of [
    'malformed JSON', 'null', '[]', '{}', { cik: CIK }, { cik: CIK, period: '2099-12-31' },
    { cik: CIK, period: PERIOD, holdings: [] }, { cik: CIK, period: PERIOD, reportHash: HASH },
    { cik: CIK, period: PERIOD, budget: 100000 }, { cik: CIK, period: PERIOD, url: 'https://example.org/source' },
    `${' '.repeat(4096)}${JSON.stringify({ cik: CIK, period: PERIOD })}`,
  ]) {
    const response = await endpoint.POST(post(body));
    assert.equal(response.status, 400); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  for (const request of [
    post(undefined, { headers: { 'Content-Type': 'text/plain' } }),
    post(undefined, { headers: { 'Content-Length': '4097' } }),
    new Request(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    new Request(`${BASE}?cik=${CIK}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cik: CIK, period: PERIOD }) }),
  ]) assert.equal((await endpoint.POST(request)).status, 400);
});

test('feature and per-client rate limits stop both read and write work with noncacheable responses', async () => {
  for (const method of ['GET', 'POST']) {
    const request = () => method === 'GET' ? get() : post();
    const disabled = await api({ enabled: () => false, rateLimit: forbidden })[method](request());
    assert.equal(disabled.status, 503); assert.equal((await disabled.json()).code, 'CFTC_DISABLED');
    const limited = await api({ rateLimit: async () => ({ allowed: false, retryAfter: 60, reset: Date.now() + 60000 }) })[method](request());
    assert.equal(limited.status, 429); assert.match(limited.headers.get('cache-control'), /no-store/);
  }
});
