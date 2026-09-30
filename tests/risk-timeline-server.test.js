import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRiskTimelineRequest,
  verifiedRiskTimelineFilings,
  selectRiskTimelineFilings,
  discoverRiskTimeline,
  createRiskTimelineLoader,
} from '../src/utils/riskTimelineServer.js';
import { matchesRiskTimelineResponse } from '../src/utils/riskTimelineResponse.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const CIK = '0000123456';
const SELECTION = { ticker: 'ACME', basis: 'ttm', asOf: null };
const request = query => `https://example.test/api/risk-timeline?${query}`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function filing(serial, form = '10-K', reportDate = '2025-12-31', filed = '2026-02-15', extra = {}) {
  const accession = `0000999999-${filed.slice(2, 4)}-${String(serial).padStart(6, '0')}`;
  const primaryDoc = `acme-${reportDate.replaceAll('-', '')}.htm`;
  return { accession, form, reportDate, filingDate: filed, primaryDoc,
    documentUrl: `https://www.sec.gov/Archives/edgar/data/${Number(CIK)}/${accession.replaceAll('-', '')}/${primaryDoc}`, ...extra };
}

function company(filings = [], archives = [], ticker = 'ACME', extra = {}) {
  return { ticker, cik: CIK, name: `${ticker} Corporation`, kind: 'company', filings, archives, ...extra };
}

const annualRows = () => [
  filing(1, '10-K', '2022-12-31', '2023-02-15'),
  filing(2, '10-K', '2023-12-31', '2024-02-15'),
  filing(3, '10-K', '2024-12-31', '2025-02-15'),
  filing(4, '10-K', '2025-12-31', '2026-02-15'),
];

function narrative(amount = 100) {
  return `Item 1A. Risk Factors\n\nOur debt covenants require us to maintain minimum liquidity of $${amount} million under the credit agreement. We must comply with these financial requirements throughout the borrowing period, and any failure to satisfy the agreed conditions could restrict our access to additional financing and affect our ability to fund operations.\n\nItem 1B. Unresolved Staff Comments\n\nNone.`;
}

const noArchive = async () => { throw new Error('Unexpected archive read'); };
const discover = (selection, options = {}) => discoverRiskTimeline(selection, {
  now: new Date(NOW), loadCompany: async ticker => company([], [], ticker),
  loadArchive: noArchive, loadDocument: async () => ({ text: narrative() }), ...options,
});

async function emptyResponse(selection = SELECTION) {
  return discover(selection);
}

test('request parsing normalizes an exact ticker and rejects ambiguous, invalid and future selections', () => {
  assert.deepEqual(parseRiskTimelineRequest(request('ticker=%20acme%20'), new Date(NOW)), SELECTION);
  assert.deepEqual(parseRiskTimelineRequest(request('ticker=BRK.B&basis=annual&asOf=2024-02-29'), new Date(NOW)),
    { ticker: 'BRK.B', basis: 'annual', asOf: '2024-02-29' });
  for (const query of [
    'ticker=ACME&ticker=OTHER', 'ticker=ACME&basis=annual&basis=ttm', 'ticker=ACME&forms=10-K',
    'ticker=ACME&asOf=', 'ticker=ACME&asOf=2025-02-29', 'ticker=ACME&asOf=2026-10-01',
    'ticker=ACME&asOf=1993-12-31', 'ticker=ACME&basis=quarter', 'ticker=ACME,OTHER',
    'ticker=1234567890123', 'ticker=',
  ]) assert.throws(() => parseRiskTimelineRequest(request(query), new Date(NOW)),
    error => error.status === 400 && error.code === 'INVALID_RISK_TIMELINE', query);
});

