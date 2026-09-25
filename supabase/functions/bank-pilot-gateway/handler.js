// Separate preview workload boundary. Existing production gateway is untouched.
export const BANK_TRUST = Object.freeze({ issuer: 'https://oidc.vercel.com/econometricsedwards-projects',
  audience: 'https://vercel.com/econometricsedwards-projects', subject: 'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:preview',
  ownerId: 'team_EEZpsSbH41QqVl83n2OJmLob', projectId: 'prj_tjTGC2omKa1JOT7il31bFZ8ilk8f' });
const PROJECT = 'https://vvkihuduqqnxqahhbphs.supabase.co';
const OPERATIONS = new Set(['read', 'source', 'begin', 'reserve', 'cooldown', 'finish', 'discovery', 'institution', 'publish']);
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
export function validBankClaims(p, now = Date.now()) {
  return p?.iss === BANK_TRUST.issuer && p.aud === BANK_TRUST.audience && p.sub === BANK_TRUST.subject
    && p.owner_id === BANK_TRUST.ownerId && p.project_id === BANK_TRUST.projectId && p.environment === 'preview'
    && Number.isInteger(p.iat) && Number.isInteger(p.exp) && p.iat <= now / 1000 + 5 && p.exp > now / 1000 - 5
    && p.exp > p.iat && p.exp - p.iat <= 7205 && now / 1000 - p.iat <= 7205;
}
export function createBankGateway({ verify, env, fetchImpl = fetch }) {
  return async request => {
    try {
      if (request.method !== 'POST') return reply({ code: 'method_not_allowed' }, 405);
      const authorization = request.headers.get('authorization') || '';
      if (!/^Bearer [A-Za-z0-9_.-]{20,16384}$/.test(authorization)) return reply({ code: 'unauthorized' }, 401);
      let claims; try { claims = await verify(authorization.slice(7)); } catch { return reply({ code: 'unauthorized' }, 401); }
      if (!validBankClaims(claims)) return reply({ code: 'unauthorized' }, 401);
      const reader = request.body?.getReader(); let size = 0; const chunks = [];
      if (!reader) return reply({ code: 'invalid_payload' }, 400);
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 12000000) return reply({ code: 'body_too_large' }, 413); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ code: 'invalid_payload' }, 400); }
      if (!OPERATIONS.has(body.operation) || !body.payload || Array.isArray(body.payload) || typeof body.payload !== 'object'
        || Object.keys(body).some(k => !['operation', 'payload'].includes(k))) return reply({ code: 'invalid_operation' }, 400);
      if (env('SUPABASE_URL')?.replace(/\/$/, '') !== PROJECT) return reply({ code: 'gateway_unavailable' }, 503);
      const secret = env('SUPABASE_SERVICE_ROLE_KEY'); if (!secret) return reply({ code: 'gateway_unavailable' }, 503);
      const response = await fetchImpl(`${PROJECT}/rest/v1/rpc/bank_pilot_operation`, { method: 'POST',
        headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_operation: body.operation, p_payload: body.payload }), redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) return reply({ code: 'database_failure' }, 503);
      return reply(await response.json());
    } catch { return reply({ code: 'database_failure' }, 503); }
  };
}
