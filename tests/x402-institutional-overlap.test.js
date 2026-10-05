import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { createPaidInstitutionalOverlapReader, paidInstitutionalOverlapSelection } from '../src/utils/x402InstitutionalOverlap.js';
import { X402_INSTITUTIONAL_OVERLAP_SCHEMA } from '../src/utils/x402InstitutionalOverlapSchema.js';
import { summarize13FPortfolio } from '../src/utils/thirteenF.js';
import { valid13FSnapshot, THIRTEEN_F_FRESH_MS, THIRTEEN_F_STALE_MS } from '../src/utils/thirteenFCache.js';

const NOW = Date.parse('2026-10-04T20:00:00.000Z'), PERIOD = '2026-06-30';
const A = '0001067983', B = '0001350694', C = '0001747057';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function position(cusip, valueUsd, { quantity = 10, putCall = null, quantityType = 'SH', issuer = 'Example issuer', classTitle = 'COM' } = {}) {
  return { key: [cusip, putCall || 'SECURITY', quantityType].join('|'), cusip, issuer, classTitle, putCall, quantityType,
    quantity, valueUsd, sourceRowCount: 1, investmentDiscretion: 'SOLE', votingAuthority: { sole: quantity, shared: 0, none: 0 } };
}
function snapshot(cik, holdings, { period = PERIOD, requestedPeriod = '', checkedAt = new Date(NOW).toISOString(),
  confidentialOmitted = false, reportType = '13F HOLDINGS REPORT', amended = false } = {}) {
  const filing = (suffix, amendment) => {
    const accession = `${cik}-26-${suffix}`, root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll('-', '')}/`;
    return { accession, form: amendment ? '13F-HR/A' : '13F-HR', filingDate: amendment ? '2026-09-15' : '2026-08-14', reportDate: period,
      indexUrl: `${root}${accession}-index.html`, primaryUrl: `${root}primary.xml`, tableUrls: [`${root}holdings.xml`],
      isAmendment: amendment, amendmentType: amendment ? 'RESTATEMENT' : null, amendmentNumber: amendment ? 1 : null, superseded: amended && !amendment };
  };
  const filings = [filing('000001', false), ...(amended ? [filing('000002', true)] : [])];
  const totalValueUsd = holdings.reduce((sum, row) => sum + row.valueUsd, 0);
  const portfolio = { cik, period, holdings: holdings.map(row => ({ ...row, weightPct: totalValueUsd > 0 ? row.valueUsd / totalValueUsd * 100 : null })),
    complete: true, comparable: !confidentialOmitted && reportType === '13F HOLDINGS REPORT', confidentialOmitted, reportType,
    totalValueUsd, positionCount: holdings.length, entryCount: holdings.length, issues: [], amendmentCount: amended ? 1 : 0, filings };
  const summary = summarize13FPortfolio(portfolio); delete summary.holdings;
  const data = { status: 'ready', manager: { cik, name: `Manager ${cik}` }, selectedPeriod: period, observedAt: checkedAt,
    coverage: { selectedPeriodComplete: true }, portfolio, summary,
    reports: [{ period, filingCount: filings.length, latestFiled: filings.at(-1).filingDate, forms: [...new Set(filings.map(f => f.form))] }] };
  return { schemaVersion: 'edgar.13f-prepared.v1', cik, requestedPeriod, checkedAt, sourceChainHash: hash(filings), data };
}
const baseRowsA = () => [position('123456789', 100, { issuer: '=HYPERLINK("bad")' }), position('987654321', 100),
  position('123456789', 50, { putCall: 'PUT' }), position('123456789', 25, { quantityType: 'PRN' })];
const baseRowsB = () => [position('123456789', 300, { quantity: 30, issuer: 'Double "quote",\nline', classTitle: 'Reported class' }),
  position('111111111', 300), position('123456789', 60, { putCall: 'PUT' }), position('123456789', 50, { quantityType: 'PRN' })];
function harness(overrides = {}) {
  const records = new Map([[A, snapshot(A, baseRowsA())], [B, snapshot(B, baseRowsB())]]), reads = [];
  const read = createPaidInstitutionalOverlapReader({ readManager: async (cik, period, signal) => {
    reads.push({ cik, period, signal }); return records.get(cik) ?? null;
  }, now: () => NOW, ...overrides });
  return { read, records, reads };
}
function selection(suffix = '') {
  return paidInstitutionalOverlapSelection({ url: `https://example.invalid/api/x402/institutional-overlap?ciks=${A}%2C${B}${suffix}` }, NOW);
}

