import test from 'node:test';
import assert from 'node:assert/strict';
import { createThirteenFLoader, normalize13FRequest } from '../src/utils/thirteenFServer.js';
import { create13FCache, THIRTEEN_F_FRESH_MS } from '../src/utils/thirteenFCache.js';
import { createHash } from 'node:crypto';
import { GET } from '../src/app/api/fund-13f/route.js';

const CIK = '0001747057';
const PERIOD = '2026-06-30';
const acc = n => `0001172661-26-${String(n).padStart(6, '0')}`;
const filing = (n = 1, period = PERIOD, form = '13F-HR', extra = {}) => ({ accession: acc(n), reportDate: period, filingDate: '2026-08-14', form, primaryDoc: 'xslForm13F_X02/primary_doc.xml', ...extra });
const company = (filings = [filing()], archives = [], extra = {}) => ({ cik: CIK, kind: 'filer', name: 'Fixture Capital L.P.', filings, archives, omittedRecords: 0, omittedArchives: 0, ...extra });
const archive = (n, filingTo = '2026-08-01') => ({ name: `CIK${CIK}-submissions-${String(n).padStart(3, '0')}.json`, filingFrom: '2018-01-01', filingTo });
const cover = ({ cik = CIK, period = PERIOD, form = '13F-HR', entries = 1, total = 1500, amendmentType = 'NEW HOLDINGS', managerName = 'Fixture Capital L.P.' } = {}) => `<?xml version="1.0"?><edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler"><schemaVersion>X0202</schemaVersion><headerData><submissionType>${form}</submissionType><filerInfo><filer><credentials><cik>${cik}</cik></credentials></filer><periodOfReport>${period.slice(5)}-${period.slice(0, 4)}</periodOfReport></filerInfo></headerData><formData><coverPage><reportCalendarOrQuarter>${period.slice(5)}-${period.slice(0, 4)}</reportCalendarOrQuarter><isAmendment>${form.endsWith('/A')}</isAmendment>${form.endsWith('/A') ? `<amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>${amendmentType}</amendmentType></amendmentInfo>` : ''}<filingManager><name>${managerName}</name></filingManager><reportType>${form.startsWith('13F-NT') ? '13F NOTICE' : '13F HOLDINGS REPORT'}</reportType></coverPage><summaryPage><otherIncludedManagersCount>0</otherIncludedManagersCount><tableEntryTotal>${entries}</tableEntryTotal><tableValueTotal>${total}</tableValueTotal><isConfidentialOmitted>false</isConfidentialOmitted></summaryPage></formData></edgarSubmission>`;
const infoRow = ({ cusip = '123456789', value = 1500, quantity = 10 } = {}) => `<infoTable><nameOfIssuer>EXAMPLE INC</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${cusip}</cusip><value>${value}</value><shrsOrPrnAmt><sshPrnamt>${quantity}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><investmentDiscretion>SOLE</investmentDiscretion><votingAuthority><Sole>${quantity}</Sole><Shared>0</Shared><None>0</None></votingAuthority></infoTable>`;
const table = rows => `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows || infoRow()}</informationTable>`;
function fixtureTransport({ documents = {}, index = null, requests = [] } = {}) {
  return async urlInput => {
    const url = new URL(String(urlInput));
    requests.push(url.href);
    const parts = url.pathname.split('/');
    const name = parts.pop(), rootPath = parts.join('/');
    if (name === 'index.json') return Response.json(index || { directory: { name: rootPath, item: [{ name: 'primary_doc.xml' }, { name: 'unpredictable-holdings-name.xml' }] } });
    const doc = documents[url.pathname] ?? documents[name];
    if (doc instanceof Response) return doc.clone();
    if (doc != null) return new Response(doc);
    if (name === 'primary_doc.xml') return new Response(cover());
    if (name === 'unpredictable-holdings-name.xml') return new Response(table());
    throw new Error(`Unlisted fixture request: ${url}`);
  };
}
function loader(options = {}) {
  return createThirteenFLoader({ companyLoader: async () => company(), archiveLoader: async () => { throw new Error('Unexpected archive request'); }, fetchSec: fixtureTransport(), ...options });
}

