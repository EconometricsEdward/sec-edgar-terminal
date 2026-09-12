import { runProviderRetirementStep } from '../../../../utils/providerRetirement.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (process.env.VERCEL_ENV !== 'production') return Response.json({ error: 'Provider retirement cleanup runs only in production.' }, { status: 403, headers });
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  try { return Response.json(await runProviderRetirementStep(), { headers }); }
  catch (error) { return Response.json({ error: error.message, code: 'PROVIDER_RETIREMENT_FAILED' }, { status: error.status || 503, headers }); }
}
