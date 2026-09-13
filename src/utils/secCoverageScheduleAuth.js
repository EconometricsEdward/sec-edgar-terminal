import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyCoverageScheduleSignature } from './dataStore.js';
import { checkRateLimit, getClientIp } from './rateLimit.js';

/** Short-lived signed machine request. The Vault secret never enters pg_net. */
export async function authorizeSecCoverageSchedule(request, {
  env = process.env, now = Date.now, verify = verifyCoverageScheduleSignature, rateLimit = checkRateLimit,
} = {}) {
  if (env.VERCEL_ENV !== 'production' || request.method !== 'GET') return false;
  const authorization = request.headers.get('authorization') || '';
  if (authorization.length <= 4096 && typeof env.CRON_SECRET === 'string' && env.CRON_SECRET.length >= 16 && env.CRON_SECRET.length <= 4000) {
    const supplied = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  let url;
  try { url = new URL(request.url); } catch { return false; }
  // Only CRON_SECRET can authorize the route's bounded manual query parameters.
  if (url.origin !== 'https://secedgarterminal.com' || url.pathname !== '/api/cron/sec-coverage' || url.search || url.hash) return false;
  const timestampText = request.headers.get('x-edgar-schedule-timestamp') || '';
  const nonce = request.headers.get('x-edgar-schedule-nonce') || '';
  const signature = request.headers.get('x-edgar-schedule-signature') || '';
  if (!/^\d{10}$/.test(timestampText) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const timestamp = Number(timestampText), seconds = Math.floor(now()/1000);
  if (!Number.isFinite(seconds) || timestamp < seconds-300 || timestamp > seconds+30) return false;
  try {
    // Limit well-formed forgeries before the private verification RPC. These
    // reuse the site's shared limiter and allow bounded operator backfills.
    const global = await rateLimit({ key:'rl:sec-coverage-signatures:global', windowMs:60000, max:60 });
    if (!global?.allowed) return false;
    const caller = createHash('sha256').update(String(getClientIp(request)).slice(0,128)).digest('hex').slice(0,24);
    const source = await rateLimit({ key:`rl:sec-coverage-signatures:${caller}`, windowMs:60000, max:20 });
    if (!source?.allowed) return false;
    return await verify({ timestamp, nonce, signature }) === true;
  } catch { return false; }
}