test('13F request rejects arbitrary identifiers, URLs, query syntax and invalid quarter ends', () => {
  assert.deepEqual(normalize13FRequest('1747057', PERIOD), { cik: CIK, period: PERIOD });
  for (const cik of ['0', '', 'D1 Capital', 'https://www.sec.gov/', '12345678901', '1/2']) assert.throws(() => normalize13FRequest(cik), { code: 'INVALID_CIK' });
  for (const period of ['2026-02-30', '2026-06-29', '../2026-06-30', '26-06-30']) assert.throws(() => normalize13FRequest(CIK, period), { code: 'INVALID_PERIOD' });
});

test('13F loader discovers information tables from a verified same-accession index and returns source evidence', async () => {
  const requests = [];
  const result = await loader({ fetchSec: fixtureTransport({ requests }) })(CIK);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.manager, { cik: CIK, name: 'Fixture Capital L.P.', submissionsUrl: `https://data.sec.gov/submissions/CIK${CIK}.json` });
  assert.equal(result.selectedPeriod, PERIOD);
  assert.equal(result.portfolio.totalValueUsd, 1500);
  assert.equal(result.portfolio.holdings[0].quantity, 10);
  assert.equal(result.portfolio.complete, true);
  assert.equal(result.summary.holdings, undefined);
  assert.equal(result.coverage.selectedPeriodComplete, true);
  assert.equal(result.portfolio.filings[0].tableUrls[0], `https://www.sec.gov/Archives/edgar/data/1747057/${acc(1).replaceAll('-', '')}/unpredictable-holdings-name.xml`);
  assert.equal(result.portfolio.filings[0].primaryUrl.endsWith('/primary_doc.xml'), true);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(url => url.startsWith('https://www.sec.gov/Archives/edgar/data/1747057/')));
});

test('13F periods sort by report period so a late historical amendment cannot become the latest portfolio', async () => {
  const records = [filing(1), filing(2, '2026-03-31', '13F-HR/A', { filingDate: '2026-09-01' })];
  const result = await loader({ companyLoader: async () => company(records) })(CIK);
  assert.equal(result.selectedPeriod, PERIOD);
  assert.deepEqual(result.reports.map(row => row.period), [PERIOD, '2026-03-31']);
  assert.equal(result.reports[1].latestFiled, '2026-09-01');
});

test('13F loader checks relevant verified archives and combines a new-holdings amendment with its base report', async () => {
  const a = archive(1), calls = [];
  const basePath = `/Archives/edgar/data/1747057/${acc(2).replaceAll('-', '')}`;
  const result = await loader({
    companyLoader: async () => company([filing()], [a]),
    archiveLoader: async (_cik, name) => { calls.push(name); return { cik: CIK, archive: a, filings: [filing(2, PERIOD, '13F-HR/A', { filingDate: '2026-08-15' })], omittedRecords: 0 }; },
    fetchSec: fixtureTransport({ documents: {
      [`${basePath}/primary_doc.xml`]: cover({ form: '13F-HR/A', total: 700 }),
      [`${basePath}/unpredictable-holdings-name.xml`]: table(infoRow({ cusip: '987654321', value: 700 })),
    } }),
  })(CIK);
  assert.deepEqual(calls, [a.name]);
  assert.equal(result.reports[0].filingCount, 2);
  assert.equal(result.portfolio.totalValueUsd, 2200);
  assert.equal(result.portfolio.filings.length, 2);
  assert.equal(result.coverage.historyComplete, true);
});

test('An unverified archived manager identity is rejected before holding documents are fetched', async () => {
  const a = archive(1), requests = [];
  const load = loader({ companyLoader: async () => company([filing()], [a]), archiveLoader: async () => ({ cik: '0000000099', archive: a, filings: [] }), fetchSec: fixtureTransport({ requests }) });
  await assert.rejects(load(CIK), /did not match this manager/);
  assert.equal(requests.length, 0);
});

