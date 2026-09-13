import { refreshQuantBatch, refreshQuantMembership } from '../../../../utils/quantCoverageServer.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== 'production') return Response.json({ error: 'SEC coverage refreshes run only in production.' }, { status: 403, headers });
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !['batch', 'membership'].includes(key)) || query.getAll('batch').length > 1 || query.getAll('membership').length > 1 || (query.has('batch') === query.has('membership')) || query.has('membership') && query.get('membership') !== '1' || query.has('batch') && !/^(\d|1[0-5])$/.test(query.get('batch'))) return Response.json({ error: 'Choose one valid batch or membership refresh.' }, { status: 400, headers });
  const controller = new AbortController(), deadline = Date.now() + 280000;
  const timer = setTimeout(() => controller.abort(new Error('Coverage batch deadline reached.')), 265000);
  try { return Response.json(query.has('membership') ? await refreshQuantMembership({ signal: controller.signal }) : await refreshQuantBatch(Number(query.get('batch')), { signal: controller.signal, deadline }), { headers }); }
  catch (error) { return Response.json({ error: error.message }, { status: error.status || 503, headers }); }
  finally { clearTimeout(timer); }
}
