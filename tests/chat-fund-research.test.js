import test from 'node:test';
import assert from 'node:assert/strict';
import { createFundChatTools } from '../src/utils/chatFundResearch.js';
import { buildThirteenFComparison } from '../src/utils/thirteenFComparison.js';
import { buildFundChanges } from '../src/utils/fundChanges.js';

const A = '0001747057', B = '0001350694', FUND = 'ZZZFX', CUSIP = '037833100';
const period = '2026-06-30', beforePeriod = '2026-03-31';
const accession = '0000000100-26-000002', priorAccession = '0000000100-26-000001';
const identity = (id, kind) => kind === '13f' ? { id, cik: id, name: `Manager ${id}` }
  : { id: FUND, ticker: FUND, cik: '0000000100', seriesId: 'S000000123', name: 'Example series' };
function holding(cusip = CUSIP, fields = {}) {
  const row = { issuer: `Issuer ${cusip}`, classTitle: 'COM', cusip, putCall: null, quantityType: 'SH', quantity: 10, valueUsd: 100, weightPct: 100, ...fields };
  return { ...row, key: `${row.cusip}|${row.putCall || 'SECURITY'}|${row.quantityType}` };
}
function manager(cik = A, date = period, rows = [holding()], fields = {}) {
  const id = `${cik}-26-000001`, root = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${id.replaceAll('-', '')}/`;
  return { status: 'ready', manager: { cik, name: `Manager ${cik}` }, selectedPeriod: date, observedAt: '2026-09-01T00:00:00.000Z',
    reports: [{ period: date }], coverage: { selectedPeriodComplete: true },
    portfolio: { cik, period: date, holdings: rows, positionCount: rows.length, complete: true, comparable: true,
      confidentialOmitted: false, reportType: '13F HOLDINGS REPORT', totalValueUsd: rows.reduce((s, r) => s + (r.valueUsd || 0), 0),
      amendmentCount: 0, entryCount: rows.length, issues: [], filings: [{ accession: id, form: '13F-HR', filingDate: '2026-08-01', indexUrl: `${root}${id}-index.html`, tableUrls: [`${root}table.xml`] }], ...fields } };
}
function nport(id = accession, rows = null) {
  const root = `https://www.sec.gov/Archives/edgar/data/100/${id.replaceAll('-', '')}/`;
  const holdings = rows || [{ id: 1, name: 'Example common', cusip: CUSIP, isin: 'US0378331005', tickerSymbol: 'AAA', value: 100, pctOfNav: 10, balance: 10, units: 'NS', assetCat: 'EC', payoffProfile: 'Long' }];
  return { status: 'ready', ticker: FUND, name: 'Example series', cik: '0000000100', seriesId: 'S000000123', accession: id,
    asOf: id === accession ? period : beforePeriod, form: 'NPORT-P', filingDate: '2026-08-01',
    holdings, summary: { count: holdings.length }, filingUrl: `${root}${id}-index.html`, sourceUrl: `${root}primary.xml`,
    reports: [{ accession: priorAccession, reportDate: beforePeriod, filingDate: '2026-05-01' }] };
}
function api(dependencies = {}, context = {}, extra = {}) {
  const sourceList = [], reads = [], tools = createFundChatTools({ dependencies, context, preview: false,
    tool: (description, properties, status, execute) => ({ description, properties, status, execute }),
    stringSchema: description => ({ type: 'string', minLength: 1, description }), enumeration: values => ({ type: 'string', enum: values }),
    read: async (key, work) => { reads.push(key); return work(new AbortController().signal); },
    resolve: async (id, kind) => ({ identity: identity(id, kind) }),
    addSource: (title, url, asOf) => { if (!url?.startsWith('https://www.sec.gov/Archives/edgar/data/') && !url?.startsWith('https://secedgarterminal.com/fund')) return null; const id = `S${sourceList.length + 1}`; sourceList.push({ id, title, url, asOf }); return id; },
    fail: (message, code) => Object.assign(new Error(message), { code }), unavailable: (reason, code, detail) => ({ status: 'unavailable', reason, code, ...detail }),
    txt: (value, max = 600) => typeof value === 'string' ? value.slice(0, max) : '', finite: value => typeof value === 'number' && Number.isFinite(value) ? value : null,
    ...extra });
  return { tools, reads, sources: sourceList };
}
const lookup = (fields = {}) => ({ identifier: A, kind: '13f', selection: '', query: '', ...fields });
const change = (fields = {}) => ({ identifier: A, kind: '13f', before: '', after: '', query: '', ...fields });