test('selectors reject unbounded, duplicate and ambiguous requests before reading prepared data', async () => {
  for (const suffix of ['&limit=101', '&limit=0', '&offset=10000', '&minimumManagers=3', '&sort=weight', '&format=xml',
    '&period=2026-09-31', '&period=2026-12-31', '&snapshot=ab', '&refresh=1', '&limit=1&limit=2', '&period=']) {
    assert.equal(selection(suffix), null, suffix);
  }
  for (const ciks of [A, `${A},${A}`, '1067983,1350694', `0000000000,${B}`, `${A}, ${B}`, `${A},${B},${C},0001037389,0000000001`]) {
    assert.equal(paidInstitutionalOverlapSelection({ url: `https://example.invalid/?ciks=${encodeURIComponent(ciks)}` }, NOW), null);
  }
  const f = harness(); assert.equal((await f.read({ ciks: [A] })).status, 400); assert.equal(f.reads.length, 0);
});

test('complete same-quarter packets reconcile every denominator, preserve identities, and validate against the delivery schema', async () => {
  const f = harness();
  for (const [cik, value] of f.records) assert.equal(valid13FSnapshot(value, cik, '', NOW), true);
  const response = await f.read(selection()), result = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Data-Stale'), '0');
  assert.equal(result.period, PERIOD); assert.equal(result.rows.length, 3); assert.equal(result.population.unionPositions, 5);
  assert.equal(result.pairs[0].sharedCount, 3); assert.equal(result.pairs[0].unionCount, 5);
  const shares = result.rows.find(row => row.putCall === null && row.quantityType === 'SH');
  assert.equal(shares.aggregateReportedValueUsd, 400); assert.equal(shares.cells[0].quantity, 10);
  assert.equal(shares.cells[1].quantity, 30); assert.equal(shares.cells[0].weightPct, 100 / 275 * 100);
  assert.equal(shares.cells[1].weightPct, 300 / 710 * 100);
  assert.equal(shares.cells[1].classTitle, 'Reported class');
  assert.ok(result.rows.some(row => row.putCall === 'PUT')); assert.ok(result.rows.some(row => row.quantityType === 'PRN'));
  assert.equal(result.pairs[0].overlapPct, Math.min(100 / 275 * 100, 300 / 710 * 100)
    + Math.min(50 / 275 * 100, 60 / 710 * 100) + Math.min(25 / 275 * 100, 50 / 710 * 100));
  const validate = new Ajv({ allErrors: true }).compile(X402_INSTITUTIONAL_OVERLAP_SCHEMA);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(f.reads.length, 2); assert.ok(f.reads.every(row => row.signal instanceof AbortSignal));
});

test('amendment-chain sources are serializable, exact, and anchored to each manager', async () => {
  const f = harness(); f.records.set(A, snapshot(A, baseRowsA(), { amended: true }));
  const result = await (await f.read(selection())).json(), manager = result.managers[0];
  assert.equal(manager.amendmentCount, 1); assert.equal(manager.filings.length, 2);
  assert.equal(manager.filings[0].superseded, true); assert.equal(manager.filings[1].amendmentType, 'RESTATEMENT');
  assert.match(manager.filings[1].tableUrls[0], /1067983\/000106798326000002\/holdings\.xml$/);
  assert.equal(result.snapshot.observations[0].sourceChainHash, hash(f.records.get(A).data.portfolio.filings));
  assert.equal(manager.filings.some(row => 'reportDate' in row), false);
});

