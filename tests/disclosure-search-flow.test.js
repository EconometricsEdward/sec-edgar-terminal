import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDisclosureWork, mergeDisclosureSearchFilings } from '../src/utils/disclosureSearchFlow.js';

const filing = { cik: '0000789019', accession: '0000789019-26-000001', primaryDoc: 'annual.htm' };
test('independent source checks are bounded and preserve input order', async () => {
  let active = 0, highWater = 0;
  const result = await mapDisclosureWork([1, 2, 3, 4], async (value) => {
    active++; highWater = Math.max(highWater, active);
    await new Promise((resolve) => setTimeout(resolve, value === 1 ? 15 : 1));
    active--; return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(highWater, 2);
});
test('cancelled search never starts queued source requests', async () => {
  const controller = new AbortController(); const started = [];
  await mapDisclosureWork([1, 2, 3, 4], async (value) => {
    started.push(value); controller.abort();
  }, { signal: controller.signal });
  assert.deepEqual(started, [1]);
});
test('merging SEC and prepared results retains verified evidence and original retrieval order', () => {
  const [result] = mergeDisclosureSearchFilings(
    [{ ...filing, status: 'index-candidate', indexRank: 2, indexScore: 8 }],
    [{ ...filing, status: 'indexed-match', matched: true, previews: [{ text: 'No covenant breach occurred.' }] }],
    [{ ...filing, status: 'reviewed', matched: true, matchCount: 4 }],
  );
  assert.equal(result.status, 'reviewed');
  assert.equal(result.indexRank, 2);
  assert.equal(result.indexScore, 8);
  assert.equal(result.matchCount, 4);
});
test('failed full-source fetch does not erase an already verified indexed passage', () => {
  const [result] = mergeDisclosureSearchFilings(
    [{ ...filing, status: 'indexed-match', matched: true, previews: [{ text: 'source passage' }] }],
    [{ ...filing, status: 'fetch-failed', reason: 'Source temporarily unavailable' }],
  );
  assert.equal(result.status, 'indexed-match');
  assert.equal(result.previews[0].text, 'source passage');
});
test('different documents within one accession remain distinct evidence', () => {
  assert.equal(mergeDisclosureSearchFilings([filing, { ...filing, primaryDoc: 'exhibit.htm' }]).length, 2);
});
test('CIK source verification retains a known issuer ticker across prepared and SEC evidence', () => {
  const results = mergeDisclosureSearchFilings(
    [{ ...filing, ticker: 'MSFT', status: 'index-candidate' }],
    [{ ...filing, ticker: '0000789019', status: 'reviewed', matchCount: 3 },
      { ...filing, primaryDoc: 'exhibit.htm', ticker: '0000789019', status: 'indexed-match' }],
  );
  assert.deepEqual(results.map(result => result.ticker), ['MSFT', 'MSFT']);
  assert.equal(results[0].status, 'reviewed');
  assert.equal(results[0].matchCount, 3);
  assert.equal(results[1].primaryDoc, 'exhibit.htm');
});
