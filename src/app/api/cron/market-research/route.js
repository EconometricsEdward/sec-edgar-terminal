import { runMarketResearchWorker } from '../../../../utils/marketPlumbing/worker.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  try { return Response.json(await runMarketResearchWorker({ signal: AbortSignal.timeout(260000) }), { headers }); }
  catch { return Response.json({ error: 'Scheduled market refresh unavailable' }, { status: 503, headers }); }
}
