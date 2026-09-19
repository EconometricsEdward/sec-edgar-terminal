import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDisclosureQuery, evaluateQuery } from '../src/utils/disclosureQuery.js';
import { compileDisclosureIndexQuery, disclosureIndexPagination, disclosureIndexPageCoverage } from '../src/utils/disclosureIndexSearch.js';
import { GET } from '../src/app/api/edgar-index-search/route.js';

test('SEC discovery preserves mandatory terms and documented adjacent OR groups', () => {
  assert.equal(compileDisclosureIndexQuery(parseDisclosureQuery('"material weakness" AND remediation')).secQuery, '"material weakness" "remediation"');
  assert.equal(compileDisclosureIndexQuery(parseDisclosureQuery('liquidity AND (covenant OR default)')).secQuery, '"liquidity" "covenant" OR "default"');
  const excluded = compileDisclosureIndexQuery(parseDisclosureQuery('liquidity AND NOT bankruptcy'));
  assert.equal(excluded.secQuery, '"liquidity"');
  assert.equal(excluded.exclusionsDeferred, true);
  assert.match(excluded.verification, /do not exclude an entire filing/);
  const nested = compileDisclosureIndexQuery(parseDisclosureQuery('(liquidity OR covenant) AND (default OR bankruptcy)'));
  assert.equal(nested.nestedGroupsDeferred, true);
  assert.equal(nested.exactPositiveLogic, false);
  assert.match(nested.verification, /grouped conditions are deferred/);
});

test('discovery relaxation cannot discard a matching document under nested or negative logic', () => {
  // Evaluate the documented EFTS shape: required terms followed by one OR group.
  function candidate(query, has) {
    const parts = [...query.matchAll(/"([^"]+)"|(OR)/g)].map(m => m[2] || m[1]);
    const or = parts.indexOf('OR');
    if (or < 0) return parts.every(has);
    return parts.slice(0, or - 1).every(has) && parts.slice(or - 1).filter(x => x !== 'OR').some(has);
  }
  for (const raw of [
    'alpha AND beta', 'alpha OR beta', 'alpha AND (beta OR gamma)',
    '(alpha AND beta) OR (gamma AND delta)',
    '(alpha OR beta) AND (gamma OR delta)',
    '(alpha AND NOT beta) OR (gamma AND NOT delta)',
    'alpha AND NOT (beta AND NOT gamma)',
    'NOT (NOT alpha OR NOT beta)', 'NOT (NOT alpha AND NOT beta)',
  ]) {
    const parsed = parseDisclosureQuery(raw);
    const compiled = compileDisclosureIndexQuery(parsed);
    for (let mask = 0; mask < 16; mask++) {
      const has = term => Boolean(mask & (1 << ['alpha', 'beta', 'gamma', 'delta'].indexOf(term)));
      if (evaluateQuery(parsed.ast, has)) assert.equal(candidate(compiled.secQuery, has), true, `${raw} at ${mask}`);
    }
  }
});

test('pagination bounds and continuation use raw SEC offsets including invalid pointers', () => {
  assert.deepEqual(disclosureIndexPagination(new URLSearchParams()), { from: 0, limit: 20 });
  assert.deepEqual(disclosureIndexPagination(new URLSearchParams({ from: '9995', limit: '20' })), { from: 9995, limit: 5 });
  for (const params of [{ from: '-1' }, { from: '2.5' }, { from: '' }, { from: '10000' }, { limit: '20x' }, { limit: '101' }])
    assert.throws(() => disclosureIndexPagination(new URLSearchParams(params)));
  const page = disclosureIndexPageCoverage({ from: 20, limit: 20, rawHits: 20, returnedHits: 18, totalHits: 77 });
  assert.equal(page.nextFrom, 40);
  assert.equal(page.coverage.startRank, 21);
  assert.equal(page.coverage.endRank, 40);
  assert.equal(disclosureIndexPageCoverage({ from: 60, limit: 20, rawHits: 17, returnedHits: 17, totalHits: 77 }).hasMore, false);
  const bound = disclosureIndexPageCoverage({ from: 9980, limit: 20, rawHits: 20, returnedHits: 20, totalHits: 10000, totalRelation: 'gte' });
  assert.equal(bound.nextFrom, null);
  assert.equal(bound.coverage.windowLimited, true);
});

