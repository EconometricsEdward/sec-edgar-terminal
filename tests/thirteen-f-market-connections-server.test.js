import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFMarketConnectionsLoader, normalize13FMarketConnectionsRequest, THIRTEEN_F_MARKET_CONNECTIONS_BATCH_MAX_BYTES } from '../src/utils/thirteenFMarketConnectionsServer.js';
import { createThirteenFMarketConnectionsCache, thirteenFMarketConnectionsCacheId, thirteenFMarketConnectionsExpiresAt } from '../src/utils/thirteenFMarketConnectionsCache.js';
import { discoverCompanyExposures } from '../src/utils/companyExposureServer.js';
import { GET } from '../src/app/api/fund-13f/market-connections/route.js';

const CIK = '0001747057', ISSUER_CIK = '0001579091', PERIOD = '2026-06-30', KEY = '565394103|SECURITY|SH';
const NOW = Date.parse('2026-09-15T12:00:00Z');
const holding = { key: KEY, cusip: '565394103', issuer: 'MAPLEBEAR INC', classTitle: 'COM', putCall: null, quantityType: 'SH', quantity: 100, valueUsd: 5000, weightPct: 25 };
const report = () => ({ manager: { cik: CIK, name: 'Fixture Capital' }, selectedPeriod: PERIOD,
  portfolio: { cik: CIK, period: PERIOD, holdings: [holding], complete: true }, coverage: { selectedPeriodComplete: true } });
const identity = () => ({ status: 'resolved', cusip: holding.cusip, securityType: 'equity', observedAt: new Date(NOW).toISOString(),
  issuer: { cik: ISSUER_CIK, name: 'Maplebear Inc.', tickers: ['CART'], kind: 'company' },
  evidence: [{ cik: ISSUER_CIK, cusips: [holding.cusip], form: 'SCHEDULE 13G', filingDate: '2026-02-01', url: 'https://www.sec.gov/Archives/edgar/data/1579091/000157909126000001/primary_doc.xml' }] });
const annualText = 'Our copper production revenue is exposed to changes in copper prices and customer demand.';
const quarterText = 'We no longer have any copper production revenue or exposure to changes in copper prices.';
async function discovery(options = {}) {
  return discoverCompanyExposures({ cik: ISSUER_CIK }, {
    now: new Date(NOW), lookupTicker: async () => { throw new Error('A verified CIK must not use a ticker lookup'); },
    loadSubmissions: async () => ({ cik: ISSUER_CIK, name: 'Maplebear Inc.', filings: { recent: {
      accessionNumber: ['0001579091-26-000010', '0001579091-26-000020'], form: ['10-K', '10-Q'],
      filingDate: ['2026-02-01', '2026-08-01'], reportDate: ['2025-12-31', '2026-06-30'], primaryDocument: ['annual.htm', 'quarter.htm'],
    }, files: [] } }),
    loadFilingText: async (_cik, filing) => ({ text: filing.form === '10-K' ? annualText : quarterText }), ...options,
  });
}
const loader = options => createThirteenFMarketConnectionsLoader({ portfolioLoader: async () => report(), identityLoader: async () => identity(), exposureLoader: async () => discovery(), now: () => NOW, ...options });
const load = options => loader(options)(CIK, { period: PERIOD, key: KEY });