test('every selected manager must be complete, valid, not invalidated and within hard retention', async () => {
  for (const mutate of [value => null, value => { value.invalidatedAt = value.checkedAt; return value; },
    value => { value.data.coverage.selectedPeriodComplete = false; return value; },
    value => { value.data.portfolio.totalValueUsd++; return value; },
    value => { value.data.portfolio.filings[0].tableUrls[0] = 'https://example.invalid/private'; return value; },
    value => { value.checkedAt = new Date(NOW - THIRTEEN_F_STALE_MS - 1).toISOString(); return value; },
    value => { value.checkedAt = new Date(NOW + 1).toISOString(); return value; }]) {
    const f = harness(); f.records.set(B, mutate(structuredClone(f.records.get(B))));
    const response = await f.read(selection()); assert.equal(response.status, 503); assert.equal(f.reads.length, 2);
  }
  const f = harness({ readManager: async () => { throw new Error('Optional prepared cache unavailable'); } });
  assert.equal((await f.read(selection())).status, 503);
});

test('stale complete observations remain explicit and are never renewed', async () => {
  const f = harness(), checkedAt = new Date(NOW - THIRTEEN_F_FRESH_MS - 1).toISOString();
  f.records.set(B, snapshot(B, baseRowsB(), { checkedAt }));
  const before = JSON.stringify(f.records.get(B));
  const response = await f.read(selection()), result = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Data-Stale'), '1'); assert.equal(result.stale, true);
  assert.equal(result.managers[1].checkedAt, checkedAt); assert.equal(result.managers[1].stale, true);
  assert.equal(result.snapshot.earliestCheckedAt, checkedAt); assert.equal(JSON.stringify(f.records.get(B)), before);
});

test('latest quarters must align and an unavailable explicit quarter fails atomically', async () => {
  const f = harness(); f.records.set(B, snapshot(B, baseRowsB(), { period: '2026-03-31' }));
  assert.equal((await f.read(selection())).status, 409);
  assert.equal((await f.read(selection('&period=2026-06-30'))).status, 503);
  f.records.set(A, snapshot(A, baseRowsA(), { requestedPeriod: PERIOD }));
  f.records.set(B, snapshot(B, baseRowsB(), { requestedPeriod: PERIOD }));
  assert.equal((await f.read(selection('&period=2026-06-30'))).status, 200);
  assert.equal(f.reads.at(-1).period, PERIOD);
});

test('confidential/combination scope cannot turn missing rows into zero holdings', async () => {
  const f = harness(); f.records.set(C, snapshot(C, [position('123456789', 20)], { confidentialOmitted: true, reportType: '13F COMBINATION REPORT' }));
  const request = paidInstitutionalOverlapSelection({ url: `https://example.invalid/?ciks=${A},${B},${C}` }, NOW);
  const result = await (await f.read(request)).json();
  const put = result.rows.find(row => row.putCall === 'PUT'), cell = put.cells.find(row => row.cik === C);
  assert.deepEqual(cell, { cik: C, status: 'unknown', issuer: null, classTitle: null, quantity: null, valueUsd: null, weightPct: null });
  assert.equal(result.coverage.publicScopeLimitedManagers, 1);
  f.records.set(C, snapshot(C, [position('123456789', 20)]));
  const known = await (await f.read(request)).json();
  assert.equal(known.rows.find(row => row.putCall === 'PUT').cells.find(row => row.cik === C).status, 'not-reported');
  assert.equal(known.rows.find(row => row.putCall === 'PUT').cells.find(row => row.cik === C).valueUsd, 0);
});

test('zero denominators withhold percentages while shared zero positions remain reported', async () => {
  const f = harness(); f.records.set(A, snapshot(A, [position('123456789', 0)]));
  f.records.set(B, snapshot(B, [position('123456789', 0)]));
  const result = await (await f.read(selection())).json();
  assert.equal(result.rows[0].cells[0].status, 'reported'); assert.equal(result.rows[0].cells[0].weightPct, null);
  assert.equal(result.pairs[0].overlapPct, null); assert.equal(result.managers[0].top10Pct, null);
});

