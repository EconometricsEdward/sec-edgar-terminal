import { NextResponse } from 'next/server';
import { warmCacheEnabled } from '../../../utils/warmCache.js';
import { secClientStatus } from '../../../utils/secClient.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const warmCacheConfigured = warmCacheEnabled();
  const gate = secClientStatus();
  const secUserAgentConfigured = gate.userAgent === 'configured';
  const deployed = Boolean(process.env.VERCEL_ENV || process.env.VERCEL) || process.env.NODE_ENV === 'production';
  const status = secUserAgentConfigured && (!deployed || (warmCacheConfigured && gate.sharedGate === 'configured'))
    ? 'ok'
    : 'degraded';

  return NextResponse.json(
    {
      status,
      service: 'sec-edgar-terminal',
      checkedAt: new Date().toISOString(),
      checks: {
        secUserAgent: secUserAgentConfigured ? 'configured' : 'invalid',
        warmCache: warmCacheConfigured ? 'configured' : 'disabled',
        secRateGate: gate.sharedGate,
        secStartsPerSecond: gate.startsPerSecond,
      },
      deployment: {
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
        region: process.env.VERCEL_REGION || 'unknown',
        commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
      },
    },
    {
      status: status === 'ok' ? 200 : 503,
      headers: {
        'Cache-Control': status === 'ok'
          ? 'public, max-age=0, s-maxage=30, stale-while-revalidate=60'
          : 'private, no-store',
      },
    },
  );
}
