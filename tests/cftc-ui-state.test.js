import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cftc = readFileSync(new URL('../src/app/market/CftcPositioning.tsx', import.meta.url), 'utf8');
const market = readFileSync(new URL('../src/app/market/MarketOverviewClient.tsx', import.meta.url), 'utf8');
const panels = readFileSync(new URL('../src/app/market/MarketPanels.tsx', import.meta.url), 'utf8');

test('Market client delegates canonical no-op/push/replace state and restores popstate without a second navigation', () => {
  assert.match(market, /marketViewHistoryMode\(current, next, push\)/);
  assert.match(market, /if \(!mode\) return;/);
  assert.match(market, /window\.history\[mode\]\(null, '', marketViewPath\(next\)\)/);
  assert.match(market, /addEventListener\('popstate', restore\)/);
  assert.match(market, /onOpenView=\{\(query\) => updateView\(parseMarketView\(query, COHORT_IDS\) as MarketView, true\)\}/);
});

test('CFTC unsupported contracts remain explicit and retries clear only failed request paths', () => {
  assert.match(cftc, /The requested code remains in the URL and has not been replaced/);
  assert.match(cftc, /const contract = knownContract \? view\.cftcContract : ''/);
  assert.doesNotMatch(cftc, /view\.cftcContract !== contract/);
  assert.match(cftc, /clearPreparedCftc\(marketsPath\)/);
  assert.match(cftc, /clearPreparedCftc\(historyPath\)/);
  assert.doesNotMatch(cftc, /clearPreparedCftc\(\)/);
});

test('CFTC UI binds the selected rank, accessible tooltip provenance, freshness, and required charts', () => {
  assert.match(cftc, /cftcPercentileForHistory\(group, view\.cftcHistory\)/);
  assert.match(cftc, /aria-describedby=\{tooltipId\}/);
  assert.match(cftc, /Source-report age/);
  assert.match(cftc, /Cache state/);
  assert.match(cftc, /launch markets available/);
  assert.match(cftc, /field="net" title="Net position \(contracts\)"/);
  assert.match(cftc, /field="openInterest" title="Open interest \(contracts\)"/);
  assert.match(cftc, /point\.spreadingStatus === 'not_applicable'/);
  assert.match(cftc, /CFTC_FAMILIES\[family\]\.shortLabel/);
});

test('Saved-research copy identifies exact CFTC or SEC scope rather than generic filters', () => {
  assert.match(panels, /marketSavedViewSummary\(v\.query, cohortIds\)/);
  assert.match(panels, /unsupported legacy screening rules/i);
  assert.match(panels, /never replaced with a different metric/i);
});