test('verified filing sources bind the manifest document to the issuer, cutoff and original report', () => {
  const good = filing(1);
  const badUrl = (serial, change) => { const row = filing(serial); return { ...row, documentUrl: change(row.documentUrl) }; };
  const badDocument = (serial, name) => {
    const row = filing(serial);
    return { ...row, primaryDoc: name, documentUrl: row.documentUrl.replace(row.primaryDoc, name) };
  };
  // The accession prefix can identify a filing agent; the SEC issuer path is authoritative.
  assert.notEqual(good.accession.slice(0, 10), CIK);
  const invalid = [
    { ...filing(2), form: '10-K/A' }, { ...filing(3), form: '10-Q/A' }, { ...filing(4), form: '8-K' },
    { ...filing(5), filingDate: '2026-10-01' }, { ...filing(6), reportDate: '2026-03-01' },
    { ...filing(7), reportDate: '2025-02-29' }, { ...filing(8), accession: 'invalid' },
    badDocument(9, '../report.htm'), badDocument(10, 'folder/report.htm'), badDocument(11, 'report.pdf'),
    badUrl(12, url => url.replace('/123456/', '/999999/')),
    badUrl(13, url => url.replace('www.sec.gov', 'example.test')),
    badUrl(14, url => `${url}?document=other.htm`), badUrl(15, url => `${url}#risk`),
    badUrl(16, url => url.replace('acme-', 'other-')),
  ];
  const result = verifiedRiskTimelineFilings([good, ...invalid, good], CIK, '2026-09-30');
  assert.equal(result.length, 1);
  assert.equal(result[0].accession, good.accession);
  assert.equal(result[0].url, good.documentUrl);
  assert.equal(verifiedRiskTimelineFilings([good], '123456', '2026-09-30').length, 0);
  assert.equal(verifiedRiskTimelineFilings([good], '0000000000', '2026-09-30').length, 0);
  assert.equal(verifiedRiskTimelineFilings([good], CIK, '2026-02-14').length, 0);
  assert.equal(verifiedRiskTimelineFilings([good], CIK, '2026-02-15').length, 1);
});