test('A current report does not depend on unrelated older SEC archives', async () => {
  let archiveCalls = 0;
  const data = await loader({
    companyLoader: async () => company([filing()], [archive(1, '2025-12-31')]),
    archiveLoader: async () => { archiveCalls++; throw new Error('Old archive unavailable'); },
  })(CIK);
  assert.equal(archiveCalls, 0);
  assert.equal(data.portfolio.complete, true);
  assert.equal(data.coverage.selectedPeriodComplete, true);
  assert.equal(data.coverage.historyComplete, false);
  assert.equal(data.coverage.archivesRemaining, 1);
});

test('A manager without recent 13F filings is discovered in verified archives without requiring older history', async () => {
  const current = archive(1), old = archive(2, '2025-12-31'), calls = [];
  const data = await loader({
    companyLoader: async () => company([], [current, old]),
    archiveLoader: async (_cik, name) => {
      calls.push(name);
      if (name === old.name) throw new Error('Unrelated archive must not be read');
      return { cik: CIK, archive: current, filings: [filing()], omittedRecords: 0 };
    },
  })(CIK);
  assert.deepEqual(calls, [current.name]);
  assert.equal(data.selectedPeriod, PERIOD);
  assert.equal(data.portfolio.complete, true);
});

test('Relevant historical evidence cannot be silently skipped when its archive is unavailable', async () => {
  await assert.rejects(loader({
    companyLoader: async () => company([filing()], [archive(1)]),
    archiveLoader: async () => { throw new Error('Relevant archive unavailable'); },
  })(CIK), /Relevant archive unavailable/);
});

test('Any manager detects amendments on refresh and a new quarter after its snapshot expires', async () => {
  const cik = '0001167483', previous = '2026-03-31';
  const first = filing(1, previous, '13F-HR', { filingDate: '2026-05-15' });
  const amended = filing(2, previous, '13F-HR/A', { filingDate: '2026-05-20' });
  const latest = filing(3);
  let stage = 0, clock = Date.parse('2026-09-01T00:00:00Z'), checks = 0;
  const transport = fixtureTransport();
  const load = loader({ now: () => clock,
    companyLoader: async (requested, options) => {
      assert.equal(requested, cik); assert.equal(options.refresh, true); checks++;
      return company(stage === 0 ? [first] : stage === 1 ? [amended, first] : [latest, amended, first], [], { cik, name: 'Independent reporting manager' });
    },
    fetchSec: async (url, options) => {
      assert.equal(options.retries, 1);
      if (!url.endsWith('/primary_doc.xml')) return transport(url);
      const selected = [first, amended, latest].find(row => url.includes(row.accession.replaceAll('-', '')));
      return new Response(cover({ cik, period: selected.reportDate, form: selected.form, amendmentType: 'RESTATEMENT' }));
    },
  });
  const initial = await load(cik);
  assert.equal(initial.selectedPeriod, previous);
  stage = 1; clock += 1000;
  assert.equal((await load(cik)).portfolio.filings.length, 1);
  assert.equal(checks, 1, 'fresh snapshots avoid repeated source checks');
  const revised = await load(cik, { refresh: true });
  assert.equal(revised.portfolio.filings.length, 2);
  assert.equal(revised.portfolio.complete, true);
  stage = 2; clock += THIRTEEN_F_FRESH_MS + 1;
  const next = await load(cik);
  assert.equal(next.selectedPeriod, PERIOD);
  assert.equal(next.portfolio.filings[0].accession, latest.accession);
  assert.equal(next.cache.stale, false);
  assert.equal(checks, 3);
});

test('Invalid new 13F evidence is rejected instead of becoming an outage fallback', async () => {
  let broken = false;
  const transport = fixtureTransport();
  const load = loader({
    companyLoader: async () => company([filing(broken ? 2 : 1)]),
    fetchSec: async url => broken && url.endsWith('/primary_doc.xml') ? new Response('<broken>') : transport(url),
  });
  assert.equal((await load(CIK)).portfolio.complete, true);
  broken = true;
  await assert.rejects(load(CIK, { refresh: true }), { status: 422, code: 'INVALID_13F_DOCUMENT' });
});

