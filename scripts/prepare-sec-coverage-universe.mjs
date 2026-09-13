import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildSecCoverageUniverse, compareSecCoverageUniverses } from '../src/utils/secCoverageMembership.js';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--output', '--previous', '--now'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error('Usage: node scripts/prepare-sec-coverage-universe.mjs [--input manifest.json] [--output new-version.json] [--previous prior-version.json] [--now ISO-date]');
  }
  options[args[i]] = args[i + 1];
}
const input = options['--input'] || 'src/data/quant-coverage.json';
const contents = await readFile(resolve(input));
const now = options['--now'] ? Date.parse(options['--now']) : Date.now();
const next = buildSecCoverageUniverse(JSON.parse(contents.toString('utf8')), {
  sourcePath: input, sourceSha256: createHash('sha256').update(contents).digest('hex'), now,
});
const changes = options['--previous']
  ? compareSecCoverageUniverses(JSON.parse(await readFile(resolve(options['--previous']), 'utf8')), next, { now })
  : null;
// Versioned outputs are immutable. Selecting the next deployed file remains an
// explicit code change shared by the SEC eligibility and gateway allowlists.
if (options['--output']) await writeFile(resolve(options['--output']), `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ id: next.id, issuers: next.issuerCount, securities: next.securityCount,
  sourceAsOf: next.reference.asOf, membershipFingerprint: next.membershipFingerprint,
  ...(changes ? { added: changes.added.map(row => row.ticker), removed: changes.removed.map(row => row.ticker) } : {}),
  output: options['--output'] || null }, null, 2));
