import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { providerBoundaryViolations } from './provider-boundary-rules.mjs';

const buildRoot = new URL('../.next/', import.meta.url).pathname;
if (!existsSync(buildRoot)) throw new Error('Production build output is unavailable for the provider-removal gate.');

const textExtensions = /\.(?:js|mjs|cjs|json|map|html|txt|rsc|body|css|xml|svg|webmanifest|ndjson|csv)$/i;
const hits = [];
function scan(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = statSync(path);
    if (info.isDirectory()) scan(path);
    else if (textExtensions.test(name) || !name.includes('.')) {
      if (info.size > 100_000_000) throw new Error(`Provider-removal gate cannot safely inspect oversized text artifact: ${path.slice(buildRoot.length)}`);
      const value = readFileSync(path, 'utf8');
      const name = path.slice(buildRoot.length);
      const violations = providerBoundaryViolations(name, value, { built: true });
      if (violations.length) hits.push(`${name} (${violations.join(', ')})`);
    }
  }
}
scan(buildRoot);
if (hits.length) throw new Error(`Provider-removal gate failed in ${hits.length} production build artifact(s): ${hits.slice(0, 8).join(', ')}`);
console.log('Production build provider-removal gate passed.');
