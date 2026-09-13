import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import previous from '../src/data/sec-coverage-2026-09-08.json' with { type: 'json' };
import { SEC_COVERAGE_REFERENCE_URL } from '../src/utils/secCoverageMembership.js';
import {
  refreshSecCoverageMembershipSource, resolveFreshSecCoverageTickers,
  SEC_COVERAGE_DIRECTORY_URL, SEC_COVERAGE_SOURCE_LIMITS,
} from '../src/utils/secCoverageMembershipSource.js';

const NOW = Date.parse('2026-09-13T12:00:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const baseRows = previous.issuers.flatMap(issuer => issuer.aliases.map(ticker => ({
  ticker, name: issuer.name, sector: issuer.sector, cik: issuer.cik, exchange: 'NASDAQ',
})));
const csvFor = (rows = baseRows, date = 'Sep 12, 2026') => [
  'iShares Core S&P 500 ETF', `Fund Holdings as of,${quote(date)}`,
  'Ticker,Name,Sector,Asset Class,Exchange',
  ...rows.map(row => [row.ticker, row.name, row.sector, 'Equity', row.exchange].map(quote).join(',')),
  'USD,US Dollar,Cash and/or Derivatives,Cash,-', '', 'Fund data is a dated holdings reference.', '',
].join('\n');
const directoryFor = (rows = baseRows) => Object.fromEntries(rows.map(row => [row.ticker.replace(/[ .]/g, '-'), { cik: row.cik, name: row.name }]));
const resolution = (rows = baseRows) => ({ directory: directoryFor(rows), sourceSha256: 'b'.repeat(64), checkedAt: new Date(NOW).toISOString() });
function run({ csv = csvFor(), resolve = async () => resolution(), fetchImpl, ...options } = {}) {
  return refreshSecCoverageMembershipSource({ previous, now: NOW,
    fetchImpl: fetchImpl || (async () => new Response(csv, { headers: { 'content-type': 'text/csv' } })),
    resolveTickers: resolve, ...options,
  });
}

test('daily IVV retrieval preserves all share classes, SEC identities, source bytes, and previous representative securities', async () => {
  const rows = baseRows.map(row => row.ticker === 'BRK-B' ? { ...row, ticker: 'BRK B' } : row).reverse();
  const csv = csvFor(rows), untouched = structuredClone(previous);
  const result = await run({ csv, fetchImpl: async (url, options) => {
    assert.equal(url, SEC_COVERAGE_REFERENCE_URL);
    assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    return new Response(csv, { headers: { 'content-type': 'application/octet-stream' } });
  } });
  assert.equal(result.candidate.issuerCount, 500); assert.equal(result.candidate.securityCount, 503);
  assert.equal(result.sourceAsOf, '2026-09-12'); assert.equal(result.sourceSha256, digest(csv));
  assert.equal(result.sourceBytes.toString('utf8'), csv);
  assert.deepEqual(result.candidate.issuers, previous.issuers);
  assert.equal(result.changes.changed, false);
  assert.equal(result.candidate.reference.fund, 'IVV');
  assert.match(result.candidate.reference.description, /not certified current index membership or SPY holdings/);
  assert.equal(result.candidate.sourceSnapshot.sha256, digest(csv));
  assert.equal(result.candidate.mapping.sourceSha256, 'b'.repeat(64));
  assert.match(result.candidate.sourceSnapshot.path, /^memberships\/ivv\/2026-09-12\/[a-f0-9]{64}\.csv$/);
  assert.deepEqual(previous, untouched);
});

test('a validated addition and removal are returned without activating or deleting old coverage', async () => {
  const rows = baseRows.map(row => row.ticker === 'AAPL' ? { ...row, ticker: 'NEW', name: 'New Company', cik: '0000999999' } : row);
  const result = await run({ csv: csvFor(rows), resolve: async () => resolution(rows) });
  assert.deepEqual(result.changes.added.map(row => row.ticker), ['NEW']);
  assert.deepEqual(result.changes.removed.map(row => row.ticker), ['AAPL']);
  assert.equal(previous.issuers.some(row => row.ticker === 'AAPL'), true);
});

test('normal fund issuer counts need not be exactly 500', async () => {
  const rows = [...baseRows, { ticker: 'NEW', name: 'New Company', cik: '0000999999', sector: 'Financials', exchange: 'NYSE' }];
  const result = await run({ csv: csvFor(rows), resolve: async () => resolution(rows) });
  assert.equal(result.candidate.issuerCount, 501); assert.equal(result.candidate.securityCount, 504);
});

