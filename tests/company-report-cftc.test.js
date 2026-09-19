import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enrichCompanyReportCftc, createReportCompanyExposureDiscovery } from '../src/utils/companyReportCftc.js';
import { extractCompanyExposureMap } from '../src/utils/companyExposure.js';
import { buildCftcHistoryResponse } from '../src/utils/cftcServer.js';

const NOW = '2026-09-19T12:00:00.000Z', CIK = '0000000077';
const annual = { role: 'annual', form: '10-K', accession: '0000000077-26-000001', filed: '2026-02-20',
  reportDate: '2025-12-31', primaryDoc: 'annual.htm', url: 'https://www.sec.gov/Archives/edgar/data/77/000000007726000001/annual.htm', status: 'ready' };
const quarter = { role: 'quarterly', form: '10-Q', accession: '0000000077-26-000002', filed: '2026-08-20',
  reportDate: '2026-06-30', primaryDoc: 'quarter.htm', url: 'https://www.sec.gov/Archives/edgar/data/77/000000007726000002/quarter.htm', status: 'ready' };
const oil = 'Our crude oil production revenue is priced using the WTI benchmark and is affected by supply and demand.';
function report(fields = {}) {
  return { schema: 'edgar.report.v1', kind: 'company', generatedAt: '2026-09-19T11:59:00.000Z',
    entity: { id: CIK, cik: CIK, name: 'Untickered Manufacturer' },
    title: 'Untickered Manufacturer — Company report', subtitle: 'Annual financial report',
    period: { basis: 'annual', asOf: '2025-12-31', filingDate: annual.filed },
    summary: [{ label: 'Revenue', value: 500, unit: 'usd' }], highlights: [], charts: [], sources: [], notes: ['Core financial note'],
    sections: [{ id: 'income', title: 'Financial results', columns: [{ key: 'revenue', label: 'Revenue', format: 'usd' }], rows: [{ revenue: 500 }] }],
    coverage: { status: 'ready', message: 'One verified financial period.', recordCount: 1 }, ...fields };
}
function context(annualText = oil, quarterlyText = '', overrides = {}) {
  const inputs = [{ filing: annual, role: 'annual', text: annualText },
    ...(quarterlyText ? [{ filing: quarter, role: 'quarterly', text: quarterlyText }] : [])];
  const { rows } = extractCompanyExposureMap(inputs, { companyName: 'Untickered Manufacturer', ticker: null });
  return { schemaVersion: 'edgar.company-exposure-map.v1', ticker: null, cik: CIK, asOf: null,
    checkedAt: '2026-09-19T10:00:00.000Z', status: rows.length ? 'ready' : 'no_matches', rows,
    sources: inputs.map(item => item.filing), ...overrides };
}
const raw = JSON.parse(readFileSync(new URL('./fixtures/cftc-disaggregated-72hh-3qpy-v1.json', import.meta.url), 'utf8'))[0];
function history(rows) {
  const records = rows || [['2026-09-15', 70], ['2026-09-08', 60], ['2026-08-18', 100]].map(([date, long], index) => ({
    ...raw, id: `report-${index}`, report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`,
    m_money_positions_long_all: String(long), prod_merc_positions_long: String(185 - long),
  }));
  return buildCftcHistoryResponse({ family: 'disaggregated', code: '067651', group: 'managed-money',
    throughDate: '2026-09-15', window: '1y', rawRows: records, retrievedAt: '2026-09-18T15:30:00.000Z' });
}
const section = (value, id) => value.sections.find(item => item.id === id);
const options = (overrides = {}) => ({ loadContext: async () => context(), loadHistory: async () => history(), now: () => NOW, ...overrides });

test('company CFTC enrichment uses exact CIK evidence and preserves the financial report, dates and aggregate scope', async () => {
  const base = report(), evidence = context(), observation = history();
  const before = structuredClone({ base, evidence, observation });
  const enriched = await enrichCompanyReportCftc(base, options({ loadContext: async (selection, { signal }) => {
    assert.deepEqual(selection, { cik: CIK, asOf: null }); assert.ok(signal); return evidence;
  }, loadHistory: async selection => {
    assert.equal(selection.family, 'disaggregated'); assert.equal(selection.code, '067651');
    assert.equal(selection.group, 'managed-money'); assert.equal(selection.reportDate, 'latest');
    assert.equal(selection.window, '1y'); assert.ok(selection.signal); return observation;
  } }));
  assert.deepEqual(enriched.entity, base.entity);
  assert.deepEqual(enriched.period, base.period);
  assert.equal(enriched.generatedAt, base.generatedAt);
  assert.deepEqual(enriched.sections[0], base.sections[0]);
  const row = section(enriched, 'cftc-positioning').rows[0];
  assert.equal(row.net, -30);
  assert.ok(Math.abs(row.netPctOi - -30 / 365) < 1e-14);
  assert.equal(row.oneWeekChange, 10);
  assert.equal(row.fourWeekChange, -30);
  assert.equal(row.reportDate, '2026-09-15');
  assert.equal(section(enriched, 'cftc-history').rows.length, 3);
  assert.ok(enriched.charts[0].points.some(point => point.value === null), 'A missing reporting interval breaks the chart line');
  assert.equal(section(enriched, 'cftc-company-relevance').rows[0].benchmarkFit, 'Named benchmark reference');
  assert.ok(enriched.notes.some(note => note.includes('do not identify the company’s futures positions')));
  assert.ok(enriched.notes.some(note => note.includes('financial baseline ends 2025-12-31')));
  assert.ok(enriched.notes.some(note => note.includes('effective SEC filing-date cutoff 2026-09-19')));
  assert.ok(enriched.notes.some(note => note.includes('not information verified as publicly available at the financial period end')));
  assert.ok(enriched.sources.some(source => source.url.startsWith('https://publicreporting.cftc.gov/')));
  assert.ok(enriched.sources.some(source => source.url === annual.url && source.note === oil));
  assert.deepEqual({ base, evidence, observation }, before);
});

test('duplicate business channels share one market request and annual basis cannot inherit a quarterly benchmark upgrade', async () => {
  let requests = 0;
  const both = context(`${oil} We purchase crude oil priced at WTI for use in our manufacturing operations.`);
  const enriched = await enrichCompanyReportCftc(report(), options({ loadContext: async () => both,
    loadHistory: async () => { requests++; return history(); } }));
  assert.equal(requests, 1);
  assert.equal(section(enriched, 'cftc-positioning').rows.length, 1);
  const mixed = context('Our crude oil production revenue depends on selling prices and demand.', oil);
  const annualReport = await enrichCompanyReportCftc(report(), options({ loadContext: async () => mixed }));
  assert.equal(section(annualReport, 'cftc-company-relevance').rows[0].benchmarkFit, 'Proxy benchmark');
  assert.ok(annualReport.sources.filter(source => source.form).every(source => source.form === '10-K'));
  const quarterReport = await enrichCompanyReportCftc(report({ period: { basis: 'quarter', asOf: '2026-06-30', filingDate: quarter.filed } }),
    options({ loadContext: async () => mixed }));
  assert.equal(section(quarterReport, 'cftc-company-relevance').rows[0].benchmarkFit, 'Named benchmark reference');
});

test('unmapped generic exposures never receive an unrelated CFTC contract', async () => {
  const enriched = await enrichCompanyReportCftc(report(), options({
    loadContext: async () => context('Our debt and borrowings are exposed to changes in interest rates. Our sugar procurement costs affect our operating margins.'),
    loadHistory: async () => assert.fail('Generic interest-rate and unsupported sugar disclosures cannot select a futures contract'),
  }));
  assert.equal(section(enriched, 'cftc-positioning'), undefined);
  assert.match(section(enriched, 'cftc-coverage').rows[0].detail, /No supported CFTC benchmark/);
  assert.equal(enriched.coverage.status, 'ready');
});

test('wrong company, cutoff, source provenance or CFTC identities leave the core report usable without invented values', async () => {
  for (const mutation of [
    value => { value.cik = '0000000001'; }, value => { value.asOf = '2025-12-31'; },
    value => { value.checkedAt = '2027-01-01T00:00:00Z'; },
    value => { value.sources[0] = { ...value.sources[0], url: 'https://example.com/annual.htm' }; value.rows[0].evidence[0].url = 'https://example.com/annual.htm'; },
  ]) {
    const value = structuredClone(context()); mutation(value);
    const enriched = await enrichCompanyReportCftc(report(), options({ loadContext: async () => value,
      loadHistory: async () => assert.fail('Invalid SEC identity must not load CFTC data') }));
    assert.equal(enriched.coverage.status, 'partial');
    assert.equal(section(enriched, 'income').rows[0].revenue, 500);
    assert.equal(section(enriched, 'cftc-positioning'), undefined);
  }
  for (const mutation of [
    value => { value.selection.contract = '023651'; }, value => { value.selected.selectedGroup.id = 'swap-dealers'; },
    value => { value.report_basis = 'combined'; }, value => { value.source.url = 'https://example.com/cftc.json'; },
    value => { value.history[0].net = 999; }, value => { value.history[0].raw.cftc_market_code = 'OTHER'; },
    value => { value.history.push(structuredClone(value.history[0])); },
    value => { value.retrieved_at = '2027-01-01T00:00:00Z'; },
  ]) {
    const value = history(); mutation(value);
    const enriched = await enrichCompanyReportCftc(report(), options({ loadHistory: async () => value }));
    const row = section(enriched, 'cftc-positioning').rows[0];
    assert.equal(row.net, null); assert.equal(row.reportDate, null); assert.equal(enriched.coverage.status, 'partial');
    assert.equal(section(enriched, 'cftc-history').rows.length, 0);
  }
});

test('missing inputs and zero open interest stay unavailable while reported zero net contracts remain zero', async () => {
  for (const [long, oi, expectedNet] of [['', '365', null], ['100', '0', 0]]) {
    const value = history([{ ...raw, report_date_as_yyyy_mm_dd: '2026-09-15T00:00:00.000',
      m_money_positions_long_all: long, open_interest_all: oi }]);
    const enriched = await enrichCompanyReportCftc(report(), options({ loadHistory: async () => value }));
    const row = section(enriched, 'cftc-positioning').rows[0];
    assert.equal(row.net, expectedNet); assert.equal(row.netPctOi, null);
    assert.equal(row.oneWeekChange, null); assert.equal(row.fourWeekChange, null);
    assert.equal(enriched.coverage.status, 'partial');
  }
});

test('one-week changes require the exact prior date and retained CFTC freshness remains visible', async () => {
  const value = history();
  const prior = value.history.find(point => point.reportDate === '2026-09-08');
  prior.reportDate = '2026-09-09'; prior.raw.report_date_as_yyyy_mm_dd = '2026-09-09T00:00:00.000';
  value.status = 'stale'; value.refresh_warning = 'The prepared source is awaiting revalidation.';
  const enriched = await enrichCompanyReportCftc(report(), options({ loadHistory: async () => value }));
  assert.equal(section(enriched, 'cftc-positioning').rows[0].oneWeekChange, null);
  assert.equal(section(enriched, 'cftc-positioning').rows[0].fourWeekChange, -30);
  assert.equal(section(enriched, 'cftc-market-detail').rows[0].oneWeekPctPoints, null);
  assert.equal(enriched.coverage.status, 'partial');
  assert.ok(enriched.notes.some(note => note.includes('Retained or aged source')));
  assert.ok(enriched.notes.some(note => note.includes(value.refresh_warning)));
});

test('official fixed-width market codes reconcile after the same whitespace normalization as the CFTC loader', async () => {
  const value = history();
  for (const point of value.history) {
    point.raw.cftc_market_code += ' ';
    point.raw.contract_units = ` ${point.raw.contract_units} `;
  }
  const enriched = await enrichCompanyReportCftc(report(), options({ loadHistory: async () => value }));
  assert.equal(section(enriched, 'cftc-positioning').rows[0].net, -30);
  assert.equal(section(enriched, 'cftc-history').rows.length, 3);
});

test('optional outages retain finance, exact-CIK aliases are accepted and explicit caller cancellation propagates', async () => {
  const failure = await enrichCompanyReportCftc(report(), options({ loadContext: async () => { throw new Error('Disabled or source outage'); } }));
  assert.equal(section(failure, 'income').rows[0].revenue, 500);
  assert.match(section(failure, 'cftc-coverage').rows[0].detail, /could not be verified/);
  const alias = await enrichCompanyReportCftc(report(), options({ loadContext: async () => context(oil, '', { ticker: 'SOME.A' }) }));
  assert.equal(section(alias, 'cftc-positioning').rows[0].net, -30);
  const wrongTicker = await enrichCompanyReportCftc(report({ entity: { id: 'RIGHT', ticker: 'RIGHT', cik: CIK, name: 'Issuer' } }),
    options({ loadContext: async () => context(oil, '', { ticker: 'WRONG' }) }));
  assert.equal(section(wrongTicker, 'cftc-positioning'), undefined);
  const controller = new AbortController();
  await assert.rejects(enrichCompanyReportCftc(report(), options({ signal: controller.signal,
    loadContext: async () => { controller.abort(new Error('Cancelled by reader')); return context(); } })), /Cancelled by reader/);
  const fund = { kind: 'nport' };
  assert.equal(await enrichCompanyReportCftc(fund), fund);
});

test('company market enrichment is bounded to four distinct evidenced markets and discloses the limit', async () => {
  let calls = 0;
  const evidence = context('Our crude oil production revenue is priced at WTI.\n\nWe purchase natural gas for our manufacturing operations in the United States.\n\nWe purchase copper for our manufacturing operations in the United States.\n\nWe purchase gold for our manufacturing operations in the United States.\n\nWe purchase silver for our manufacturing operations in the United States.\n\nWe purchase coffee for our beverage operations in the United States.');
  const enriched = await enrichCompanyReportCftc(report(), options({ loadContext: async () => evidence,
    loadHistory: async () => { calls++; throw new Error('Not prepared'); } }));
  assert.equal(calls, 4); assert.equal(section(enriched, 'cftc-positioning').rows.length, 4);
  assert.ok(enriched.notes.some(note => note.includes('includes the first 4')));
});

function discoveryFixture({ staleDocumentWithoutClock = false, wrongCik = false } = {}) {
  const calls = [];
  const fetchSec = async (url, options) => {
    calls.push(url); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    if (url.includes('/submissions/')) return Response.json({ cik: wrongCik ? 1 : 77, name: 'Untickered Manufacturer', tickers: [], filings: {
      recent: { accessionNumber: [annual.accession], form: [annual.form], filingDate: [annual.filed], reportDate: [annual.reportDate], primaryDocument: [annual.primaryDoc] }, files: [],
    } }, { headers: { 'x-data-fetched-at': '2026-09-17T09:00:00.000Z', 'x-data-revalidated-at': '2026-09-18T09:00:00.000Z', 'x-cache-source': 'supabase-prepared' } });
    assert.equal(url, annual.url);
    return new Response(`<html><body><p>${oil}</p></body></html>`, { headers: { 'content-type': 'text/html', 'x-vercel-cache': 'HIT',
      ...(staleDocumentWithoutClock ? {} : { 'x-data-fetched-at': '2026-09-16T08:00:00.000Z' }) } });
  };
  return { calls, load: createReportCompanyExposureDiscovery({ fetchSec, now: () => Date.parse(NOW) }) };
}

test('exact-CIK preview disclosure discovery reuses visible-text parsing and preserves observed retrieval/check dates', async () => {
  const { calls, load } = discoveryFixture();
  const value = await load({ cik: CIK, asOf: null });
  assert.equal(value.status, 'ready'); assert.equal(value.cik, CIK); assert.equal(value.ticker, null);
  assert.equal(value.checkedAt, '2026-09-18T09:00:00.000Z');
  assert.equal(value.sources[0].retrievedAt, '2026-09-16T08:00:00.000Z');
  assert.equal(value.rows[0].benchmark.contract, '067651');
  assert.equal(calls.length, 2);
  const enriched = await enrichCompanyReportCftc(report(), options({ loadContext: load }));
  assert.equal(section(enriched, 'cftc-positioning').rows[0].net, -30);
});

test('preview discovery never relabels retained documents without clocks or crosses issuer CIKs', async () => {
  const retained = await discoveryFixture({ staleDocumentWithoutClock: true }).load({ cik: CIK, asOf: null });
  assert.equal(retained.status, 'unavailable'); assert.equal(retained.sources[0].retrievedAt, null);
  const crossed = discoveryFixture({ wrongCik: true });
  assert.equal((await crossed.load({ cik: CIK, asOf: null })).status, 'unavailable');
  assert.equal(crossed.calls.length, 1);
  await assert.rejects(crossed.load({ cik: CIK, ticker: 'OTHER' }), /exact verified SEC CIK/);
});