test('Transport size limits are reported as unsupported evidence, not transient outages', async () => {
  await assert.rejects(loader({ fetchSec: async () => {
    throw Object.assign(new Error('Transport limit'), { status: 502, code: 'SEC_RESPONSE_TOO_LARGE' });
  } })(CIK), { status: 422, code: 'DOCUMENT_TOO_LARGE' });
});

test('A large source table preserves every repeated manager row and survives a cold shared-cache read', async () => {
  const entries = 40000, records = new Map(), requests = [];
  const xml = table(infoRow().repeat(entries));
  assert.ok(Buffer.byteLength(xml) > 12 * 1024 * 1024, 'Exercise the previous document size ceiling');
  const shared = () => create13FCache({ enabled: () => true,
    read: async (type, id) => records.get(`${type}:${id}`) || null,
    write: async (type, id, payload, ttl) => {
      records.set(`${type}:${id}`, { payload, rawSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), expiresAt: new Date(Date.now() + ttl * 1000).toISOString() });
      return { stored: true };
    },
  });
  const first = await loader({ sharedCache: shared(), fetchSec: fixtureTransport({ requests, documents: {
    'primary_doc.xml': cover({ entries, total: entries * 1500 }),
    'unpredictable-holdings-name.xml': xml,
  } }) })(CIK);
  assert.equal(first.portfolio.complete, true);
  assert.equal(first.portfolio.entryCount, entries);
  assert.equal(first.portfolio.positionCount, 1);
  assert.equal(first.portfolio.holdings[0].sourceRowCount, entries);
  assert.equal(first.portfolio.totalValueUsd, entries * 1500);
  const cached = shared();
  assert.equal((await cached.readFiling(CIK, filing())).holdings.length, entries);
  const restored = await loader({ sharedCache: cached, companyLoader: async () => { throw new Error('Source must not run for a prepared report'); } })(CIK);
  assert.equal(restored.cache.status, 'shared');
  assert.equal(restored.portfolio.entryCount, entries);
  assert.equal(restored.portfolio.totalValueUsd, first.portfolio.totalValueUsd);
  assert.equal((await cached.readPublicSummary(CIK)).publicSummary.positionCount, 1);
});

test('Remaining relevant archives make coverage incomplete and disable a definitive quarter comparison', async () => {
  const archives = Array.from({ length: 9 }, (_, i) => archive(i + 1));
  const load = loader({ companyLoader: async () => company([filing()], archives), archiveLoader: async (_cik, name) => ({ cik: CIK, archive: archives.find(a => a.name === name), filings: [], omittedRecords: 0 }) });
  const data = await load(CIK);
  assert.equal(data.coverage.archivesLoaded, 8);
  assert.equal(data.coverage.archivesRemaining, 1);
  assert.equal(data.coverage.selectedPeriodComplete, false);
  assert.equal(data.portfolio.complete, false);
  assert.equal(data.portfolio.comparable, false);
  assert.match(data.coverage.note, /incomplete/);
});

test('Missing SEC report dates are resolved from the verified cover without mutating cached submissions rows', async () => {
  const source = company([filing(1, '')]);
  const result = await loader({ companyLoader: async () => source })(CIK);
  assert.equal(result.selectedPeriod, PERIOD);
  assert.equal(source.filings[0].reportDate, '');
});

test('13F-NT returns a notice with no fabricated holdings portfolio', async () => {
  const result = await loader({ companyLoader: async () => company([filing(1, PERIOD, '13F-NT')]), fetchSec: fixtureTransport({ documents: { 'primary_doc.xml': cover({ form: '13F-NT', entries: 0, total: 0 }) } }) })(CIK);
  assert.equal(result.portfolio.reportType, '13F NOTICE');
  assert.equal(result.portfolio.holdings.length, 0);
  assert.equal(result.portfolio.comparable, false);
  assert.equal(result.portfolio.complete, false);
});

