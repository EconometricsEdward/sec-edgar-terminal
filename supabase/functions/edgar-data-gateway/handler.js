/** Narrow workload gateway. Supabase credentials never leave this function. */
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
const CIKS = '(?:0000320193|0000789019|0000019617|0000002098)';
const SEC_KEY = new RegExp(`^sec-documents-v1:CIK${CIKS}:(?:submissions|companyfacts)$`);
const FINANCIAL_KEY = new RegExp(`^financial-analysis-v1:analysis-v1\\.4:context-v3:CIK${CIKS}:(?:annual|quarter|ytd|ttm):latest$`);
const GROUPS = Object.freeze({
  tff: ['dealer', 'asset-manager', 'leveraged-funds', 'other-reportables', 'non-reportables'],
  disaggregated: ['producer-merchant', 'swap-dealers', 'managed-money', 'other-reportables', 'non-reportables'],
});

// Unknown parameters are rejected rather than accidentally reaching a new SQL
// overload or a future operation with wider privileges.
export const RPC_PARAMETERS = Object.freeze({
  edgar_begin_write: ['p_dataset', 'p_key', 'p_owner', 'p_lease_seconds'],
  edgar_get_version: ['p_dataset', 'p_key', 'p_identity', 'p_pointer'],
  edgar_publish: ['p_dataset', 'p_key', 'p_claim', 'p_record', 'p_promote_good'],
  edgar_revalidate: ['p_dataset', 'p_key', 'p_claim', 'p_metadata'],
  edgar_release_write: ['p_dataset', 'p_key', 'p_claim'],
  edgar_enqueue_job: ['p_dataset', 'p_key', 'p_job_key', 'p_checkpoint', 'p_max_attempts'],
  edgar_claim_job: ['p_dataset', 'p_owner', 'p_lease_seconds', 'p_job_key'],
  edgar_finish_job: ['p_claim', 'p_status', 'p_checkpoint', 'p_error', 'p_delay_seconds'],
  edgar_checkpoint_job: ['p_claim', 'p_checkpoint', 'p_lease_seconds'],
  edgar_store_status: [],
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
  if (job) return (dataset === 'sec' && key === 'financial-cohort-v1') || (dataset === 'cftc' && key === 'refresh:tff-disaggregated');
  if (dataset === 'sec') return SEC_KEY.test(key);
  if (dataset === 'financial') return FINANCIAL_KEY.test(key);
  if (dataset !== 'cftc') return false;
  const parts = key.split(':');
  if (!has(GROUPS, parts[1])) return false;
  if (parts[0] === 'markets' && parts.length === 3) return parts[2] === 'latest' || date(parts[2]);
  return parts[0] === 'history' && parts.length === 6 && /^[A-Z0-9]{6}$/.test(parts[2])
    && GROUPS[parts[1]].includes(parts[3]) && date(parts[4]) && ['1y', '3y', '5y'].includes(parts[5]);
}
function jobKey(dataset, value) {
  if (typeof value !== 'string') return false;
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
function validateRpc(name, params) {
  knownKeys(params, ['p_namespace', ...RPC_PARAMETERS[name]]);
  if (has(params, 'p_namespace') && params.p_namespace !== NAMESPACE) reject('namespace_denied', 403);
  if (RPC_PARAMETERS[name].includes('p_dataset')) {
    if (!['sec', 'cftc', 'financial'].includes(params.p_dataset)) reject('dataset_denied', 403);
    if (RPC_PARAMETERS[name].includes('p_key') && !validKey(params.p_dataset, params.p_key, name === 'edgar_enqueue_job')) reject('resource_denied', 403);
  }
  if (RPC_PARAMETERS[name].includes('p_owner') && !UUID.test(params.p_owner || '')) reject('invalid_owner');
  if (RPC_PARAMETERS[name].includes('p_claim')) claim(params.p_claim, ['edgar_finish_job', 'edgar_checkpoint_job'].includes(name));
  if (has(params, 'p_lease_seconds') && !integer(params.p_lease_seconds, 10, 900)) reject('invalid_lease');
  if (has(params, 'p_identity') && params.p_identity !== null && !HASH.test(params.p_identity)) reject('invalid_identity');
  if (has(params, 'p_pointer') && !['current', 'last-good', 'rollback'].includes(params.p_pointer)) reject('invalid_pointer');
  if (has(params, 'p_promote_good') && typeof params.p_promote_good !== 'boolean') reject();
  if (name === 'edgar_publish') publishRecord(params.p_record, params.p_dataset);
  if (name === 'edgar_revalidate') {
    knownKeys(params.p_metadata, ['revalidatedAt', 'expiresAt', 'etag', 'lastModified']);
    metadata(params.p_metadata); timestamp(params.p_metadata.revalidatedAt); timestamp(params.p_metadata.expiresAt, true);
  }
  if (['edgar_enqueue_job', 'edgar_claim_job'].includes(name)) {
    if (!['sec', 'cftc'].includes(params.p_dataset)) reject('dataset_denied', 403);
    if ((name === 'edgar_enqueue_job' || params.p_job_key != null) && !jobKey(params.p_dataset, params.p_job_key)) reject('invalid_job_key');
  }
  if (has(params, 'p_max_attempts') && !integer(params.p_max_attempts, 1, 10)) reject();
  if (['edgar_finish_job', 'edgar_checkpoint_job'].includes(name) || has(params, 'p_checkpoint')) metadata(params.p_checkpoint);
  if (name === 'edgar_finish_job' && !['done', 'retry', 'dead'].includes(params.p_status)) reject('invalid_job_status');
  if (has(params, 'p_error') && params.p_error !== null && (typeof params.p_error !== 'string' || !/^[A-Za-z0-9_:-]{1,100}$/.test(params.p_error))) reject();
  if (has(params, 'p_delay_seconds') && !integer(params.p_delay_seconds, 0, 2147483647)) reject();
  if (name === 'edgar_read_financial_metrics' && !UUID.test(params.p_version || '')) reject();
  if (has(params, 'p_after') && params.p_after !== null && !UUID.test(params.p_after)) reject();
  if (has(params, 'p_limit') && !integer(params.p_limit, 1, 100)) reject('invalid_limit');
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
      timer = setTimeout(() => controller.abort(), timeoutMs);
      let targetPath, body, raw = false;
      const rpcMatch = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path);
      if (rpcMatch && has(RPC_PARAMETERS, rpcMatch[1])) {
        if (request.method !== 'POST') reject('method_denied', 405);
        if (request.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json') reject('content_type_denied', 415);
        const bytes = await boundedBytes(request, RPC_BYTES, controller.signal);
        let parsed; try { parsed = JSON.parse(decoder.decode(bytes)); } catch { reject('invalid_json', 400); }
        body = JSON.stringify(validateRpc(rpcMatch[1], parsed));
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
      const headers = { apikey: secret, 'Accept-Encoding': 'identity' };
      if (!secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secret}`;
      if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'application/json' : 'application/gzip';
      const upstream = await fetchImpl(`${PROJECT_URL}${targetPath}`, { method: request.method, headers, body, redirect: 'error', signal: controller.signal, cache: 'no-store' });
      if (!upstream.ok) {
        // Preserve the SQL fencing marker used by the adapter; all other
        // upstream messages are discarded so credentials cannot reach callers.
        let code;
        try { code = JSON.parse(decoder.decode(await boundedBytes(upstream, RPC_BYTES, controller.signal))).code; } catch { /* sanitized below */ }
        const status = integer(upstream.status, 400, 599) ? upstream.status : 502;
        return json({ code: code === '40001' ? '40001' : 'upstream_failure' }, status);
      }
      const bytes = await boundedBytes(upstream, raw ? OBJECT_BYTES : RPC_BYTES, controller.signal);
      return result(bytes, upstream.status, raw ? 'application/gzip' : 'application/json');
    } catch (error) {
      if (error instanceof GatewayError) return json({ code: error.code }, error.status);
      return json({ code: error?.name === 'AbortError' ? 'gateway_timeout' : 'gateway_unavailable' }, error?.name === 'AbortError' ? 504 : 503);
    } finally { if (timer) clearTimeout(timer); }
  };
}