test('index endpoint issues one page, retains SEC rank and score, and discloses verification', async () => {
  const original = global.fetch;
  const requests = [];
  global.fetch = async url => {
    requests.push(new URL(url));
    return Response.json({ hits: { total: { value: 123, relation: 'eq' }, hits: Array.from({ length: 20 }, (_, i) => ({
      _id: `0000999911-26-${String(i + 1).padStart(6, '0')}:${i === 3 ? '../escape.htm' : `report${i}.htm`}`,
      _score: 10 - i / 10,
      _source: { ciks: ['999911'], display_names: ['Fixture (CIK 0000999911)'], adsh: `0000999911-26-${String(i + 1).padStart(6, '0')}`, form: '10-K', file_date: '2026-02-02' },
    })) }, took: 4 });
  };
  try {
    const response = await GET(new Request('https://example.test/api/edgar-index-search?expression=liquidity%20AND%20covenant&from=20&limit=20'));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('q'), '"liquidity" "covenant"');
    assert.equal(requests[0].searchParams.get('from'), '20');
    assert.equal(data.results[0].rank, 21);
    assert.equal(data.results[0].secRank, 21);
    assert.equal(data.results[0].score, 10);
    assert.equal(data.results[3].rank, 25);
    assert.equal(data.returnedHits, 19);
    assert.equal(data.nextFrom, 40);
    assert.equal(data.query.candidateSearch, true);
    assert.match(data.query.verification, /verified against filing text/);
  } finally { global.fetch = original; }
});

test('cancelled index request never dispatches SEC traffic or falls back to term searches', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('should not fetch'); };
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await GET(new Request('https://example.test/api/edgar-index-search?query=liquidity', { signal: controller.signal }));
    assert.equal(result.status, 499);
    assert.equal(calls, 0);
  } finally { global.fetch = original; }
});

test('an upstream default batch cannot exceed the requested page size or skip remaining raw hits', async () => {
  const original = global.fetch, offsets = [];
  const allHits = Array.from({ length: 123 }, (_, i) => ({
    _id: `0000999930-26-${String(i + 1).padStart(6, '0')}:report.htm`, _score: 200 - i,
    _source: { ciks: ['999930'], display_names: ['Size Fixture (CIK 0000999930)'],
      adsh: `0000999930-26-${String(i + 1).padStart(6, '0')}`, form: '10-K', file_date: '2026-02-02' },
  }));
  global.fetch = async input => {
    const url = new URL(input), from = Number(url.searchParams.get('from'));
    offsets.push(from);
    assert.equal(url.searchParams.get('size'), '20');
    // Reproduce SEC behavior: requested size is ignored, but from is honored.
    return Response.json({ hits: { total: { value: allHits.length, relation: 'eq' }, hits: allHits.slice(from, from + 100) } });
  };
  try {
    const first = await (await GET(new Request('https://example.test/api/edgar-index-search?expression=liquidity&forms=10-K&limit=20'))).json();
    assert.equal(first.results.length, 20);
    assert.equal(first.nextFrom, 20);
    assert.equal(first.coverage.searchedHits, 20);
    assert.equal(first.coverage.upstreamHitsReceived, 100);
    assert.equal(first.results.at(-1).rank, 20);
    const second = await (await GET(new Request(`https://example.test/api/edgar-index-search?expression=liquidity&forms=10-K&limit=20&from=${first.nextFrom}`))).json();
    assert.equal(second.results.length, 20);
    assert.equal(second.results[0].rank, 21);
    assert.equal(second.results[0].accession, allHits[20]._source.adsh);
    assert.equal(second.nextFrom, 40);
    assert.deepEqual(offsets, [0, 20]);
    assert.equal(new Set([...first.results, ...second.results].map(hit => hit.accession)).size, 40);
  } finally { global.fetch = original; }
});