test('No-13F history is a verified unavailable state while network failures reject and remain retryable', async () => {
  let attempts = 0;
  const load = loader({ companyLoader: async () => { attempts++; if (attempts === 1) throw new Error('SEC unavailable'); return company([]); } });
  await assert.rejects(load(CIK), /SEC unavailable/);
  const data = await load(CIK);
  assert.equal(data.status, 'unavailable');
  assert.equal(data.portfolio, null);
  assert.equal(data.coverage.historyComplete, true);
  assert.equal(attempts, 2);
});

test('A filing index for another accession or unsafe filename is rejected without fetching attachments', async () => {
  for (const index of [
    { directory: { name: '/Archives/edgar/data/99/wrong', item: [{ name: 'primary_doc.xml' }] } },
    { directory: { name: `/Archives/edgar/data/1747057/${acc(1).replaceAll('-', '')}`, item: [{ name: '../private.xml' }] } },
  ]) {
    const requests = [];
    await assert.rejects(loader({ fetchSec: fixtureTransport({ index, requests }) })(CIK), /index did not match|invalid document name/);
    assert.equal(requests.length, 1);
  }
});

test('Missing or malformed information tables never become an empty ready portfolio', async () => {
  for (const xml of ['<otherDocument/>', '<informationTable><broken>']) {
    await assert.rejects(loader({ fetchSec: fixtureTransport({ documents: { 'unpredictable-holdings-name.xml': xml } }) })(CIK));
  }
});

test('Multiple verified tables reconcile together against one cover total', async () => {
  const path = `/Archives/edgar/data/1747057/${acc(1).replaceAll('-', '')}`;
  const result = await loader({ fetchSec: fixtureTransport({ index: { directory: { name: path, item: [{ name: 'primary_doc.xml' }, { name: 'first.xml' }, { name: 'second.xml' }] } }, documents: {
    'primary_doc.xml': cover({ entries: 2, total: 2300 }), 'first.xml': table(), 'second.xml': table(infoRow({ cusip: '987654321', value: 800 })),
  } }) })(CIK);
  assert.equal(result.portfolio.totalValueUsd, 2300);
  assert.equal(result.portfolio.complete, true);
  assert.equal(result.portfolio.filings[0].tableUrls.length, 2);
});

test('Declared oversized SEC documents fail before the body is accepted', async () => {
  await assert.rejects(loader({ fetchSec: async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }) })(CIK), { code: 'DOCUMENT_TOO_LARGE' });
});

test('Identical requests coalesce and bounded cache expires; concurrent unique requests are limited', async () => {
  let clock = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const load = loader({ now: () => clock, maxPending: 1, companyLoader: async cik => { calls++; await gate; return company([], [], { cik }); } });
  const first = load(CIK), same = load(CIK);
  await assert.rejects(load('99'), { code: 'SEC_13F_BUSY' });
  release();
  assert.deepEqual(await first, await same);
  await load(CIK);
  assert.equal(calls, 1);
  clock += THIRTEEN_F_FRESH_MS + 1;
  await load(CIK);
  assert.equal(calls, 2);
});

test('Caller cancellation does not poison a coalesced request used by another reader', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const load = loader({ companyLoader: async () => { await gate; return company([]); } });
  const controller = new AbortController();
  const first = load(CIK, { signal: controller.signal });
  const second = load(CIK);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  release();
  assert.equal((await second).status, 'unavailable');
});

