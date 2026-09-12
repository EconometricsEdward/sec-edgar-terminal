import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const buildRoot = new URL('../.next/', import.meta.url).pathname;
if (!existsSync(buildRoot)) throw new Error('Production build output is unavailable for the provider-removal gate.');

const forbidden = [
  ['query1', 'finance', ['ya', 'hoo'].join(''), 'com'].join('.'),
  ['query2', 'finance', ['ya', 'hoo'].join(''), 'com'].join('.'),
  ['finance', ['ya', 'hoo'].join(''), 'com'].join('.'),
  [['st', 'ooq'].join(''), 'com'].join('.'),
  [['ya', 'hoo'].join(''), 'finance'].join('_'),
  ...[
    ['price', 'Data', 'Server'], ['market', 'Signals', 'Server'], ['market', 'Regression'],
    ['market', 'Factor', 'Insights'], ['Stock', 'Price', 'Chart'], ['popular', 'Tickers'], ['view', 'Tracker'],
  ].map(parts => parts.join('')),
];
const textExtensions = /\.(?:js|json|map|html|txt|rsc|body)$/i;
const hits = [];
function scan(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = statSync(path);
    if (info.isDirectory()) scan(path);
    else if (info.size <= 25_000_000 && (textExtensions.test(name) || !name.includes('.'))) {
      const value = readFileSync(path, 'utf8');
      if (forbidden.some(term => value.toLowerCase().includes(term.toLowerCase()))) hits.push(path.slice(buildRoot.length));
    }
  }
}
scan(buildRoot);
if (hits.length) throw new Error(`Provider-removal gate failed in ${hits.length} production build artifact(s): ${hits.slice(0, 8).join(', ')}`);
console.log('Production build provider-removal gate passed.');
