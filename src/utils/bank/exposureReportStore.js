import { unstable_cache } from 'next/cache.js';
import { bankScopeStore, isBankScopeEnvironment } from './scopeStore.js';
import { BankDataError } from './errors.js';
import { SCOPE_MAPPING_VERSION } from './catalog.js';
import { parseCallXbrl } from './parser.js';
import { buildExposureReport } from './exposureModel.js';
import { EXPOSURE_VERSION } from './exposureDefinitions.js';

// Bump this parser/schema namespace when parsing or the cached shape changes.
const CACHE_VERSION = 'bankscope-exposure-report-v1';
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 48;
const LOCAL_TTL = 300000;
const segments = ['construction', 'cre', 'residential', 'commercial', 'consumer'];
const valueKeys = [
  'loan_total', 'loan_other', ...segments.flatMap(s => [`loan_${s}`, ...['past30', 'past90', 'nonaccrual'].map(k => `${s}_${k}`)]),
  'deposits', 'transaction', 'mmda', 'savings', 'time_small', 'time_large', 'uninsured', 'brokered', 'noninterest',
  ...[0, 1, 2, 3].flatMap(i => [`time_maturity_${i}`, `fhlb_${i}`]), 'fhlb_total',
  ...['htm', 'afs'].flatMap(p => ['cost', 'fair', 'gap'].map(k => `${p}_${k}`)),
  ...[0, 1, 2, 3, 4, 5].flatMap(i => [`securities_other_${i}`, `securities_pass_${i}`]), 'mbs_life_short', 'mbs_life_long',
];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const optionalString = (value, max) => value == null || string(value, max);
const number = value => value === null || typeof value === 'number' && Number.isFinite(value);
const code = value => typeof value === 'string' && /^(RCFD|RCON|RCFN)[A-Z0-9]{4}$/.test(value);
const only = (object, keys) => Object.keys(object).every(key => keys.includes(key));
const validMetadata = r => record(r) && r.validation?.passed === true && /^[1-9]\d{0,9}$/.test(String(r.id_rssd))
  && /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(r.report_date || '') && ['031', '041', '051'].includes(r.form_type)
  && /^[a-f0-9]{64}$/.test(r.source_sha256 || '');

/** Only the complete public derived shape is retained; raw XBRL and credentials are excluded. */
export function isExposureReport(report, metadata) {
  if (!validMetadata(metadata) || !record(report) || !only(report, ['period', 'rssd', 'form', 'hash', 'retrievedAt', 'submission', 'values', 'facts', 'mappingVersion'])
    || report.rssd !== Number(metadata.id_rssd) || report.period !== metadata.report_date || report.form !== metadata.form_type
    || report.hash !== metadata.source_sha256 || report.mappingVersion !== EXPOSURE_VERSION
    || !optionalString(report.retrievedAt, 100) || !optionalString(report.submission, 100)
    || !record(report.values) || !record(report.facts)) return false;
  const required = metadata.form_type === '031' ? [...valueKeys, 'foreign_deposits'] : valueKeys;
  if (Object.keys(report.values).length !== required.length || required.some(key => !Object.hasOwn(report.values, key))) return false;
  if (!Object.keys(report.facts).length || Object.keys(report.facts).length > 250) return false;
  for (const [key, f] of Object.entries(report.facts)) {
    if (!code(key) || !record(f) || !only(f, ['code', 'value', 'reason', 'rawValue', 'unit', 'contextRef', 'contextNote'])
      || f.code !== key || !number(f.value) || !optionalString(f.reason, 200) || f.value === null && !string(f.reason, 200)
      || !optionalString(f.rawValue, 200) || !optionalString(f.unit, 100) || !optionalString(f.contextRef, 200)
      || !optionalString(f.contextNote, 500)) return false;
  }
  for (const v of Object.values(report.values)) {
    if (!record(v) || !only(v, ['label', 'value', 'codes', 'reason', 'group', 'schedule', 'scope', 'formula'])
      || !string(v.label) || !number(v.value) || !optionalString(v.reason, 200) || v.value === null && !string(v.reason, 200)
      || !['credit', 'funding', 'securities'].includes(v.group) || !string(v.schedule) || !string(v.scope) || !optionalString(v.formula, 500)
      || !Array.isArray(v.codes) || !v.codes.length || v.codes.length > 30 || !v.codes.every(c => code(c) && Object.hasOwn(report.facts, c))) return false;
  }
  try { return Buffer.byteLength(JSON.stringify(report)) <= MAX_BYTES; } catch { return false; }
}

/** Immutable, source-hash-pinned report reuse across Vercel instances. */
export function createCachedExposureReport({ store = bankScopeStore, cache = unstable_cache, env = process.env, now = Date.now } = {}) {
  const local = new Map();
  return async metadata => {
    // Check before both local and shared hits, including environment changes.
    if (typeof window !== 'undefined' || !isBankScopeEnvironment(env)) throw new BankDataError('bank_service_unavailable');
    if (!validMetadata(metadata)) throw new BankDataError('database_failure');
    const parts = [CACHE_VERSION, env.VERCEL_ENV, env.VERCEL_GIT_COMMIT_REF || '', SCOPE_MAPPING_VERSION, EXPOSURE_VERSION,
      String(metadata.id_rssd), metadata.report_date, metadata.form_type, metadata.source_sha256];
    const key = parts.join(':');
    const hit = local.get(key);
    if (hit && hit.until > now()) return structuredClone(await hit.promise);
    if (local.size >= MAX_ENTRIES) local.delete(local.keys().next().value);
    const entry = { until: now() + LOCAL_TTL, promise: null };
    entry.promise = (async () => {
      let attempted = false, loaded;
      const load = async () => {
        attempted = true;
        const source = await store('source', { rssd: Number(metadata.id_rssd), period: metadata.report_date, hash: metadata.source_sha256 });
        if (!source?.validation?.passed || Number(source.rssd) !== Number(metadata.id_rssd) || source.reportDate !== metadata.report_date || source.sha256 !== metadata.source_sha256) throw new Error('Source unavailable');
        const parsed = parseCallXbrl(source.rawXbrl, { rssd: Number(metadata.id_rssd), reportDate: metadata.report_date });
        if (parsed.sha256 !== metadata.source_sha256) throw new Error('Source hash mismatch');
        const report = buildExposureReport(parsed, { form: metadata.form_type, retrievedAt: source.retrievedAt, submission: source.submission });
        if (!isExposureReport(report, metadata)) throw new BankDataError('database_failure');
        loaded = report;
        return report;
      };
      if (env.VERCEL_ENV !== 'production') return load();
      let report;
      try {
        // Source identity is immutable. New filings and parser/mapping versions get new keys.
        report = await cache(load, parts, { revalidate: 86400 })();
      } catch (error) {
        if (loaded) return loaded; // A cache-write failure must not discard a valid source read.
        if (attempted) throw error; // Do not immediately repeat a failed backend request.
        return load(); // Shared cache outage: one bounded normal read, with existing gateway timeout.
      }
      return isExposureReport(report, metadata) ? report : load();
    })().catch(error => { if (local.get(key) === entry) local.delete(key); throw error; });
    local.set(key, entry);
    return structuredClone(await entry.promise);
  };
}
