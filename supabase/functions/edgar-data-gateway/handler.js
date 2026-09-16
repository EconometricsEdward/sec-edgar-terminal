/** Narrow workload gateway. Supabase credentials never leave this function. */
import { APPROVED_SEC_CIKS, SUPPORTING_SOURCE_CIKS } from './coverage.js';
import { DISPOSABLE_CACHE_LIMITS as CACHE_LIMITS, disposableCachePolicy, disposableCacheFencePolicy, disposableCacheFenceResource } from './cachePolicy.js';
import { DISCLOSURE_INDEX_LIMITS, disclosureIndexIdentity, validDisclosureIndexDocument, validDisclosureIndexSearch } from './disclosurePolicy.js';
export const TRUST = Object.freeze({
  issuer: 'https://oidc.vercel.com/econometricsedwards-projects',
  audience: 'https://vercel.com/econometricsedwards-projects',
  subject: 'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:production',
  owner: 'econometricsedwards-projects',
  ownerId: 'team_EEZpsSbH41QqVl83n2OJmLob',
  project: 'sec-edgar-terminal',
  projectId: 'prj_tjTGC2omKa1JOT7il31bFZ8ilk8f',
});
const PROJECT_URL = 'https://vvkihuduqqnxqahhbphs.supabase.co';
// Supabase's hosted relay removes /functions/v1 before invoking the handler.
// Support its exact function prefix and the full local HTTP URL, never an
// arbitrary suffix or an attacker-selected function name.
const PREFIXES = Object.freeze(['/edgar-data-gateway', '/functions/v1/edgar-data-gateway']);
const BUCKET = 'edgar-durable-private';
const NAMESPACE = 'production';
const RPC_BYTES = 512 * 1024;
const OBJECT_BYTES = 6 * 1024 * 1024;
const DECODED_BYTES = 24 * 1024 * 1024;
const META_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APPROVED = new Set(APPROVED_SEC_CIKS);
const SOURCE_ONLY = new Set(SUPPORTING_SOURCE_CIKS);
const CIK = /^(?!0000000000)[0-9]{10}$/;
// These patterns validate structure only. Unknown CIKs require a separate,
// private membership admission lookup after all parameters and JWT are valid.
const SEC_KEY = /^sec-documents-v1:CIK((?!0000000000)[0-9]{10}):(?:submissions|companyfacts)$/;
const FINANCIAL_KEY = /^financial-analysis-v1:analysis-v1\.4:context-v3:CIK((?!0000000000)[0-9]{10}):(?:annual|quarter|ytd|ttm):latest$/;
const COMPARE_KEY = /^research-compare-v1:compare-v2:context-v3:CIK((?!0000000000)[0-9]{10}):(?:annual|quarter|ttm):latest$/;
const PORTFOLIO_KEY = /^research-portfolio-v1:analysis-v1\.4:context-v3:CIK((?!0000000000)[0-9]{10}):(?:annual|quarter|ytd|ttm):latest$/;
const COMPANY_KEY = /^research-company-v1:CIK((?!0000000000)[0-9]{10})$/;
const MEMBERSHIP_ID = /^sec-coverage-v1:ivv:(\d{4}-\d{2}-\d{2}):[a-f0-9]{16}$/;
const MEMBERSHIP_SOURCE = 'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv';
const MEMBERSHIP_MAPPING_SOURCE = 'https://www.sec.gov/files/company_tickers.json';
const MEMBERSHIP_SECTORS = new Set(['Information Technology', 'Financials', 'Health Care', 'Consumer Discretionary', 'Communication', 'Industrials', 'Consumer Staples', 'Energy', 'Utilities', 'Real Estate', 'Materials']);
const GROUPS = Object.freeze({
  tff: ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables'],
  disaggregated: ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'],
});

