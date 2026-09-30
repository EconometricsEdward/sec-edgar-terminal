import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function chartHarness({ width = 640, height = 220, intersection = true } = {}) {
  const effects = [], states = [];
  let intersect, resize, disconnected = 0;
  const source = readFileSync('src/app/market/research/ResearchChart.jsx', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const compiledModule = { exports: {} };
  const observer = class {
    constructor(callback) { intersect = callback; }
    observe() {}
    disconnect() { disconnected++; }
  };
  const sizeObserver = class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() { disconnected++; }
  };
  new Function('require', 'module', 'exports', 'IntersectionObserver', 'ResizeObserver', compiled)(name => {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === 'react') return {
      useRef: () => ({ current: { getBoundingClientRect: () => ({ width, height }) } }),
      useState: () => [null, value => states.push(value)],
      useEffect: callback => effects.push(callback),
    };
    if (name === 'recharts') return { ResponsiveContainer: () => null };
    throw new Error(name);
  }, compiledModule, compiledModule.exports, intersection ? observer : undefined, sizeObserver);
  const element = compiledModule.exports.default({ children: 'chart' });
  const cleanup = effects[0]();
  return { element, states, intersect: () => intersect([{ isIntersecting: true }]), resize: () => resize(), cleanup, disconnected: () => disconnected };
}

test('offscreen research charts mount only after visibility and positive geometry', () => {
  const chart = chartHarness();
  assert.equal(chart.element.props.children, null);
  assert.deepEqual(chart.states, []);
  chart.intersect();
  assert.deepEqual(chart.states, [{ width: 640, height: 220 }]);
  assert.ok(chart.disconnected() >= 2);
  chart.cleanup();
});

test('hidden zero-size chart does not mount; older browsers still show charts', () => {
  const hidden = chartHarness({ width: 0, height: 0 });
  hidden.intersect();
  assert.deepEqual(hidden.states, []);
  hidden.cleanup();
  const fallback = chartHarness({ intersection: false });
  assert.deepEqual(fallback.states, [{ width: 640, height: 220 }]);
  fallback.cleanup();
});

test('CFTC collapsed history preserves disclosure summary without building hundreds of hidden rows', () => {
  const source = readFileSync('src/app/market/CftcPositioning.tsx', 'utf8');
  assert.match(source, /\[historyTableOpen, setHistoryTableOpen\] = useState\(false\)/);
  assert.match(source, /onToggle=\{event => setHistoryTableOpen\(event.currentTarget.open\)\}/);
  assert.match(source, /Accessible history table[^\n]*<\/summary>\{historyTableOpen &&/);
});
