import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { brokerDealerReportSelection, brokerDealerResearchPayload } from '../src/utils/brokerDealerPayload.js';

test('chart selections preserve exact annual-report identity and reject ambiguous or arbitrary requests', () => {
  const accession = '0001690976-26-000005';
  assert.deepEqual(brokerDealerReportSelection(new URLSearchParams({ cik: '1690976', accession, filed: '2026-08-27', document: 'ASLCMIPUBLICFSJUNE2026.pdf' })), {
    cik: '0001690976', accession, archive: '', filed: '2026-08-27', document: 'ASLCMIPUBLICFSJUNE2026.pdf',
  });
  for (const query of ['cik=0', 'cik=1690976&cik=2', 'cik=1690976&url=https://example.com/private',
    'cik=1690976&document=report.pdf', `cik=1690976&accession=${accession}&document=../report.pdf`,
    `cik=1690976&accession=${accession}&filed=2026-02-30`, 'cik=1690976&accession=', 'cik=1690976&archive=wrong.json']) {
    assert.throws(() => brokerDealerReportSelection(new URLSearchParams(query)), { status: 400 }, query);
  }
});

test('chart payload retains source evidence without serializing full PDFs, raw text or unrelated company filings', () => {
  const analysis = { metrics: [{ id: 'totalAssets', value: 12, source: { page: 6, text: 'Total assets 12' } }] };
  const result = brokerDealerResearchPayload({ company: { cik: '0001690976', name: 'ASL', filings: new Array(100).fill('unrelated') },
    filing: { accession: '0001690976-26-000005' }, analysis, pages: ['large raw pages'], text: 'full document',
    selectedDocument: { name: 'report.pdf' }, extraction: { retryable: false }, coverage: { complete: true } });
  assert.equal(result.analysis, analysis);
  assert.equal(result.company.cik, '0001690976');
  assert.equal('pages' in result, false); assert.equal('text' in result, false);
  assert.equal('filings' in result.company, false);
  assert.equal(result.extraction.retryable, false);
});

async function routeFixture() {
  const { mock } = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  let calls = 0, retryable = false, available = true;
  mock.module(new URL('src/utils/rateLimit.js', root).href, { namedExports: {
    checkRateLimit: async () => ({ allowed: true }), getClientIp: () => 'test', rateLimitedResponse: () => { throw Error('unused'); },
  } });
  mock.module(new URL('src/utils/brokerDealerResearch.js', root).href, { namedExports: { loadBrokerDealerResearch: async (cik, options) => {
    calls++; assert.equal(cik, '0001690976');
    if (options.accession) assert.equal(options.accession, '0001690976-26-000005');
    return { status: available ? 'available' : 'not-applicable', company: { cik, name: 'ASL' }, filing: { accession: options.accession },
      analysis: available ? { status: retryable ? 'unavailable' : 'ready', metrics: [] } : null,
      extraction: { retryable }, pages: ['large'], text: 'not for charts' };
  } } });
  const { GET } = await import(new URL('src/app/api/broker-dealer/report/route.js', root));
  const request = query => new Request(`https://example.test/api/broker-dealer/report?${query}`);
  let response = await GET(request('cik=1690976&document=../private.pdf'));
  assert.equal(response.status, 400); assert.equal(calls, 0);
  response = await GET(request('cik=1690976&accession=0001690976-26-000005'));
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /s-maxage=86400/);
  const body = await response.json(); assert.equal(body.company.cik, '0001690976'); assert.equal('pages' in body, false);
  retryable = true;
  response = await GET(request('cik=1690976')); assert.equal(response.status, 503); assert.match(response.headers.get('cache-control'), /no-store/);
  retryable = false; available = false;
  response = await GET(request('cik=1690976')); assert.equal(response.status, 404); assert.match(response.headers.get('cache-control'), /no-store/);
}

test('compact report route caches successful exact filings and leaves transient failures retryable', () => {
  execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', `await (${routeFixture.toString()})();`, new URL('../', import.meta.url).href], { stdio: 'pipe' });
});