test('selection takes the latest two quarters plus two annuals, or four annuals without quarters', () => {
  const rows = [...annualRows(), filing(5, '10-Q', '2025-09-30', '2025-11-01'),
    filing(6, '10-Q', '2026-03-31', '2026-05-01'), filing(7, '10-Q', '2026-06-30', '2026-08-01'),
    filing(8, '10-K', '2025-12-31', '2026-03-01'), filing(9, '10-K/A', '2025-12-31', '2026-04-01')];
  const verified = verifiedRiskTimelineFilings(rows, CIK, '2026-09-30');
  const mixed = selectRiskTimelineFilings(verified, 'ttm');
  assert.deepEqual(mixed.map(row => [row.form, row.reportDate]), [
    ['10-K', '2024-12-31'], ['10-K', '2025-12-31'], ['10-Q', '2026-03-31'], ['10-Q', '2026-06-30'],
  ]);
  assert.equal(mixed[1].accession, rows[3].accession, 'earliest original of a duplicated annual period wins');
  assert.deepEqual(selectRiskTimelineFilings(verified, 'annual').map(row => row.reportDate),
    ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']);
  assert.deepEqual(selectRiskTimelineFilings(verified.filter(row => row.form !== '10-Q')).map(row => row.reportDate),
    ['2022-12-31', '2023-12-31', '2024-12-31', '2025-12-31']);
  assert.equal(new Set(mixed.map(row => row.reportDate)).size, mixed.length);
});

test('foreign annual originals remain eligible without treating 6-K reports or amendments as new periods', () => {
  const rows = [filing(1, '20-F', '2023-12-31', '2024-04-15'), filing(2, '20-F', '2024-12-31', '2025-04-15'),
    filing(3, '40-F', '2025-12-31', '2026-03-15'), filing(4, '20-F/A', '2024-12-31', '2025-05-01'),
    filing(5, '6-K', '2026-06-30', '2026-08-01')];
  assert.deepEqual(selectRiskTimelineFilings(verifiedRiskTimelineFilings(rows, CIK, '2026-09-30')).map(row => row.form),
    ['20-F', '20-F', '40-F']);
});

test('discovery rejects unverifiable issuer and archive identities before reading documents', async () => {
  let reads = 0;
  for (const manifest of [company([], [], 'OTHER'), company([], [], 'ACME', { cik: 'invalid' }),
    company([], [], 'ACME', { archives: null })]) {
    await assert.rejects(discover(SELECTION, { loadCompany: async () => manifest,
      loadDocument: async () => { reads++; return { text: narrative() }; } }),
    error => error.status === 502 && error.code === 'SEC_SOURCE_INVALID');
  }
  await assert.rejects(discover(SELECTION, { loadCompany: async () => company([], [], 'ACME', { kind: 'fund' }) }),
    error => error.status === 422 && error.code === 'FUND_TICKER');
  const archive = { name: `CIK${CIK}-submissions-001.json`, filingFrom: '2020-01-01', filingTo: '2026-01-01' };
  for (const older of [company(annualRows(), [], 'OTHER'), company(annualRows(), [], 'ACME', { cik: '0000999999' })]) {
    await assert.rejects(discover(SELECTION, { loadCompany: async () => company([], [archive]),
      loadArchive: async () => older, loadDocument: async () => { reads++; return { text: narrative() }; } }),
    error => error.status === 502 && error.code === 'SEC_SOURCE_INVALID');
  }
  assert.equal(reads, 0);
});

test('archive discovery reads at most two eligible files and preserves incomplete failures', async () => {
  const archives = [1, 2, 3].map((serial, index) => ({ name: `CIK${CIK}-submissions-00${serial}.json`,
    filingFrom: `${2024 - index}-01-01`, filingTo: `${2026 - index}-01-01` }));
  const seen = [];
  const result = await discover(SELECTION, { loadCompany: async () => company([], [
    ...archives, { ...archives[0], name: 'CIK0000999999-submissions-004.json' },
    { ...archives[0], name: `CIK${CIK}-submissions-005.json`, filingFrom: '2027-01-01', filingTo: '2027-12-31' },
  ]), loadArchive: async (_ticker, name) => { seen.push(name); throw new Error(`Unavailable ${name}`); } });
  assert.deepEqual(seen, archives.slice(0, 2).map(row => row.name));
  assert.equal(result.coverage.historyFilesScanned, 2);
  assert.equal(result.coverage.historyLimited, true);
  assert.equal(result.coverage.historyIssues.length, 2);
  assert.equal(result.status, 'no_filing');
  assert.ok(matchesRiskTimelineResponse(result, 'ACME', 'ttm', null));
});

test('archives recover original reports while cutoff and complete recent coverage bound extra work', async () => {
  const archives = [
    { name: `CIK${CIK}-submissions-001.json`, filingFrom: '2023-01-01', filingTo: '2026-03-01' },
    { name: `CIK${CIK}-submissions-002.json`, filingFrom: '2020-01-01', filingTo: '2022-12-31' },
  ];
  const seen = [];
  const result = await discover({ ...SELECTION, basis: 'annual', asOf: '2026-02-15' }, {
    loadCompany: async () => company([], archives),
    loadArchive: async (_ticker, name) => { seen.push(name); return company([...annualRows(),
      filing(9, '10-K', '2026-03-31', '2026-05-01')]); },
  });
  assert.deepEqual(seen, [archives[0].name]);
  assert.equal(result.filings.length, 4);
  assert.ok(result.filings.every(row => row.filed <= '2026-02-15'));
  assert.equal(result.coverage.historyLimited, false);
  assert.ok(matchesRiskTimelineResponse(result, 'ACME', 'annual', '2026-02-15'));
});

test('an unreadable selected report stays visible and prevents comparison across that same-form gap', async () => {
  const rows = annualRows();
  const result = await discover({ ...SELECTION, basis: 'annual' }, { loadCompany: async () => company(rows),
    loadDocument: async (_cik, source) => {
      if (source.reportDate === '2024-12-31') throw new Error('SEC document unavailable');
      return { text: narrative(Number(source.reportDate.slice(0, 4)) * 10) };
    } });
  assert.equal(result.status, 'partial');
  assert.equal(result.coverage.reviewed, 3);
  assert.equal(result.coverage.failed, 1);
  assert.equal(result.filings[2].status, 'fetch-failed');
  assert.ok(Object.values(result.filings[2].topics).every(topic => topic.status === 'unavailable'));
  assert.ok(result.events.some(event => event.date === '2023-12-31'));
  assert.ok(result.events.every(event => event.date !== '2025-12-31'));
  assert.equal(result.filings[3].topics.covenants.status, 'uncompared');
  assert.equal(result.filings[3].topics.covenants.comparedTo, undefined);
  assert.ok(matchesRiskTimelineResponse(result, 'ACME', 'annual', null));
});

test('each discovery request runs at most two primary document reads concurrently', async () => {
  let active = 0, maximum = 0;
  const gates = [];
  const task = discover({ ...SELECTION, basis: 'annual' }, { loadCompany: async () => company(annualRows()),
    loadDocument: async () => {
      active++; maximum = Math.max(maximum, active);
      const gate = deferred(); gates.push(gate);
      try { await gate.promise; return { text: narrative() }; } finally { active--; }
    } });
  await turn();
  assert.equal(gates.length, 2);
  gates[0].resolve(); gates[1].resolve();
  await turn();
  assert.equal(gates.length, 4);
  gates[2].resolve(); gates[3].resolve();
  const result = await task;
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(result.coverage.reviewed, 4);
});

test('a loader caps concurrent primary documents across requests at four and returns busy 503', async () => {
  let active = 0, maximum = 0;
  const gates = [];
  const loader = createRiskTimelineLoader({ now: () => NOW,
    loadCompany: async ticker => company(annualRows().slice(2), [], ticker), loadArchive: noArchive,
    loadDocument: async () => {
      active++; maximum = Math.max(maximum, active);
      const gate = deferred(); gates.push(gate);
      try { await gate.promise; return { text: narrative() }; } finally { active--; }
    } });
  const first = loader({ ...SELECTION, ticker: 'ONE' });
  const second = loader({ ...SELECTION, ticker: 'TWO' });
  await turn();
  assert.equal(gates.length, 4);
  await assert.rejects(loader({ ...SELECTION, ticker: 'THREE' }),
    error => error.status === 503 && error.code === 'RISK_TIMELINE_BUSY');
  assert.equal(gates.length, 4, 'busy requests never reach the source document transport');
  gates.forEach(gate => gate.resolve());
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.coverage.reviewed === 2));
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});

