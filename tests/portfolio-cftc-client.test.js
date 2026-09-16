import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPortfolioCftcChanges, mergePortfolioCftcChanges, unfinishedPortfolioCftcCompanies } from '../src/utils/portfolioCftcChangesClient.js';

const companies = Array.from({ length: 100 }, (_, index) => ({ ticker: `C${index}`, cik: String(index + 1).padStart(10, '0'), rowId: `row-${index}` }));
const marketKey = 'disaggregated:067651:managed-money';
const response = (batch, { failed = [], preparation, marketUnavailable = false, events = true } = {}) => ({
  schemaVersion: 'edgar.portfolio-cftc-changes.v2', generatedAt: '2026-09-16T12:00:00Z',
  companyChecks: batch.map(company => ({ ...company, status: failed.includes(company.ticker) ? 'unavailable' : 'linked',
    marketKeys: failed.includes(company.ticker) ? [] : [marketKey], code: failed.includes(company.ticker) ? 'SEC_UPSTREAM_UNAVAILABLE' : undefined })),
  marketChecks: [{ key: marketKey, status: marketUnavailable ? 'unavailable' : 'ready', belowThreshold: 2 }],
  events: !events || marketUnavailable ? [] : [{ id: `${marketKey}:2026-09-08`, family: 'disaggregated', contract: '067651', traderGroup: 'managed-money',
    reportDate: '2026-09-08', netPctChange: 2, relatedCompanies: batch.filter(company => !failed.includes(company.ticker)) }],
  preparation,
});
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('100-company cold coverage completes in five sequential distinct requests and deduplicates shared events', async () => {
  const batches = [], progress = [];
  let active = 0;
  const result = await loadPortfolioCftcChanges(companies, { fetchImpl: async (_url, options) => {
    assert.equal(++active, 1, 'requests must not create parallel source bursts');
    const requested = JSON.parse(options.body).companies;
    batches.push(requested);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return ok(response(requested.slice(0, 24)));
  }, onUpdate: data => progress.push(data.coverage.checked) });
  assert.deepEqual(batches.map(batch => batch.length), [100, 24, 24, 24, 4]);
  assert.deepEqual(progress, [24, 48, 72, 96, 100]);
  assert.equal(new Set(batches.flatMap((batch, index) => (index ? batch : batch.slice(0, 24)).map(company => company.cik))).size, 100);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].relatedCompanies.length, 100);
  assert.equal(result.coverage.checked, 100);
  assert.equal(result.coverage.pending, 0);
  assert.equal(result.coverage.limited, false);
  assert.equal(result.coverage.uniqueMarkets, 1);
  assert.equal(result.coverage.marketsChecked, 1);
  assert.equal(result.coverage.belowThreshold, 2, 'market statistics must not be multiplied by five batches');
});

test('prepared complete and stale snapshots each use one read without starting live discovery', async () => {
  for (const status of ['ready', 'stale']) {
    let requests = 0;
    const result = await loadPortfolioCftcChanges(companies, { fetchImpl: async (_url, options) => {
      requests++;
      assert.equal(JSON.parse(options.body).companies.length, 100);
      return ok(response(companies, { preparation: { status, checkedAt: '2026-09-16T10:00:00Z' } }));
    } });
    assert.equal(requests, 1);
    assert.equal(result.coverage.checked, 100);
    assert.equal(result.preparation.status, status);
  }
});

test('an incompatible API schema cannot publish results or claim checked coverage', async () => {
  let updates = 0, requests = 0;
  await assert.rejects(loadPortfolioCftcChanges(companies, { onUpdate: () => updates++, fetchImpl: async () => {
    requests++;
    return ok({ ...response(companies), schemaVersion: 'edgar.portfolio-cftc-changes.v1' });
  } }), /coverage could not be verified/);
  assert.equal(updates, 0);
  assert.equal(requests, 1);
});

test('only failed company checks are retried once after the initial full scan', async () => {
  const batches = [], delays = [];
  const result = await loadPortfolioCftcChanges(companies, { delay: async ms => delays.push(ms), fetchImpl: async (_url, options) => {
    const batch = JSON.parse(options.body).companies.slice(0, 24);
    batches.push(batch);
    return ok(response(batch, { failed: batches.length === 1 ? ['C2'] : [] }));
  } });
  assert.equal(batches.length, 6);
  assert.deepEqual(batches.at(-1).map(company => company.ticker), ['C2']);
  assert.equal(delays.length, 1);
  assert.ok(delays[0] > 0);
  assert.equal(result.coverage.checked, 100);
  assert.equal(result.coverage.unavailable, 0);
  assert.equal(result.events[0].relatedCompanies.length, 100);
});

test('persistent failures are reported without an unbounded retry loop or false completed coverage', async () => {
  let requests = 0;
  const result = await loadPortfolioCftcChanges(companies, { delay: async () => {}, fetchImpl: async (_url, options) => {
    requests++;
    const batch = JSON.parse(options.body).companies.slice(0, 24);
    return ok(response(batch, { failed: batch.map(company => company.ticker) }));
  } });
  assert.equal(requests, 10);
  assert.equal(result.coverage.checked, 0);
  assert.equal(result.coverage.unavailable, 100);
  assert.equal(result.coverage.pending, 0);
  assert.equal(result.events.length, 0);
});

