import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { refinancingResponse } from '../src/utils/refinancing/http.js';
import { extractRefinancingProfile, MATURITY_BUCKETS } from '../src/utils/refinancing/maturities.js';
import { buildRefinancingWall } from '../src/utils/refinancing/projection.js';
import { encodeRefinancingCache } from '../src/utils/refinancing/server.js';

const generatedAt = '2026-09-29T00:00:00.000Z';
const profile = cik => extractRefinancingProfile({ cik, facts: { 'us-gaap': Object.fromEntries(MATURITY_BUCKETS.map((bucket, i) => [
  'LongTermDebtMaturitiesRepaymentsOfPrincipal' + bucket.suffix,
  { units: { USD: [{ val: (i + 1) * Number(cik) * 100000, end: '2025-12-31', filed: '2026-02-01', form: '10-K', accn: `${cik}-26-000001` }] } },
])) } }, { asOf: '2026-09-29' });

test('full 5,000-issuer capacity fits the compressed shared cache and streams a recoverable compact HTTP response', async () => {
  const companies = Array.from({ length: 5000 }, (_, index) => {
    const cik = String(index + 1).padStart(10, '0');
    return { cik, ticker: `T${index}`, name: `Issuer ${index}`, sic: '3571', observedAt: generatedAt, refinancing: profile(cik) };
  });
  const value = buildRefinancingWall({ companies, requested: 5000, generatedAt });
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 4500000, 'fixture must exercise the buffered function ceiling');
  assert.ok(Buffer.byteLength(JSON.stringify(encodeRefinancingCache(value))) < 1800000);
  const response = refinancingResponse(value, new Request('https://example.com/api/market-refinancing', { headers: { 'accept-encoding': 'br, gzip' } }), Date.parse(generatedAt));
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('content-length'), null);
  assert.match(response.headers.get('cache-control'), /s-maxage=900/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 1800000, `wire size ${bytes.length}`);
  const decoded = JSON.parse(gunzipSync(bytes));
  assert.equal(decoded.companies.length, 5000);
  assert.equal(decoded.companies[4999].profile.buckets.length, 6);
});

test('clients declining gzip receive a streamed identity response without content-encoding', async () => {
  const value = { companies: [], coverage: { coveredCompanies: 0 }, sourceSnapshotAt: generatedAt };
  for (const accepted of ['', 'gzip;q=0, br', 'gzip; q=0.000']) {
    const response = refinancingResponse(value, new Request('https://example.com', { headers: { 'accept-encoding': accepted } }), Date.parse(generatedAt));
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.deepEqual(await response.json(), value);
  }
});


test('CDN stale windows cannot extend the snapshot beyond its seven-day retention', () => {
  const value = { companies: [], coverage: { coveredCompanies: 0 }, sourceSnapshotAt: generatedAt };
  const nearExpiry = Date.parse(generatedAt) + 7 * 86400000 - 100000;
  const response = refinancingResponse(value, new Request('https://example.com'), nearExpiry);
  assert.match(response.headers.get('cache-control'), /s-maxage=100, stale-while-revalidate=0, stale-if-error=0/);
  assert.throws(() => refinancingResponse(value, new Request('https://example.com'), nearExpiry + 100000), /retention/);
});