test('holdings respects exact page quarter, explicit latest and unrelated-manager identity', async () => {
  const requests = [], a = api({ fund13f: async request => { requests.push(request); return manager(request.cik, request.period || period); } }, { managerCik: A, managerPeriod: beforePeriod });
  assert.equal((await a.tools.fund_holdings.execute(lookup())).period, beforePeriod);
  assert.equal((await a.tools.fund_holdings.execute(lookup({ selection: 'latest' }))).period, period);
  assert.equal((await a.tools.fund_holdings.execute(lookup({ identifier: B }))).period, period);
  assert.deepEqual(requests.map(row => row.period), [beforePeriod, '', '']);
  assert.ok(a.sources.some(source => source.url.includes(`managerPeriod=${beforePeriod}`)));
  await assert.rejects(a.tools.fund_holdings.execute(lookup({ selection: '2026-05-30' })), /calendar quarter/);
});

test('exact source quarter and SEC manager mismatch fail before publishing sources', async () => {
  for (const data of [manager(B), manager(A, beforePeriod)]) {
    const a = api({ fund13f: async () => data });
    await assert.rejects(a.tools.fund_holdings.execute(lookup({ selection: period })), /did not match/);
    assert.equal(a.sources.length, 0);
  }
});

test('targeted search reaches holdings beyond ten and keeps option/principal identity and unknown weights', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => holding(String(i).padStart(9, '0'), { issuer: `Other ${i}`, valueUsd: 1000 - i }));
  rows.push(holding(CUSIP, { issuer: 'Target', putCall: 'PUT', valueUsd: 5 }), holding(CUSIP, { issuer: 'Target', quantityType: 'PRN', valueUsd: 6 }));
  const a = api({ fund13f: async () => manager(A, period, rows, { complete: false }) });
  const result = await a.tools.fund_holdings.execute(lookup({ query: 'Target' }));
  assert.equal(result.holdings.length, 2); assert.equal(result.observedMatchCount, 2); assert.equal(result.matchCount, null);
  assert.equal(result.coverage.absenceKnown, false); assert.ok(result.holdings.every(row => row.weightPct === null));
  assert.deepEqual(new Set(result.holdings.map(row => row.key)), new Set([`${CUSIP}|PUT|SH`, `${CUSIP}|SECURITY|PRN`]));
  assert.match(result.scope, /not manager AUM/); assert.ok(result.sourceIds.length);
});

test('amendment assembly is preserved; superseded sources are not cited as current positions', async () => {
  const data = manager(), old = { ...data.portfolio.filings[0], superseded: true };
  data.portfolio.filings = [old, { ...old, accession: `${A}-26-000002`, form: '13F-HR/A', amendmentType: 'RESTATEMENT',
    superseded: false, indexUrl: old.indexUrl.replace('000001', '000002'), tableUrls: [] }];
  const a = api({ fund13f: async () => data }), result = await a.tools.fund_holdings.execute(lookup());
  assert.equal(result.holdings.length, 1); assert.deepEqual(result.filings[0].sourceIds, []);
  assert.equal(result.filings[1].amendmentType, 'RESTATEMENT'); assert.equal(a.sources.filter(source => source.url.startsWith('https://www.sec.gov/')).length, 1);
});

test('N-PORT exact accession respects series and preserves negative, missing and zero amounts', async () => {
  const rows = [nport().holdings[0], { name: 'Short derivative', value: -5, pctOfNav: -0.5, balance: 2, units: 'CT', assetCat: 'DE', payoffProfile: 'Short' },
    { name: 'Missing', value: null, pctOfNav: null }, { name: 'Zero', value: 0, pctOfNav: 0 }];
  const requests = [], a = api({ fundNport: async r => { requests.push(r); return nport(r.accession || accession, rows); } }, { fund: FUND, accession: priorAccession });
  const result = await a.tools.fund_holdings.execute(lookup({ identifier: FUND, kind: 'nport' }));
  assert.equal(requests[0].accession, priorAccession); assert.equal(result.period, beforePeriod);
  assert.equal(result.holdings.find(r => r.name === 'Missing').valueUsd, null);
  assert.equal(result.holdings.find(r => r.name === 'Zero').valueUsd, 0);
  assert.equal(result.holdings.find(r => r.name === 'Short derivative').valueUsd, -5);
  const wrong = nport(); wrong.seriesId = 'S000000999';
  await assert.rejects(api({ fundNport: async () => wrong }).tools.fund_holdings.execute(lookup({ identifier: FUND, kind: 'nport' })), /SEC fund series/);
});

