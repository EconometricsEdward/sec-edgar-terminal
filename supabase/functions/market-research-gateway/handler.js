export const TRUST = { issuer: 'https://oidc.vercel.com/econometricsedwards-projects', audience: 'https://vercel.com/econometricsedwards-projects',
  owner: 'team_EEZpsSbH41QqVl83n2OJmLob', project: 'prj_tjTGC2omKa1JOT7il31bFZ8ilk8f' };
const PROJECT = 'https://vvkihuduqqnxqahhbphs.supabase.co';
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
export function validMarketClaims(p, now = Date.now()) {
  return p?.environment === 'production' && p.iss === TRUST.issuer && p.aud === TRUST.audience && p.owner_id === TRUST.owner && p.project_id === TRUST.project
    && p.sub === 'owner:econometricsedwards-projects:project:sec-edgar-terminal:environment:production'
    && Number.isInteger(p.iat) && Number.isInteger(p.exp) && p.iat <= now / 1000 + 5 && p.exp > now / 1000 - 5 && p.exp > p.iat && p.exp - p.iat <= 7205 && now / 1000 - p.iat <= 7205;
}
export function createMarketGateway({ verify, env, fetchImpl = fetch }) {
  return async request => {
    try {
      if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
      const auth = request.headers.get('authorization') || '';
      if (!/^Bearer [A-Za-z0-9_.-]{20,16384}$/.test(auth)) return reply({ error: 'unauthorized' }, 401);
      let claims; try { claims = await verify(auth.slice(7)); } catch { return reply({ error: 'unauthorized' }, 401); }
      if (!validMarketClaims(claims)) return reply({ error: 'unauthorized' }, 401);
      const reader = request.body?.getReader(); if (!reader) return reply({ error: 'invalid_body' }, 400);
      const parts = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 5000000) return reply({ error: 'body_too_large' }, 413); parts.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply({ error: 'invalid_body' }, 400); }
      if (!['read', 'begin', 'publish', 'finish'].includes(body.operation) || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)
        || Object.keys(body).some(k => !['operation', 'payload'].includes(k))) return reply({ error: 'invalid_operation' }, 400);
      if (env('SUPABASE_URL')?.replace(/\/$/, '') !== PROJECT || !env('SUPABASE_SERVICE_ROLE_KEY')) return reply({ error: 'unavailable' }, 503);
      const key = env('SUPABASE_SERVICE_ROLE_KEY');
      const r = await fetchImpl(`${PROJECT}/rest/v1/rpc/market_research_operation`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_operation: body.operation, p_payload: body.payload }), redirect: 'error', signal: AbortSignal.timeout(18000) });
      if (!r.ok) return reply({ error: 'store_unavailable' }, 503);
      return reply(await r.json());
    } catch { return reply({ error: 'store_unavailable' }, 503); }
  };
}
