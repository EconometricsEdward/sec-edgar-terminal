import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarketView, marketViewQuery, canonicalMarketViewQuery, marketViewHistoryMode } from '../src/utils/marketResearch.js';
import { updateMarketView } from '../src/utils/marketOverview.js';

test('sector company sorting, search and pagination survive share links', () => {
  const input = 'tab=sectors&cohort=sector-technology&basis=annual&companyMetric=currentRatio&companyDirection=asc&companyQuery=Applied%20Materials&companyPage=2';
  const view = parseMarketView(input);
  assert.equal(view.companyMetric, 'currentRatio');
  assert.equal(view.companyPage, 2);
  assert.equal(view.companyQuery, 'Applied Materials');
  assert.deepEqual(parseMarketView(marketViewQuery(view)), view);
  assert.equal(canonicalMarketViewQuery(input).query, marketViewQuery(view));
});

test('changing company selection resets pagination but not independent sector statistics', () => {
  const original = parseMarketView('tab=sectors&cohort=sector-energy&metric=equityToAssets&companyMetric=netMargin&companyPage=3');
  for (const patch of [{ cohort: 'sector-technology' }, { basis: 'annual' }, { companyMetric: 'cashToAssets' }, { companyQuery: 'Exxon' }, { companyDirection: 'asc' }]) {
    const next = updateMarketView(original, patch);
    assert.equal(next.companyPage, 1);
    assert.equal(next.metric, 'equityToAssets');
  }
  const nextPage = updateMarketView(original, { companyPage: 4 });
  assert.equal(nextPage.companyPage, 4);
  assert.equal(marketViewHistoryMode(original, nextPage), 'replaceState');
});

test('invalid sector company controls are normalized in URLs and rejected in saved views', () => {
  const view = parseMarketView('tab=sectors&companyMetric=rating&companyDirection=sideways&companyPage=-1');
  assert.equal(view.companyMetric, 'revenueGrowth');
  assert.equal(view.companyDirection, 'desc');
  assert.equal(view.companyPage, 1);
  assert.equal(canonicalMarketViewQuery('tab=sectors&companyPage=-1').query, null);
  assert.equal(canonicalMarketViewQuery('tab=sectors&companyMetric=rating').query, null);
  assert.equal(canonicalMarketViewQuery('tab=sectors&companyQuery=' + 'a'.repeat(101)).query, null);
  const cftc = { ...view, tab: 'positioning', companyMetric: 'netMargin', companyPage: 3 };
  assert.doesNotMatch(marketViewQuery(cftc), /companyMetric|companyPage/);
});