test('13F changes use deterministic reported quantity changes, not price-change trade claims', async () => {
  const a = api({ fund13f: async ({ period: date }) => manager(A, date || period, [holding(CUSIP, { valueUsd: date === beforePeriod ? 80 : 100 })]) });
  const result = await a.tools.fund_changes.execute(change());
  assert.equal(result.before, beforePeriod); assert.equal(result.after, period);
  assert.equal(result.changes[0].status, 'unchanged'); assert.equal(result.changes[0].quantityChange, 0);
  assert.equal(result.changes[0].valueChangeUsd, 20); assert.match(result.notes[0], /do not establish purchases/);
});

test('changes reject incomplete, confidential, nonconsecutive and paginated reports', async () => {
  for (const fields of [{ complete: false }, { confidentialOmitted: true }, { comparable: false }]) {
    const a = api({ fund13f: async ({ period: date }) => manager(A, date || period, [holding()], fields) });
    assert.equal((await a.tools.fund_changes.execute(change())).status, 'unavailable');
  }
  const a = api({ fund13f: async ({ period: date }) => manager(A, date || period) });
  assert.match((await a.tools.fund_changes.execute(change({ before: '2025-12-31' }))).reason, /consecutive/);
  const b = api({ fundNport: async ({ accession: id }) => ({ ...nport(id || accession), pagination: { portfolioTotal: 100 } }) });
  assert.match((await b.tools.fund_changes.execute(change({ identifier: FUND, kind: 'nport' }))).reason, /Complete holdings/);
});

test('N-PORT changes retain unit incompatibility and same-period amendment qualification', async () => {
  const a = api({ fundNport: async ({ accession: id }) => {
    const data = nport(id || accession); data.asOf = period;
    if (id === priorAccession) data.holdings[0].units = 'PA'; else data.form = 'NPORT-P/A';
    return data;
  } });
  const result = await a.tools.fund_changes.execute(change({ identifier: FUND, kind: 'nport', before: priorAccession }));
  assert.equal(result.status, 'ready'); assert.equal(result.comparisonType, 'same-period-revision');
  assert.equal(result.changes[0].quantityChange, null); assert.match(result.changes[0].quantityReason, /units/);
  assert.ok(result.notes.some(note => /filing revisions/.test(note)));
});

test('overlap uses aligned-quarter full denominators with shares and options separate', async () => {
  const left = manager(A, period, [holding(CUSIP, { valueUsd: 60 }), holding('000000001', { valueUsd: 40 })]);
  const right = manager(B, period, [holding(CUSIP, { valueUsd: 20 }), holding(CUSIP, { putCall: 'CALL', valueUsd: 80 })]);
  const model = buildThirteenFComparison([left, right], { period });
  const a = api({ fundOverlap: async () => model });
  const result = await a.tools.fund_overlap.execute({ left: A, right: B, period });
  assert.equal(result.pairs[0].overlapPct, 20); assert.equal(result.pairs[0].sharedCount, 1);
  assert.equal(result.holdings[0].key, `${CUSIP}|SECURITY|SH`); assert.ok(result.sourceIds.length);
  assert.equal(result.pairs[0].sharedHoldings, undefined); assert.equal(result.holdings[0].summedSharePct, undefined);
  assert.ok(a.sources.some(source => source.url.includes(`managerComparePeriod=${period}`) && source.url.includes('managerCompare=')));
  await assert.rejects(a.tools.fund_overlap.execute({ left: A, right: B, period: beforePeriod }), /same reporting quarter/);
});

test('partial overlap retains unknown totals rather than inventing zero holdings', async () => {
  const left = manager(A), right = manager(B, period, [holding()], { complete: false, totalValueUsd: null });
  const model = buildThirteenFComparison([left, right], { period });
  const a = api({ fundOverlap: async () => model });
  const result = await a.tools.fund_overlap.execute({ left: A, right: B, period });
  assert.equal(result.managers[1].totalValueUsd, null); assert.equal(result.pairs[0].overlapPct, null);
  assert.equal(result.pairs[0].observedSharedCount, 1); assert.equal(result.coverage.allComplete, false);
  assert.ok(a.sources.some(source => source.url.startsWith(`https://www.sec.gov/Archives/edgar/data/${Number(A)}/`)));
  assert.ok(a.sources.some(source => source.url.startsWith(`https://www.sec.gov/Archives/edgar/data/${Number(B)}/`)));
});

test('preview N-PORT search forwards query and refuses absence claims on paginated result', async () => {
  const requests = [], a = api({}, {}, { preview: true, publicJson: async (path, params) => {
    requests.push({ path, params }); return { payload: { ...nport(), pagination: { portfolioTotal: 300 } } };
  } });
  const result = await a.tools.fund_holdings.execute(lookup({ identifier: FUND, kind: 'nport', query: 'AAA' }));
  assert.equal(requests[0].path, '/api/fund'); assert.equal(requests[0].params.q, 'AAA');
  assert.equal(result.coverage.absenceKnown, false); assert.equal(result.matchCount, null);
});