test('coalesced subscribers share one request and one cancellation does not abort the other subscriber', async () => {
  const body = await emptyResponse();
  const gate = deferred();
  let calls = 0, sharedSignal;
  const loader = createRiskTimelineLoader({ now: () => NOW, discover: async (_selection, options) => {
    calls++; sharedSignal = options.signal; await gate.promise; return body;
  } });
  const a = new AbortController(), b = new AbortController();
  const first = loader(SELECTION, { signal: a.signal });
  const second = loader(SELECTION, { signal: b.signal });
  const cancelled = assert.rejects(first, error => error.name === 'AbortError');
  a.abort(); await cancelled;
  assert.equal(calls, 1);
  assert.equal(sharedSignal.aborted, false);
  gate.resolve();
  assert.equal(await second, body);
  assert.equal(await loader(SELECTION), body);
  assert.equal(calls, 1);
});

test('cancelling every subscriber aborts shared work and does not cache the cancelled request', async () => {
  const body = await emptyResponse();
  const gates = [], signals = [];
  let calls = 0;
  const loader = createRiskTimelineLoader({ now: () => NOW, discover: async (_selection, options) => {
    calls++; signals.push(options.signal);
    const gate = deferred(); gates.push(gate);
    options.signal.addEventListener('abort', () => gate.reject(options.signal.reason), { once: true });
    await gate.promise; return body;
  } });
  const a = new AbortController(), b = new AbortController();
  const first = loader(SELECTION, { signal: a.signal });
  const second = loader(SELECTION, { signal: b.signal });
  const cancelled = Promise.all([assert.rejects(first, error => error.name === 'AbortError'),
    assert.rejects(second, error => error.name === 'AbortError')]);
  a.abort(); b.abort(); await cancelled;
  assert.equal(signals[0].aborted, true);
  const retry = loader(SELECTION);
  assert.equal(calls, 2);
  gates[1].resolve();
  assert.equal(await retry, body);
});