test('stale, future, backward, ambiguous, or incomplete source snapshots never reach identity resolution', async () => {
  let resolutions = 0;
  const resolve = async () => { resolutions++; return resolution(); };
  for (const csv of [
    '', '<html>Service unavailable</html>', csvFor(baseRows, 'Aug 01, 2026'),
    csvFor(baseRows, 'Sep 14, 2026'), csvFor(baseRows.slice(0, 100)),
    `${csvFor()}\nFund Holdings as of,"Sep 12, 2026"`,
    csvFor().replace('Sector,Asset Class', 'Other,Asset Class'),
    csvFor().slice(0, csvFor().indexOf('USD,')),
  ]) await assert.rejects(run({ csv, resolve }));
  assert.equal(resolutions, 0);
  await assert.rejects(run({ csv: csvFor(baseRows, 'Sep 07, 2026') }), /moved backward/);
});

test('no listed equity can disappear silently through ticker parsing, truncation, or duplicate share classes', async () => {
  for (const transform of [
    rows => [{ ...rows[0], ticker: '-' }, ...rows.slice(1)],
    rows => [{ ...rows[0], exchange: '-' }, ...rows.slice(1)],
    rows => [{ ...rows[0], exchange: 'NO MARKET (E.G. UNLISTED)' }, ...rows.slice(1)],
    rows => [{ ...rows[0], name: '' }, ...rows.slice(1)],
    rows => [{ ...rows[0], sector: 'Unknown' }, ...rows.slice(1)],
    rows => [rows[0], ...rows],
  ]) await assert.rejects(run({ csv: csvFor(transform(baseRows)) }));
  await assert.rejects(run({ csv: csvFor().replace('"Equity","NASDAQ"', '"Equity"') }), /incomplete/);
  await assert.rejects(run({ csv: csvFor().replace('USD,', '\nUSD,') }), /table ended/);
});

test('official unlisted residuals are explicitly recorded, with strict individual and aggregate USD limits', async () => {
  const residual = { ticker: 'HOLX', name: 'HOLOGIC INC', sector: 'Health Care', exchange: 'NO MARKET (E.G. UNLISTED)', marketValue: '28,433.88', weight: '0.00', currency: 'USD' };
  const source = extras => [
    'Fund Holdings as of,"Sep 10, 2026"',
    'Ticker,Name,Sector,Asset Class,Exchange,Market Value,Weight (%),Currency',
    ...baseRows.map(row => [row.ticker, row.name, row.sector, 'Equity', row.exchange, '100,000,000.00', '0.10', 'USD'].map(quote).join(',')),
    ...extras.map(row => [row.ticker, row.name, row.sector, 'Equity', row.exchange, row.marketValue, row.weight, row.currency].map(quote).join(',')),
    'USD,US Dollar,Cash and/or Derivatives,Cash,-,0.00,0.00,USD', '',
  ].join('\n');
  const result = await run({ csv: source([residual]) });
  assert.equal(result.candidate.securityCount, 503);
  assert.deepEqual(result.candidate.sourceExclusions, [{ ticker: 'HOLX', name: 'HOLOGIC INC', exchange: residual.exchange,
    currency: 'USD', marketValueUsd: 28433.88, weightPercent: 0,
    reason: 'Unlisted residual holding, excluded from listed-security research coverage.' }]);
  for (const extras of [
    [{ ...residual, marketValue: '100,000.01' }],
    [{ ...residual, marketValue: '-' }],
    [{ ...residual, weight: '0.01' }],
    [{ ...residual, currency: 'EUR' }],
    [{ ...residual, exchange: 'NYSE' }],
    [residual, { ...residual, ticker: 'RESIDUAL', marketValue: '75,000.00' }],
    [residual, residual],
  ]) await assert.rejects(run({ csv: source(extras) }));
});

