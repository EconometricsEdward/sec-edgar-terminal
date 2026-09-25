import { BankDataError } from './errors.js';

export const FFIEC_BASE = 'https://ffieccdr.azure-api.us/public/';
export const FFIEC_METHODS = new Set(['RetrieveReportingPeriods', 'RetrievePanelOfReporters', 'RetrieveFilersSubmissionDateTime', 'RetrieveFacsimile']);
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export async function limitedText(response, limit = MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) throw new BankDataError('response_too_large');
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new BankDataError('response_too_large'); chunks.push(Buffer.from(value)); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
export function quotaRetryAt(headers, body, now = Date.now()) {
  const retry = headers.get('retry-after'); let wait = 0;
  if (retry && /^\d+$/.test(retry)) wait = Number(retry) * 1000;
  else if (retry && Number.isFinite(Date.parse(retry))) wait = Math.max(0, Date.parse(retry) - now);
  const clock = /replenished in\s+(?:(\d+)\.)?(\d+):(\d+):(\d+)/i.exec(body);
  if (clock) wait = Math.max(wait, ((+clock[1] || 0) * 86400 + +clock[2] * 3600 + +clock[3] * 60 + +clock[4]) * 1000);
  const seconds = /replenished in\s+(\+)??(\d+)\s*seconds?/i.exec(body);
  if (seconds) wait = Math.max(wait, Number(seconds[2]) * 1000);
  return new Date(now + Math.max(wait, 5000)).toISOString();
}
export function classifyFfiecError(status, body, headers, now = Date.now()) {
  if (status === 429 || (status === 403 && /quota|call volume|replenish/i.test(body))) {
    const hasHint = headers.has('retry-after') || /replenished in\s+\d/i.test(body);
    return new BankDataError('quota_exhausted', { status: 429, retryAt: hasHint ? quotaRetryAt(headers, body, now) : new Date(now + 3600000).toISOString() });
  }
  if ([401, 403].includes(status) || /token.{0,30}(invalid|expired)|invalid.{0,20}token|unauthoriz/i.test(body)) return new BankDataError('authentication_failure', { status: 401 });
  if (/invalid reporting period/i.test(body)) return new BankDataError('reporting_period_unavailable', { status: 404 });
  if (/facsimile.{0,40}(not found|unavailable)/i.test(body)) return new BankDataError('call_report_not_filed', { status: 404 });
  if (status === 404) return new BankDataError('api_endpoint_unavailable');
  return new BankDataError('network_api_failure');
}

/** No request can bypass the shared Postgres gate. Credentials are used only here. */
export function createFfiecClient({ env = process.env, gate, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  if (typeof window !== 'undefined') throw new BankDataError('server_only', { status: 403 });
  const base = env.FFIEC_CDR_BASE_URL?.replace(/\/+$/, '') + '/';
  if (base !== FFIEC_BASE) throw new BankDataError('ffiec_base_url_invalid');
  if (![env.FFIEC_CDR_USER_ID, env.FFIEC_CDR_TOKEN].every(v => typeof v === 'string' && v.trim() && !/[\r\n]/.test(v))) throw new BankDataError('ffiec_credentials_unavailable');
  if (!gate) throw new BankDataError('request_gate_unavailable');
  let queue = Promise.resolve();
  function request(method, parameters = {}) {
    const task = queue.then(async () => {
      if (!FFIEC_METHODS.has(method)) throw new BankDataError('unsupported_endpoint');
      for (let attempt = 0; attempt < 3; attempt++) {
        const permit = await gate.reserve(method);
        if (!permit.allowed) {
          if (permit.retryAt && Date.parse(permit.retryAt) - now() <= 15000) { await sleep(Math.max(1, Date.parse(permit.retryAt) - now())); attempt--; continue; }
          throw new BankDataError(permit.code || 'request_gate_unavailable', { retryAt: permit.retryAt });
        }
        let response, body;
        try {
          response = await fetchImpl(FFIEC_BASE + method, { method: 'GET', headers: {
            UserID: env.FFIEC_CDR_USER_ID.trim(), Authentication: `Bearer ${env.FFIEC_CDR_TOKEN.trim().replace(/^Bearer\s+/i, '')}`,
            dataSeries: 'Call', 'Content-Type': 'application/json', ...parameters,
          }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25000) });
          body = await limitedText(response);
        } catch {
          if (attempt === 2) throw new BankDataError('network_api_failure');
          await sleep(5000 * (2 ** attempt)); continue;
        }
        if (response.ok) { try { return JSON.parse(body); } catch { throw new BankDataError('parsing_failure'); } }
        const error = classifyFfiecError(response.status, body, response.headers, now());
        if (error.code === 'quota_exhausted') { await gate.cooldown(error.retryAt, error.code); throw error; }
        if (response.status >= 500 && attempt < 2) {
          const retryAt = response.headers.has('retry-after') ? quotaRetryAt(response.headers, '', now()) : new Date(now() + 5000 * (2 ** attempt)).toISOString();
          await gate.cooldown(retryAt, 'network_api_failure');
          if (Date.parse(retryAt) - now() > 15000) throw new BankDataError('network_api_failure', { retryAt });
          await sleep(Math.max(0, Date.parse(retryAt) - now())); continue;
        }
        throw error;
      }
      throw new BankDataError('network_api_failure');
    });
    queue = task.catch(() => {}); return task;
  }
  return { request };
}
