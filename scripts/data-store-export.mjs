/** Bounded, portable evidence export; this script never deletes or changes pointers. */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { exportDataStoreManifests, readDatasetVersion, readDatasetSource, readFinancialMetrics,
  dataStoreContentHash, stableDataStoreJson, getDataStoreMode } from '../src/utils/dataStore.js';

const args = process.argv.slice(2);
function argument(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const directory = argument('--directory', null);
const limit = Number(argument('--limit', '10'));
const after = argument('--after', null);
if (!directory || !Number.isInteger(limit) || limit < 1 || limit > 25 || after && !/^[a-f0-9-]{36}$/i.test(after)) {
  console.error('Usage: node scripts/data-store-export.mjs --directory /absolute/export-page --limit 10 [--after VERSION_UUID]');
  process.exit(1);
}
const output = resolve(directory);
const manifestPath = join(output, 'manifest.json');
try { await access(manifestPath); throw new Error('Export directory already contains a manifest; choose another page directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true, mode: 0o700 });
const rows = await exportDataStoreManifests({ limit, after });
const manifest = { version: 1, exportedAt: new Date().toISOString(), after, records: [], nextAfter: null,
  scope: 'Bounded source evidence and prepared versions. Pair with a database dump for exact pointer/job recovery.' };
let writtenBytes = 0;
const seen = new Set();
async function saveBytes(bytes, kind) {
  const hash = dataStoreContentHash(bytes);
  const name = `${kind}-${hash}.gz`;
  if (!seen.has(name)) {
    const compressed = gzipSync(bytes);
    if (writtenBytes + compressed.length > 128 * 1024 * 1024) throw new Error('Export page exceeded 128 MiB; reduce --limit.');
    await writeFile(join(output, name), compressed, { mode: 0o600, flag: 'wx' });
    seen.add(name); writtenBytes += compressed.length;
  }
  return { name, sha256: hash, decodedBytes: bytes.length };
}
for (const row of rows) {
  if (getDataStoreMode(row.dataset) === 'off') throw new Error(`Enable ${row.dataset} shadow mode only in this trusted export process before exporting it.`);
  const record = await readDatasetVersion(row.dataset, row.resource_key, row.identity_hash);
  if (!record) throw new Error('Version disappeared during export; no complete manifest was published.');
  const payload = await saveBytes(Buffer.from(stableDataStoreJson(record.payload)), 'payload');
  const sourceBytes = await readDatasetSource(record);
  const source = sourceBytes ? await saveBytes(sourceBytes, 'source') : null;
  const observations = row.dataset === 'financial' ? await readFinancialMetrics(row.id) : [];
  manifest.records.push({ manifest: row, metadata: record.metadata, sourceManifest: record._source, payload, source, observations });
  manifest.nextAfter = row.id;
}
manifest.possiblyMore = rows.length === limit;
manifest.objectBytes = writtenBytes;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ versions: rows.length, objectBytes: writtenBytes, nextAfter: manifest.nextAfter, possiblyMore: manifest.possiblyMore }));
