import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isValidElement } from 'react';
import * as presentation from '../src/app/risk/riskProfilePresentation.js';
import * as workspace from '../src/utils/riskWorkspace.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/app/risk/RiskProfileOverview.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const testModule = { exports: {} };
const section = name => ({ __esModule: true, default: function Section() { return name; } });
new Function('require', 'module', 'exports', compiled)(name => {
  if (name === './riskProfilePresentation.js') return presentation;
  if (name === '../../utils/riskWorkspace.js') return workspace;
  if (name === 'next/dynamic') return { __esModule: true, default: () => section('market').default };
  if (name.endsWith('.css')) return { __esModule: true, default: {} };
  if (name === './RiskFundingStory' || name === './RiskNoteEvidence' || name.endsWith('ChartPeriodOverlay')) return section(name);
  return require(name);
}, testModule, testModule.exports);
const Overview = testModule.exports.default;

function sectionKeys(ticker, basis, cftcEnabled = true) {
  const tree = Overview({
    data: { ticker, sic: 3571 },
    profile: { basis, periods: [], metrics: [], industry: {}, coverage: { available: 0, total: 0, missing: [] } },
    cftcEnabled,
    onInspect: () => {},
  });
  return tree.props.children.filter(isValidElement).filter(child => child.key != null).map(child => child.key);
}

test('stateful Risk sections have distinct sibling identities when the company or reporting basis changes', () => {
  const states = [['AAPL', 'ttm'], ['AAPL', 'annual'], ['JPM', 'ttm']];
  const snapshots = states.map(([ticker, basis]) => {
    const keys = sectionKeys(ticker, basis);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, keys.length, `${ticker}/${basis}: duplicate keys can leave the old funding history mounted`);
    return keys;
  });
  assert.equal(new Set(snapshots.flat()).size, snapshots.flat().length, 'each section resets its inspection state for a different company or basis');
  const withoutMarket = sectionKeys('AAPL', 'ttm', false);
  assert.equal(withoutMarket.length, 2);
  assert.equal(new Set(withoutMarket).size, withoutMarket.length);
});