test('13F market requests require an exact holding and quarter; the route rejects caller-supplied issuer identities', async () => {
  assert.deepEqual(normalize13FMarketConnectionsRequest('1747057', PERIOD, KEY), { cik: CIK, period: PERIOD, key: KEY });
  for (const query of [
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&issuerCik=${ISSUER_CIK}`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&ticker=CART`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&asOf=2026-01-01`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&key=${encodeURIComponent(KEY)}`,
    `cik=${CIK}&period=${PERIOD}`, `cik=${CIK}&period=2026-06-29&key=${encodeURIComponent(KEY)}`,
    `cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent('MAPLEBEAR')}`,
  ]) {
    const response = await GET(new Request(`https://example.test/api/fund-13f/market-connections?${query}`));
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

function sharedCacheFixture({ now = () => NOW, timeoutMs = 1500, readMany, write } = {}) {
  const rows = new Map(), writes = [], reads = [];
  const create = () => createThirteenFMarketConnectionsCache({ enabled: () => true, now, timeoutMs,
    readMany: readMany || (async (_type, ids) => { reads.push(ids); return ids.map(id => rows.get(id) ?? null); }),
    write: write || (async (type, id, payload, ttl, options) => {
      writes.push({ type, id, payload, ttl, options }); rows.set(id, { payload: structuredClone(payload), expiresAt: options.expiresAt }); return { stored: true };
    }),
  });
  return { rows, writes, reads, create };
}

test('completed connections survive independent server instances without repeating issuer research', async () => {
  const shared = sharedCacheFixture(); let identities = 0, discoveries = 0;
  const options = { identityLoader: async () => { identities++; return identity(); }, exposureLoader: async () => { discoveries++; return discovery(); } };
  const first = await load({ ...options, preparedCache: shared.create() });
  const second = await load({ ...options, preparedCache: shared.create() });
  assert.deepEqual(second, first); assert.equal(identities, 1); assert.equal(discoveries, 1);
  assert.equal(shared.writes.length, 1); assert.equal(shared.writes[0].payload.cik, CIK);
  assert.match(shared.writes[0].id, new RegExp(`^${CIK}:${PERIOD}:[A-F0-9]{64}$`));
});

test('explicit refresh bypasses prepared connections without extending the original source expiry', async () => {
  let time = NOW, identities = 0, discoveries = 0;
  const shared = sharedCacheFixture({ now: () => time });
  const instance = loader({ now: () => time, preparedCache: shared.create(),
    identityLoader: async () => { identities++; return identity(); },
    exposureLoader: async () => { discoveries++; return discovery(); },
  });
  await instance(CIK, { period: PERIOD, key: KEY });
  time += 60000;
  const refreshed = await instance(CIK, { period: PERIOD, key: KEY, skipPrepared: true });
  assert.equal(identities, 2); assert.equal(discoveries, 2); assert.equal(shared.reads.length, 1);
  assert.equal(refreshed.observedAt, new Date(time).toISOString());
  assert.equal(refreshed.identity.observedAt, new Date(NOW).toISOString());
  assert.equal(refreshed.discovery.checkedAt, new Date(NOW).toISOString());
  assert.equal(shared.writes[0].options.expiresAt, shared.writes[1].options.expiresAt);
  assert.equal(shared.writes[1].ttl, shared.writes[0].ttl - 60);
});

test('holding changes, denominator changes and amended source chains invalidate prepared connections', async () => {
  const shared = sharedCacheFixture(); let calls = 0;
  const identityLoader = async () => { calls++; return identity(); };
  await load({ identityLoader, preparedCache: shared.create() });
  for (const change of [
    value => { value.portfolio.holdings[0].valueUsd++; },
    value => { value.portfolio.holdings[0].weightPct++; },
    value => { value.portfolio.totalValueUsd = 90000; },
    value => { value.coverage.selectedPeriodComplete = false; },
    value => { value.portfolio.filings = [{ accession: '0001747057-26-000100', isAmendment: true, amendmentNumber: 1 }]; },
    value => { value.portfolio.filings = [{ primaryUrl: 'https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/cover.xml', tableUrls: ['https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/table.xml'] }]; },
  ]) {
    const changed = structuredClone(report()); change(changed);
    await load({ identityLoader, preparedCache: shared.create(), portfolioLoader: async () => changed });
  }
  assert.equal(calls, 7);
  const sourceReport = structuredClone(report());
  sourceReport.portfolio.filings = [{ accession: '0001747057-26-000100', filingDate: '2026-08-01', reportDate: PERIOD,
    primaryUrl: 'https://www.sec.gov/Archives/edgar/data/1747057/000174705726000100/cover.xml', tableUrls: ['table-one.xml'] }];
  const sourceId = thirteenFMarketConnectionsCacheId(sourceReport, holding);
  sourceReport.portfolio.filings[0].tableUrls = ['table-two.xml'];
  assert.notEqual(thirteenFMarketConnectionsCacheId(sourceReport, holding), sourceId);
  sourceReport.portfolio.filings[0].tableUrls = ['table-one.xml'];
  sourceReport.observedAt = new Date(NOW + 60000).toISOString();
  assert.equal(thirteenFMarketConnectionsCacheId(sourceReport, holding), sourceId);
});

test('shared reads reject altered issuer proof, source links and report coverage', async () => {
  for (const change of [
    value => { value.result.identity.evidence[0].url = 'https://example.test/false.xml'; },
    value => { value.result.discovery.sources[0].url = 'https://www.sec.gov/Archives/edgar/data/99/other.htm'; },
    value => { value.result.coverage.portfolioComplete = false; },
    value => { value.cik = '0000000001'; },
    value => { value.binding = `${CIK}:${PERIOD}:${'A'.repeat(64)}`; },
  ]) {
    const shared = sharedCacheFixture(); let calls = 0;
    await load({ preparedCache: shared.create() });
    change(shared.rows.values().next().value.payload);
    await load({ preparedCache: shared.create(), identityLoader: async () => { calls++; return identity(); } });
    assert.equal(calls, 1);
  }
});

test('partial, unavailable and incomplete searches are never published as completed connections', async () => {
  for (const mutate of [
    value => { value.status = 'partial'; }, value => { value.coverage.searchComplete = false; },
    value => { value.retryable = true; },
    value => { value.status = 'unavailable'; value.rows = []; },
  ]) {
    const shared = sharedCacheFixture();
    const result = await load({ preparedCache: shared.create(), exposureLoader: async () => { const value = await discovery(); mutate(value); return value; } });
    assert.ok(result); assert.equal(shared.writes.length, 0);
  }
});

test('prepared expiry is anchored to oldest source observation and preserves shorter negative lifetimes', async () => {
  const shared = sharedCacheFixture();
  const result = await load({ preparedCache: shared.create(), identityLoader: async () => ({ ...identity(), observedAt: new Date(NOW - 3600000).toISOString() }) });
  assert.equal(shared.writes[0].options.expiresAt, new Date(NOW + 5 * 3600000).toISOString());
  assert.equal(shared.writes[0].ttl, 5 * 3600);
  assert.equal(result.identity.observedAt, new Date(NOW - 3600000).toISOString());
  const negative = structuredClone(result); negative.identity.observedAt = negative.observedAt;
  negative.discovery.rows = [];
  for (const [status, ttl] of [['no_matches', 3600000], ['no_filing', 15 * 60000]]) {
    negative.discovery.status = status;
    assert.equal(thirteenFMarketConnectionsExpiresAt(negative, NOW), NOW + ttl);
  }
  negative.status = 'unresolved'; negative.identity.status = 'unresolved'; negative.discovery = null;
  assert.equal(thirteenFMarketConnectionsExpiresAt(negative, NOW), NOW + 60000);
  assert.equal(thirteenFMarketConnectionsExpiresAt(result, NOW + 5 * 3600000), null);
  const before = shared.rows.get(shared.writes[0].id);
  before.expiresAt = new Date(NOW + 6 * 3600000).toISOString();
  assert.deepEqual(await shared.create().getMany(report(), [holding]), [null]);
});

test('prepared batch loads the report once and returns cache hits without researching misses', async () => {
  const shared = sharedCacheFixture(); await load({ preparedCache: shared.create() });
  const call = { ...holding, key: `${holding.cusip}|CALL|SH`, putCall: 'CALL' };
  let portfolios = 0;
  const current = report(); current.portfolio.holdings = [holding, call]; current.portfolio.positionCount = 1;
  const batch = loader({ preparedCache: shared.create(), portfolioLoader: async () => { portfolios++; return current; },
    identityLoader: async () => { throw new Error('Cache-only read started SEC research'); },
    exposureLoader: async () => { throw new Error('Cache-only read started disclosure research'); },
  });
  const result = await batch.prepared(CIK, { period: PERIOD, keys: [KEY, call.key] });
  assert.equal(result.schemaVersion, 'edgar.13f-market-connections-batch.v1'); assert.equal(result.requested, 2);
  assert.equal(portfolios, 1); assert.deepEqual(result.results.map(value => value.holding.key), [KEY]);
  assert.equal(shared.reads.at(-1).length, 2); assert.equal(shared.writes.length, 1);
});

test('prepared batches reject duplicate, oversized, malformed and unknown requests before research', async () => {
  const shared = sharedCacheFixture(); let portfolios = 0;
  const batch = loader({ preparedCache: shared.create(), portfolioLoader: async () => { portfolios++; return report(); } });
  for (const keys of [[], [KEY, KEY], Array.from({ length: 21 }, (_, index) => `${String(index).padStart(9, '0')}|SECURITY|SH`), ['wrong']])
    await assert.rejects(batch.prepared(CIK, { period: PERIOD, keys }), { status: 400 });
  assert.equal(portfolios, 0);
  await assert.rejects(batch.prepared(CIK, { period: PERIOD, keys: ['123456789|SECURITY|SH'] }), { code: 'HOLDING_NOT_FOUND' });
  assert.equal(shared.reads.length, 0);
  for (const query of [
    'prepared=2', 'prepared=1&prepared=1', `prepared=1&key=${encodeURIComponent(KEY)}`, 'prepared=1&issuerCik=0000000001',
  ]) {
    const response = await GET(new Request(`https://example.test/api/fund-13f/market-connections?cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}&${query}`));
    assert.equal(response.status, 400);
  }
});

test('prepared batch excludes results that would exceed its response budget', async () => {
  const shared = sharedCacheFixture();
  const holdings = [holding, ...['PUT', 'CALL'].map(putCall => ({ ...holding, key: `${holding.cusip}|${putCall}|SH`, putCall }))];
  const current = report(); current.portfolio.holdings = holdings;
  const research = loader({ preparedCache: shared.create(), portfolioLoader: async () => current, exposureLoader: async () => ({ ...await discovery(), limitations: ['x'.repeat(750000)] }) });
  for (const item of holdings) await research(CIK, { period: PERIOD, key: item.key });
  const result = await research.prepared(CIK, { period: PERIOD, keys: holdings.map(value => value.key) });
  assert.equal(shared.writes.length, 3); assert.equal(result.results.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= THIRTEEN_F_MARKET_CONNECTIONS_BATCH_MAX_BYTES);
});

test('cache transport is optional and bounded while caller cancellation stops research', async () => {
  const shared = sharedCacheFixture({ timeoutMs: 5, readMany: async () => new Promise(() => {}), write: async () => new Promise(() => {}) });
  let calls = 0;
  const instance = loader({ preparedCache: shared.create(), identityLoader: async () => { calls++; return identity(); } });
  const result = await instance(CIK, { period: PERIOD, key: KEY });
  assert.equal(result.status, 'ready'); assert.equal(calls, 1);
  const controller = new AbortController();
  const aborted = instance(CIK, { period: PERIOD, key: KEY, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' }); assert.equal(calls, 1);
  assert.deepEqual((await instance.prepared(CIK, { period: PERIOD, keys: [KEY] })).results, []);
  assert.match(thirteenFMarketConnectionsCacheId(report(), holding), /^[0-9]{10}:2026-06-30:[A-F0-9]{64}$/);
});

test('market discovery verifies both report identities and an actual unique security before looking up any issuer', async () => {
  let calls = 0;
  const identityLoader = async () => { calls++; return identity(); };
  for (const change of [
    value => { value.manager.cik = '0000000099'; },
    value => { value.selectedPeriod = '2026-03-31'; },
    value => { value.portfolio.cik = '0000000099'; },
    value => { value.portfolio.period = '2026-03-31'; },
  ]) await assert.rejects(load({ identityLoader, portfolioLoader: async () => { const value = structuredClone(report()); change(value); return value; } }), { code: 'REPORT_IDENTITY_MISMATCH' });
  for (const holdings of [[], [holding, holding]])
    await assert.rejects(load({ identityLoader, portfolioLoader: async () => ({ ...report(), portfolio: { ...report().portfolio, holdings } }) }), { code: 'HOLDING_NOT_FOUND' });
  await assert.rejects(load({ identityLoader, portfolioLoader: async () => ({ ...report(), portfolio: { ...report().portfolio, holdings: [{ ...holding, cusip: '123456789' }] } }) }), { code: 'HOLDING_IDENTITY_MISMATCH' });
  assert.equal(calls, 0);
});

test('current disclosure connections use only the proved CIK, preserve annual/quarterly dates and include later qualifications', async () => {
  const calls = [];
  const result = await load({ exposureLoader: async (cik, options) => { calls.push({ cik, options }); return discovery(); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].cik, ISSUER_CIK);
  assert.equal(calls[0].options.period, undefined); assert.equal(calls[0].options.asOf, undefined); assert.ok(calls[0].options.signal);
  assert.equal(result.schemaVersion, 'edgar.13f-market-connections.v1'); assert.equal(result.status, 'ready');
  assert.equal(result.selectedPeriod, PERIOD); assert.equal(result.observedAt, new Date(NOW).toISOString());
  assert.equal(result.discovery.cik, ISSUER_CIK); assert.equal(result.discovery.ticker, null);
  assert.equal(result.discovery.checkedAt, new Date(NOW).toISOString());
  assert.deepEqual(result.discovery.sources.map(value => [value.role, value.reportDate, value.filed]), [
    ['annual', '2025-12-31', '2026-02-01'], ['quarterly', '2026-06-30', '2026-08-01'],
  ]);
  const row = result.discovery.rows.find(value => value.marketId === 'copper');
  assert.equal(row.benchmark.contract, '085692'); assert.equal(row.evidence.length, 2);
  assert.equal(row.evidence[0].text, quarterText); assert.equal(row.evidence[0].disclosureDirection, 'qualifying-or-negative');
  assert.equal(row.evidence[0].benchmark, null); assert.equal(row.evidence[1].text, annualText);
  assert.equal(result.holding.valueUsd, holding.valueUsd); assert.equal(result.holding.weightPct, holding.weightPct);
  assert.match(result.basis, /not measured economic exposure/); assert.equal(result.portfolio, undefined);
  assert.equal(result.discovery.sources[0].text, undefined); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 30000);
});

test('ETF and unresolved holdings never receive operating-company disclosures or inferred markets', async () => {
  for (const securityType of ['fund', 'equity', 'principal']) {
    const result = await load({ identityLoader: async () => ({ status: 'unresolved', cusip: holding.cusip, issuer: null,
      securityType, evidence: [], reason: 'A verified operating-company connection is unavailable.' }),
    exposureLoader: async () => { throw new Error('Unresolved issuer triggered disclosure retrieval'); } });
    assert.equal(result.status, 'unresolved'); assert.equal(result.discovery, null); assert.equal(result.retryable, false);
    assert.equal(result.holding.key, KEY); assert.match(result.message, /unavailable/);
  }
});

test('CUSIP proof conflicts, wrong issuer CIKs and unverified proof links stop before disclosure retrieval', async () => {
  let calls = 0;
  for (const change of [
    value => { value.cusip = '123456789'; }, value => { value.status = 'unavailable'; },
    value => { value.issuer.cik = '0000000000'; }, value => { value.issuer.kind = 'fund'; },
    value => { value.evidence = []; }, value => { value.evidence[0].cik = '0000000099'; },
    value => { value.evidence[0].cusips = ['123456789']; },
    value => { value.evidence[0].url = 'https://wrong.example/primary.xml'; },
  ]) await assert.rejects(load({ identityLoader: async () => { const value = identity(); change(value); return value; },
    exposureLoader: async () => { calls++; return discovery(); } }), { code: 'ISSUER_IDENTITY_MISMATCH' });
  assert.equal(calls, 0);
});

test('disclosure CIK, source directory and exact quote/source metadata are rechecked at the holding boundary', async () => {
  for (const change of [
    value => { value.cik = '0000000099'; }, value => { value.code = 'SEC_SOURCE_IDENTITY_MISMATCH'; },
    value => { value.sources[0].url = value.sources[0].url.replace('/1579091/', '/99/'); },
    value => { value.rows[0].evidence[0].url = 'https://www.sec.gov/Archives/edgar/data/99/other.htm'; },
    value => { value.rows[0].evidence[0].filed = '2024-01-01'; },
    value => { value.rows[0].evidence[0].reportDate = '2024-01-01'; },
    value => { value.sources[1].status = 'unavailable'; },
  ]) await assert.rejects(load({ exposureLoader: async () => { const value = await discovery(); change(value); return value; } }), error => /^DISCLOSURE_(?:IDENTITY|SOURCE)_MISMATCH$/.test(error.code));
});

test('partial filing retrieval preserves the actual successful passages and identifies the failed newest quarter', async () => {
  const result = await load({ exposureLoader: async () => discovery({ loadFilingText: async (_cik, filing) => {
    if (filing.form === '10-Q') throw new Error('Internal transport detail');
    return { text: annualText };
  } }) });
  assert.equal(result.status, 'ready'); assert.equal(result.discovery.status, 'partial'); assert.equal(result.retryable, true);
  assert.equal(result.discovery.coverage.filingsScanned, 1); assert.equal(result.discovery.coverage.filingsFailed, 1);
  assert.equal(result.discovery.sources[1].filed, '2026-08-01'); assert.equal(result.discovery.sources[1].status, 'unavailable');
  assert.ok(result.discovery.rows.every(row => row.evidence.every(value => value.role === 'annual')));
  assert.equal(JSON.stringify(result).includes('Internal transport detail'), false);
});

test('no-match, no-filing and unavailable scans remain different from issuer resolution failures', async () => {
  const noMatches = await load({ exposureLoader: async () => discovery({ loadFilingText: async () => ({ text: 'Our consolidated financial statements follow the applicable accounting principles and conventions.' }) }) });
  assert.equal(noMatches.status, 'ready'); assert.equal(noMatches.discovery.status, 'no_matches'); assert.equal(noMatches.discovery.rows.length, 0);
  const noFiling = await load({ exposureLoader: async () => discovery({ loadSubmissions: async () => ({ cik: ISSUER_CIK, name: 'Maplebear Inc.', filings: { recent: { accessionNumber: [] }, files: [] } }) }) });
  assert.equal(noFiling.status, 'ready'); assert.equal(noFiling.discovery.status, 'no_filing');
  const unavailable = await load({ exposureLoader: async () => discovery({ loadFilingText: async () => { throw new Error('Transport failure'); } }) });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.discovery.status, 'unavailable');
  assert.equal(unavailable.identity.issuer.cik, ISSUER_CIK); assert.equal(unavailable.discovery.sources.length, 2); assert.equal(unavailable.retryable, true);
  await assert.rejects(load({ identityLoader: async () => { throw Object.assign(new Error('Unavailable issuer source'), { code: 'SEC_IDENTITY_UNAVAILABLE' }); } }), { code: 'SEC_IDENTITY_UNAVAILABLE' });
});

test('incomplete 13F coverage remains explicit rather than being promoted by successfully matched disclosures', async () => {
  const result = await load({ portfolioLoader: async () => ({ ...report(), portfolio: { ...report().portfolio, complete: false }, coverage: { selectedPeriodComplete: false } }) });
  assert.equal(result.status, 'ready'); assert.deepEqual(result.coverage, { selectedPeriodComplete: false, portfolioComplete: false });
});

test('oversized disclosure envelopes fail explicitly instead of exceeding the client’s response budget', async () => {
  await assert.rejects(load({ exposureLoader: async () => {
    const value = await discovery();
    value.limitations = ['x'.repeat(1024 * 1024)];
    return value;
  } }), { code: 'DISCLOSURE_RESPONSE_TOO_LARGE' });
});

test('feature disable and pre-aborted requests stop before any SEC manager retrieval', async () => {
  let calls = 0;
  const portfolioLoader = async () => { calls++; return report(); };
  await assert.rejects(load({ portfolioLoader, enabled: () => false }), { code: 'CFTC_DISABLED' });
  await assert.rejects(loader({ portfolioLoader })(CIK, { period: PERIOD, key: KEY, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const previous = process.env.CFTC_ENABLED;
  try {
    process.env.CFTC_ENABLED = 'false';
    const response = await GET(new Request(`https://example.test/api/fund-13f/market-connections?cik=${CIK}&period=${PERIOD}&key=${encodeURIComponent(KEY)}`));
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const body = await response.json(); assert.equal(body.code, 'CFTC_DISABLED'); assert.equal(body.retryable, false);
  } finally { if (previous === undefined) delete process.env.CFTC_ENABLED; else process.env.CFTC_ENABLED = previous; }
});
