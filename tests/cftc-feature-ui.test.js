import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isCftcEnabled } from '../src/utils/cftcFeature.js';
import {
  DEFAULT_MARKET_VIEW,
  isCftcPositioningPath,
  marketSavedViewsForCftcAvailability,
  marketViewForCftcAvailability,
} from '../src/utils/marketResearch.js';

const marketPage = readFileSync(new URL('../src/app/market/page.tsx', import.meta.url), 'utf8');
const shortcut = readFileSync(new URL('../src/app/market/positioning/page.tsx', import.meta.url), 'utf8');
const marketClient = readFileSync(new URL('../src/app/market/MarketOverviewClient.tsx', import.meta.url), 'utf8');
const marketPanels = readFileSync(new URL('../src/app/market/MarketPanels.tsx', import.meta.url), 'utf8');
const homePage = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
const homeResearch = readFileSync(new URL('../src/components/site/HomeResearch.tsx', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
const globalSearch = readFileSync(new URL('../src/components/GlobalSearchBar.jsx', import.meta.url), 'utf8');

test('CFTC feature switch defaults on and recognizes explicit server disable values', () => {
  assert.equal(isCftcEnabled({}), true);
  assert.equal(isCftcEnabled({ CFTC_ENABLED: '1' }), true);
  assert.equal(isCftcEnabled({ CFTC_ENABLED: '0' }), false);
  assert.equal(isCftcEnabled({ CFTC_ENABLED: ' false ' }), false);
});

test('disabled CFTC navigation becomes an SEC overview without losing SEC selections', () => {
  const positioning = {
    ...DEFAULT_MARKET_VIEW,
    tab: 'positioning',
    basis: 'annual',
    cohort: 'large-cap',
    selected: ['AAPL'],
    cftcContract: '001602',
  };
  const disabled = marketViewForCftcAvailability(positioning, false);
  assert.notEqual(disabled, positioning);
  assert.equal(disabled.tab, 'overview');
  assert.equal(disabled.basis, 'annual');
  assert.equal(disabled.cohort, 'large-cap');
  assert.deepEqual(disabled.selected, ['AAPL']);
  assert.equal(disabled.cftcContract, '001602');
  assert.equal(marketViewForCftcAvailability(positioning, true), positioning);
});

test('CFTC canonical and convenience destinations are identified without hiding other Market views', () => {
  assert.equal(isCftcPositioningPath('/market?tab=positioning&contract=001602'), true);
  assert.equal(isCftcPositioningPath('/market/positioning'), true);
  assert.equal(isCftcPositioningPath('/market?tab=fundamentals'), false);
  assert.equal(isCftcPositioningPath('/analysis/AAPL?tab=positioning'), false);
  assert.equal(isCftcPositioningPath('https://example.com/market?tab=positioning'), false);
});

test('disabled CFTC saved views remain stored while their navigation is omitted', () => {
  const views = [
    { name: 'SEC first', query: 'tab=companies' },
    { name: 'CFTC', query: 'tab=positioning&family=tff' },
    { name: 'SEC second', query: 'tab=fundamentals' },
  ];
  assert.deepEqual(
    marketSavedViewsForCftcAvailability(views, undefined, false).map(({ view, index }) => [view.name, index]),
    [['SEC first', 0], ['SEC second', 2]],
  );
  assert.equal(marketSavedViewsForCftcAvailability(views, undefined, true).length, 3);
  assert.equal(views.length, 3);
});

test('server-derived switch gates canonical routes, tabs, previews, saved views, home and recent navigation', () => {
  assert.match(marketPage, /const cftcEnabled = isCftcEnabled\(\)/);
  assert.match(marketPage, /redirect\(marketViewPath\(marketViewForCftcAvailability/);
  assert.match(marketPage, /cftcEnabled=\{cftcEnabled\}/);
  assert.match(shortcut, /redirect\(isCftcEnabled\(\) \? '\/market\?tab=positioning' : '\/market'\)/);
  assert.match(marketClient, /TABS\.filter\(\(tab\) => cftcEnabled \|\| tab\.id !== 'positioning'\)/);
  assert.match(marketClient, /cftcEnabled && <CftcPositioningPreview/);
  assert.match(marketClient, /cftcEnabled=\{cftcEnabled\}/);
  assert.match(marketPanels, /marketSavedViewsForCftcAvailability\(saved\.views, cohortIds, cftcEnabled\)/);
  assert.match(marketPanels, /saved CFTC .* stored in this browser and will return/);
  assert.match(homePage, /cftcEnabled \|\| tool\.href !== "\/market\?tab=positioning"/);
  assert.match(homePage, /<HomeResearch cftcEnabled=\{cftcEnabled\} \/>/);
  assert.match(homeResearch, /!isCftcPositioningPath\(item\.href\)/);
  assert.match(layout, /<HeaderSearchWrapper cftcEnabled=\{cftcEnabled\} \/>/);
  assert.match(globalSearch, /!isCftcPositioningPath\(item\.path\)/);
});
