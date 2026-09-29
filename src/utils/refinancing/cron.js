import { runRefinancingBackfill } from './backfill.js';

/** Fixed server-side budgets; a request cannot choose issuers or expand work. */
export async function handleRefinancingCron(request, {
  run = runRefinancingBackfill, env = process.env, now = Date.now,
} = {}) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`)
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (env.VERCEL_ENV !== 'production')
    return Response.json({ error: 'Refinancing preparation runs only in production.' }, { status: 403, headers });
  if (new URL(request.url).search)
    return Response.json({ error: 'This scheduled job does not accept parameters.' }, { status: 400, headers });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Refinancing preparation deadline reached.')), 235000);
  try {
    const result = await run({ signal: controller.signal, deadline: now() + 240000, limit: 160 });
    return Response.json(result, { headers });
  } catch {
    return Response.json({ error: 'Scheduled refinancing preparation is temporarily unavailable.' },
      { status: 503, headers: { ...headers, 'Retry-After': '600' } });
  } finally { clearTimeout(timer); }
}
