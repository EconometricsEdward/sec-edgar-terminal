#!/usr/bin/env node
/**
 * Bounded migration sizing audit. Default: no network. --sec uses the existing
 * secFetch gate, never a second SEC transport. --cftc calls four fixed public
 * application endpoints. --redis issues STRLEN/PTTL for fixed keys only.
 * No key discovery, value downloads, database writes, or cleanup commands.
 * Existing SEC coordination and public-endpoint cache side effects still apply.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secFetch, secClientStatus } from '../src/utils/secClient.js';
import { buildMarketCompany, marketCompanySummary, marketAcceptanceTimes } from '../src/utils/marketResearchData.js';

const COHORT = Object.freeze([
  { ticker: 'AAPL', cik: '0000320193', selection: 'large nonfinancial; September fiscal year end' },
  { ticker: 'MSFT', cik: '0000789019', selection: 'large nonfinancial; June fiscal year end' },
  { ticker: 'JPM', cik: '0000019617', selection: 'bank; December fiscal year end' },
  { ticker: 'ACU', cik: '0000002098', selection: 'smaller nonfinancial issuer candidate; verify source identity' },
]);
const PUBLIC_PATHS = Object.freeze([
  '/api/v1/cftc/markets?family=tff',
  '/api/v1/cftc/markets?family=disaggregated',
  '/api/v1/cftc/history?family=tff&contract=13874A&group=leveraged-funds&window=1y',
  '/api/v1/cftc/status',
]);
const FIXED_REDIS_KEYS = Object.freeze([
  'warm:submissions-cik:0000320193',
  'warm:research-sec-v1:/SUBMISSIONS/CIK0000320193.JSON',
  'warm:research-sec-v1:/API/XBRL/COMPANYFACTS/CIK0000320193.JSON',
  'warm:filings-submissions-v1:/SUBMISSIONS/CIK0000320193.JSON',
  'warm:edgar.cftc-positioning.v1:production:MARKETS:TFF:LATEST',
  'warm:edgar.cftc-positioning.v1:production:MARKETS-LAST-GOOD:TFF:LATEST',
  'warm:edgar.cftc-positioning.v1:production:MARKETS:DISAGGREGATED:LATEST',
  'warm:edgar.cftc-positioning.v1:production:REFRESH-CHECKPOINT',
  'warm:market-research-v3:company:production:AAPL',
  'warm:quant-company-v2:production:0000320193',
  'warm:market-research-v3:ATLAS',
]);
const BYTE_LIMIT = 32 * 1024 * 1024;
const TOTAL_LIMIT = 100 * 1024 * 1024;
const flags = new Set(process.argv.slice(2));
for (const arg of flags) {
  if (!['--sec', '--cftc', '--redis', '--help'].includes(arg) && !arg.startsWith('--out=') && !arg.startsWith('--save-samples=')) {
    throw new Error(`Unknown audit option: ${arg}`);
  }
}
if (flags.has('--help')) {
  console.log('node scripts/data-migration-audit.mjs [--sec] [--cftc] [--redis] [--out=/absolute/report.json] [--save-samples=/absolute/scratch-directory]\nNo network by default. At most 8 SEC requests (zero retries, existing secFetch), 4 application reads, and one 22-command Redis metadata pipeline. No key scan, value read, deletion, or infrastructure mutation.');
  process.exit(0);
}
const optionPath = name => {
  const values = [...flags].filter(flag => flag.startsWith(`${name}=`));
  if (values.length > 1) throw new Error(`Provide ${name} once.`);
  const value = values[0]?.slice(name.length + 1);
  if (value && !isAbsolute(value)) throw new Error(`${name} must use an absolute path.`);
  return value ? resolve(value) : null;
};
const outputPath = optionPath('--out');
const sampleDir = optionPath('--save-samples');
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (sampleDir && !relative(repoRoot, sampleDir).startsWith('..')) {
  throw new Error('Raw audit samples must be outside the repository.');
}
const result = {
  auditVersion: 1,
  startedAt: new Date().toISOString(),
  cohort: COHORT,
  secGate: secClientStatus(),
  limits: { secLogicalRequests: 8, secRetries: 0, secResponseBytes: BYTE_LIMIT, totalResponseBytes: TOTAL_LIMIT, publicRequests: 4, redisKeys: FIXED_REDIS_KEYS.length },
  measurements: [],
  calculationMeasurements: [],
  redis: { status: 'not-requested', commands: 0, responseBytes: 0, keys: [] },
  notes: [
    'Logical calls are counted; SEC redirect starts and coordination commands are not an observed provider billing total.',
    'gzipBytes uses local gzip level 6 over decoded response bytes, not measured compressed network transfer.',
    'Failed/error responses are not financial or CFTC payload size observations.',
    'Selection is representative by issuer type and fiscal year, not measured traffic. Missing-data/restatement coverage requires separate reconciliation.',
  ],
};
let totalBytes = 0;
const sourceSamples = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function boundedBody(response, maximum) {
  if (!response.body) throw Object.assign(new Error('No response body.'), { code: 'MISSING_BODY' });
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum || totalBytes + bytes > TOTAL_LIMIT) throw Object.assign(new Error('Audit response limit exceeded.'), { code: 'AUDIT_BYTE_LIMIT' });
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  totalBytes += bytes;
  return Buffer.concat(chunks);
}
async function measure({ label, url, kind, issuer }) {
  const started = performance.now();
  const observation = { label, kind, url, retrievedAt: new Date().toISOString() };
  try {
    const response = kind === 'sec'
      ? await secFetch(url, { retries: 0, maxBytes: BYTE_LIMIT, timeoutMs: 15000, signal: AbortSignal.timeout(20000), cache: 'no-store', headers: { Accept: 'application/json' } })
      : await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } });
    observation.httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      observation.status = 'unavailable';
      observation.code = `HTTP_${response.status}`;
      return observation;
    }
    const bytes = await boundedBody(response, kind === 'sec' ? BYTE_LIMIT : 4 * 1024 * 1024);
    const json = JSON.parse(bytes.toString('utf8'));
    if (kind === 'sec' && Number(json.cik) !== Number(issuer.cik)) throw Object.assign(new Error('Unexpected SEC identity.'), { code: 'SEC_IDENTITY_MISMATCH' });
    if (kind === 'sec' && !(label.endsWith('-submissions') ? json.filings?.recent : json.facts)) throw Object.assign(new Error('Unexpected SEC shape.'), { code: 'SEC_SHAPE_MISMATCH' });
    Object.assign(observation, {
      status: 'measured', rawBytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 6 }).length,
      sha256: hash(bytes),
      jsonReserializedBytes: Buffer.byteLength(JSON.stringify(json)),
      exceedsWarmSetLimit: Buffer.byteLength(JSON.stringify(json)) > 900000,
      contentEncoding: response.headers.get('content-encoding'),
      cacheControl: response.headers.get('cache-control'),
      cacheSource: response.headers.get('x-cache-source'),
    });
    if (kind === 'sec') {
      sourceSamples.set(label, json);
      observation.sourceIdentity = { cik: String(json.cik), name: json.name || json.entityName, fiscalYearEnd: json.fiscalYearEnd || null };
      if (json.filings?.recent) {
        const recent = json.filings.recent;
        const index = recent.form.findIndex(form => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(form));
        observation.latestFinancialFiling = index < 0 ? null : { accession: recent.accessionNumber[index], form: recent.form[index], filed: recent.filingDate[index], reportDate: recent.reportDate[index], acceptanceDateTime: recent.acceptanceDateTime?.[index] || null };
      }
      if (json.facts) {
        const concepts = Object.values(json.facts).flatMap(taxonomy => Object.values(taxonomy));
        observation.concepts = concepts.length;
        observation.observations = concepts.reduce((sum, concept) => sum + Object.values(concept.units || {}).reduce((subtotal, rows) => subtotal + rows.length, 0), 0);
      }
    } else {
      observation.sourceIdentity = { schema: json.schema_version, reportDate: json.report_date || json.selected?.reportDate || null, family: json.report_family || null, status: json.status };
    }
    if (sampleDir) {
      await mkdir(sampleDir, { recursive: true });
      await writeFile(resolve(sampleDir, `${label}.json`), bytes, { mode: 0o600 });
    }
  } catch (error) {
    // Do not echo provider URLs/tokens embedded in transport exceptions.
    observation.status = 'unavailable';
    observation.code = /^[A-Z0-9_]{2,70}$/.test(error?.code || '') ? error.code : error?.name || 'FETCH_FAILED';
  } finally {
    observation.elapsedMs = Math.round(performance.now() - started);
    result.measurements.push(observation);
  }
  return observation;
}

if (flags.has('--sec')) {
  let blocked = null;
  for (const issuer of COHORT) {
    for (const resource of ['submissions', 'companyfacts']) {
      const path = resource === 'submissions' ? `/submissions/CIK${issuer.cik}.json` : `/api/xbrl/companyfacts/CIK${issuer.cik}.json`;
      const label = `${issuer.ticker.toLowerCase()}-${resource}`;
      if (blocked) { result.measurements.push({ label, kind: 'sec', status: 'not-attempted', reason: blocked }); continue; }
      const observation = await measure({ label, url: `https://data.sec.gov${path}`, kind: 'sec', issuer });
      if (observation.status !== 'measured' && observation.httpStatus !== 404) blocked = observation.code;
    }
  }
  for (const issuer of COHORT) {
    const submissions = sourceSamples.get(`${issuer.ticker.toLowerCase()}-submissions`);
    const companyfacts = sourceSamples.get(`${issuer.ticker.toLowerCase()}-companyfacts`);
    if (!submissions || !companyfacts) continue;
    const started = performance.now();
    try {
      const full = buildMarketCompany({ ...issuer, name: submissions.name, sic: submissions.sic, facts: companyfacts.facts, acceptanceTimes: marketAcceptanceTimes(submissions) }, [], result.startedAt);
      const computeMs = Math.round(performance.now() - started);
      const compact = marketCompanySummary(full);
      const sizes = value => {
        const raw = Buffer.from(JSON.stringify(value));
        return { rawBytes: raw.length, gzipBytes: gzipSync(raw, { level: 6 }).length };
      };
      result.calculationMeasurements.push({ ticker: issuer.ticker, calculation: 'existing buildMarketCompany + marketCompanySummary', version: full.version, computeMs, full: sizes(full), compact: sizes(compact), reports: compact.reports });
    } catch { result.calculationMeasurements.push({ ticker: issuer.ticker, status: 'calculation-unavailable' }); }
  }
}
if (flags.has('--cftc')) {
  let blocked = null;
  for (const [index, path] of PUBLIC_PATHS.entries()) {
    if (blocked) { result.measurements.push({ label: `cftc-${index}`, kind: 'application', status: 'not-attempted', reason: blocked }); continue; }
    const observation = await measure({ label: `cftc-${index}`, url: `https://secedgarterminal.com${path}`, kind: 'application' });
    if (observation.status !== 'measured') blocked = observation.code;
  }
}
if (flags.has('--redis')) {
  const redisUrl = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !token) result.redis.status = 'not-configured';
  else {
    try {
      const commands = FIXED_REDIS_KEYS.flatMap(key => [['STRLEN', key], ['PTTL', key]]);
      result.redis.commands = commands.length;
      const response = await fetch(`${redisUrl}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands), signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error('Redis audit request failed.');
      const raw = await boundedBody(response, 65536);
      result.redis.responseBytes = raw.length;
      const rows = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(rows) || rows.length !== commands.length || rows.some(row => row.error || !Number.isSafeInteger(row.result))) throw new Error('Invalid Redis metadata response.');
      result.redis.keys = FIXED_REDIS_KEYS.map((key, index) => ({ key, bytes: rows[index * 2].result, pttlMs: rows[index * 2 + 1].result }));
      result.redis.status = 'measured';
    } catch { result.redis.status = 'unavailable'; }
  }
}
result.finishedAt = new Date().toISOString();
result.totalDecodedResponseBytes = totalBytes;
const report = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, report, { mode: 0o600 });
console.log(report);
