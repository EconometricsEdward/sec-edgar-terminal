import { NextResponse } from 'next/server';
import { warmCacheEnabled, warmGet } from '../../../utils/warmCache.js';
import { secClientStatus } from '../../../utils/secClient.js';
import { MARKET_ATLAS_FRESH_MS, MARKET_VERSION } from '../../../utils/marketResearch.js';
import { isMarketAtlas } from '../../../utils/marketResearchValidation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const warmCacheConfigured = warmCacheEnabled();
  const gate = secClientStatus();
  const secUserAgentConfigured = gate.userAgent === 'configured';
  const deployed = Boolean(process.env.VERCEL_ENV || process.env.VERCEL) || process.env.NODE_ENV === 'production';
  const candidate = warmCacheConfigured ? await warmGet(MARKET_VERSION, 'atlas') : null;
  const atlasReady = isMarketAtlas(candidate, MARKET_VERSION);
  const atlasAge = atlasReady ? Date.now() - Date.parse(candidate.generatedAt) : Number.POSITIVE_INFINITY;
  const marketAtlas = atlasReady && Number.isFinite(atlasAge) && atlasAge >= 0 && atlasAge < MARKET_ATLAS_FRESH_MS
    ? 'ready'
    : atlasReady ? 'stale' : 'missing';
  const status = secUserAgentConfigured && (!deployed || (
    warmCacheConfigured && gate.sharedGate === 'configured' && marketAtlas !== 'missing'
  ))
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
        priceProviderGate: warmCacheConfigured ? 'configured' : 'disabled',
        secStartsPerSecond: gate.startsPerSecond,
        marketAtlas,
        marketAtlasGeneratedAt: atlasReady ? candidate.generatedAt : null,
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