test('unverifiable original sources do not publish financial holdings', async () => {
  const data = manager(); data.portfolio.filings = [];
  await assert.rejects(api({ fund13f: async () => data }).tools.fund_holdings.execute(lookup()), /source links/);
});

test('citation exhaustion cannot publish combined holdings without evidence for an active amendment', async () => {
  const data = manager(), original = data.portfolio.filings[0];
  data.portfolio.filings.push({ ...original, accession: `${A}-26-000002`, form: '13F-HR/A', amendmentType: 'NEW HOLDINGS',
    indexUrl: original.indexUrl.replace('000001', '000002'), tableUrls: [] });
  let count = 0;
  const a = api({ fund13f: async () => data }, {}, { addSource: () => ++count <= 3 ? `S${count}` : null });
  await assert.rejects(a.tools.fund_holdings.execute(lookup()), /Every active source filing/);
});

function previewChanges() {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...nport().holdings[0], cusip: String(i + 1).padStart(9, '0'), isin: null, value: 100, pctOfNav: 1 }));
  const older = { ...nport(priorAccession, rows), complete: true };
  const newer = { ...nport(accession, rows.map(row => ({ ...row, value: 110, pctOfNav: 1.1 }))), complete: true };
  const result = buildFundChanges(older, newer);
  const metadata = ({ holdings: _holdings, ...data }) => data;
  return { mode: 'changes', funds: [metadata(newer), metadata(older)], resolvedBefore: priorAccession, resolvedAfter: accession,
    result: { ...result, rows: result.rows.slice(0, 50) }, pagination: { total: result.rows.length, page: 1, pageCount: 2 } };
}

test('preview reuses N-PORT comparison endpoint for large complete portfolios without full holdings delivery', async () => {
  const requests = [], response = previewChanges(), a = api({}, { fund: FUND, accession }, { preview: true,
    publicJson: async (path, params, _signal, maxBytes) => { requests.push({ path, params, maxBytes }); return { payload: response }; } });
  const result = await a.tools.fund_changes.execute(change({ identifier: FUND, kind: 'nport' }));
  assert.equal(result.status, 'ready'); assert.equal(result.matchCount, 100); assert.equal(result.changes.length, 12);
  assert.equal(result.changes[0].valueChangeUsd, 10); assert.equal(result.truncated, true);
  assert.equal(requests[0].path, '/api/fund-workspace'); assert.equal(requests[0].params.after, accession);
  assert.ok(requests[0].maxBytes <= 12 * 1024 * 1024); assert.ok(result.sourceIds.length);
});

test('preview rejects mismatched N-PORT comparison identity, selected accession and completeness', async () => {
  for (const mutate of [response => { response.funds[0].seriesId = 'S000000999'; },
    response => { response.resolvedAfter = priorAccession; }, response => { response.result.coverage.before.complete = false; },
    response => { response.result.after.accession = priorAccession; }, response => { response.funds[0].summary.count = 101; }]) {
    const response = previewChanges(); mutate(response);
    const a = api({}, {}, { preview: true, publicJson: async () => ({ payload: response }) });
    await assert.rejects(a.tools.fund_changes.execute(change({ identifier: FUND, kind: 'nport', after: accession })), /exact series/);
    assert.equal(a.sources.length, 0);
  }
});

test('N-PORT workspace changes preserve both selected reports and link to the exact comparison', async () => {
  const requests = [], a = api({ fundNport: async request => { requests.push(request); return nport(request.accession || accession); } },
    { view: 'changes', changeTicker: FUND, changeBefore: priorAccession, changeAfter: accession });
  const result = await a.tools.fund_changes.execute(change({ identifier: FUND, kind: 'nport' }));
  assert.deepEqual(requests.map(row => row.accession), [accession, priorAccession]);
  assert.equal(result.status, 'ready');
  assert.ok(a.sources.some(source => source.url.includes(`changeBefore=${priorAccession}`) && source.url.includes(`changeAfter=${accession}`)));
});

test('13F overlap inherits a selected comparison quarter only for managers in that comparison', async () => {
  const requests = [], a = api({ fundOverlap: async request => {
    requests.push(request); const date = request.period || period;
    return buildThirteenFComparison(request.ciks.map(cik => manager(cik, date)), { period: date });
  } }, { managerCompare: [A, B], managerComparePeriod: beforePeriod });
  await a.tools.fund_overlap.execute({ left: B, right: A, period: '' });
  await a.tools.fund_overlap.execute({ left: A, right: B, period: 'latest' });
  await a.tools.fund_overlap.execute({ left: A, right: '0001067983', period: '' });
  assert.deepEqual(requests.map(row => row.period), [beforePeriod, '', '']);
});