test('13F API rejects arbitrary URL inputs, duplicate CIKs and invalid periods with private errors', async () => {
  for (const query of ['', 'cik=0', 'cik=1&cik=2', 'cik=1&period=2026-06-29', 'cik=1&url=https://www.sec.gov/evil', 'cik=1&period=2026-06-30&period=2026-03-31']) {
    const response = await GET(new Request(`https://example.com/api/fund-13f?${query}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok((await response.json()).error);
  }
});

test('Actual 13F API returns the manager, verified unavailable history and bounded cache headers', async () => {
  const original = globalThis.fetch;
  const cik = '0000098713';
  globalThis.fetch = async url => {
    if (String(url) === `https://data.sec.gov/submissions/CIK${cik}.json`) return Response.json({ cik: Number(cik), name: 'No 13F fixture filer', filings: { recent: { accessionNumber: [], form: [], filingDate: [] }, files: [] } });
    throw new Error(`Unexpected API request ${url}`);
  };
  try {
    const response = await GET(new Request(`https://example.com/api/fund-13f?cik=${cik}`));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.manager.cik, cik);
    assert.equal(data.status, 'unavailable');
    assert.equal(data.portfolio, null);
    assert.equal(data.coverage.historyComplete, true);
    assert.match(response.headers.get('cache-control'), /s-maxage=300/);
  } finally { globalThis.fetch = original; }
});

test('Old undated pre-XML records do not block a verifiable modern quarter', async () => {
  const requests = [];
  const source = company([filing(), filing(2, '', '13F-HR', { filingDate: '2010-05-14', primaryDoc: 'old-ascii-report.txt' })]);
  const data = await loader({ companyLoader: async () => source, fetchSec: fixtureTransport({ requests }) })(CIK);
  assert.equal(data.portfolio.complete, true);
  assert.equal(data.coverage.selectedPeriodComplete, true);
  assert.equal(data.coverage.historyComplete, false);
  assert.equal(data.coverage.unresolvedPeriods, 1);
  assert.ok(!requests.some(url => url.includes(acc(2).replaceAll('-', ''))));
});

test('A failed cover reconciliation stays visibly incomplete and can recover on an immediate retry', async () => {
  let valid = false, requests = 0;
  const transport = fixtureTransport();
  const load = loader({ fetchSec: async url => { requests++; return String(url).endsWith('/primary_doc.xml') ? new Response(cover({ total: valid ? 1500 : 2000 })) : transport(url); } });
  const partial = await load(CIK);
  assert.equal(partial.portfolio.complete, false);
  assert.equal(partial.portfolio.comparable, false);
  assert.ok(partial.portfolio.issues.length);
  valid = true;
  const retried = await load(CIK);
  assert.equal(retried.portfolio.complete, true);
  assert.equal(requests, 6);
});

test('Actual 13F API serves a validated holdings report and private retryable errors for malformed SEC data', async () => {
  const original = globalThis.fetch;
  const cik = '0000098714', broken = '0000098715';
  const transport = fixtureTransport({ documents: { 'primary_doc.xml': cover({ cik }) } });
  globalThis.fetch = async url => {
    if (String(url).endsWith(`CIK${cik}.json`)) return Response.json({ cik: Number(cik), name: 'API holdings fixture', filings: { recent: { accessionNumber: [acc(1)], form: ['13F-HR'], filingDate: ['2026-08-14'], reportDate: [PERIOD], primaryDocument: ['xslForm13F_X02/primary_doc.xml'] }, files: [] } });
    if (String(url).endsWith(`CIK${broken}.json`)) return Response.json({ error: 'invalid upstream JSON shape' });
    return transport(url);
  };
  try {
    const response = await GET(new Request(`https://example.com/api/fund-13f?cik=${cik}&period=${PERIOD}`));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, 'ready');
    assert.equal(data.manager.cik, cik);
    assert.equal(data.portfolio.cik, cik);
    assert.equal(data.portfolio.totalValueUsd, 1500);
    assert.equal(data.portfolio.complete, true);
    assert.match(response.headers.get('cache-control'), /s-maxage=300/);
    const refreshed = await GET(new Request(`https://example.com/api/fund-13f?cik=${cik}&period=${PERIOD}&refresh=1`));
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers.get('cache-control'), 'private, no-store');
    assert.equal((await refreshed.json()).cache.status, 'source');
    const failure = await GET(new Request(`https://example.com/api/fund-13f?cik=${broken}`));
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get('cache-control'), 'private, no-store');
    assert.ok((await failure.json()).error);
  } finally { globalThis.fetch = original; }
});
