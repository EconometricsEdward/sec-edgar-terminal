import test from 'node:test';
import assert from 'node:assert/strict';
import { riskProfileCachePolicy } from '../src/utils/riskProfileCache.js';
import { riskResponseForVersion } from '../src/utils/riskWorkspace.js';

const profile = (filing = 'applied', continuity = 'not-applicable') => ({
  ticker: 'NEE', annual: { metrics: [] },
  sourceCoverage: { filingFallback: { status: filing }, continuity: { status: continuity } },
});

test('temporary source failures expire quickly without stale reuse in both response contracts', () => {
  for (const data of [profile('unavailable'), profile('not-needed', 'partial'), profile('unavailable', 'partial')]) {
    for (const version of [null, 'risk-workspace-v9']) {
      const policy = riskProfileCachePolicy(riskResponseForVersion(data, version));
      assert.equal(policy.ttlSeconds, 60);
      assert.match(policy.cacheControl, /(?:^|, )s-maxage=60(?:,|$)/);
      assert.match(policy.cacheControl, /max-age=0/);
      assert.match(policy.cacheControl, /must-revalidate/);
      assert.doesNotMatch(policy.cacheControl, /stale-/);
    }
  }
});

test('healthy and confirmed unsupported coverage keep normal caching', () => {
  for (const data of [profile(), profile('not-needed', 'applied'), profile('no-supported-facts')]) {
    const policy = riskProfileCachePolicy(data);
    assert.equal(policy.ttlSeconds, 900);
    assert.equal(policy.cacheControl, 'public, s-maxage=900, stale-while-revalidate=900');
  }
});

test('a recovered response restores normal caching without retaining the earlier gap', () => {
  const data = profile('unavailable', 'partial');
  assert.equal(riskProfileCachePolicy(data).ttlSeconds, 60);
  data.sourceCoverage.filingFallback.status = 'applied';
  data.sourceCoverage.continuity.status = 'applied';
  assert.equal(riskProfileCachePolicy(data).ttlSeconds, 900);
});