test('minimum-manager filter, bounded pages and fingerprints apply to the complete comparison', async () => {
  const f = harness(), first = await (await f.read(selection('&limit=1'))).json();
  assert.equal(first.rows.length, 1); assert.equal(first.pagination.total, 3); assert.equal(first.pagination.nextOffset, 1);
  const next = await (await f.read(selection(`&limit=1&offset=1&snapshot=${first.pagination.snapshot}`))).json();
  assert.notEqual(first.rows[0].key, next.rows[0].key); assert.equal(first.pagination.snapshot, next.pagination.snapshot);
  assert.equal((await f.read(selection(`&sort=cusip&snapshot=${first.pagination.snapshot}`))).status, 409);
  assert.equal((await f.read(selection('&offset=3'))).status, 416);
  f.records.set(A, snapshot(A, baseRowsA(), { amended: true }));
  assert.equal((await f.read(selection(`&snapshot=${first.pagination.snapshot}`))).status, 409);
  f.records.set(C, snapshot(C, [position('123456789', 20)]));
  const selected = paidInstitutionalOverlapSelection({ url: `https://example.invalid/?ciks=${A},${B},${C}&minimumManagers=3` }, NOW);
  const filtered = await (await f.read(selected)).json(); assert.equal(filtered.rows.length, 1); assert.equal(filtered.rows[0].managerCount, 3);
});

test('nonmatching manager selections return an uncharged failure', async () => {
  const f = harness(); f.records.set(B, snapshot(B, [position('222222222', 30)]));
  const response = await f.read(selection()); assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'NO_MATCHING_DATA');
});

test('CSV gives one security/manager cell per row with safe spreadsheet quoting and source metadata', async () => {
  const f = harness(), response = await f.read(selection('&format=csv&limit=1')), body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.match(body, /"quantity","valueUsd","weightPct"/); assert.match(body, /"filings","limitations"/);
  assert.ok(body.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(body.includes('"Double ""quote"",\nline"')); assert.match(body, /www\.sec\.gov\/Archives\/edgar\/data\/1067983/);
  assert.equal(body.match(/edgar\.paid-institutional-overlap\.v1/g).length, 2);
});

test('oversized serializable product bodies fail without a successful paid response', async () => {
  const f = harness(), rows = Array.from({ length: 100 }, (_, index) => position(String(index).padStart(9, '0'), 1, { issuer: 'x'.repeat(150) }));
  // The validated source format permits class names; a very large valid name must still obey paid byte bounds.
  rows.forEach(row => { row.classTitle = 'x'.repeat(499); });
  f.records.set(A, snapshot(A, rows)); f.records.set(B, snapshot(B, rows));
  // All valid source chains are repeated on each CSV cell; bound the eventual payload independently from source caching.
  const large = snapshot(B, rows, { amended: true });
  for (let index = 3; index <= 16; index++) {
    const base = structuredClone(large.data.portfolio.filings[1]), accession = `${B}-26-${String(index).padStart(6, '0')}`;
    const root = `https://www.sec.gov/Archives/edgar/data/${Number(B)}/${accession.replaceAll('-', '')}/`;
    Object.assign(base, { accession, indexUrl: `${root}${accession}-index.html`, primaryUrl: `${root}${'x'.repeat(230)}.xml`,
      tableUrls: Array.from({ length: 15 }, (_, table) => `${root}${'t'.repeat(228)}${String(table).padStart(2, '0')}.xml`), amendmentNumber: index - 1 });
    large.data.portfolio.filings.push(base);
  }
  large.data.reports[0].filingCount = 16; large.data.portfolio.amendmentCount = 15; large.sourceChainHash = hash(large.data.portfolio.filings);
  large.data.summary = summarize13FPortfolio(large.data.portfolio); delete large.data.summary.holdings;
  assert.equal(valid13FSnapshot(large, B, '', NOW), true); f.records.set(B, large);
  const response = await f.read(selection('&format=csv')); assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'PRODUCT_TOO_LARGE');
});