test('successful comparisons reuse a five-minute cache and expire at its exact boundary', async () => {
  let time = NOW, calls = 0;
  const loader = createRiskTimelineLoader({ now: () => time, discover: async selection => {
    calls++; return emptyResponse(selection);
  } });
  const initial = await loader(SELECTION);
  time += 299_999;
  assert.equal(await loader(SELECTION), initial);
  assert.equal(calls, 1);
  time++;
  await loader(SELECTION);
  assert.equal(calls, 2);
  await loader({ ...SELECTION, basis: 'annual' });
  await loader({ ...SELECTION, asOf: '2026-02-15' });
  assert.equal(calls, 4, 'basis and filing cutoff identify different cached requests');
});

test('source failures have a twenty-second cooldown and become retryable after expiry', async () => {
  let time = NOW, calls = 0;
  const loader = createRiskTimelineLoader({ now: () => time, discover: async selection => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Manifest unavailable'), { status: 502, code: 'SEC_SOURCE_INVALID' });
    return emptyResponse(selection);
  } });
  const failure = error => error.status === 502 && error.code === 'SEC_SOURCE_INVALID' && error.message === 'Manifest unavailable';
  await assert.rejects(loader(SELECTION), failure);
  time += 19_999;
  await assert.rejects(loader(SELECTION), failure);
  assert.equal(calls, 1);
  time++;
  assert.equal((await loader(SELECTION)).status, 'no_filing');
  assert.equal(calls, 2);
});

test('a returned partial comparison with failed documents also expires after twenty seconds', async () => {
  let time = NOW, reads = 0;
  const loader = createRiskTimelineLoader({ now: () => time,
    loadCompany: async ticker => company([filing(1)], [], ticker), loadArchive: noArchive,
    loadDocument: async () => { reads++; throw new Error('Temporary primary document failure'); } });
  const first = await loader(SELECTION);
  assert.equal(first.status, 'partial');
  assert.equal(first.coverage.failed, 1);
  time += 19_999;
  assert.equal(await loader(SELECTION), first);
  assert.equal(reads, 1);
  time++;
  await loader(SELECTION);
  assert.equal(reads, 2);
});

test('coalesced loader rejects an unbound response rather than caching it as valid evidence', async () => {
  const body = await emptyResponse({ ...SELECTION, ticker: 'OTHER' });
  const loader = createRiskTimelineLoader({ now: () => NOW, discover: async () => body });
  await assert.rejects(loader(SELECTION), error => error.status === 502 && error.code === 'SEC_SOURCE_INVALID');
});

test('loader admission permits at most twelve distinct pending requests', async () => {
  const body = await emptyResponse();
  const gates = [];
  let calls = 0;
  const loader = createRiskTimelineLoader({ now: () => NOW, discover: async selection => {
    calls++; const gate = deferred(); gates.push(gate); await gate.promise;
    return { ...body, ticker: selection.ticker };
  } });
  const pending = Array.from({ length: 12 }, (_, index) => loader({ ...SELECTION, ticker: `ISSUER${index}` }));
  await assert.rejects(loader({ ...SELECTION, ticker: 'THIRTEENTH' }),
    error => error.status === 503 && error.code === 'RISK_TIMELINE_BUSY');
  assert.equal(calls, 12);
  gates.forEach(gate => gate.resolve());
  assert.equal((await Promise.all(pending)).length, 12);
});

test('successful response reuse retains at most twelve requests and evicts the least recently used', async () => {
  const body = await emptyResponse();
  const calls = new Map();
  const loader = createRiskTimelineLoader({ now: () => NOW, discover: async selection => {
    calls.set(selection.ticker, (calls.get(selection.ticker) || 0) + 1);
    return { ...body, ticker: selection.ticker };
  } });
  for (let index = 0; index < 12; index++) await loader({ ...SELECTION, ticker: `ISSUER${index}` });
  await loader({ ...SELECTION, ticker: 'ISSUER0' });
  await loader({ ...SELECTION, ticker: 'ISSUER12' });
  await loader({ ...SELECTION, ticker: 'ISSUER0' });
  assert.equal(calls.get('ISSUER0'), 1, 'a cache hit keeps the request recently used');
  await loader({ ...SELECTION, ticker: 'ISSUER1' });
  assert.equal(calls.get('ISSUER1'), 2, 'the oldest untouched request was evicted');
});