test('unmapped or stale SEC identities and inconsistent share-class sectors retain prior membership', async () => {
  const missing = resolution(); delete missing.directory.AAPL;
  await assert.rejects(run({ resolve: async () => missing }), /mapping is unavailable for AAPL/);
  const invalid = resolution(); invalid.directory.AAPL.cik = '0';
  await assert.rejects(run({ resolve: async () => invalid }), /mapping is unavailable/);
  await assert.rejects(run({ resolve: async () => ({ ...resolution(), checkedAt: '2026-09-12T12:00:00Z' }) }), /fresh SEC mapping evidence/);
  await assert.rejects(run({ resolve: async () => ({ directory: directoryFor() }) }), /fresh SEC mapping evidence/);
  const conflicting = baseRows.map(row => row.ticker === 'GOOG' ? { ...row, sector: 'Financials' } : row);
  await assert.rejects(run({ csv: csvFor(conflicting) }), /share classes disagree/);
});

test('unexpected issuer turnover and mass security remapping are held for review', async () => {
  let replaced = 0;
  const identities = baseRows.map(row => replaced++ < 26 ? { ...row, cik: String(9000000000 + replaced) } : row);
  await assert.rejects(run({ csv: csvFor(identities), resolve: async () => resolution(identities) }), /turnover/);
  replaced = 0;
  const securities = baseRows.map(row => replaced++ < 26 ? { ...row, ticker: `NEW${replaced}` } : row);
  await assert.rejects(run({ csv: csvFor(securities), resolve: async () => resolution(securities) }), /security turnover/);
});

test('declared and streamed oversized downloads, HTTP errors, and unexpected payload types stop before mapping', async () => {
  let resolutions = 0, cancelled = false;
  const resolve = async () => { resolutions++; return resolution(); };
  const streamed = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(SEC_COVERAGE_SOURCE_LIMITS.holdingsBytes + 1)); },
    cancel() { cancelled = true; },
  });
  for (const response of [
    new Response(csvFor(), { headers: { 'content-length': String(SEC_COVERAGE_SOURCE_LIMITS.holdingsBytes + 1) } }),
    new Response(csvFor(), { headers: { 'content-length': 'NaN' } }),
    new Response(streamed), new Response('blocked', { status: 403 }),
    new Response(null, { status: 302, headers: { location: 'https://example.test/holdings' } }),
    new Response(csvFor(), { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array([0xc3, 0x28])),
  ]) await assert.rejects(run({ resolve, fetchImpl: async () => response }));
  assert.equal(resolutions, 0); assert.equal(cancelled, true);
});

test('expired deadlines and caller aborts prevent source work', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(csvFor()); };
  await assert.rejects(run({ deadline: NOW, fetchImpl }), /deadline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run({ signal: controller.signal, fetchImpl }), { name: 'AbortError' });
  assert.equal(fetched, 0);
});

test('fresh SEC resolution uses the fixed operating directory and shared transport budget, with normalized class tickers', async () => {
  const raw = Object.fromEntries(baseRows.map((row, index) => [index, { ticker: row.ticker === 'BRK-B' ? 'BRK.B' : row.ticker, cik_str: Number(row.cik), title: row.name }]));
  const bytes = JSON.stringify(raw);
  const mapping = await resolveFreshSecCoverageTickers(['AAPL', 'GOOG', 'GOOGL', 'BRK-B'], {
    now: NOW, deadline: NOW + 20000,
    fetchSec: async (url, options) => {
      assert.equal(url, SEC_COVERAGE_DIRECTORY_URL); assert.equal(options.retries, 0);
      assert.equal(options.cache, 'no-store'); assert.equal(options.timeoutMs, 15000);
      assert.equal(options.maxBytes, SEC_COVERAGE_SOURCE_LIMITS.directoryBytes);
      return new Response(bytes);
    },
  });
  assert.equal(mapping.directory.GOOG.cik, mapping.directory.GOOGL.cik);
  assert.equal(mapping.directory['BRK-B'].cik, '0001067983');
  assert.equal(mapping.sourceSha256, digest(bytes)); assert.equal(mapping.checkedAt, new Date(NOW).toISOString());
  assert.equal(Object.keys(mapping.directory).length, 4);
});

test('fresh directory failures cannot fall back to cached or bundled issuer identities', async () => {
  const raw = Object.fromEntries(baseRows.map((row, index) => [index, { ticker: row.ticker, cik_str: Number(row.cik), title: row.name }]));
  raw.conflict = { ticker: 'BRK.B', cik_str: 999999, title: 'Wrong Company' };
  for (const response of [new Response('unavailable', { status: 503 }), Response.json([]), Response.json({}), Response.json(raw)]) {
    await assert.rejects(resolveFreshSecCoverageTickers(['BRK-B'], { now: NOW, deadline: NOW + 15000, fetchSec: async () => response }));
  }
});