// Unknown parameters are rejected rather than accidentally reaching a new SQL
// overload or a future operation with wider privileges.
export const RPC_PARAMETERS = Object.freeze({
  edgar_disclosure_document: ['p_cik', 'p_accession', 'p_primary_doc', 'p_parser_version'],
  edgar_disclosure_replace: ['p_document', 'p_passages'],
  edgar_disclosure_search: ['p_terms', 'p_start', 'p_end', 'p_forms', 'p_ciks', 'p_tickers', 'p_section', 'p_offset', 'p_limit', 'p_parser_version'],
  edgar_begin_write: ['p_dataset', 'p_key', 'p_owner', 'p_lease_seconds'],
  edgar_get_version: ['p_dataset', 'p_key', 'p_identity', 'p_pointer'],
  edgar_get_manifests: ['p_dataset', 'p_keys'],
  edgar_get_compact_batch: ['p_dataset', 'p_keys'],
  edgar_publish: ['p_dataset', 'p_key', 'p_claim', 'p_record', 'p_promote_good'],
  edgar_revalidate: ['p_dataset', 'p_key', 'p_claim', 'p_metadata'],
  edgar_release_write: ['p_dataset', 'p_key', 'p_claim'],
  edgar_enqueue_job: ['p_dataset', 'p_key', 'p_job_key', 'p_checkpoint', 'p_max_attempts'],
  edgar_enqueue_coverage_jobs: ['p_cycle', 'p_version', 'p_shards'],
  edgar_coverage_registry: [],
  edgar_begin_membership_check: ['p_owner'],
  edgar_stage_membership: ['p_claim', 'p_snapshot', 'p_evidence'],
  edgar_activate_membership: ['p_claim', 'p_id'],
  edgar_finish_membership_check: ['p_claim', 'p_error'],
  edgar_enqueue_current_coverage_jobs: ['p_cycle', 'p_shards'],
  edgar_coverage_operations: ['p_hours'],
  edgar_capture_coverage_operations: [],
  edgar_acquire_sec_dispatch: ['p_owner'],
  edgar_release_sec_dispatch: ['p_owner', 'p_cooldown_ms'],
  edgar_publish_sec_cooldown: ['p_cooldown_ms'],
  edgar_cache_get: ['p_family', 'p_type', 'p_ids'],
  edgar_cache_put: ['p_family', 'p_type', 'p_id', 'p_gzip_base64', 'p_raw_sha256', 'p_gzip_sha256', 'p_raw_bytes', 'p_ttl_seconds', 'p_if_hash', 'p_expires_at'],
  edgar_cache_status: [],
  edgar_cftc_history_status: [],
  edgar_cache_maintenance: ['p_action', 'p_owner', 'p_state'],
  edgar_reserve_cache_generation: ['p_dataset', 'p_key', 'p_claim'],
  edgar_cache_put_fenced: ['p_dataset', 'p_key', 'p_claim', 'p_family', 'p_type', 'p_id', 'p_gzip_base64', 'p_raw_sha256', 'p_gzip_sha256', 'p_raw_bytes', 'p_ttl_seconds', 'p_if_hash', 'p_expires_at'],
  edgar_authorize_coverage_schedule: ['p_timestamp', 'p_nonce', 'p_signature'],
  edgar_claim_job: ['p_dataset', 'p_owner', 'p_lease_seconds', 'p_job_key'],
  edgar_claim_job_prefix: ['p_dataset', 'p_owner', 'p_lease_seconds', 'p_prefix'],
  edgar_finish_job: ['p_claim', 'p_status', 'p_checkpoint', 'p_error', 'p_delay_seconds'],
  edgar_yield_job: ['p_claim', 'p_checkpoint', 'p_delay_seconds'],
  edgar_checkpoint_job: ['p_claim', 'p_checkpoint', 'p_lease_seconds'],
  edgar_store_status: [],
  edgar_coverage_status: [],
  edgar_read_financial_metrics: ['p_version'],
  edgar_export_manifests: ['p_after', 'p_limit'],
  edgar_retention_dry_run: ['p_before', 'p_limit'],
  edgar_orphan_dry_run: ['p_before', 'p_limit'],
});

class GatewayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function reject(code = 'invalid_request', status = 422) { throw new GatewayError(status, code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertObject(value) { if (!object(value)) reject(); }
function knownKeys(value, allowed) {
  assertObject(value);
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject();
}
function has(value, key) { return Object.hasOwn(value, key); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function timestamp(value, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) reject();
}
function date(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validKey(dataset, key, job = false) {
  if (typeof key !== 'string' || key.length > 512) return false;
  if (job) return (dataset === 'sec' && (key === 'financial-cohort-v1' || /^sec-coverage-v1:shard:(?:[0-2]\d|3[01])$/.test(key)))
    || (dataset === 'cftc' && (key === 'refresh:tff-disaggregated' || /^history-refresh:futures-only:(?:tff|disaggregated):shard:(?:[0-2]\d|3[01])$/.test(key)));
  if (dataset === 'sec') return SEC_KEY.test(key);
  if (dataset === 'financial') {
    if (key === 'research-market-overview-v1:latest') return true;
    const match = FINANCIAL_KEY.exec(key) || COMPARE_KEY.exec(key) || PORTFOLIO_KEY.exec(key) || COMPANY_KEY.exec(key);
    return !!match && !SOURCE_ONLY.has(match[1]);
  }
  if (dataset !== 'cftc') return false;
  const raw = /^raw-history-v1:futures-only:(tff|disaggregated):([A-Z0-9+]{3,12}):(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (raw) return date(raw[3]);
  const parts = key.split(':');
  if (!has(GROUPS, parts[1])) return false;
  if (parts[0] === 'markets' && parts.length === 3) return parts[2] === 'latest' || date(parts[2]);
  return parts[0] === 'history' && parts.length === 6 && /^[A-Z0-9+]{3,12}$/.test(parts[2])
    && GROUPS[parts[1]].includes(parts[3]) && date(parts[4]) && ['1y', '3y', '5y'].includes(parts[5]);
}
function jobKey(dataset, value) {
  if (typeof value !== 'string') return false;
  if (dataset === 'cftc') {
    const history = /^cftc-history-v1:(\d{4}-\d{2}-\d{2}):(tff|disaggregated):(?:[0-2]\d|3[01]):[a-f0-9]{16}$/.exec(value);
    if (history) return date(history[1]);
  }
  if (dataset === 'sec') {
    const coverage = /^sec-coverage-v1:(\d{4}-\d{2}-\d{2}):(?:[0-2]\d|3[01]):[a-zA-Z0-9_-]{1,64}$/.exec(value);
    if (coverage) return date(coverage[1]);
  }
  const prefix = dataset === 'sec' ? 'sec-financial-cohort-v1:' : dataset === 'cftc' ? 'cftc-refresh:' : null;
  return !!prefix && value.startsWith(prefix) && date(value.slice(prefix.length));
}
function claim(value, job = false) {
  knownKeys(value, job ? ['id', 'generation', 'owner'] : ['generation', 'owner']);
  if (!UUID.test(value.owner || '') || (job && !UUID.test(value.id || ''))) reject('invalid_claim');
  const n = value.generation;
  if (!(typeof n === 'string' && /^[1-9]\d{0,18}$/.test(n)) && !integer(n, 1, Number.MAX_SAFE_INTEGER)) reject('invalid_claim');
  if (BigInt(n) > 9223372036854775807n) reject('invalid_claim');
}
function metadata(value) {
  assertObject(value);
  if (encoder.encode(JSON.stringify(value)).byteLength > META_BYTES) reject('metadata_too_large', 413);
}
function objectPath(value, dataset, kind) {
  if (typeof value !== 'string') reject('invalid_object_path');
  const match = /^production\/(cftc|sec|financial)\/(source|snapshot)\/([a-f0-9]{64})\.json\.gz$/.exec(value);
  if (!match || (dataset && match[1] !== dataset) || (kind && match[2] !== kind)) reject('invalid_object_path');
  return match;
}
function sourceUrl(value, dataset) {
  if (typeof value !== 'string' || value.length > 4096) reject('invalid_source');
  let parsed; try { parsed = new URL(value); } catch { reject('invalid_source'); }
  const origins = dataset === 'cftc' ? ['https://publicreporting.cftc.gov', 'https://www.cftc.gov'] : ['https://data.sec.gov', 'https://www.sec.gov'];
  if (!origins.includes(parsed.origin) || parsed.username || parsed.password || parsed.hash) reject('invalid_source');
}
function asset(value, dataset, source = false) {
  if (objectPath(value.objectPath, dataset, source ? 'source' : null)[3] !== value.contentHash || !HASH.test(value.contentHash)) reject('invalid_object_path');
  if (!integer(value.rawBytes, 1, DECODED_BYTES) || !integer(value.storedBytes, 1, OBJECT_BYTES)) reject('invalid_object_size');
  if (source) {
    sourceUrl(value.url, dataset);
    timestamp(value.fetchedAt);
    if (has(value, 'publishedAt')) timestamp(value.publishedAt, true);
  }
}
function publishRecord(record, dataset) {
  knownKeys(record, ['identityHash', 'metadata', 'payload', 'objectPath', 'contentHash', 'rawBytes', 'storedBytes', 'schemaVersion', 'source', 'observations', 'url', 'fetchedAt', 'publishedAt', 'contentType']);
  if (!HASH.test(record.identityHash || '')) reject('invalid_identity');
  metadata(record.metadata);
  timestamp(record.metadata.fetchedAt);
  for (const key of ['publishedAt', 'expiresAt', 'revalidatedAt']) if (has(record.metadata, key)) timestamp(record.metadata[key], true);
  if (record.metadata.sourceUrl) sourceUrl(record.metadata.sourceUrl, dataset);
  // Existing immutable versions can be republished with fresh validation metadata.
  if (Object.keys(record).every((key) => ['identityHash', 'metadata'].includes(key))) return;
  if (record.schemaVersion !== '1' || !HASH.test(record.contentHash || '')) reject('invalid_record');
  if (record.objectPath != null) {
    asset(record, dataset);
    if (record.payload !== null) reject('invalid_record');
  } else {
    if (!has(record, 'payload') || record.payload === null || encoder.encode(JSON.stringify(record.payload)).byteLength > 64 * 1024) reject('invalid_compact_payload');
    if (!integer(record.rawBytes, 1, 64 * 1024) || !integer(record.storedBytes, 1, 64 * 1024)) reject('invalid_object_size');
  }
  if (record.source != null) {
    knownKeys(record.source, ['objectPath', 'contentHash', 'rawBytes', 'storedBytes', 'url', 'fetchedAt', 'publishedAt', 'contentType']);
    asset(record.source, dataset, true);
  }
  if (!Array.isArray(record.observations) || record.observations.length > 512 || (dataset !== 'financial' && record.observations.length)) reject('invalid_observations');
}
function membershipSnapshot(value, nowMs) {
  knownKeys(value, ['version', 'id', 'label', 'reference', 'sourceSnapshot', 'mapping', 'membershipFingerprint', 'issuerCount', 'securityCount', 'issuers', 'securities', 'sourceExclusions']);
  knownKeys(value.reference, ['fund', 'asOf', 'checkedAt', 'url', 'description']);
  knownKeys(value.sourceSnapshot, ['path', 'sha256']);
  knownKeys(value.mapping, ['sourceUrl', 'description', 'sourceSha256', 'checkedAt']);
  if (value.version !== 'sec-coverage-v1' || value.reference.fund !== 'IVV' || value.reference.url !== MEMBERSHIP_SOURCE
    || value.mapping.sourceUrl !== MEMBERSHIP_MAPPING_SOURCE || !HASH.test(value.membershipFingerprint || '')
    || !HASH.test(value.sourceSnapshot.sha256 || '') || !date(value.reference.asOf)) reject('invalid_membership');
  timestamp(value.reference.checkedAt);
  if (has(value.mapping, 'sourceSha256') || has(value.mapping, 'checkedAt')) {
    if (!HASH.test(value.mapping.sourceSha256 || '')) reject('invalid_membership');
    timestamp(value.mapping.checkedAt);
    if (Date.parse(value.mapping.checkedAt) > nowMs + 60000) reject('invalid_membership');
  }
  if (Date.parse(value.reference.asOf) > Date.parse(value.reference.checkedAt)
    || Date.parse(value.reference.checkedAt) > nowMs + 60000
    || value.id !== `sec-coverage-v1:ivv:${value.reference.asOf}:${value.membershipFingerprint.slice(0, 16)}`) reject('invalid_membership');
  for (const [text, max] of [[value.label, 300], [value.reference.description, 2000], [value.mapping.description, 2000]]) {
    if (text !== undefined && (typeof text !== 'string' || text.length > max)) reject('invalid_membership');
  }
  if (typeof value.sourceSnapshot.path !== 'string' || !value.sourceSnapshot.path.length || value.sourceSnapshot.path.length > 1024
    || !Array.isArray(value.issuers) || !integer(value.issuers.length, 475, 525) || value.issuerCount !== value.issuers.length
    || !Array.isArray(value.securities) || !integer(value.securities.length, 475, 550) || value.securityCount !== value.securities.length) reject('invalid_membership');
  const ciks = new Set(), aliases = new Map();
  const tickerPattern = /^[A-Z][A-Z0-9-]{0,9}$/;
  for (const row of value.issuers) {
    knownKeys(row, ['cik', 'ticker', 'name', 'sector', 'fund', 'aliases']);
    if (typeof row.cik !== 'string' || !CIK.test(row.cik) || ciks.has(row.cik)
      || typeof row.ticker !== 'string' || !tickerPattern.test(row.ticker) || row.fund !== 'IVV'
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300 || !MEMBERSHIP_SECTORS.has(row.sector)
      || !Array.isArray(row.aliases) || !integer(row.aliases.length, 1, 10) || !row.aliases.includes(row.ticker)) reject('invalid_membership');
    ciks.add(row.cik);
    for (const ticker of row.aliases) {
      if (typeof ticker !== 'string' || !tickerPattern.test(ticker) || aliases.has(ticker)) reject('invalid_membership');
      aliases.set(ticker, row.cik);
    }
  }
  const observed = new Set();
  for (const row of value.securities) {
    knownKeys(row, ['ticker', 'cik']);
    if (typeof row.ticker !== 'string' || aliases.get(row.ticker) !== row.cik || observed.has(row.ticker)) reject('invalid_membership');
    observed.add(row.ticker);
  }
  if (aliases.size !== value.securities.length) reject('invalid_membership');
  if (has(value, 'sourceExclusions')) {
    if (!Array.isArray(value.sourceExclusions) || value.sourceExclusions.length > 25) reject('invalid_membership');
    const excluded = new Set(); let total = 0;
    for (const row of value.sourceExclusions) {
      knownKeys(row, ['ticker', 'name', 'exchange', 'currency', 'marketValueUsd', 'weightPercent', 'reason']);
      if (typeof row.ticker !== 'string' || !tickerPattern.test(row.ticker) || aliases.has(row.ticker) || excluded.has(row.ticker)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 300
        || typeof row.exchange !== 'string' || row.exchange.length > 100 || !/^NO MARKET(?:\s|$)/i.test(row.exchange)
        || row.currency !== 'USD' || !Number.isFinite(row.marketValueUsd) || row.marketValueUsd < 0 || row.marketValueUsd > 100000
        || row.weightPercent !== 0 || row.reason !== 'Unlisted residual holding, excluded from listed-security research coverage.') reject('invalid_membership');
      total += row.marketValueUsd; excluded.add(row.ticker);
    }
    if (total > 100000) reject('invalid_membership');
  }
}
function membershipEvidence(value, snapshot) {
  knownKeys(value, ['rawSha256', 'rawBytes', 'gzipSha256', 'gzipBase64']);
  if (!HASH.test(value.rawSha256 || '') || !HASH.test(value.gzipSha256 || '')
    || value.rawSha256 !== snapshot.sourceSnapshot.sha256 || !integer(value.rawBytes, 1, 750000)
    || typeof value.gzipBase64 !== 'string' || value.gzipBase64.length > 266668 || !value.gzipBase64.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.gzipBase64)) reject('invalid_membership_evidence');
}
function validateRpc(name, params, nowMs) {
  knownKeys(params, ['p_namespace', ...RPC_PARAMETERS[name]]);
  if (has(params, 'p_namespace') && params.p_namespace !== NAMESPACE) reject('namespace_denied', 403);
  if (name === 'edgar_disclosure_document' && (!disclosureIndexIdentity({ cik: params.p_cik, accession: params.p_accession, primaryDoc: params.p_primary_doc })
    || params.p_parser_version !== DISCLOSURE_INDEX_LIMITS.parserVersion)) reject('invalid_disclosure_identity');
  if (name === 'edgar_disclosure_replace' && !validDisclosureIndexDocument(params.p_document, params.p_passages, nowMs)) reject('invalid_disclosure_document');
  if (name === 'edgar_disclosure_search' && !validDisclosureIndexSearch(Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'p_namespace')
    .map(([key, value]) => [key === 'p_parser_version' ? 'parserVersion' : key.slice(2), value])))) reject('invalid_disclosure_search');
  if (RPC_PARAMETERS[name].includes('p_dataset')) {
    if (!['sec', 'cftc', 'financial'].includes(params.p_dataset)) reject('dataset_denied', 403);
    if (RPC_PARAMETERS[name].includes('p_key') && !validKey(params.p_dataset, params.p_key, name === 'edgar_enqueue_job')) reject('resource_denied', 403);
    if (RPC_PARAMETERS[name].includes('p_keys')) {
      const bound = name === 'edgar_get_manifests' ? 100 : 5;
      if (!Array.isArray(params.p_keys) || params.p_keys.length > bound || params.p_keys.some(key => !validKey(params.p_dataset, key))) reject('invalid_batch_keys', 403);
    }
  }
  if (RPC_PARAMETERS[name].includes('p_owner') && name !== 'edgar_cache_maintenance' && !UUID.test(params.p_owner || '')) reject('invalid_owner');
  if (RPC_PARAMETERS[name].includes('p_claim')) claim(params.p_claim, ['edgar_finish_job', 'edgar_checkpoint_job', 'edgar_yield_job'].includes(name));
  if (has(params, 'p_lease_seconds') && !integer(params.p_lease_seconds, 10, 900)) reject('invalid_lease');
  if (has(params, 'p_identity') && params.p_identity !== null && !HASH.test(params.p_identity)) reject('invalid_identity');
  if (has(params, 'p_pointer') && !['current', 'last-good', 'rollback'].includes(params.p_pointer)) reject('invalid_pointer');
  if (has(params, 'p_promote_good') && typeof params.p_promote_good !== 'boolean') reject();
  if (name === 'edgar_publish') publishRecord(params.p_record, params.p_dataset);
  if (name === 'edgar_revalidate') {
    knownKeys(params.p_metadata, ['revalidatedAt', 'expiresAt', 'etag', 'lastModified']);
    metadata(params.p_metadata); timestamp(params.p_metadata.revalidatedAt); timestamp(params.p_metadata.expiresAt, true);
  }
  if (['edgar_enqueue_job', 'edgar_claim_job', 'edgar_claim_job_prefix'].includes(name)) {
    if (!['sec', 'cftc'].includes(params.p_dataset)) reject('dataset_denied', 403);
    if ((name === 'edgar_enqueue_job' || params.p_job_key != null) && !jobKey(params.p_dataset, params.p_job_key)) reject('invalid_job_key');
  }
  if (name === 'edgar_claim_job_prefix' && !(params.p_dataset === 'sec' && ['sec-financial-cohort-v1:', 'sec-coverage-v1:'].includes(params.p_prefix)
    || params.p_dataset === 'cftc' && params.p_prefix === 'cftc-history-v1:')) reject('invalid_job_prefix', 403);
  if (name === 'edgar_enqueue_job' && params.p_dataset === 'cftc' && params.p_job_key.startsWith('cftc-history-v1:')) {
    const parts = params.p_job_key.split(':');
    if (params.p_key !== `history-refresh:futures-only:${parts[2]}:shard:${parts[3]}`) reject('invalid_job_resource', 403);
  }
  if (name === 'edgar_enqueue_job' && params.p_dataset === 'cftc' && !params.p_job_key.startsWith('cftc-history-v1:')
    && params.p_key !== 'refresh:tff-disaggregated') reject('invalid_job_resource', 403);
  if (name === 'edgar_enqueue_coverage_jobs' || name === 'edgar_enqueue_current_coverage_jobs') {
    if (!date(params.p_cycle) || (name === 'edgar_enqueue_coverage_jobs' && (typeof params.p_version !== 'string' || !/^[a-f0-9]{16}$/.test(params.p_version)))) reject('invalid_coverage_cycle');
    if (params.p_shards != null && (!Array.isArray(params.p_shards) || params.p_shards.length < 1 || params.p_shards.length > 32
      || new Set(params.p_shards).size !== params.p_shards.length || params.p_shards.some(shard => !integer(shard,0,31)))) reject('invalid_coverage_shards');
  }
  if (name === 'edgar_stage_membership') { membershipSnapshot(params.p_snapshot, nowMs); membershipEvidence(params.p_evidence, params.p_snapshot); }
  if (name === 'edgar_activate_membership') {
    const match = typeof params.p_id === 'string' && MEMBERSHIP_ID.exec(params.p_id);
    if (!match || !date(match[1])) reject('invalid_membership');
  }
  if (name === 'edgar_coverage_operations' && has(params, 'p_hours') && !integer(params.p_hours, 1, 168)) reject('invalid_hours');
  if (name === 'edgar_release_sec_dispatch' && has(params, 'p_cooldown_ms') && !integer(params.p_cooldown_ms, 0, 300000)) reject('invalid_sec_cooldown');
  if (name === 'edgar_publish_sec_cooldown' && !integer(params.p_cooldown_ms, 1, 300000)) reject('invalid_sec_cooldown');
  if (name === 'edgar_reserve_cache_generation' && !disposableCacheFenceResource(params.p_dataset, params.p_key)) reject('cache_fence_denied', 403);
  if (name === 'edgar_cache_put_fenced') {
    const binding = disposableCacheFencePolicy(params.p_type, params.p_key, params.p_id);
    if (!binding || binding.dataset !== params.p_dataset) reject('cache_fence_denied', 403);
    if (params.p_key.startsWith('raw-history-v1:') && params.p_family !== 'cftc-history') reject('cache_fence_denied', 403);
  }
  if (['edgar_cache_get', 'edgar_cache_put', 'edgar_cache_put_fenced'].includes(name)) {
    const ids = name === 'edgar_cache_get' ? params.p_ids : [params.p_id];
    if (!Array.isArray(ids) || !integer(ids.length, 1, CACHE_LIMITS.batch)) reject('invalid_cache_batch');
    let policy;
    for (const id of ids) {
      policy = disposableCachePolicy(params.p_type, id);
      // Old production functions can drain after this gateway deploy. Retained
      // raw/history IDs keep their prior bounded family until those callers end.
      const legacyCftcFamily = policy?.family === 'cftc-history' && params.p_family === 'history'
        && params.p_type === 'edgar.cftc-positioning.v1:production';
      if (!policy || policy.id !== id || policy.family !== params.p_family && !legacyCftcFamily) reject('cache_resource_denied', 403);
    }
    if (name !== 'edgar_cache_get') {
      if (has(params, 'p_expires_at')) timestamp(params.p_expires_at, true);
      if (!HASH.test(params.p_raw_sha256 || '') || !HASH.test(params.p_gzip_sha256 || '')
        || !integer(params.p_raw_bytes, 1, Math.min(CACHE_LIMITS.rawBytes, policy.maxRawBytes ?? Infinity)) || !integer(params.p_ttl_seconds, 1, policy.maxTtlSeconds)
        || typeof params.p_gzip_base64 !== 'string' || !params.p_gzip_base64.length
        || params.p_gzip_base64.length > Math.ceil(CACHE_LIMITS.gzipBytes / 3) * 4
        || params.p_gzip_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.p_gzip_base64)
        || params.p_if_hash != null && params.p_if_hash !== 'absent' && !HASH.test(params.p_if_hash)) reject('invalid_cache_record');
    }
  }
  if (name === 'edgar_cache_maintenance') {
    if (!['read', 'claim', 'save'].includes(params.p_action)) reject('invalid_cache_action');
    if (params.p_action === 'read' && (params.p_owner != null || params.p_state != null)
      || params.p_action === 'claim' && (params.p_state != null || !UUID.test(params.p_owner || ''))
      || params.p_action === 'save' && (!UUID.test(params.p_owner || '') || !object(params.p_state))) reject('invalid_cache_state');
    if (params.p_state != null && encoder.encode(JSON.stringify(params.p_state)).byteLength > CACHE_LIMITS.stateBytes) reject('cache_state_too_large', 413);
  }
  if (name === 'edgar_authorize_coverage_schedule') {
    if (!integer(params.p_timestamp,1000000000,9999999999)
      || typeof params.p_nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(params.p_nonce)
      || typeof params.p_signature !== 'string' || !HASH.test(params.p_signature)) reject('invalid_schedule_signature');
  }
  if (has(params, 'p_max_attempts') && !integer(params.p_max_attempts, 1, 10)) reject();
  if (['edgar_finish_job', 'edgar_checkpoint_job', 'edgar_yield_job'].includes(name) || has(params, 'p_checkpoint')) {
    metadata(params.p_checkpoint);
    if (encoder.encode(JSON.stringify(params.p_checkpoint)).byteLength > 16384) reject('checkpoint_too_large', 413);
  }
  if (name === 'edgar_finish_job' && !['done', 'retry', 'dead'].includes(params.p_status)) reject('invalid_job_status');
  if (has(params, 'p_error') && params.p_error !== null && (typeof params.p_error !== 'string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(params.p_error))) reject();
  if (name === 'edgar_finish_membership_check' && params.p_error != null && !/^[A-Za-z0-9_]{1,100}$/.test(params.p_error)) reject();
  if (has(params, 'p_delay_seconds') && !integer(params.p_delay_seconds, 0, 2147483647)) reject();
  if (name === 'edgar_yield_job' && has(params, 'p_delay_seconds') && !integer(params.p_delay_seconds, 1, 86400)) reject('invalid_yield_delay');
  if (name === 'edgar_read_financial_metrics' && !UUID.test(params.p_version || '')) reject();
  if (has(params, 'p_after') && params.p_after !== null && !UUID.test(params.p_after)) reject();
  if (has(params, 'p_limit') && !integer(params.p_limit, 1, name === 'edgar_disclosure_search' ? DISCLOSURE_INDEX_LIMITS.candidateLimit : 100)) reject('invalid_limit');
  if (name === 'edgar_retention_dry_run' || name === 'edgar_orphan_dry_run') timestamp(params.p_before);
  return { ...params, p_namespace: NAMESPACE };
}

export function assertProductionClaims(payload, nowMs = Date.now()) {
  if (!object(payload) || payload.iss !== TRUST.issuer || payload.aud !== TRUST.audience || payload.sub !== TRUST.subject
    || payload.owner !== TRUST.owner || payload.owner_id !== TRUST.ownerId || payload.project !== TRUST.project
    || payload.project_id !== TRUST.projectId || payload.environment !== 'production') reject('unauthorized', 401);
  const now = nowMs / 1000;
  if (!integer(payload.iat, 0, Number.MAX_SAFE_INTEGER) || !integer(payload.exp, 0, Number.MAX_SAFE_INTEGER)
    || payload.iat > now + 5 || payload.exp <= now - 5 || payload.exp <= payload.iat
    || payload.exp - payload.iat > 7200 + 5 || now - payload.iat > 7200 + 5
    || (has(payload, 'nbf') && (!integer(payload.nbf, 0, Number.MAX_SAFE_INTEGER) || payload.nbf > now + 5))) reject('unauthorized', 401);
}
export function createJwtVerifier(jwtVerify, jwks) {
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['RS256'], issuer: TRUST.issuer, audience: TRUST.audience,
      subject: TRUST.subject, requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
      clockTolerance: 5, maxTokenAge: '2h',
    });
    return payload;
  };
}
function configuration(env) {
  if (env('SUPABASE_URL')?.replace(/\/$/, '') !== PROJECT_URL) reject('gateway_unavailable', 503);
  let secret = env('SUPABASE_SERVICE_ROLE_KEY');
  const keys = env('SUPABASE_SECRET_KEYS');
  if (keys) { try { secret = JSON.parse(keys).default || secret; } catch { reject('gateway_unavailable', 503); } }
  if (typeof secret !== 'string' || secret.length < 20 || secret.length > 4096 || /[\r\n]/.test(secret)) reject('gateway_unavailable', 503);
  return secret;
}
function result(body, status = 200, contentType = 'application/json') {
  return new Response(body, { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function json(value, status = 200) { return result(JSON.stringify(value), status); }
async function boundedBytes(message, limit, signal) {
  const length = message.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) reject('body_too_large', 413);
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks = []; let total = 0;
  let onAbort;
  const aborted = new Promise((_, fail) => { onAbort = () => { fail(new GatewayError(504, 'gateway_timeout')); reader.cancel().catch(() => {}); }; signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    if (signal.aborted) throw new GatewayError(504, 'gateway_timeout');
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) reject('body_too_large', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function verifyMembershipEvidence(params, signal) {
  const evidence = params.p_evidence;
  let compressed;
  try { compressed = Uint8Array.from(atob(evidence.gzipBase64), value => value.charCodeAt(0)); } catch { reject('invalid_membership_evidence'); }
  if (compressed.byteLength < 3 || compressed.byteLength > 200000 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8
    || await sha256(compressed) !== evidence.gzipSha256) reject('invalid_membership_evidence');
  let raw;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    raw = await boundedBytes(new Response(stream), 750000, signal);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    reject('invalid_membership_evidence');
  }
  if (raw.byteLength !== evidence.rawBytes || await sha256(raw) !== evidence.rawSha256) reject('invalid_membership_evidence');
  const issuerIdentity = params.p_snapshot.issuers.map(row => [row.cik, row.ticker, row.name, row.sector, row.fund, [...row.aliases].sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (await sha256(encoder.encode(JSON.stringify(issuerIdentity))) !== params.p_snapshot.membershipFingerprint) reject('invalid_membership');
}
async function verifyCachePayload(params, signal) {
  let compressed;
  try { compressed = Uint8Array.from(atob(params.p_gzip_base64), value => value.charCodeAt(0)); }
  catch { reject('invalid_cache_record'); }
  if (compressed.byteLength < 3 || compressed.byteLength > CACHE_LIMITS.gzipBytes
    || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8
    || await sha256(compressed) !== params.p_gzip_sha256) reject('invalid_cache_record');
  let raw;
  try { raw = await boundedBytes(new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))), CACHE_LIMITS.rawBytes, signal); }
  catch (error) { if (error instanceof GatewayError) throw error; reject('invalid_cache_record'); }
  if (raw.byteLength !== params.p_raw_bytes || await sha256(raw) !== params.p_raw_sha256) reject('invalid_cache_record');
  let payload; try { payload = JSON.parse(decoder.decode(raw)); } catch { reject('invalid_cache_json'); }
  const policy = disposableCachePolicy(params.p_type, params.p_id);
  if (policy.sourceCik && String(payload?.cik || '').padStart(10, '0') !== policy.sourceCik) reject('cache_source_identity_mismatch');
}
function serviceHeaders(secret) {
  const headers = { apikey: secret, 'Accept-Encoding': 'identity' };
  if (!secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secret}`;
  return headers;
}
async function admitMembership(params, { fetchImpl, secret, signal }) {
  if (!['sec', 'financial'].includes(params.p_dataset)) return;
  const keys = has(params, 'p_keys') ? params.p_keys : [params.p_key];
  const unknown = new Set();
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    const match = SEC_KEY.exec(key) || FINANCIAL_KEY.exec(key) || COMPARE_KEY.exec(key) || PORTFOLIO_KEY.exec(key) || COMPANY_KEY.exec(key);
    if (match && !APPROVED.has(match[1]) && !(params.p_dataset === 'sec' && SOURCE_ONLY.has(match[1]))) unknown.add(match[1]);
  }
  if (!unknown.size) return;
  const upstream = await fetchImpl(`${PROJECT_URL}/rest/v1/rpc/edgar_membership_admission`, {
    method: 'POST', headers: { ...serviceHeaders(secret), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_namespace: NAMESPACE, p_ciks: [...unknown] }), redirect: 'error', signal, cache: 'no-store',
  });
  if (!upstream.ok) { await upstream.body?.cancel().catch(() => {}); reject('membership_unavailable', 503); }
  let admission;
  try { admission = JSON.parse(decoder.decode(await boundedBytes(upstream, 8192, signal))); }
  catch (error) { if (signal.aborted) throw error; reject('membership_unavailable', 503); }
  if (!object(admission) || Object.keys(admission).some(key => !['allowedCiks', 'sourceOnlyCiks'].includes(key))
    || !['allowedCiks', 'sourceOnlyCiks'].every(key => Array.isArray(admission[key]) && admission[key].length <= unknown.size
      && new Set(admission[key]).size === admission[key].length && admission[key].every(cik => typeof cik === 'string' && CIK.test(cik) && unknown.has(cik)))) reject('membership_unavailable', 503);
  const allowed = new Set(admission.allowedCiks), sourceOnly = new Set(admission.sourceOnlyCiks);
  if ([...unknown].some(cik => params.p_dataset === 'sec' ? !allowed.has(cik) && !sourceOnly.has(cik) : !allowed.has(cik) || sourceOnly.has(cik))) reject('resource_denied', 403);
}

/** @param {string} _name @returns {string | undefined} */
function defaultEnvironment(_name) { return undefined; }

/** @param {{ verifyToken?: (token: string) => Promise<object>, fetchImpl?: typeof fetch, env?: (name: string) => string | undefined, now?: () => number, timeoutMs?: number }} options */
export function createGateway({ verifyToken, fetchImpl = fetch, env = defaultEnvironment, now = Date.now, timeoutMs = 5500 } = {}) {
  if (typeof verifyToken !== 'function') throw new Error('A cryptographic token verifier is required');
  return async function gateway(request) {
    let timer;
    try {
      const authorization = request.headers.get('authorization') || '';
      if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 12288) reject('unauthorized', 401);
      try { assertProductionClaims(await verifyToken(authorization.slice(7)), now()); } catch { reject('unauthorized', 401); }
      // No body parsing, configuration access, or data access before verification.
      const url = new URL(request.url);
      const prefix = PREFIXES.find((candidate) => url.pathname.startsWith(`${candidate}/`));
      if (url.search || url.hash || !prefix || url.pathname.includes('%')) reject('route_denied', 403);
      const path = url.pathname.slice(prefix.length);
      const secret = configuration(env);
      if (path === '/health' && request.method === 'GET') return json({ ok: true, auth: 'vercel-oidc', environment: 'production', namespace: NAMESPACE, operations: 'bounded-data-store' });
      if (request.headers.has('content-encoding') || request.headers.has('x-upsert')) reject('unsupported_headers', 400);
      const controller = new AbortController();
      let targetPath, body, raw = false;
      const rpcMatch = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
      // Evidence verification is the only larger operation. Ordinary reads keep
      // their original timeout, and injected shorter test/operator limits win.
      const secDispatchOperation = ['edgar_acquire_sec_dispatch', 'edgar_release_sec_dispatch', 'edgar_publish_sec_cooldown'].includes(rpcMatch?.[1]);
      const cacheDataOperation = ['edgar_cache_get', 'edgar_cache_put', 'edgar_cache_put_fenced'].includes(rpcMatch?.[1]);
      const operationTimeout = secDispatchOperation ? Math.min(timeoutMs, 1500)
        : rpcMatch?.[1] === 'edgar_stage_membership' && timeoutMs === 5500 ? 15000
          : cacheDataOperation && timeoutMs === 5500 ? 9000 : timeoutMs;
      timer = setTimeout(() => controller.abort(), operationTimeout);
      if (rpcMatch && has(RPC_PARAMETERS, rpcMatch[1])) {
        if (request.method !== 'POST') reject('method_denied', 405);
        if (request.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json') reject('content_type_denied', 415);
        const bytes = await boundedBytes(request, cacheDataOperation ? CACHE_LIMITS.rpcBytes : RPC_BYTES, controller.signal);
        let parsed; try { parsed = JSON.parse(decoder.decode(bytes)); } catch { reject('invalid_json', 400); }
        const params = validateRpc(rpcMatch[1], parsed, now());
        if (rpcMatch[1] === 'edgar_stage_membership') await verifyMembershipEvidence(params, controller.signal);
        if (['edgar_cache_put', 'edgar_cache_put_fenced'].includes(rpcMatch[1])) await verifyCachePayload(params, controller.signal);
        await admitMembership(params, { fetchImpl, secret, signal: controller.signal });
        body = JSON.stringify(params);
        targetPath = `/rest/v1/rpc/${rpcMatch[1]}`;
      } else {
        const downloadPrefix = `/storage/v1/object/authenticated/${BUCKET}/`;
        const uploadPrefix = `/storage/v1/object/${BUCKET}/`;
        const download = path.startsWith(downloadPrefix);
        if (!download && !path.startsWith(uploadPrefix)) reject('route_denied', 403);
        const reference = path.slice((download ? downloadPrefix : uploadPrefix).length);
        objectPath(reference);
        if (request.method !== (download ? 'GET' : 'POST')) reject('method_denied', 405);
        if (!download) {
          if (request.headers.get('content-type') !== 'application/gzip') reject('content_type_denied', 415);
          body = await boundedBytes(request, OBJECT_BYTES, controller.signal);
          if (body.length < 3 || body[0] !== 0x1f || body[1] !== 0x8b || body[2] !== 8) reject('invalid_gzip', 422);
        }
        targetPath = `${download ? downloadPrefix : uploadPrefix}${reference}`;
        raw = download;
      }
      const headers = serviceHeaders(secret);
      if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'application/json' : 'application/gzip';
      const upstream = await fetchImpl(`${PROJECT_URL}${targetPath}`, { method: request.method, headers, body, redirect: 'error', signal: controller.signal, cache: 'no-store' });
      if (!upstream.ok) {
        // Preserve the SQL fencing marker used by the adapter; all other
        // upstream messages are discarded so credentials cannot reach callers.
        let code, cacheOverflow = false;
        try {
          const error = JSON.parse(decoder.decode(await boundedBytes(upstream, RPC_BYTES, controller.signal)));
          code = error.code;
          cacheOverflow = rpcMatch?.[1] === 'edgar_cache_get' && error.code === '22023' && error.message === 'cache_response_too_large';
        } catch { /* sanitized below */ }
        const status = integer(upstream.status, 400, 599) ? upstream.status : 502;
        return json({ code: cacheOverflow ? 'cache_response_too_large' : code === '40001' ? '40001' : 'upstream_failure' }, status);
      }
      const bytes = await boundedBytes(upstream, raw ? OBJECT_BYTES : cacheDataOperation ? CACHE_LIMITS.rpcBytes : RPC_BYTES, controller.signal);
      return result(bytes, upstream.status, raw ? 'application/gzip' : 'application/json');
    } catch (error) {
      if (error instanceof GatewayError) return json({ code: error.code }, error.status);
      return json({ code: error?.name === 'AbortError' ? 'gateway_timeout' : 'gateway_unavailable' }, error?.name === 'AbortError' ? 504 : 503);
    } finally { if (timer) clearTimeout(timer); }
  };
}
