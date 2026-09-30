import { createRiskContextApi } from '../../../../utils/riskContextApi.js';
import { readCachedRefinancingWall } from '../../../../utils/refinancing/publicRead.js';
import { getMarketResearch } from '../../../../utils/marketPlumbing/server.js';
import { bankScopeStore } from '../../../../utils/bank/scopeStore.js';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '../../../../utils/rateLimit.js';
import { isCftcEnabled } from '../../../../utils/cftcFeature.js';
import { createRiskMaturityRead } from '../../../../utils/riskContext.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const GET = createRiskContextApi({
  readMaturities: createRiskMaturityRead({ read: readCachedRefinancingWall }), readMarket: getMarketResearch, readBank: bankScopeStore,
  cftcEnabled: isCftcEnabled(),
  rateLimit: async request => {
    const result = await checkRateLimit({ key: `rl:risk-context:${getClientIp(request)}`, windowMs: 60000, max: 60 });
    return result.allowed ? null : rateLimitedResponse(result);
  },
});
