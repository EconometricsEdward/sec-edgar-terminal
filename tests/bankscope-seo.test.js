import test from 'node:test';
import assert from 'node:assert/strict';
import { bankPageSeo, bankSitemapXml } from '../src/utils/bank/seo.js';
import { bankHref, bankPageOptions } from '../src/utils/bank/viewModel.js';

test('bank SEO identifies the legal bank and keeps the canonical independent of filters', () => {
  const state = { banks: [{ id_rssd: 101, legal_name: 'EXAMPLE BANK', city: 'BOSTON', state: 'MA' }], reports: [{ id_rssd: 101, validation: { passed: true } }] };
  const seo = bankPageSeo('101', state);
  assert.match(seo.title, /^EXAMPLE BANK/);
  assert.match(seo.description, /BOSTON, MA.*RSSD 101/);
  assert.equal(seo.path, '/analysis/banks/101');
  assert.equal(seo.index, true);
  assert.equal(bankPageSeo('101', state, true).index, false);
});

test('unprepared or failed bank pages cannot borrow a peer’s index eligibility', () => {
  const state = { banks: [{ id_rssd: 101, legal_name: 'EXAMPLE BANK' }], reports: [{ id_rssd: 102, validation: { passed: true } }, { id_rssd: 101, validation: { passed: false } }] };
  assert.equal(bankPageSeo('101', state).index, false);
  assert.equal(bankPageSeo('999', state).index, false);
  assert.equal(bankPageSeo('101', null, true).index, false);
});

test('bank sitemap includes only canonical, unique prepared-bank identities', () => {
  const xml = bankSitemapXml({ banks: [
    { id_rssd: 101, prepared_quarters: 4 }, { id_rssd: '101', prepared_quarters: 1 },
    { id_rssd: 102, prepared_quarters: 0 }, { id_rssd: 103, prepared_quarters: 2 },
    { id_rssd: '101</loc>', prepared_quarters: 4 }, { id_rssd: 0, prepared_quarters: 1 },
  ] }, 'https://secedgarterminal.com');
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.match(xml, /<loc>https:\/\/secedgarterminal.com\/analysis\/banks\/101<\/loc>/);
  assert.match(xml, /\/banks\/103<\/loc>/);
  assert.doesNotMatch(xml, /\/banks\/102|<loc>[^<]*\?/);
});

test('all local bank views survive share links, reloads and history restoration', () => {
  for (const view of ['overview', 'trends', 'compare', 'exposures']) {
    const input = { view, peers: '102,103', period: '2026-03-31', metric: 'net_income', basis: 'quarterly', panel: 'benchmarks', lens: 'camels', category: 'earnings', exposure: 'securities', segment: 'consumer' };
    const selected = bankPageOptions('101', input);
    const restored = bankPageOptions('101', Object.fromEntries(new URL(bankHref('101', selected), 'https://secedgarterminal.com').searchParams));
    for (const key of ['view', 'peers', 'period', 'metric', 'basis']) assert.deepEqual(restored[key], selected[key]);
    if (view === 'compare') for (const key of ['panel', 'lens', 'category']) assert.equal(restored[key], selected[key]);
    if (view === 'exposures') for (const key of ['exposure', 'segment']) assert.equal(restored[key], selected[key]);
  }
});
