import { NextResponse } from 'next/server';
import { warmCacheEnabled } from '../../../utils/warmCache.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function configured(value: string | undefined) {
  return Boolean(value && value.trim());
}

export async function GET() {
  const secUserAgentConfigured = configured(process.env.SEC_USER_AGENT);
  const status = secUserAgentConfigured ? 'ok' : 'degraded';

  return NextResponse.json(
    {
      status,
      service: 'sec-edgar-terminal',
      checkedAt: new Date().toISOString(),
      checks: {
        secUserAgent: secUserAgentConfigured ? 'configured' : 'missing',
        warmCache: warmCacheEnabled() ? 'configured' : 'disabled',
      },
      deployment: {
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
        region: process.env.VERCEL_REGION || 'unknown',
        commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
      },
    },
    {
      status: secUserAgentConfigured ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
