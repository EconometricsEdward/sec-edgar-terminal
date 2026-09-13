import { runProviderRetirementStep } from '../../../../utils/providerRetirement.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (process.env.VERCEL_ENV !== 'production') return Response.json({ error: 'Provider retirement cleanup runs only in production.' }, { status: 403, headers });
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== 'max_keys') || query.getAll('max_keys').length > 1 || query.has('max_keys') && !/^(?:[1-9]\d{0,2}|1\d{3}|2[0-4]\d{2}|2500)$/.test(query.get('max_keys'))) {
    return Response.json({ error: 'max_keys must be one integer from 1 to 2500.' }, { status: 400, headers });
  }
  try {
    const result = await runProviderRetirementStep({ maxKeys: Number(query.get('max_keys') || 2500) });
    console.info('[provider-retirement]', JSON.stringify({ plan_id: result.plan_id, phase: result.phase || null, complete: result.complete === true, scanned: result.scanned || 0, removed: result.removed || 0, verification_removed: result.verification_removed || 0, target_index: result.target_index ?? null, deletion_not_before: result.deletion_not_before || null, verification_not_before: result.verification_not_before || null, completed_at: result.completed_at || null, skipped: result.skipped || null }));
    return Response.json(result, { headers });
  }
  catch (error) { return Response.json({ error: error.message, code: 'PROVIDER_RETIREMENT_FAILED' }, { status: error.status || 503, headers }); }
}
