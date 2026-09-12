import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
function files(path) {
  const output = [];
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) output.push(...files(child)); else output.push(child);
  }
  return output;
}

test('runtime, build scripts and public documentation have no retired provider acquisition boundary', () => {
  const scanned = ['src', 'scripts', 'public'].flatMap(folder => files(join(root, folder))).concat([join(root, 'README.md'), join(root, 'package.json'), join(root, 'vercel.json')]);
  const hostPattern = new RegExp(['query1\\.finance\\.yahoo\\.com', 'query2\\.finance\\.yahoo\\.com', 'finance\\.yahoo\\.com', 'stooq\\.com'].join('|'), 'i');
  const providerNamePattern = new RegExp(['yahoo_finance', '\\byahoo\\b', '\\bstooq\\b'].join('|'), 'i');
  const deletedModulePattern = /(?:priceDataServer|marketSignalsServer|marketRegression|marketFactorInsights|StockPriceChart|popularTickers|viewTracker)/;
  const providerHits = [], moduleHits = [];
  for (const path of scanned) {
    const name = relative(root, path);
    const value = readFileSync(path, 'utf8');
    const migrationOnly = name === 'src/utils/providerRetirement.js'
      ? value.replaceAll("'stock-raw-yahoo'", "'stock-raw-retired-provider'")
      : value;
    if (hostPattern.test(value) || providerNamePattern.test(migrationOnly)) providerHits.push(name);
    if (deletedModulePattern.test(value)) moduleHits.push(name);
  }
  assert.deepEqual(providerHits, []);
  assert.deepEqual(moduleHits, []);
});