test('manual retry requests only unfinished checks and linked companies with failed market observations', async () => {
  let previous = mergePortfolioCftcChanges(null, response(companies.slice(0, 24), { failed: ['C2'] }), companies.slice(0, 25));
  const batches = [];
  const result = await loadPortfolioCftcChanges(companies.slice(0, 25), { previous, retryOnly: true, fetchImpl: async (_url, options) => {
    const batch = JSON.parse(options.body).companies;
    batches.push(batch);
    return ok(response(batch));
  } });
  assert.deepEqual(batches.map(batch => batch.map(company => company.ticker)), [['C2', 'C24']]);
  assert.equal(result.coverage.checked, 25);
  previous = mergePortfolioCftcChanges(null, response(companies.slice(0, 2), { marketUnavailable: true }), companies.slice(0, 2));
  assert.deepEqual(unfinishedPortfolioCftcCompanies(previous, companies.slice(0, 2)), companies.slice(0, 2));
});

test('manual refresh checks stale linked markets without automatically retrying unchanged aged source data', async () => {
  const universe = companies.slice(0, 2);
  const body = response(universe);
  body.marketChecks[0].status = 'stale';
  const previous = mergePortfolioCftcChanges(null, body, universe);
  let requests = 0;
  await loadPortfolioCftcChanges(universe, { previous, retryOnly: true, fetchImpl: async () => { requests++; return ok(body); } });
  assert.equal(requests, 1);
});

test('a failed refresh retains earlier evidence while a successful no-change refresh replaces it', () => {
  const universe = companies.slice(0, 2);
  const previous = mergePortfolioCftcChanges(null, response(universe), universe);
  const failed = mergePortfolioCftcChanges(previous, response([companies[0]], { failed: ['C0'] }), universe);
  assert.equal(failed.events[0].relatedCompanies.length, 2);
  assert.equal(failed.coverage.checked, 1);
  assert.equal(failed.coverage.unavailable, 1);
  const fresh = mergePortfolioCftcChanges(failed, { ...response(universe, { events: false }),
    companyChecks: universe.map(company => ({ ...company, status: 'no_matches' })), marketChecks: [] }, universe);
  assert.equal(fresh.events.length, 0);
  assert.equal(fresh.coverage.noLink, 2);
  assert.equal(fresh.coverage.uniqueMarkets, 0);
  assert.equal(fresh.coverage.unavailable, 0);
  assert.equal(previous.events[0].relatedCompanies.length, 2, 'merge must not mutate retained results');
});

test('successful company discovery with a failed market refresh retains its prior event as stale', () => {
  const universe = companies.slice(0, 1);
  const previous = mergePortfolioCftcChanges(null, response(universe), universe);
  const failed = mergePortfolioCftcChanges(previous, response(universe, { marketUnavailable: true }), universe);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0].relatedCompanies.length, 1);
  assert.equal(failed.events[0].historyStatus, 'stale');
  assert.equal(failed.events[0].retainedFromPrevious, true);
  assert.equal(failed.coverage.marketUnavailable, 1);
  assert.deepEqual(unfinishedPortfolioCftcCompanies(failed, universe), universe);
  const recovered = mergePortfolioCftcChanges(failed, response(universe, { events: false }), universe);
  assert.equal(recovered.events.length, 0);
  assert.equal(recovered.coverage.marketUnavailable, 0);
});

test('rate limiting stops immediately, preserves partial progress, and communicates the cooldown', async () => {
  let requests = 0, retained;
  const before = Date.now();
  await assert.rejects(loadPortfolioCftcChanges(companies, { onUpdate: data => { retained = data; }, fetchImpl: async (_url, options) => {
    requests++;
    if (requests === 2) return new Response(JSON.stringify({ error: 'Too many requests.' }), { status: 429, headers: { 'Retry-After': '120' } });
    return ok(response(JSON.parse(options.body).companies.slice(0, 24)));
  } }), error => error.status === 429 && error.retryAt >= before + 120_000);
  assert.equal(requests, 2);
  assert.equal(retained.coverage.checked, 24);
  assert.equal(retained.coverage.pending, 76);
});

test('aborted obsolete requests never publish their late response or start later batches', async () => {
  const old = new AbortController();
  let finish, updates = 0, requests = 0;
  const pending = loadPortfolioCftcChanges(companies, { signal: old.signal, onUpdate: () => updates++, fetchImpl: () => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  } });
  old.abort(new DOMException('Portfolio changed.', 'AbortError'));
  finish(ok(response(companies.slice(0, 24))));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(updates, 0);
  assert.equal(requests, 1);
});

test('abort during retry backoff prevents another request', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(loadPortfolioCftcChanges(companies.slice(0, 1), { signal: controller.signal,
    delay: async () => controller.abort(new DOMException('Left tab.', 'AbortError')),
    fetchImpl: async () => { requests++; return ok(response(companies.slice(0, 1), { failed: ['C0'] })); },
  }), error => error.name === 'AbortError');
  assert.equal(requests, 1);
});

test('a different portfolio cannot inherit old coverage, row identifiers, or related company evidence', () => {
  const previous = mergePortfolioCftcChanges(null, response(companies.slice(0, 2)), companies.slice(0, 2));
  const next = mergePortfolioCftcChanges(previous, response(companies.slice(5, 7)), companies.slice(5, 7));
  assert.equal(next.coverage.checked, 2);
  assert.deepEqual(next.events[0].relatedCompanies.map(company => company.rowId), ['row-5', 'row-6']);
  assert.deepEqual(next.companyChecks.map(company => company.cik), companies.slice(5, 7).map(company => company.cik));
});
