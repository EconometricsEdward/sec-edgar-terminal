import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secDocumentIdentity, refreshSecDocument, readPreparedSecDocument, preparedDataHeaders, preparedCacheControl, sampleSecShadow, SEC_DOCUMENT_MAX_BYTES } from '../src/utils/secDocumentStore.js';

const path = '/submissions/CIK0000320193.json';
const payload = { cik: '320193', name: 'Apple fixture', filings: { recent: { form: [] } } };
const time = Date.now();
const envelope = (value = payload) => ({ payload: value, metadata: { fetchedAt: new Date(time - 10000).toISOString(), expiresAt: new Date(time + 100000).toISOString(), etag: 'original-etag', documentContentHash: 'original-hash' }, stale: false });

test('SEC canonical identity is by CIK/resource, excludes archives and arbitrary URLs', () => {
  assert.equal(secDocumentIdentity(path).key, 'sec-documents-v1:CIK0000320193:submissions');
  assert.equal(secDocumentIdentity('/api/xbrl/companyfacts/CIK0000320193.json').resource, 'companyfacts');
  assert.equal(secDocumentIdentity('/submissions/CIK0000320193-submissions-001.json'), null);
  assert.equal(secDocumentIdentity('https://evil.test/submissions/CIK0000320193.json'), null);
  assert.equal(secDocumentIdentity('/submissions/CIK0000000001.json').covered, false);
});

test('off and shadow reads never change legacy execution or touch persistence', async () => {
  const read = async () => { throw new Error('must not read'); };
  assert.equal(await readPreparedSecDocument(path, { mode: 'off', read }), null);
  assert.equal(await readPreparedSecDocument(path, { mode: 'shadow', read }), null);
  assert.equal(await readPreparedSecDocument('/submissions/CIK0000000001.json', { mode: 'supabase', read }), null);
});

test('cohort missing data and database outages are unavailable, not upstream refills', async () => {
  for (const read of [async () => null, async () => { throw new Error('DB outage'); }]) {
    await assert.rejects(readPreparedSecDocument(path, { mode: 'supabase', read }), (error) => error.status === 503);
  }
  const old = envelope(); old.metadata.expiresAt = new Date(time - 8 * 86400000).toISOString();
  await assert.rejects(readPreparedSecDocument(path, { mode: 'supabase', read: async () => old }), /not ready/);
  const stale = envelope(); stale.metadata.expiresAt = new Date(time - 1000).toISOString(); stale.stale = true;
  const read = await readPreparedSecDocument(path, { mode: 'supabase', read: async () => stale });
  assert.equal(preparedDataHeaders(read)['X-Data-Stale'], 'true');
  assert.equal(preparedDataHeaders(read)['X-Data-Fetched-At'], stale.metadata.fetchedAt);
  await assert.rejects(readPreparedSecDocument(path, { mode: 'supabase', read: async () => stale, allowStale: false }), /revalidation/);
  assert.equal(preparedCacheControl(stale, { now: time }), 'public, max-age=60, s-maxage=60');
  assert.doesNotMatch(preparedCacheControl(stale), /stale-if-error|stale-while-revalidate/);
});

test('scheduled canonical refresh claims before fetch and retains exact source bytes', async () => {
  const order = []; const raw = ` { "cik": "320193", "filings": { "recent": {} } }\n`;
  let publication;
  const result = await refreshSecDocument(path, {
    mode: 'shadow', now: () => time,
    begin: async () => { order.push('claim'); return { generation: 1, owner: 'worker' }; },
    read: async () => null,
    fetchSec: async (url, options) => { order.push('fetch'); assert.equal(url, 'https://data.sec.gov' + path); assert.equal(options.retries, 0); return new Response(raw, { headers: { etag: 'v1' } }); },
    publish: async (value) => { publication = value; return { payload: value.payload, metadata: value.metadata }; },
  });
  assert.deepEqual(order, ['claim', 'fetch']);
  assert.equal(result.status, 'updated');
  assert.equal(Buffer.from(publication.source.bytes).toString(), raw);
  assert.equal(publication.metadata.documentContentHash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(publication.metadata.publishedAt, null);
  assert.equal(publication.kind, 'source-document');
});

test('304 and byte-identical revalidation preserve source age and content reference', async () => {
  const previous = envelope(); let revalidated;
  const shared = { mode: 'supabase', now: () => time, begin: async () => ({ generation: 9, owner: 'worker' }), read: async () => previous,
    publish: async () => { throw new Error('must not publish a duplicate'); },
    revalidate: async (...args) => { revalidated = args; return true; } };
  const result = await refreshSecDocument(path, { ...shared, fetchSec: async (_url, { headers }) => { assert.equal(headers['If-None-Match'], 'original-etag'); return new Response(null, { status: 304 }); } });
  assert.equal(result.envelope.metadata.fetchedAt, previous.metadata.fetchedAt);
  assert.equal(result.envelope.metadata.documentContentHash, previous.metadata.documentContentHash);
  assert.equal(revalidated[2].claim.generation, 9);
  const raw = JSON.stringify(payload); previous.metadata.documentContentHash = createHash('sha256').update(raw).digest('hex');
  assert.equal((await refreshSecDocument(path, { ...shared, fetchSec: async () => new Response(raw) })).status, 'unchanged');
});

test('busy lease, invalid identity, oversized data and upstream failures never publish', async () => {
  let fetched = 0, published = 0;
  const base = { mode: 'shadow', read: async () => null, begin: async () => ({ generation: 1 }),
    fetchSec: async () => { fetched++; return new Response(JSON.stringify(payload)); }, publish: async () => { published++; } };
  assert.equal((await refreshSecDocument(path, { ...base, begin: async () => null })).status, 'busy');
  assert.equal(fetched, 0);
  await assert.rejects(refreshSecDocument(path, { ...base, fetchSec: async () => new Response(JSON.stringify({ ...payload, cik: '1' })) }), /identity/);
  await assert.rejects(refreshSecDocument(path, { ...base, fetchSec: async () => new Response('{}', { headers: { 'content-length': String(SEC_DOCUMENT_MAX_BYTES + 1) } }) }), /size limit/);
  await assert.rejects(refreshSecDocument(path, { ...base, fetchSec: async () => new Response('Unavailable', { status: 503 }) }), /HTTP 503/);
  assert.equal(published, 0);
});

test('shadow differences between raw source versions are not reported as storage mismatches', async () => {
  const status = await sampleSecShadow(path, { ...payload, name: 'Later revision' }, { mode: 'shadow', now: time + 1e6, read: async () => envelope(), report: () => {} });
  assert.equal(status, 'different-source-version');
});

test('failed publication fence cannot mirror stale SEC bytes to rollback cache', async () => {
  let mirrored = 0, released = 0;
  await assert.rejects(refreshSecDocument(path, { mode: 'shadow',
    begin: async () => ({ generation: 2 }), read: async () => envelope(),
    reserveLegacy: async () => true, legacyWrite: async () => { mirrored++; return true; },
    fetchSec: async () => new Response(null, { status: 304 }),
    revalidate: async () => false, release: async () => { released++; return true; },
  }), /lost its publication claim/);
  assert.equal(mirrored, 0); assert.equal(released, 1);
});