test('implicit SEC amendments are filtered locally without losing their raw cursor positions', async () => {
  const original = global.fetch;
  const allHits = Array.from({ length: 29 }, (_, i) => ({
    _id: `0000999931-26-${String(i + 1).padStart(6, '0')}:report.htm`, _score: 100 - i,
    _source: { ciks: ['999931'], display_names: ['Amendment Fixture (CIK 0000999931)'],
      adsh: `0000999931-26-${String(i + 1).padStart(6, '0')}`, form: [3, 24].includes(i) ? '8-K/A' : '8-K', file_date: '2026-02-02' },
  }));
  global.fetch = async input => {
    const from = Number(new URL(input).searchParams.get('from'));
    return Response.json({ hits: { total: { value: 29, relation: 'eq' }, hits: allHits.slice(from) } });
  };
  try {
    const base = 'https://example.test/api/edgar-index-search?expression=cybersecurity&limit=20&forms=8-K';
    const first = await (await GET(new Request(base))).json();
    assert.equal(first.returnedHits, 19);
    assert.equal(first.nextFrom, 20);
    assert.equal(first.coverage.excludedFormHits, 1);
    assert.ok(first.results.every(hit => hit.form === '8-K'));
    assert.equal(first.results[3].rank, 5);
    const last = await (await GET(new Request(`${base}&from=${first.nextFrom}`))).json();
    assert.equal(last.returnedHits, 8);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextFrom, null);
    assert.equal(last.coverage.searchedHits, 9);
    assert.equal(last.coverage.excludedFormHits, 1);
    assert.equal(last.results[0].rank, 21);
    assert.equal(last.results.at(-1).rank, 29);
    assert.match(last.coverage.totalHitsScope, /before exact form filtering/);
    const amended = await (await GET(new Request(`${base},8-K%2FA`))).json();
    assert.equal(amended.returnedHits, 20);
    assert.equal(amended.coverage.excludedFormHits, 0);
    assert.ok(amended.results.some(hit => hit.form === '8-K/A'));
  } finally { global.fetch = original; }
});


test('focused source links reject mismatched CIKs, accessions and dates without moving the raw cursor', async () => {
  const original = global.fetch, cik = '0000999932';
  const hits = Array.from({ length: 6 }, (_, i) => ({
    _id: `${cik}-26-${String(i + 1).padStart(6, '0')}:report.htm`,
    _source: { ciks: [cik], display_names: [`Source identity fixture (CIK ${cik})`],
      adsh: `${cik}-26-${String(i + 1).padStart(6, '0')}`, form: '10-K', file_date: '2026-02-02' },
  }));
  hits[1]._source.ciks = ['0000999933'];
  hits[2]._source.ciks = [];
  hits[3]._source.adsh = `${cik}-26-999999`;
  hits[4]._source.file_date = '2024-12-31';
  // A requested co-registrant must use its own aligned display name and CIK.
  hits[5]._source.ciks = ['0000999934', cik];
  hits[5]._source.display_names = ['Unrelated co-registrant', `Requested registrant (CIK ${cik})`];
  global.fetch = async () => Response.json({ hits: { total: { value: 20, relation: 'eq' }, hits } });
  try {
    const response = await GET(new Request(`https://example.test/api/edgar-index-search?expression=liquidity&focus=${cik}&forms=10-K&startdt=2025-01-01&enddt=2026-09-19&limit=6`));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.returnedHits, 2);
    assert.equal(result.nextFrom, 6);
    assert.deepEqual(result.results.map(hit => hit.rank), [1, 6]);
    assert.equal(result.results[1].companyName, 'Requested registrant');
    assert.ok(result.results.every(hit => hit.cik === cik && hit.documentUrl.includes(`/999932/`)));
    assert.equal(result.coverage.excludedIdentityHits, 3);
    assert.equal(result.coverage.excludedDateHits, 1);
  } finally { global.fetch = original; }
});
