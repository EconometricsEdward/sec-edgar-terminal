import { refreshCftcSnapshots } from '../../../../utils/cftcServer.js';
import { isCftcEnabled } from '../../../../utils/cftcFeature.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (!isCftcEnabled()) return Response.json({ status: 'disabled', skipped: true, reason: 'CFTC positioning is disabled for provider-free rollback.' }, { headers });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('CFTC refresh deadline reached.')), 260_000);
  try { return Response.json(await refreshCftcSnapshots({ signal: controller.signal }), { headers }); }
  catch (error) { return Response.json({ error: error.message, code: error.code || 'CFTC_REFRESH_FAILED' }, { status: error.status || 503, headers }); }
  finally { clearTimeout(timer); }
}
